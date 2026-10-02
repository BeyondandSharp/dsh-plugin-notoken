import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPayload, deliver, errorSummary, isAuthUrl } from './notify-lib.mjs';

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

export function firstTarballFromPack(stdout) {
  const parsed = JSON.parse(stdout);
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;
  return { filename: manifest?.filename || '', size: Number(manifest?.size || 0) };
}

export function sha256Of(file, run = spawnSync) {
  if (!file) return '';
  const digest = run('sha256sum', [file], { encoding: 'utf8' });
  return digest.status === 0 ? digest.stdout.trim().split(/\s+/)[0] || '' : '';
}

async function main() {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const corePath = join(temp, 'release.json');
  const core = JSON.parse(readFileSync(corePath, 'utf8'));

  const versioned = spawnSync('npm', ['version', core.version, '--no-git-tag-version', '--allow-same-version'], {
      encoding: 'utf8',
      env: { ...process.env, npm_config_git_checks: 'false' },
  });
  if (versioned.status !== 0) {
    process.stderr.write(`npm version 失败：\n${versioned.stderr || versioned.stdout}\n`);
    process.exit(1);
  }

  const packed = spawnSync('npm', ['pack', '--json'], { encoding: 'utf8' });
  if (packed.status !== 0) {
    process.stderr.write(`npm pack 失败：\n${packed.stderr || packed.stdout}\n`);
    process.exit(1);
  }

  let tarball;
  try {
    tarball = firstTarballFromPack(packed.stdout);
  } catch (error) {
    process.stderr.write(`无法解析 npm pack 输出：${error.message}\n`);
    process.exit(1);
  }
  const sha256 = sha256Of(tarball.filename);

  const state = { ...core, tarball: tarball.filename, tarball_bytes: tarball.size, tarball_sha256: sha256 };
  writeFileSync(corePath, JSON.stringify(state, null, 2));
  process.stdout.write(`打包完成：${tarball.filename}（${tarball.size} bytes${sha256 ? `，sha256=${sha256}` : ''}）\n`);

  if (!core.dryRun) {
    try {
      await deliver(buildPayload({ phase: 'publishing', core: state }));
    } catch (error) {
      process.stderr.write(`发布前通知投递失败：${errorSummary(error)}\n`);
      if (String(process.env.NOTIFY_REQUIRED || 'true').toLowerCase() !== 'false') process.exit(1);
    }
  }
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`打包异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
