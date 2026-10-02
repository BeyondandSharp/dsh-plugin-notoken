// run.mjs — the single entry point the workflow invokes.
//
// Every workflow step is one line:
//     run: |
//       dir="${FORGEJO_DIR:-…}"; node "$dir/scripts/run.mjs" <subcommand>
// so the YAML contains orchestration only, and all behaviour (including the
// shell-level work) lives in real, testable files.
//
// Subcommands:
//   locate-action      find the copied Action directory, emit forgejo_dir
//   verify-action      assert every shipped program is present
//   install-deps       install dependencies with the lockfile's package manager
//   resolve            derive version/dist-tag/run info from the tag
//   preflight          version and artifact checks
//   test / build       run the project's own scripts
//   prepare            align package.json, pack, hash
//   publish            npm web login -> second factor -> publish
//   release            create the Forgejo release
//   notify-failure     report a failure (only when there is a link to send)

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

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

/** Programs that are executed as their own process (they own process.exit). */
const PROGRAMS = {
  'locate-action': 'locate-action.mjs',
  resolve: 'resolve.mjs',
  preflight: 'preflight.mjs',
  prepare: 'prepare.mjs',
  publish: 'publish.mjs',
  release: 'release.mjs',
  'notify-failure': 'notify-failure.mjs',
};

/** Everything the Action ships; verify-action insists on all of it. */
export const REQUIRED_SCRIPTS = [
  'notify-lib.mjs',
  'verification-parse.mjs',
  'locate-action.mjs',
  'run.mjs',
  'resolve.mjs',
  'preflight.mjs',
  'prepare.mjs',
  'publish.mjs',
  'release.mjs',
  'notify-failure.mjs',
];

export const SUBCOMMANDS = [
  'locate-action',
  'verify-action',
  'install-deps',
  'resolve',
  'preflight',
  'test',
  'build',
  'prepare',
  'publish',
  'release',
  'notify-failure',
];

/** The working directory holding package.json (PKG_TARGET_DIR for monorepos). */
export function packageDir(env = process.env) {
  const workspace = (env.GITHUB_WORKSPACE || process.cwd()).replace(/\/+$/, '');
  const target = (env.PKG_TARGET_DIR || '').replace(/^\/+|\/+$/g, '');
  return target ? join(workspace, target) : workspace;
}

function readPackageJson(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(`package.json 解析失败：${error.message}\n`);
    return null;
  }
}

/** Pick the package manager from the lockfile that is present. */
export function packageManagerFor(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  return 'npm';
}

/** Run a command in `cwd`, streaming output; resolves with its exit code. */
export function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (error) => {
      process.stderr.write(`无法启动 ${command}：${error.message}\n`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runSubprocessProgram(name, env) {
  const program = PROGRAMS[name];
  const path = join(HERE, program);
  if (!existsSync(path)) {
    process.stderr.write(`缺少程序：${path}\n`);
    return 1;
  }
  return runCommand(process.execPath, [path], { cwd: packageDir(env), env });
}

async function verifyAction(env) {
  const dir = (env.GITHUB_ACTION_PATH || HERE.replace(/\/scripts$/, '')).replace(/\/+$/, '');
  const missing = REQUIRED_SCRIPTS.filter((name) => !existsSync(join(dir, 'scripts', name)));
  if (missing.length > 0) {
    for (const name of missing) process.stderr.write(`缺少 ${dir}/scripts/${name}\n`);
    process.stderr.write(
      `Action 目录不完整：请整目录复制 npm-publish/（workflows/ 与 scripts/ 都要）后改名为 .forgejo\n`,
    );
    return 1;
  }
  process.stdout.write(`Action 脚本齐全：${dir}/scripts（${REQUIRED_SCRIPTS.length} 个文件）\n`);
  return 0;
}

async function installDeps(env) {
  const dir = packageDir(env);
  const pkg = readPackageJson(dir);
  if (!pkg) {
    process.stderr.write(`缺少 package.json：${dir}（monorepo 请设置变量 PKG_TARGET_DIR）\n`);
    return 1;
  }
  const manager = packageManagerFor(dir);
  if (manager === 'pnpm') return runCommand('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, env });
  if (manager === 'yarn') return runCommand('yarn', ['install', '--immutable'], { cwd: dir, env });
  if (existsSync(join(dir, 'package-lock.json'))) return runCommand('npm', ['ci'], { cwd: dir, env });
  return runCommand('npm', ['install'], { cwd: dir, env });
}

async function runPackageScript(name, env) {
  const dir = packageDir(env);
  const pkg = readPackageJson(dir);
  if (!pkg) {
    process.stderr.write(`缺少 package.json：${dir}\n`);
    return 1;
  }
  const script = pkg.scripts?.[name];
  if (typeof script !== 'string' || script.trim() === '') {
    process.stdout.write(`package.json 没有 ${name} 脚本，跳过\n`);
    return 0;
  }
  const manager = packageManagerFor(dir);
  if (name === 'test') {
    // `pnpm test` / `npm test` / `yarn test` all resolve the same script.
    return runCommand(manager, ['test'], { cwd: dir, env });
  }
  return runCommand(manager, ['run', name], { cwd: dir, env });
}

export async function dispatch(name, env = process.env) {
  if (!SUBCOMMANDS.includes(name)) {
    process.stderr.write(`未知子命令：${name || '<empty>'}（可选：${SUBCOMMANDS.join(', ')}）\n`);
    return 2;
  }
  switch (name) {
    case 'verify-action':
      return verifyAction(env);
    case 'install-deps':
      return installDeps(env);
    case 'test':
      if (String(env.SKIP_TEST || '').toLowerCase() === 'true') {
        process.stdout.write('SKIP_TEST=true，跳过测试\n');
        return 0;
      }
      return runPackageScript('test', env);
    case 'build':
      if (String(env.SKIP_BUILD || '').toLowerCase() === 'true') {
        process.stdout.write('SKIP_BUILD=true，跳过构建\n');
        return 0;
      }
      return runPackageScript('build', env);
    default:
      return runSubprocessProgram(name, env);
  }
}

if (IS_DIRECT) {
  const name = process.argv[2] || '';
  dispatch(name).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`执行 ${name} 失败：${error.message}\n`);
      process.exit(1);
    },
  );
}
