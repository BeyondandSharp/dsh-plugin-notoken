import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPayload, deliver, errorSummary, isAuthUrl } from './notify-lib.mjs';
import { parseNpmAuthOutput } from './verification-parse.mjs';

// Run directly (argv[1] is this file) rather than imported by a test.
// Compare real paths: /tmp is a symlink on some hosts, and path.resolve
// would then disagree with import.meta.url.
export const IS_DIRECT = (() => {
  if (!process.argv[1] || !process.argv[1].endsWith('.mjs')) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

/**
* npm's own web flow returns a one-time URL (`https://www.npmjs.com/auth/cli/<uuid>`)
* both for a login and for a second factor, and the npm process has to stay alive
* while the human opens it — npm polls the registry and finishes by itself. That
* means every npm invocation must run with a TTY: with piped stdin npm refuses the
* interactive flow and only prints `E401`, which is why the challenge URL never
* reached the user.
*/

/**
 * npm only starts its web authorisation (the `auth/cli/<uuid>` link) when it has
 * a terminal; with piped stdin it just fails with E401. `script(1)` provides
 * that terminal. It ships with util-linux, which Debian/Ubuntu images have but
 * Alpine's BusyBox does not — so when it is missing the run must fail loudly
 * instead of silently publishing nothing.
 */
export function ptyAvailability(run, env = process.env) {
  const probe = run('sh', ['-c', 'command -v script && command -v timeout'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  return probe.status === 0;
}

/** One npm invocation. `usePty` runs it under script(1) so npm sees a terminal. */
export function npmCommand(args, { usePty, timeoutSeconds } = {}) {
  const command = `npm ${args.join(' ')}`;
  const env = 'BROWSER=true';
  if (!usePty) return `${env} ${command}`;
  const binary = process.env.NPM_SCRIPT_BINARY || 'script';
  const wrapped = `${env} timeout ${timeoutSeconds} ${binary} -q -e -c ${JSON.stringify(command)} /dev/null`;
  return wrapped;
}

/** Backwards-compatible alias. */
export function hasPty(run, env) {
  return ptyAvailability(run, env);
}

/** Strip the \r doubling and ANSI sequences a PTY introduces. */
export function cleanOutput(text) {
  return String(text || '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
  }

  async function main() {
    const temp = process.env.RUNNER_TEMP || '/tmp';
    const core = JSON.parse(readFileSync(join(temp, 'release.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const state = { ...core, package: core.name || pkg.name };
    const waitMinutes = Number(process.env.NPM_AUTH_WAIT_MINUTES || 15);
    const waitSeconds = Math.max(30, Math.round(waitMinutes * 60));
    const spawnSync = (await import('node:child_process')).spawnSync;
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const usePty = ptyAvailability(spawnSync);

    // Every URL already forwarded in this run, so the same link is never sent twice.
    const announced = new Set();
    const relay = async (text, phase) => {
      const parsed = parseNpmAuthOutput(text);
      // Only npm's own authentication link is worth sending: a registry origin or a
      // repository page would send the reader nowhere useful.
      if (!parsed.url || !isAuthUrl(parsed.url) || announced.has(parsed.url)) return parsed;
      announced.add(parsed.url);
      if (state.dryRun) {
        process.stdout.write(`dry-run：检测到 ${phase}，未投递（${parsed.url}）\n`);
        return parsed;
      }
      const payload = buildPayload({
          phase,
          core: { ...state, package: state.package },
          auth: { kind: phase, url: parsed.url, code: parsed.code },
          summary:
          phase === 'npm-login-required'
          ? `请打开链接完成 npm 登录，登录后会自动继续发布：${parsed.url}`
          : `请打开链接完成二次验证，完成后发布即完成：${parsed.url}`,
      });
      try {
        await deliver(payload);
        process.stdout.write(`已把${phase === 'npm-login-required' ? '登录' : '二次验证'}网址转发到 webhook（${parsed.url}）\n`);
      } catch (error) {
        process.stderr.write(`网址转发失败：${errorSummary(error)}\n`);
        announced.delete(parsed.url);
      }
      return parsed;
    };

    /** Run one npm command under a PTY, relaying challenge URLs as they appear. */
    const runNpm = (args, { phase, timeoutSeconds }) => {
      const command = npmCommand(args, { usePty, timeoutSeconds });
      process.stdout.write(`运行：${command}\n`);
      return new Promise((resolveRun) => {
          const child = spawn('sh', ['-c', command], {
              env: { ...process.env, BROWSER: 'true', npm_config_git_checks: 'false' },
              stdio: ['ignore', 'pipe', 'pipe'],
          });
          let captured = '';
          let pending = '';
          const handle = (chunk) => {
            process.stdout.write(chunk);
            captured = `${captured}${chunk}`.slice(-131_072);
            pending = cleanOutput(pending + chunk);
            const parsed = parseNpmAuthOutput(pending);
            if (parsed.url && !announced.has(parsed.url)) {
              pending = '';
              void relay(captured, phase);
            }
          };
          child.stdout.on('data', handle);
          child.stderr.on('data', handle);
          child.on('error', (error) => {
              process.stderr.write(`无法启动 npm：${error.message}\n`);
              resolveRun({ code: 127, captured });
          });
          child.on('close', (code) => resolveRun({ code: code ?? 1, captured }));
      });
    };

    const isAuthenticated = () => {
      const result = spawnSync('npm', ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return result.status === 0 && String(result.stdout || '').trim() !== '';
    };

    // --- 1. login, if needed: relay npm's own auth/cli URL and wait for the human.
    if (!state.dryRun && !isAuthenticated()) {
      if (!usePty) {
        // Without a terminal npm cannot open its web flow, so no auth link can
        // ever be produced — say exactly what to change instead of hanging.
        process.stderr.write(
          '需要交互式认证，但当前镜像里没有 script(1)，npm 无法进入网页登录/二次验证流程。\n' +
            '请任选其一：\n' +
            '  1) 用带 util-linux 的镜像（Debian 系自带），例如 container.image: node:22-bookworm；\n' +
            '  2) 在 Alpine 里安装：apk add --no-cache util-linux（提供 script）+ coreutils/binutils（可选 timeout）；\n' +
            '  3) 通过 NPM_SCRIPT_BINARY 指向等效的 PTY 工具。\n',
        );
        process.exit(1);
      }
      process.stdout.write('npm 未登录：发起 npm 网页登录（npm 会给出一次性登录链接）\n');
      const login = await runNpm(['login', '--auth-type=web'], {
          phase: 'npm-login-required',
          timeoutSeconds: waitSeconds,
      });
      const loginAuth = parseNpmAuthOutput(cleanOutput(login.captured));
      if (!loginAuth.url) {
        process.stderr.write('npm login 没有给出可转发的登录链接，继续尝试直接发布\n');
      } else if (!isAuthenticated()) {
        // The login process has exited without credentials: wait for the human and
        // re-check, so a slow browser confirmation does not force a failure.
        let waited = 0;
        const pollMs = Math.min(10_000, Math.max(1000, Number(process.env.NPM_LOGIN_POLL_MINUTES || 5) * 60_000));
        while (waited < pollMs && !isAuthenticated()) {
          await sleep(2000);
          waited += 2000;
        }
        if (isAuthenticated()) process.stdout.write('检测到 npm 已登录，继续发布\n');
      } else {
        process.stdout.write('npm 已登录，继续发布\n');
      }
    }

    // --- 2. publish: npm prints a second auth/cli URL when a second factor is due.
    const baseArgs = ['publish', '--access', 'public', '--tag', state.distTag];
    if (state.dryRun) baseArgs.push('--dry-run');
    const attempt = await runNpm(baseArgs, { phase: 'npm-2fa', timeoutSeconds: waitSeconds });
    const tail = cleanOutput(attempt.captured).slice(-4096);

    if (attempt.code !== 0) {
      process.stderr.write(`npm publish 以退出码 ${attempt.code} 结束\n`);
      if (!state.dryRun) {
        const parsedTail = parseNpmAuthOutput(tail);
        try {
          await deliver(
            buildPayload({
                phase: 'failed',
                core: state,
                reason: `npm publish 退出码 ${attempt.code}（认证可能未在 ${waitMinutes} 分钟内完成）`,
                auth: parsedTail.url ? parsedTail : undefined,
                outputTail: tail,
            }),
          );
        } catch (error) {
          process.stderr.write(`失败通知投递失败：${errorSummary(error)}\n`);
        }
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
