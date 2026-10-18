import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BINARY as NPM } from './publisher.mjs';
import { errorSummary } from './notify-lib.mjs';
import { isDirect } from './is-direct.mjs';

export const IS_DIRECT = isDirect(import.meta.url);

/**
 * Build outputs that must exist before anything is packed. The list is opt-in:
 * there is deliberately no built-in default, because a template cannot know
 * another repository's output paths and a wrong default would fail every release
 * that does not match it. `REQUIRED_ARTIFACTS` unset or empty disables the check.
 */
export function parseRequiredArtifacts(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function missingArtifacts(required, exists = existsSync) {
  return required.filter((item) => !exists(item));
}

/**
 * The tarball named by `pack --json`.
 *
 * npm has printed this in three shapes over the years: an array of manifests
 * (npm < 11), an object keyed by package name (npm >= 11, and by far the easiest
 * to mistake for a single manifest), and a bare manifest. All three are accepted;
 * `size` is usually present, and the file on disk is measured when it is not.
 */
export function firstTarballFromPack(stdout, { stat = statSync } = {}) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? parsed.filename
        ? [parsed]
        : Object.values(parsed)
      : [];
  const manifest = entries.find((entry) => entry && typeof entry === 'object' && entry.filename) || {};
  const filename = manifest.filename || '';
  let size = Number(manifest.size || 0);
  if (!size && filename) {
    try {
      size = stat(filename).size;
    } catch {
      size = 0;
    }
  }
  return { filename, size };
}

/** Streaming-free sha256 of a small tarball, with no external command needed. */
export function sha256Of(file, { read = readFileSync } = {}) {
  if (!file) return '';
  try {
    return createHash('sha256').update(read(file)).digest('hex');
  } catch {
    return '';
  }
}

export function main(temp = process.env.RUNNER_TEMP || '/tmp') {
  const corePath = join(temp, 'release.json');
  const core = JSON.parse(readFileSync(corePath, 'utf8'));

  // The artifact check belongs after Build and before pack: it must see what the
  // build produced, not what happened to be committed.
  const missing = missingArtifacts(parseRequiredArtifacts(process.env.REQUIRED_ARTIFACTS));
  if (missing.length > 0) {
    process.stderr.write(`构建产物缺失：${missing.join(', ')}（检查 REQUIRED_ARTIFACTS 或该项目的产物路径）\n`);
    return 1;
  }

  const versioned = spawnSync(
    NPM,
    ['version', core.version, '--no-git-tag-version', '--allow-same-version'],
    { encoding: 'utf8' },
  );
  if (versioned.status !== 0) {
    process.stderr.write(`${NPM} version 失败：\n${versioned.stderr || versioned.stdout}\n`);
    return 1;
  }

  const packed = spawnSync(NPM, ['pack', '--json'], { encoding: 'utf8' });
  if (packed.status !== 0) {
    process.stderr.write(`${NPM} pack 失败：\n${packed.stderr || packed.stdout}\n`);
    return 1;
  }

  let tarball;
  try {
    tarball = firstTarballFromPack(packed.stdout);
  } catch (error) {
    process.stderr.write(`无法解析 ${NPM} pack 输出：${error.message}\n`);
    return 1;
  }
  const sha256 = sha256Of(tarball.filename);

  const state = { ...core, tarball: tarball.filename, tarball_bytes: tarball.size, tarball_sha256: sha256 };
  writeFileSync(corePath, JSON.stringify(state, null, 2));
  process.stdout.write(`打包完成：${tarball.filename}（${tarball.size} bytes${sha256 ? `，sha256=${sha256}` : ''}）\n`);
  return 0;
}

if (IS_DIRECT) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`打包异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
