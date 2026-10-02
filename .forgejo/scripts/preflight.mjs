import { appendFileSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNotifyConfigured, buildPayload, deliver, semverGt, errorSummary, readOptional } from './notify-lib.mjs';

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

export function missingArtifacts(required, exists = existsSync) {
  return required.filter((item) => !exists(item));
}

export function parseRequiredArtifacts(raw) {
  return String(raw ?? 'lib/index.js,lib/client.js,cordis.patch.yml')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
}

export function npmViewJson(spec, run = spawnSync) {
  const result = run('npm', ['view', spec, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) return { ok: false, value: null, stderr: result.stderr || '' };
  try {
    return { ok: true, value: JSON.parse(result.stdout), stderr: '' };
  } catch {
    return { ok: true, value: result.stdout.trim(), stderr: '' };
  }
}

export function publishedVersions(view) {
  if (!view.ok) return null;
  return (Array.isArray(view.value) ? view.value : [view.value]).filter((item) => typeof item === 'string');
}

/**
* Resolve the commit a local tag points at. `rev-parse refs/tags/X` yields the
* annotated tag object itself, so peel with `^{commit}` and fall back to the
* raw object name for lightweight tags when peeling is unavailable.
*/
export function resolveTagCommit(tag, run = spawnSync) {
  const peeled = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
  if (peeled.status === 0 && peeled.stdout.trim()) return peeled.stdout.trim();
  const raw = run('git', ['rev-parse', `refs/tags/${tag}`], { encoding: 'utf8' });
  return raw.status === 0 ? raw.stdout.trim() : '';
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

  const fail = async (reason) => {
    process.stderr.write(`${reason}\n`);
    if (!core.dryRun) {
      try {
        await deliver(buildPayload({ phase: 'failed', core, reason }));
      } catch (error) {
        process.stderr.write(`失败通知也未投递成功：${errorSummary(error)}\n`);
      }
    }
    process.exit(1);
  };

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (pkg.private === true) await fail('package.json 标记为 private: true，不允许发布');
  if (!pkg.name) await fail('package.json 缺少 name');
  if (pkg.version !== core.version) {
    process.stdout.write(`提示：package.json 版本 ${pkg.version} 与 tag 版本 ${core.version} 不一致，prepare 步骤会对齐（不提交）\n`);
  }

  const missing = missingArtifacts(parseRequiredArtifacts(readOptional(process.env.REQUIRED_ARTIFACTS)));
  if (missing.length > 0) await fail(`构建产物缺失：${missing.join(', ')}`);

  // Tag verification is best effort: a tag-triggered checkout frequently has no
  // refs/tags/<tag> (detached commit, clone without --tags), so a missing tag
  // must not block the release. When the tag is visible it is still compared with
  // the run's commit, which catches a tag moved after the trigger.
  if (!resolveTagCommit(core.tag)) {
    if (fetchTagFromOrigin(core.tag)) {
      process.stdout.write(`已从远端取回 tag ${core.tag} 用于校验\n`);
    } else {
      process.stdout.write(
        `提示：本地没有 refs/tags/${core.tag}（checkout 未取 tags），跳过"tag 未移动"校验；` +
          `发布标识以本次运行的 ${core.sha} 为准\n`,
      );
    }
  }
  const tagSha = resolveTagCommit(core.tag);
  if (tagSha && core.sha && tagSha !== core.sha) {
    await fail(`tag ${core.tag} 指向 ${tagSha}，与本次运行的 ${core.sha} 不一致（tag 可能已被移动）`);
  }

  // Notification is the only path by which a human can finish an npm
  // second-factor challenge, so a missing destination is a hard error rather
  // than a silent skip.
  try {
    assertNotifyConfigured(process.env);
  } catch (error) {
    await fail(error.message);
  }

  const state = { ...core, name: pkg.name };
  const versions = publishedVersions(npmViewJson(`${pkg.name} versions`));
  if (versions === null) {
    process.stdout.write(`registry 上查不到 ${pkg.name}，按首次发布处理\n`);
  } else {
    if (versions.includes(core.version)) {
      // Idempotent no-op: the version is already live, so this is a success and
      // deliberately silent — re-triggering a tag must not spam the chat.
      process.stdout.write(`registry 上已存在 ${pkg.name}@${core.version}，本次为空操作\n`);
      process.exit(0);
    }
    const latest = versions[versions.length - 1];
    if (latest && !semverGt(core.version, latest)) {
      await fail(`版本必须严格大于 registry 上最新版：${core.version} 不大于 ${latest}`);
    }
    if (latest) process.stdout.write(`registry 最新版 ${latest} → 本次 ${core.version}\n`);
  }

  writeFileSync(corePath, JSON.stringify(state, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `name=${pkg.name}\n`);
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
