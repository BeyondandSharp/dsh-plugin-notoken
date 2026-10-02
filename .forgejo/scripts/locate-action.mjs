// locate-action.mjs — find the copied Action directory.
//
// The Action is used by copying npm-publish/ into a repository as .forgejo, so
// the directory that holds the programs has to be discovered at run time:
//   * github.action_path is empty here (it is only set when a `uses: ./path`
//     local action runs, and this is a workflow, not an action);
//   * .forgejo normally sits at the repository root, but a checkout with
//     `path:` nests it, and an older runner may have mounted the repository next
//     to the workspace instead of inside it.
//
// This program writes `forgejo_dir=<dir>` to $GITHUB_OUTPUT so every later step
// can call `node "$dir/scripts/…"`, and prints a full diagnostic when nothing
// matches.

import { appendFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The workflow invokes this with `node "$dir/scripts/run.mjs" locate-action`. */
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

/** A directory is the Action when the workflow and the programs are both there. */
export function isActionDir(dir) {
  if (!dir) return false;
  return existsSync(join(dir, 'workflows')) && existsSync(join(dir, 'scripts', 'publish.mjs'));
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/** Breadth-first search for an `.forgejo` directory under `root`. */
export function findForgejoDirs(root, maxDepth = 6) {
  const found = [];
  let level = [root];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        if (entry.name === '.forgejo') found.push(child);
        else next.push(child);
      }
    }
    level = next;
  }
  return found;
}

/** Candidate directories in priority order, de-duplicated. */
export function locateCandidates(env = process.env) {
  const workspace = stripTrailingSlash(resolve(env.GITHUB_WORKSPACE || env.PWD || process.cwd()));
  const explicit = (env.GITHUB_ACTION_PATH || '').trim();
  const seen = new Set();
  const candidates = [];
  const push = (dir) => {
    if (!dir) return;
    const clean = stripTrailingSlash(resolve(dir));
    if (seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  // 0. An explicit hint always wins (local-action runs set github.action_path).
  push(explicit);
  // 1. The documented layout: .forgejo copied to the repository root.
  push(join(workspace, '.forgejo'));
  // 2. Nested or renamed directories.
  for (const found of findForgejoDirs(workspace)) push(found);
  // 3. Older runners mounted the repository next to the workspace.
  let walk = dirname(workspace);
  for (let steps = 0; steps < 3; steps += 1) {
    if (!walk || walk === sep || dirname(walk) === walk) break;
    push(join(walk, '.forgejo'));
    walk = dirname(walk);
  }
  return { workspace, candidates };
}

/** The first candidate that actually looks like the Action. */
export function locateActionDir(env = process.env) {
  const { workspace, candidates } = locateCandidates(env);
  const found = candidates.find((dir) => isActionDir(dir));
  return { dir: found || '', workspace, candidates };
}

function listDir(dir, prefix = '') {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const flavour = entry.isDirectory() ? '/' : '';
      process.stderr.write(`${prefix}${entry.name}${flavour}\n`);
    }
  } catch {
    process.stderr.write(`${prefix}(unreadable: ${dir})\n`);
  }
}

async function main() {
  const env = process.env;
  const { dir, workspace, candidates } = locateActionDir(env);
  if (!dir) {
    process.stderr.write('找不到 Action 目录（需要同时存在 workflows/ 与 scripts/publish.mjs）\n');
    process.stderr.write(`GITHUB_ACTION_PATH=${env.GITHUB_ACTION_PATH || ''}\n`);
    process.stderr.write(`GITHUB_WORKSPACE=${workspace}\n`);
    process.stderr.write('--- 尝试过的候选目录 ---\n');
    for (const candidate of candidates) {
      process.stderr.write(`  ${candidate}${isActionDir(candidate) ? ' [ok]' : ''}\n`);
    }
    process.stderr.write('--- 工作区内容 ---\n');
    listDir(workspace, '  ');
    process.stderr.write('--- 工作区上级目录 ---\n');
    listDir(dirname(workspace), '  ');
    process.exit(1);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `forgejo_dir=${dir}\n`);
  }
  process.stdout.write(`Action 目录：${dir}\n`);
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`定位 Action 目录失败：${error.message}\n`);
    process.exit(1);
  }
}
