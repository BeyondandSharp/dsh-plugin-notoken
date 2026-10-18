// publish.mjs — web login, second factor and publish, all driven through npm.
//
// npm runs the whole authorisation dance itself once it has a terminal:
//
//   * `npm login --auth-type=web` prints the `loginUrl` from `POST /-/v1/login`
//     and polls `doneUrl` until the browser flow finishes;
//   * when a write needs a second factor npm raises `EOTP` with `authUrl` and
//     `doneUrl`, prints the `authUrl`, polls `doneUrl` and retries the publish
//     with the one-time token it receives (npm's `otplease`).
//
// This program therefore only has to (a) notice the URL as it is printed and
// relay it to the webhook while npm keeps waiting, and (b) bound the whole
// interaction with one deadline. Both npm branches sit behind
// `process.stdin.isTTY && process.stdout.isTTY`, so the calls run under
// `script(1)`; without it npm rethrows a bare EOTP and nothing can be relayed.
//
// Authenticating by hand is still possible: `workflow_dispatch`'s `otp` input is
// passed through on the first publish attempt for registries that only accept a
// typed code.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildPayload, deliver, errorSummary, isAuthUrl, readOptional } from './notify-lib.mjs';
import { extractVerificationCode, parseNpmAuthOutput } from './verification-parse.mjs';
import { fellBackToPasswordPrompt, findAuthUrl, findCompleteAuthUrl, nonInteractiveRefusal } from './registry-auth.mjs';
import {
  BINARY,
  binaryOnPath,
  loginArgs,
  MIN_VERSION_TEXT,
  NPM_AUTH_NOTE,
  npmCommand,
  npmVersion,
  publishArgs,
  unsupportedReason,
  whoamiArgs,
} from './publisher.mjs';
import { npmPtyEnv, PTY_BIN, ptyArgs, wrappedCommand } from './pty.mjs';
import { isDirect } from './is-direct.mjs';

export const IS_DIRECT = isDirect(import.meta.url);

/** Strip the \r doubling and ANSI sequences a PTY introduces. */
export function cleanOutput(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
}

/** Never let a one-time password reach a log line or a webhook payload. */
export function redactSecrets(text, secrets = []) {
  let out = String(text || '').replace(/(--otp[= ])\S+/gi, '$1***');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

/**
 * The `--access` value for this publish.
 *
 * `package.json`'s `publishConfig.access` wins, so a repository that declares
 * `restricted` is never published publicly by the Action's own default; an
 * explicit `PUBLISH_ACCESS` overrides both, and anything else means the
 * documented default of a public package.
 */
export function publishAccess(pkg, env = process.env) {
  const override = readOptional(env.PUBLISH_ACCESS);
  if (override === 'public' || override === 'restricted') return override;
  const declared = String(pkg?.publishConfig?.access || '');
  return declared === 'restricted' ? 'restricted' : 'public';
}

/** Did npm refuse because this exact version is already on the registry? */
export function isPublishConflict(text) {
  return /EPUBLISHCONFLICT|previously published versions|publish over the previously/i.test(String(text || ''));
}

/** Is exactly this version on the registry now? Confirms a concurrent publish. */
export function versionOnRegistry(name, version, run = spawnSync) {
  if (!name || !version) return false;
  const result = run(BINARY, ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  return String(result.stdout || '').includes(version);
}

async function main() {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const core = JSON.parse(readFileSync(join(temp, 'release.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const state = { ...core, package: core.name || pkg.name };
  const access = publishAccess(pkg);
  const waitMinutes = Number(process.env.NPM_AUTH_WAIT_MINUTES || 15);
  // One budget for the whole interaction, not one per wait: login, its polling
  // and the publish retry all draw from the same deadline, so the job can never
  // overshoot the workflow's timeout and lose the failure notification.
  const budgetMs = Math.max(5_000, Math.round(waitMinutes * 60_000));
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => Math.max(5_000, deadline - Date.now());
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const inputOtp = readOptional(process.env.INPUT_OTP);
  const notifyRequired = String(process.env.NOTIFY_REQUIRED ?? 'true').toLowerCase() !== 'false';

  if (!binaryOnPath(BINARY)) {
    process.stderr.write(
      `找不到 ${BINARY}。Node 官方镜像自带 npm；若是精简镜像请安装 Node（含 npm），或改用自带 npm 的镜像。\n`,
    );
    process.exit(1);
  }
  const version = npmVersion();
  const unsupported = unsupportedReason(version);
  const pty = binaryOnPath(PTY_BIN);
  process.stdout.write(
    `${BINARY} ${version || '(版本未知)'}｜${pty ? `PTY=${PTY_BIN}` : 'PTY=缺失'}｜认证总预算 ${waitMinutes} 分钟\n`,
  );
  if (unsupported && !state.dryRun) {
    process.stderr.write(
      `${unsupported}\n请升级 npm 到 ${MIN_VERSION_TEXT} 或更高（npm i -g npm@latest）。\n`,
    );
    process.exit(1);
  }
  if (!pty) {
    process.stderr.write(
      `没有 ${PTY_BIN}(1)：npm 只会在 stdin/stdout 都是终端时才走网页认证流程。\n` +
        `  登录仍可能成功，但二次验证会直接失败；请安装 util-linux（ensure-tools 会尝试）。\n`,
    );
  }
  process.stdout.write(`${NPM_AUTH_NOTE}\n`);

  /** Every URL already forwarded, so the same link is never sent twice. */
  const announced = new Set();

  /**
   * Relay one authentication link. A link that is not a one-time authorisation
   * URL is never sent (the receiving chat only ever extracts {title,url}), and a
   * delivery that silently skipped must not be reported as forwarded.
   */
  const announce = async (url, phase, fallbackCode = '') => {
    if (!url || announced.has(url)) return false;
    if (!isAuthUrl(url)) {
      process.stdout.write(`忽略非授权链接（${url}）：只有一次性的登录/验证链接会被转发\n`);
      return false;
    }
    announced.add(url);
    if (state.dryRun) {
      process.stdout.write(`dry-run：检测到 ${phase}，未投递（${url}）\n`);
      return true;
    }
    const payload = buildPayload({
      phase,
      core: state,
      auth: { kind: phase, url, code: fallbackCode },
      summary:
        phase === 'npm-login-required'
          ? `请打开链接完成 npm 登录，登录后会自动继续发布：${url}`
          : `请打开链接完成二次验证，完成后发布即完成：${url}`,
    });
    let result;
    try {
      result = await deliver(payload);
    } catch (error) {
      announced.delete(url);
      const message = `授权链接投递失败：${errorSummary(error)}`;
      // Without the link the human cannot finish; waiting would only burn the
      // budget. NOTIFY_REQUIRED=false opts into logging and carrying on.
      if (notifyRequired) throw new Error(message);
      process.stderr.write(`${message}（NOTIFY_REQUIRED=false，继续）\n`);
      return false;
    }
    if (result.skipped) {
      announced.delete(url);
      process.stdout.write(`该链接未发送：${result.reason}\n`);
      return false;
    }
    process.stdout.write(
      `已把${phase === 'npm-login-required' ? '登录' : '二次验证'}网址转发到 webhook（${url}）\n`,
    );
    return true;
  };

  /**
   * Run npm, stream its output, and relay the first authorisation URL that
   * appears — npm keeps polling while it waits for the browser, so waiting for
   * the process to exit before relaying would deadlock.
   *
   * `abortWhen` stops the run as soon as the output proves it can never finish:
   * a registry without the web-login endpoint (Verdaccio, most internal mirrors)
   * makes npm fall back to a "Username:" prompt that nothing can answer, and
   * waiting for the budget would help nobody.
   */
  const runNpm = (args, { phase = 'npm-2fa', onAuthUrl, usePty = pty, abortWhen } = {}) =>
    new Promise((resolveRun) => {
      process.stdout.write(`运行：${npmCommand(args)}${usePty ? '' : '（无 PTY）'}\n`);
      const exitFile = join(temp, `.npm-exit-${process.pid}-${Math.random().toString(36).slice(2)}`);
      const [command, commandArgs] = usePty
        ? [PTY_BIN, ptyArgs(wrappedCommand([BINARY, ...args], exitFile))]
        : [BINARY, args];
      const child = spawn(command, commandArgs, { env: npmPtyEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

      let captured = '';
      let announcedUrl = '';
      let failure = null;

      const stop = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        failure = new Error(`等待 npm 超过 ${Math.round(budgetMs / 1000)}s（认证总预算），已终止`);
        stop();
      }, remainingMs());

      const relay = (url) => {
        if (!onAuthUrl || !url || url === announcedUrl) return Promise.resolve(false);
        announcedUrl = url;
        return Promise.resolve(onAuthUrl(url, phase)).catch((error) => {
          failure = error;
          stop();
          return false;
        });
      };

      const handle = (chunk) => {
        process.stdout.write(chunk);
        captured = `${captured}${cleanOutput(chunk)}`.slice(-262_144);
        if (failure) return;
        if (abortWhen) {
          const reason = abortWhen(captured);
          if (reason) {
            failure = new Error(reason);
            stop();
            return;
          }
        }
        void relay(findCompleteAuthUrl(captured));
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', handle);
      child.stderr.on('data', handle);
      child.on('error', (error) => {
        clearTimeout(timer);
        process.stderr.write(`无法启动 ${command}：${error.message}\n`);
        resolveRun({ code: 127, captured, failure });
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        // `script` cannot portably return the child's status (-e is util-linux
        // only), so the wrapped command wrote it to a file.
        let status = code ?? 1;
        if (usePty) {
          try {
            const text = readFileSync(exitFile, 'utf8').trim();
            if (text !== '') status = Number(text);
          } catch {
            /* keep the PTY process status */
          }
        }
        // The stream is over, so any URL left in the buffer is complete.
        if (!failure && onAuthUrl) await relay(findAuthUrl(captured));
        resolveRun({ code: status, captured, failure });
      });
    });

  const isAuthenticated = () => {
    const result = spawnSync(BINARY, whoamiArgs(), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: npmPtyEnv(),
    });
    return result.status === 0 && String(result.stdout || '').trim() !== '';
  };

  // --- 1. login, if needed. ------------------------------------------------
  if (!state.dryRun && !isAuthenticated()) {
    process.stdout.write('npm 未登录：发起网页登录（npm 自己轮询，登录完成后继续）\n');
    const login = await runNpm(loginArgs(), {
      phase: 'npm-login-required',
      onAuthUrl: (url, loginPhase) => announce(url, loginPhase),
      // A registry without POST /-/v1/login (Verdaccio, most internal mirrors)
      // makes npm fall back to an unanswerable "Username:" prompt: stop at once
      // instead of waiting out the budget for a login that can never happen.
      abortWhen: (text) =>
        fellBackToPasswordPrompt(text)
          ? 'npm 退化为用户名/密码提示（该 registry 不支持网页登录）'
          : '',
    });

    // The prompt check comes first: when the run was aborted for exactly this
    // reason, `failure` is that abort and the operator needs the advice below.
    if (fellBackToPasswordPrompt(login.captured)) {
      process.stderr.write(
        'npm 退化为用户名/密码提示：该 registry 不支持 npm 的网页登录（POST /-/v1/login），\n' +
          '而本 Action 不保存任何 registry token，无法用用户名/密码完成认证。\n' +
          '请把 NPM_CONFIG_REGISTRY 指向支持网页登录的 registry（npmjs），\n' +
          '或只让"安装依赖"走内网镜像（项目的 .npmrc + package.json 的 publishConfig.registry），\n' +
          '或改用 trusted publishing (OIDC)。\n',
      );
      process.exit(1);
    }
    if (login.failure) throw login.failure;

    const prose = parseNpmAuthOutput(login.captured);
    const loginUrl = findAuthUrl(login.captured) || (isAuthUrl(prose.url) ? prose.url : '');
    if (loginUrl) {
      await announce(loginUrl, 'npm-login-required', prose.code);
    } else if (login.code !== 0) {
      // No link and no success: polling whoami would only burn the budget.
      process.stderr.write(
        `npm login 以退出码 ${login.code} 结束，且没有给出登录链接。\n` +
          `请确认该 registry 支持 --auth-type=web，或改用 trusted publishing (OIDC)。\n`,
      );
      process.exit(1);
    }

    // npm blocks until the browser flow completes; this loop only covers the
    // case where it exited first (a re-run of the step with credentials already
    // in ~/.npmrc, or a doneUrl npm gave up on).
    while (Date.now() < deadline && !isAuthenticated()) await sleep(3000);
    process.stdout.write(isAuthenticated() ? 'npm 已登录，继续发布\n' : '仍未登录，继续尝试发布\n');
  }

  // --- 2. publish; npm authorises a second factor through doneUrl itself. ---
  //
  // Publish the tarball Prepare packed and hashed rather than the directory:
  // a directory publish re-runs the project's `prepublishOnly`, which duplicates
  // the Test/Build steps and can fail on tooling the image does not have (e.g. a
  // package manager that no lockfile reveals). Falling back to the directory
  // keeps `publish` usable on its own, without a preceding prepare.
  const tarball = state.tarball && existsSync(state.tarball) ? state.tarball : '';
  if (state.tarball && !tarball) {
    process.stderr.write(`Prepare 记录的 ${state.tarball} 不存在，改用目录发布\n`);
  }
  process.stdout.write(
    tarball ? `发布 Prepare 的产物：${tarball}\n` : '未找到 Prepare 的 tarball，按目录发布（会触发 prepublishOnly）\n',
  );
  const attempt = await runNpm(
    publishArgs({ distTag: state.distTag, access, dryRun: state.dryRun, otp: inputOtp, tarball }),
    { phase: 'npm-2fa', onAuthUrl: (url, publishPhase) => announce(url, publishPhase) },
  );
  if (attempt.failure) throw attempt.failure;

  if (attempt.code !== 0 && !state.dryRun) {
    // Two runs of the same tag (or a retry after a partially-finished release) can
    // both pass Preflight and then race for the same version; npm answers the
    // loser with EPUBLISHCONFLICT. The version being live is exactly what this
    // release wanted, so confirm it and treat the run as a no-op like the
    // Preflight gate does — but never on a conflict for a *different* version.
    if (isPublishConflict(attempt.captured) && versionOnRegistry(state.package, state.version)) {
      process.stdout.write(
        `registry 上已存在 ${state.package}@${state.version}（并发或重复发布），按已发布处理\n`,
      );
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, 'published=false\n');
      }
      return;
    }

    const prose = parseNpmAuthOutput(attempt.captured);
    const tailUrl = findAuthUrl(attempt.captured) || (isAuthUrl(prose.url) ? prose.url : '');
    if (tailUrl) {
      await announce(tailUrl, prose.kind || 'npm-2fa', prose.code || extractVerificationCode(attempt.captured));
    }

    const refusal = nonInteractiveRefusal(attempt.captured);
    if (refusal && !tailUrl) {
      process.stderr.write(
        `npm 无法完成二次验证，也没有给出可网页完成的链接。\n` +
          `  可能原因：没有 ${PTY_BIN}(1)（PTY）、npm < ${MIN_VERSION_TEXT}、或该 registry 只接受手输验证码。\n` +
          `  可改用 workflow_dispatch 的 otp 输入，或升级 npm。\n`,
      );
    }
    process.stderr.write(`npm publish 以退出码 ${attempt.code} 结束\n`);

    // Only an authentication link makes a failure notice worth sending, and the
    // raw tail is redacted and bounded: it must never carry a one-time password.
    const tail = redactSecrets(attempt.captured.slice(-1200), [inputOtp]);
    try {
      await deliver(
        buildPayload({
          phase: 'failed',
          core: state,
          reason: `npm publish 退出码 ${attempt.code}（认证未在 ${waitMinutes} 分钟预算内完成）`,
          auth: tailUrl ? { url: tailUrl } : undefined,
          outputTail: tail,
        }),
      );
    } catch (error) {
      process.stderr.write(`失败通知投递失败：${errorSummary(error)}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`npm publish 结束，退出码 0${state.dryRun ? '（dry-run，未写入 registry）' : ''}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `published=${state.dryRun ? 'false' : 'true'}\n`);
  }
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`发布异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
