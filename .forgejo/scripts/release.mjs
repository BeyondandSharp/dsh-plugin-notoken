import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { errorSummary, npmWebUrl } from './notify-lib.mjs';
import { isDirect } from './is-direct.mjs';

export const IS_DIRECT = isDirect(import.meta.url);

/** How many commits the release body may list. */
export const CHANGELOG_LIMIT = 50;

export function buildReleaseBody(core, changelog, env = process.env) {
  const npmUrl = npmWebUrl(env, core.package, core.version);
  return [
    `## ${core.package}@${core.version}`,
    '',
    `- dist-tag：\`${core.distTag}\``,
    npmUrl ? `- npm：${npmUrl}` : '',
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

  // A dry run publishes nothing, so it must not create a release either: a
  // rehearsal used to leave a real Forgejo release for a version that does not
  // exist on npm.
  if (state.dryRun) {
    process.stdout.write(`dry-run：跳过创建 Forgejo Release（${state.tag}）\n`);
    return;
  }

  // The token is attached to this step only, never to the job, so install/test/
  // build never see it; an unconfigured token simply skips the release.
  if (!process.env.FORGEJO_TOKEN) {
    process.stdout.write('未配置 FORGEJO_TOKEN，跳过创建 Forgejo Release（只发包）\n');
    return;
  }

  const apiUrl = (state.apiUrl || `${state.serverUrl}/api/v1`).replace(/\/$/, '');

  const previous = gitText(['describe', '--tags', '--abbrev=0', `${state.tag}^`]);
  const range = previous ? `${previous}..HEAD` : 'HEAD';
  // Bounded: a first release has no previous tag, and the whole history does not
  // belong in a release body.
  const changelog =
    gitText(['log', '--oneline', `-n${CHANGELOG_LIMIT}`, range]) || '(没有可列出的提交)';

  let response;
  try {
    response = await fetch(`${apiUrl}/repos/${state.repo}/releases`, {
      method: 'POST',
      headers: { authorization: `token ${process.env.FORGEJO_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: state.tag,
        name: `${state.package} ${state.version}`,
        body: buildReleaseBody(state, changelog),
        draft: false,
        prerelease: Boolean(state.prerelease),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    process.stderr.write(`创建 Release 请求失败：${errorSummary(error)}\n`);
    process.exit(1);
  }

  if (response.status === 200 || response.status === 201) {
    const created = await response.json().catch(() => ({}));
    process.stdout.write(`已创建 Forgejo Release：${created.html_url || state.tag}\n`);
  } else if (response.status === 409) {
    process.stdout.write(`Release ${state.tag} 已存在，跳过创建\n`);
  } else {
    process.stderr.write(`创建 Release 失败：HTTP ${response.status} ${await response.text()}\n`);
    process.exit(1);
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
