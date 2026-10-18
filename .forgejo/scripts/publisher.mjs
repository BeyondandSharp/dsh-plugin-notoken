// publisher.mjs — the CLI that logs in and publishes: npm, and only npm.
//
// npm drives the whole token-free flow itself, as long as it has a terminal:
//
//   * `npm login --auth-type=web` POSTs `/-/v1/login`, prints the returned
//     `loginUrl`, polls `doneUrl` until the browser flow finishes and stores the
//     resulting token in `~/.npmrc`;
//   * a write that needs a second factor fails with `EOTP` whose body carries
//     `authUrl`/`doneUrl`; npm's own `otplease` then prints the `authUrl`, polls
//     `doneUrl` and retries the publish with the one-time token it got back.
//
// Both branches live behind `process.stdin.isTTY && process.stdout.isTTY` in
// npm's lib/utils/auth.js, so every call runs under `script(1)` (see pty.mjs).
// The script never has to poll `doneUrl` or pass `--otp` for the web flow —
// npm does that; `--otp` remains for registries that only accept a typed code.
//
// The first npm that exposes `authUrl`/`doneUrl` in the EOTP body is 10.9.x,
// which is also what node:22-bookworm ships. Older npm cannot complete a
// second factor headlessly, so the version is checked before publishing.

import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const BINARY = 'npm';

/** The lowest npm whose EOTP body carries authUrl/doneUrl (10.9.x). */
export const MIN_VERSION = [10, 9, 0];
export const MIN_VERSION_TEXT = MIN_VERSION.join('.');

/** Parse "10.9.2" (tolerating a leading v or surrounding noise). */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Is `version` at least `floor`? Unknown versions fail open (we try anyway). */
export function versionAtLeast(version, floor = MIN_VERSION) {
  const found = Array.isArray(version) ? version : parseVersion(version);
  if (!found) return true;
  for (let index = 0; index < floor.length; index += 1) {
    const a = found[index] ?? 0;
    const b = floor[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/** '' when this npm can expose the URLs, otherwise the reason it cannot. */
export function unsupportedReason(version) {
  if (versionAtLeast(version)) return '';
  return `npm ${String(version || '').trim() || '(版本未知)'} 低于 ${MIN_VERSION_TEXT}：该版本不会把授权链接交给脚本，无法完成网页登录/二次验证。`;
}

/**
 * Is `name` an executable on PATH?
 *
 * Checked against the filesystem rather than `sh -c 'command -v …'`: a minimal
 * image may not even have sh(1) on PATH, and that must not read as "npm is
 * missing". Symlinks are followed by statSync, which is how the node images
 * ship /usr/local/bin/npm.
 */
export function binaryOnPath(name, env = process.env, { stat = statSync } = {}) {
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  return dirs.some((dir) => {
    try {
      const info = stat(`${dir.replace(/\/+$/, '')}/${name}`);
      return info.isFile() && (info.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

/**
 * The installed npm version, or '' when it cannot be determined.
 *
 * Runs `npm --version`; a banner before the number is tolerated.
 */
export function npmVersion(run = spawnSync, env = process.env) {
  const result = run(BINARY, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  if (result.status !== 0) return '';
  const match = /(\d+\.\d+\.\d+)/.exec(String(result.stdout || ''));
  return match ? match[1] : String(result.stdout || '').trim();
}

/**
 * The publish arguments.
 *
 * With a tarball, npm uploads that file and — unlike a directory publish — does
 * not run the project's `prepublishOnly`. That is what the release wants: the
 * tarball is the artifact Prepare already packed and hashed, and the Test/Build
 * steps already ran, so `prepublishOnly` would only repeat them (and may need
 * tooling this image does not have, e.g. a package manager with no lockfile to
 * detect). npm has no dirty-worktree check, so no extra flag either.
 */
export function publishArgs({ distTag = 'latest', access = 'public', dryRun = false, otp = '', tarball = '' } = {}) {
  const args = tarball ? ['publish', tarball] : ['publish'];
  args.push('--access', access, '--tag', distTag);
  if (dryRun) {
    // npm >= 11 runs a package-existence check before publishing that stalls a
    // rehearsal (measured on npm 12.2.0: `publish --dry-run` hangs with no output
    // and no registry traffic, for a directory and a tarball alike, while
    // `--dry-run --force` finishes in milliseconds). `--force` does not override
    // `--dry-run`, so this still cannot write to the registry; the check is
    // redundant here anyway because Preflight already compared the versions.
    args.push('--dry-run', '--force');
  }
  if (otp) args.push('--otp', otp);
  return args;
}

/** The login arguments. `--auth-type=web` is the token-free browser flow. */
export function loginArgs({ registry = '' } = {}) {
  const args = ['login', '--auth-type=web'];
  if (registry) args.push('--registry', registry);
  return args;
}

/** Arguments that report the authenticated identity. */
export function whoamiArgs() {
  return ['whoami'];
}

/** `--otp <code>` is a credential: never let it reach a log line. */
export function redactArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--otp') {
      out.push('--otp', '***');
      index += 1;
      continue;
    }
    out.push(typeof arg === 'string' && arg.startsWith('--otp=') ? '--otp=***' : arg);
  }
  return out;
}

/** `npm <args>` as a shell command, for logging (OTP masked). */
export function npmCommand(args) {
  return `${BINARY} ${redactArgs(args).join(' ')}`;
}

/** Where npm keeps the token it writes on login. */
export const NPM_AUTH_NOTE =
  'npm 把登录凭据写入 ~/.npmrc（userconfig）；本流程的登录与发布都用 npm，二者一致。';
