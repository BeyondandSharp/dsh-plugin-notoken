import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNotifyConfigured, errorSummary, semverGt } from './notify-lib.mjs';
import { BINARY as NPM } from './publisher.mjs';
import { isDirect } from './is-direct.mjs';

export const IS_DIRECT = isDirect(import.meta.url);

/**
 * Ask the registry what it already has. One call fetches both the version list
 * (does this version exist?) and the dist-tags (what is `latest`?).
 *
 * `notFound` distinguishes "this package does not exist yet" (a first release,
 * which is fine) from every other failure — a typo'd name, an unreachable
 * registry or an auth error must abort instead of silently publishing a brand
 * new package under the wrong name.
 */
export function npmView(name, run = spawnSync) {
  const result = run(NPM, ['view', name, 'versions', 'dist-tags', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '');
    return { ok: false, notFound: /\bE404\b|404 Not Found/i.test(stderr), stderr };
  }
  const text = String(result.stdout || '').trim();
  // npm exits 0 with nothing on stdout when the package exists but the requested
  // fields are empty — a third-party registry without a `latest` tag does this
  // (npm/cli#6408). That is not a failed lookup: the caller retries with the tag.
  if (text === '') return { ok: true, notFound: false, empty: true, value: normalizeView(undefined), stderr: '' };
  try {
    return { ok: true, notFound: false, empty: false, value: normalizeView(parseJsonOutput(text)), stderr: '' };
  } catch {
    return { ok: false, notFound: false, stderr: `无法解析 npm view 输出：${text.slice(0, 200)}` };
  }
}

/**
 * Parse piped JSON that npm may have mixed with human-readable lines.
 *
 * npm is not guaranteed to print *only* JSON: warnings and progress lines have
 * been observed alongside it, and a strict `JSON.parse` then throws on a lookup
 * that actually succeeded. The first JSON object (or array) in the text wins.
 */
export function parseJsonOutput(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(text);
    if (!match) throw new Error('no JSON in output');
    return JSON.parse(match[1]);
  }
}

/** What one dist-tag points at, or '' — the fallback for an empty `npm view`. */
export function npmViewTagVersion(name, tag, run = spawnSync) {
  const spec = tag ? `${name}@${tag}` : name;
  const result = run(NPM, ['view', spec, 'version', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  const text = String(result.stdout || '').trim();
  if (text === '') return '';
  try {
    const parsed = parseJsonOutput(text);
    const value = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Collapse whatever `npm view … --json` printed into `{versions, distTags, latest}`.
 *
 * The shape is not stable across npm versions and registries: npm 12 wraps the
 * result in an array (`[{"versions":[…],"dist-tags":{…}}]`), npm 10 prints the
 * bare object, and a whole packument (or an older registry response) may carry
 * `versions` as a `{version: manifest}` map. Missing any of these silently
 * defeated the idempotency gate — an already-published version looked new.
 */
export function normalizeView(value) {
  // `npm view <pkg> versions --json` prints a bare list of version strings.
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return { versions: value.slice(), distTags: {}, latest: '' };
  }
  const first = Array.isArray(value) ? value[0] : value;
  const record = first && typeof first === 'object' ? first : {};
  const rawVersions = record.versions ?? {};
  const versions = (Array.isArray(rawVersions) ? rawVersions : Object.keys(rawVersions)).filter(
    (item) => typeof item === 'string',
  );
  const distTags = record['dist-tags'] && typeof record['dist-tags'] === 'object' ? record['dist-tags'] : {};
  const latest = typeof distTags.latest === 'string' ? distTags.latest : '';
  return { versions, distTags, latest };
}

/** The published version list, or null when the lookup failed. */
export function publishedVersions(view) {
  if (!view?.ok) return null;
  return view.value.versions;
}

/**
 * The version `latest` points at, falling back to the highest non-prerelease
 * version when the registry reports no dist-tags. Never the last array element:
 * the registry does not promise to hand versions back in ascending order.
 */
export function latestVersion(view, versions = publishedVersions(view) || []) {
  const tag = view?.value?.latest;
  if (typeof tag === 'string' && tag) return tag;
  const stable = versions.filter((value) => !String(value).includes('-'));
  const candidates = stable.length > 0 ? stable : versions;
  return candidates.reduce((best, value) => (best && semverGt(best, value) ? best : value), '');
}

/**
 * Resolve the commit a local tag points at. `rev-parse refs/tags/X` yields the
 * annotated tag object itself, so peel with `^{commit}` and fall back to the
 * raw object name for lightweight tags when peeling is unavailable.
 */
export function resolveTagCommit(tag, run = spawnSync) {
  if (!tag) return '';
  const peeled = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
  if (peeled.status === 0 && peeled.stdout.trim()) return peeled.stdout.trim();
  const raw = run('git', ['rev-parse', `refs/tags/${tag}`], { encoding: 'utf8' });
  return raw.status === 0 ? raw.stdout.trim() : '';
}

/** The commit the working tree was checked out at. */
export function headCommit(run = spawnSync) {
  const result = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Every local tag name that could name this version ("1.4.0" and "v1.4.0"). */
export function tagCandidates(version, tag = '') {
  const names = [tag, version, `v${version}`].filter(Boolean);
  return [...new Set(names)];
}

/**
 * Best-effort fetch of one tag from origin, used only when the checkout did not
 * bring refs/tags. Failure is not fatal: the release identity comes from the
 * event, and this helper exists to catch a tag that was moved.
 */
export function fetchTagFromOrigin(tag, run = spawnSync) {
  if (!tag) return false;
  const remote = run('git', ['remote'], { encoding: 'utf8' });
  if (remote.status !== 0 || !String(remote.stdout || '').trim()) return false;
  const name = String(remote.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];
  const result = run('git', ['fetch', '--tags', '--force', name, `refs/tags/${tag}:refs/tags/${tag}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

async function main() {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const corePath = join(temp, 'release.json');
  const core = JSON.parse(readFileSync(corePath, 'utf8'));

  // A notification destination is only needed when a release can actually get
  // far enough to ask for authorisation; dry runs never notify.
  const fail = (reason) => {
    process.stderr.write(`${reason}\n`);
    process.exit(1);
  };

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (pkg.private === true) fail('package.json 标记为 private: true，不允许发布');
  if (!pkg.name) fail('package.json 缺少 name');
  if (pkg.version !== core.version) {
    process.stdout.write(`提示：package.json 版本 ${pkg.version} 与 tag 版本 ${core.version} 不一致，prepare 步骤会对齐（不提交）\n`);
  }

  if (core.dryRun) {
    process.stdout.write('dry-run：跳过通知地址校验（dry-run 不投递通知）\n');
  } else {
    try {
      assertNotifyConfigured(process.env);
    } catch (error) {
      fail(error.message);
    }
  }

  // Tag verification is best effort for a tag-triggered run: the checkout
  // frequently has no refs/tags/<tag>, so a missing tag must not block the
  // release. A manual dispatch is different — it must name an existing tag, or
  // the run would publish something the tag does not describe.
  const state = { ...core, name: pkg.name };
  let tag = '';
  for (const candidate of tagCandidates(core.version, core.tag)) {
    if (resolveTagCommit(candidate)) {
      tag = candidate;
      break;
    }
  }
  if (!tag && core.tag && fetchTagFromOrigin(core.tag)) {
    process.stdout.write(`已从远端取回 tag ${core.tag} 用于校验\n`);
    if (resolveTagCommit(core.tag)) tag = core.tag;
  }
  if (tag) {
    state.tag = tag;
  } else if (core.dispatch) {
    fail(`手工发布必须指向一个已存在的 tag：找不到 ${tagCandidates(core.version, core.tag).join(' / ')}`);
  } else {
    process.stdout.write(
      `提示：本地没有 refs/tags/${core.tag}（checkout 未取 tags），跳过"tag 未移动"校验；` +
        `发布标识以本次运行的 ${core.sha} 为准\n`,
    );
  }

  if (tag) {
    const tagSha = resolveTagCommit(tag);
    // Compare with HEAD rather than GITHUB_SHA: for an annotated tag the event's
    // SHA can be the tag object itself, which would look like a moved tag.
    const runSha = headCommit() || core.sha;
    if (tagSha && runSha && tagSha !== runSha) {
      fail(
        `tag ${tag} 指向 ${tagSha}，与当前 checkout 的 ${runSha} 不一致` +
          `（tag 可能已被移动；手工发布请在 tag 对应的 ref 上触发）`,
      );
    }
  }

  const noOpAlreadyPublished = () => {
    // Idempotent no-op: the version is already live, so this is a success and
    // deliberately silent — re-triggering a tag must not spam the chat. The
    // workflow gates the remaining release steps on this output.
    process.stdout.write(`registry 上已存在 ${pkg.name}@${core.version}，本次为空操作\n`);
    writeFileSync(corePath, JSON.stringify(state, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `already_published=true\nname=${pkg.name}\n`);
    }
    process.exit(0);
  };

  const view = npmView(pkg.name);
  if (!view.ok && view.notFound) {
    process.stdout.write(`registry 上查不到 ${pkg.name}，按首次发布处理\n`);
  } else if (!view.ok) {
    fail(`查询 registry 失败，无法确认 ${pkg.name}@${core.version} 是否已发布：${view.stderr || '未知错误'}`);
  } else if (view.empty) {
    // The registry answered, but with nothing useful. Asking the configured tag
    // directly still catches the idempotent case; without it there is no reliable
    // "latest" to compare against, so the release continues as a first publish
    // and the publish itself stays the final guard.
    const tagged = npmViewTagVersion(pkg.name, core.distTag);
    if (tagged && tagged === core.version) noOpAlreadyPublished();
    process.stdout.write(
      `registry 对 ${pkg.name} 返回空结果${tagged ? `（${core.distTag} 指向 ${tagged}）` : ''}；无法核对版本高低，按首次发布继续\n`,
    );
  } else {
    const versions = publishedVersions(view) || [];
    if (versions.includes(core.version)) noOpAlreadyPublished();
    const latest = latestVersion(view, versions);
    if (latest && !semverGt(core.version, latest)) {
      fail(`版本必须严格大于 registry 上的 latest：${core.version} 不大于 ${latest}`);
    }
    if (latest) process.stdout.write(`registry latest ${latest} → 本次 ${core.version}\n`);
  }

  writeFileSync(corePath, JSON.stringify(state, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `already_published=false\nname=${pkg.name}\n`);
  }
  process.stdout.write(`预检通过：${pkg.name}@${core.version}（dist-tag=${core.distTag}）\n`);
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`预检异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
