import { readFileSync, realpathSync } from 'node:fs';
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

export function buildReleaseBody(core, changelog) {
  return [
    `## ${core.package}@${core.version}`,
    '',
    `- dist-tag：\`${core.distTag}\``,
    `- npm：https://www.npmjs.com/package/${core.package}/v/${core.version}`,
    core.tarball ? `- tarball：\`${core.tarball}\`` : '',
    core.tarball_sha256 ? `- sha256：\`${core.tarball_sha256}\`` : '',
    '',
    '### Commits',
    '```',
    changelog,
    '```',
    '',
  ]
  .filter((line) => line !== '')
  .join('\n');
}

export function gitText(args, run = spawnSync) {
  const result = run('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function main() {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const core = JSON.parse(readFileSync(join(temp, 'release.json'), 'utf8'));
  const state = { ...core, package: core.name || '' };
  const apiUrl = (state.apiUrl || `${state.serverUrl}/api/v1`).replace(/\/$/, '');

  const previous = gitText(['describe', '--tags', '--abbrev=0', `${state.tag}^`]);
  const changelog = gitText(['log', '--oneline', previous ? `${previous}..HEAD` : 'HEAD']) || '(没有可列出的提交)';

  const response = await fetch(`${apiUrl}/repos/${state.repo}/releases`, {
      method: 'POST',
      headers: { authorization: `token ${process.env.FORGEJO_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
          tag_name: state.tag,
          name: `${state.package} ${state.version}`,
          body: buildReleaseBody(state, changelog),
          draft: false,
          prerelease: Boolean(state.prerelease),
      }),
  });

  if (response.status === 200 || response.status === 201) {
    const created = await response.json().catch(() => ({}));
    process.stdout.write(`已创建 Forgejo Release：${created.html_url || state.tag}\n`);
  } else if (response.status === 409) {
    process.stdout.write(`Release ${state.tag} 已存在，跳过创建\n`);
  } else {
    process.stderr.write(`创建 Release 失败：HTTP ${response.status} ${await response.text()}\n`);
    process.exit(1);
  }

  if (!state.dryRun) {
    try {
      await deliver(buildPayload({ phase: 'published', core: state }));
    } catch (error) {
      process.stderr.write(`完成通知投递失败：${errorSummary(error)}\n`);
      if (String(process.env.NOTIFY_REQUIRED || 'true').toLowerCase() !== 'false') process.exit(1);
    }
  }
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`创建 Release 异常：${errorSummary(error)}\n`);
    process.exit(1);
  }
}
