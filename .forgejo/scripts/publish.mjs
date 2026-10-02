import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPayload, deliver, errorSummary } from './notify-lib.mjs';
import { parseNpmAuthOutput } from './verification-parse.mjs';
import {
  extractAuthFlow,
  fellBackToPasswordPrompt,
  findAuthUrl,
  findCompleteAuthUrl,
  needsPty,
  parseLastJsonObject,
  pollDoneUrl,
} from './npm-auth.mjs';

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
 * npm exposes its whole web-authorisation flow to a script without a terminal:
 * `npm login --auth-type=web` prints the URL unconditionally, and since
 * npm 11.9.0 a write needing a second factor reports `authUrl` + `doneUrl` in its
 * error/`--json` output. A plain pipe is therefore enough — no PTY, no extra
 * package. `script(1)` remains only as a fallback for older npm builds, which do
 * hide the URL when there is no TTY.
 */

/** Is a PTY helper available (fallback path only)? */
export function ptyAvailability(run = spawnSync, env = process.env) {
  return (
    run('sh', ['-c', 'command -v script'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).status === 0
  );
}

/** Backwards-compatible alias. */
export function hasPty(run, env) {
  return ptyAvailability(run, env);
}

/** The npm version, so the fallback decision can be made from facts. */
export function npmVersion(run = spawnSync) {
  const result = run('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

/** `npm <args>` as a shell command; wrapped in a PTY only when required. */
export function npmCommand(args, { usePty, timeoutSeconds } = {}) {
  const command = `npm ${args.join(' ')}`;
  const env = 'BROWSER=true';
  if (!usePty) return `${env} ${command}`;
  const binary = process.env.NPM_SCRIPT_BINARY || 'script';
  return `${env} timeout ${timeoutSeconds} ${binary} -q -e -c ${JSON.stringify(command)} /dev/null`;
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
  const waitMs = Math.max(30_000, Math.round(waitMinutes * 60_000));
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  const version = npmVersion();
  const usePty = needsPty({
    npmVersion: version,
    hasPty: ptyAvailability(),
    ptyForced: String(process.env.NPM_FORCE_PTY || '').toLowerCase() === 'true',
  });
  process.stdout.write(`npm ${version || '(版本未知)'}｜${usePty ? 'PTY 回退模式' : '管道模式（无需额外包）'}\n`);

  /** Every URL already forwarded, so the same link is never sent twice. */
  const announced = new Set();
  const announce = async (url, phase, fallbackCode = '') => {
    if (!url || announced.has(url)) return false;
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
    try {
      await deliver(payload);
      process.stdout.write(`已把${phase === 'npm-login-required' ? '登录' : '二次验证'}网址转发到 webhook（${url}）\n`);
      return true;
    } catch (error) {
      process.stderr.write(`网址转发失败：${errorSummary(error)}\n`);
      announced.delete(url);
      return false;
    }
  };

  /**
   * Run npm, stream its output, and keep the tail for parsing.
   *
   * `onAuthUrl` fires as soon as an authorisation link appears in the stream:
   * `npm login` prints the link and then blocks while it polls, so waiting for
   * the process to exit before relaying would deadlock — the human cannot log in
   * without the link we have not sent yet.
   */
  const runNpm = (args, { timeoutMs = waitMs, onAuthUrl, phase = 'npm-2fa' } = {}) =>
    new Promise((resolveRun) => {
      const command = usePty ? npmCommand(args, { usePty, timeoutSeconds: Math.round(waitMs / 1000) }) : 'npm';
      const useShell = usePty;
      process.stdout.write(`运行：${useShell ? command : `npm ${args.join(' ')}`}\n`);
      const child = useShell
        ? spawn('sh', ['-c', command], {
            env: { ...process.env, BROWSER: 'true', npm_config_git_checks: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('npm', args, {
            env: { ...process.env, BROWSER: 'true', npm_config_git_checks: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      let captured = '';
      let announcedUrl = '';
      const timer = setTimeout(() => {
        process.stderr.write(`npm 运行超过 ${Math.round(timeoutMs / 1000)}s，终止\n`);
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      const handle = (chunk) => {
        process.stdout.write(chunk);
        captured = `${captured}${chunk}`.slice(-262_144);
        if (!onAuthUrl) return;
        // Only a URL that is known to be whole (a chunk boundary can split it).
        const url = findCompleteAuthUrl(captured);
        if (url && url !== announcedUrl) {
          announcedUrl = url;
          Promise.resolve(onAuthUrl(url, phase)).catch((error) => {
            process.stderr.write(`网址转发失败：${errorSummary(error)}\n`);
          });
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', handle);
      child.stderr.on('data', handle);
      child.on('error', (error) => {
        clearTimeout(timer);
        process.stderr.write(`无法启动 npm：${error.message}\n`);
        resolveRun({ code: 127, captured });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const finalText = cleanOutput(captured);
        if (onAuthUrl) {
          // The stream is over, so any URL left in the buffer is complete.
          const url = findAuthUrl(finalText);
          if (url && url !== announcedUrl) {
            announcedUrl = url;
            Promise.resolve(onAuthUrl(url, phase)).catch((error) => {
              process.stderr.write(`网址转发失败：${errorSummary(error)}\n`);
            });
          }
        }
        resolveRun({ code: code ?? 1, captured: finalText });
      });
    });

  const isAuthenticated = () => {
    const result = spawnSync('npm', ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return result.status === 0 && String(result.stdout || '').trim() !== '';
  };

  // --- 1. login, if needed. ------------------------------------------------
  if (!state.dryRun && !isAuthenticated()) {
    process.stdout.write('npm 未登录：发起网页登录\n');
    // npm prints the login link and then polls; relay it from the stream so the
    // human can actually act, instead of waiting for an exit that only happens
    // after they have already logged in.
    const login = await runNpm(['login', '--auth-type=web'], {
      timeoutMs: waitMs,
      phase: 'npm-login-required',
      onAuthUrl: (url) => announce(url, 'npm-login-required'),
    });
    const flow = extractAuthFlow(login.captured || '');
    const prose = parseNpmAuthOutput(login.captured || '');

    if (fellBackToPasswordPrompt(login.captured || '')) {
      process.stderr.write(
        'npm 退化为用户名/密码提示（会话失效或该 registry 不支持 web 登录），无法自动获取网址。\n' +
          '请检查 registry 是否支持网页登录，或改用 npm trusted publishing (OIDC)。\n',
      );
      process.exit(1);
    }

    const loginUrl = flow.authUrl || prose.url;
    if (loginUrl) {
      await announce(loginUrl, 'npm-login-required', flow.token ? '' : prose.code);
    } else {
      process.stderr.write('npm login 没有给出登录链接\n');
    }

    if (flow.doneUrl) {
      // The script polls npm's own completion endpoint, the runner the human uses.
      try {
        const { token, polls } = await pollDoneUrl(flow.doneUrl, {
          timeoutMs: waitMs,
          onWait: ({ poll, status }) => process.stdout.write(`等待浏览器确认…（第 ${poll} 次，HTTP ${status}）\n`),
        });
        process.stdout.write(`浏览器确认完成（轮询 ${polls} 次），已拿到登录凭据\n`);
        void token;
      } catch (error) {
        process.stderr.write(`登录确认失败：${error.message}\n`);
      }
    }

    if (!isAuthenticated()) {
      // No doneUrl (older npm) or the poll failed: watch the credentials instead.
      let waited = 0;
      while (waited < waitMs && !isAuthenticated()) {
        await sleep(3000);
        waited += 3000;
      }
    }
    process.stdout.write(isAuthenticated() ? 'npm 已登录，继续发布\n' : '仍未登录，继续尝试发布\n');
  }

  // --- 2. publish, authorising a second factor through doneUrl when needed. --
  const baseArgs = ['publish', '--access', 'public', '--tag', state.distTag, '--json'];
  if (state.dryRun) baseArgs.push('--dry-run');

  let attempt = await runNpm(baseArgs, { timeoutMs: waitMs });
  let usedOtp = '';

  if (attempt.code !== 0 && !state.dryRun) {
    const flow = extractAuthFlow(attempt.captured);
    const prose = parseNpmAuthOutput(attempt.captured);
    const authUrl = flow.authUrl || prose.url;

    if (authUrl) {
      await announce(authUrl, prose.kind || 'npm-2fa', flow.token || prose.code);
      if (flow.doneUrl) {
        try {
          const { token, polls } = await pollDoneUrl(flow.doneUrl, {
            timeoutMs: waitMs,
            onWait: ({ poll, status }) => process.stdout.write(`等待二次验证…（第 ${poll} 次，HTTP ${status}）\n`),
          });
          usedOtp = token;
          process.stdout.write(`二次验证完成（轮询 ${polls} 次），用 --otp 重试发布\n`);
        } catch (error) {
          process.stderr.write(`二次验证轮询失败：${error.message}\n`);
        }
      }
    }

    if (usedOtp || prose.code) {
      const retryArgs = [...baseArgs, '--otp', usedOtp || prose.code];
      attempt = await runNpm(retryArgs, { timeoutMs: waitMs });
    }
  }

  if (attempt.code !== 0) {
    process.stderr.write(`npm publish 以退出码 ${attempt.code} 结束\n`);
    if (!state.dryRun) {
      const tail = attempt.captured.slice(-4096);
      const parsedTail = extractAuthFlow(tail);
      const proseTail = parseNpmAuthOutput(tail);
      try {
        await deliver(
          buildPayload({
            phase: 'failed',
            core: state,
            reason: `npm publish 退出码 ${attempt.code}（认证可能未在 ${waitMinutes} 分钟内完成）`,
            auth: parsedTail.authUrl || proseTail.url ? { url: parsedTail.authUrl || proseTail.url } : undefined,
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
  void parseLastJsonObject;
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`发布异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
