import { appendFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOptional } from './notify-lib.mjs';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
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

export function stripTagPrefix(tag) {
  let value = String(tag || '').trim();
  if (value.startsWith('refs/tags/')) value = value.slice('refs/tags/'.length);
  if (value.startsWith('v')) value = value.slice(1);
  return value;
}

export function tagVersionFromRef(ref) {
  const match = /^refs\/tags\/(.+)$/.exec(ref || '');
  return match ? match[1] : '';
}

/**
* Derive the release identity from the environment. Throws when the tag cannot
* be parsed or when a hand-typed version disagrees with the tag that triggered
* the run, so a mistyped manual dispatch can never publish the wrong version.
*/
export function resolveRelease(env = process.env) {
  const inputVersion = readOptional(env.INPUT_VERSION);
  const refName = readOptional(env.GITHUB_REF_NAME);
  const rawTag = inputVersion || refName || tagVersionFromRef(readOptional(env.GITHUB_REF));
  const version = stripTagPrefix(rawTag);
  if (!SEMVER.test(version)) throw new Error(`无法从 tag 解析出合法版本号：${rawTag || '<empty>'}`);
  if (inputVersion && stripTagPrefix(inputVersion) !== stripTagPrefix(refName)) {
    throw new Error(
      `手工输入的版本（${inputVersion}）与触发 ref（${refName || '<none>'}）不一致，已中止以避免误发`,
    );
  }

  const prerelease = version.includes('-');
  const repo = env.GITHUB_REPOSITORY || '';
  const serverUrl = env.GITHUB_SERVER_URL || '';
  const runNumber = env.GITHUB_RUN_NUMBER || '';
  const distTag = readOptional(env.INPUT_DIST_TAG) || readOptional(env.RELEASE_DIST_TAG);
  return {
    version,
    tag: rawTag,
    prerelease,
    distTag: distTag || (prerelease ? 'next' : 'latest'),
    dryRun: readOptional(env.INPUT_DRY_RUN).toLowerCase() === 'true',
    repo,
    title: repo.split('/').pop() || repo || 'unknown',
    runUrl: `${serverUrl}/${repo}/actions/runs/${runNumber}`,
    runNumber,
    runAttempt: env.GITHUB_RUN_ATTEMPT || '',
    eventName: env.GITHUB_EVENT_NAME || '',
    sha: env.GITHUB_SHA || '',
    serverUrl,
    apiUrl: env.GITHUB_API_URL || `${serverUrl}/api/v1`,
    refName: env.GITHUB_REF_NAME || '',
  };
}

if (IS_DIRECT) {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const state = resolveRelease();
  writeFileSync(join(temp, 'release.json'), JSON.stringify(state, null, 2));

  const emit = (key, value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    process.stdout.write(`${key}=${value}\n`);
  };
  emit('version', state.version);
  emit('dist_tag', state.distTag);
  emit('prerelease', String(state.prerelease));
  emit('dry_run', String(state.dryRun));
  emit('title', state.title);
  emit('run_url', state.runUrl);
  process.stdout.write(
    `tag=${state.tag} version=${state.version} dist-tag=${state.distTag} prerelease=${state.prerelease} dry-run=${state.dryRun}\n`,
  );
  process.stdout.write(`event=${state.eventName} run=${state.runNumber} attempt=${state.runAttempt} sha=${state.sha}\n`);
}
