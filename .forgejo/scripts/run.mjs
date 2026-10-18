// run.mjs — the single entry point the workflow invokes.
//
// Every workflow step is one line:
//     run: node "$FORGEJO_DIR/scripts/run.mjs" <subcommand>
// where FORGEJO_DIR is exported by the locate-action step. The YAML therefore
// contains orchestration only, and all behaviour (including the shell-level
// work) lives in real, testable files.
//
// Subcommands:
//   locate-action      find the copied Action directory, export FORGEJO_DIR
//   ensure-tools       install missing tools; check npm and the lockfile manager
//   verify-action      assert every shipped program is present
//   install-deps       install dependencies with the lockfile's package manager
//   resolve            derive version/dist-tag/run info from the tag
//   preflight          private/tag/registry checks and the idempotency gate
//   test / build       run the project's own scripts
//   prepare            artifact check, align package.json, pack, hash
//   publish            npm web login -> second factor -> publish
//   release            create the Forgejo release

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryOnPath, MIN_VERSION_TEXT, npmVersion, unsupportedReason } from './publisher.mjs';
import {
  canInstall,
  commandPrefix,
  detectPackageManager,
  installCommand,
  installTools,
  MANAGER_PROXY_VARS,
  missingTools,
  packagesFor,
  proxyEnv,
  repositoriesFor,
  REQUIRED_TOOLS,
  resolveEndpoint,
  writeAptSources,
  writeYumRepos,
} from './deps.mjs';
import { isDirect } from './is-direct.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const IS_DIRECT = isDirect(import.meta.url);

/** Programs that are executed as their own process (they own process.exit). */
const PROGRAMS = {
  'locate-action': 'locate-action.mjs',
  resolve: 'resolve.mjs',
  preflight: 'preflight.mjs',
  prepare: 'prepare.mjs',
  publish: 'publish.mjs',
  release: 'release.mjs',
};

/** Everything the Action ships; verify-action insists on all of it. */
export const REQUIRED_SCRIPTS = [
  'notify-lib.mjs',
  'verification-parse.mjs',
  'registry-auth.mjs',
  'publisher.mjs',
  'pty.mjs',
  'is-direct.mjs',
  'deps.mjs',
  'locate-action.mjs',
  'run.mjs',
  'resolve.mjs',
  'preflight.mjs',
  'prepare.mjs',
  'publish.mjs',
  'release.mjs',
];

export const SUBCOMMANDS = [
  'locate-action',
  'ensure-tools',
  'verify-action',
  'install-deps',
  'resolve',
  'preflight',
  'test',
  'build',
  'prepare',
  'publish',
  'release',
];

/** The repository root the runner checked out. */
export function workspaceDir(env = process.env) {
  return (env.GITHUB_WORKSPACE || process.cwd()).replace(/\/+$/, '');
}

/** The working directory holding package.json (PKG_TARGET_DIR for monorepos). */
export function packageDir(env = process.env) {
  const target = (env.PKG_TARGET_DIR || '').replace(/^\/+|\/+$/g, '');
  return target ? join(workspaceDir(env), target) : workspaceDir(env);
}

function hasLockfile(dir) {
  return (
    existsSync(join(dir, 'pnpm-lock.yaml')) ||
    existsSync(join(dir, 'yarn.lock')) ||
    existsSync(join(dir, 'package-lock.json'))
  );
}

/**
 * The directory whose lockfile governs this package, or '' when there is none.
 *
 * A monorepo keeps its lockfile at the workspace root while PKG_TARGET_DIR
 * points at a member, so the search starts at the package directory and walks up
 * to the checkout root — nearest lockfile wins. Never walks above the checkout:
 * a lockfile outside the repository must not decide how this repo installs.
 */
export function lockfileDir(dir = packageDir(), root = workspaceDir()) {
  const scoped = dir === root || dir.startsWith(`${root.replace(/\/+$/, '')}/`);
  let current = dir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (hasLockfile(current)) return current;
    if (!scoped || current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

/** Which package manager the repository's lockfile asks for (default: npm). */
export function packageManagerFor(dir = packageDir(), root = workspaceDir()) {
  const found = lockfileDir(dir, root);
  if (!found) return 'npm';
  if (existsSync(join(found, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(found, 'yarn.lock'))) return 'yarn';
  return 'npm';
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

/**
 * Container capabilities.
 *
 * `script(1)` is required, not optional: npm only offers the web authorisation
 * flow when stdin and stdout are TTYs, so every login/publish call runs under a
 * PTY (see pty.mjs).
 */
export function probeEnvironment(run) {
  const has = (binary) =>
    run('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
  return {
    shell: has('sh'),
    pty: has('script'),
  };
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

  const { spawnSync } = await import('node:child_process');
  const capabilities = probeEnvironment(spawnSync);
  const missingToolsNow = missingTools(REQUIRED_TOOLS, spawnSync);
  process.stdout.write(
    `运行环境：sh=${capabilities.shell ? 'ok' : '缺失'} script(PTY)=${capabilities.pty ? 'ok' : '缺失'}\n`,
  );
  if (missingToolsNow.length > 0) {
    process.stdout.write(`缺少工具：${missingToolsNow.join(', ')}\n`);
  }
  if (!capabilities.pty) {
    process.stdout.write(
      '警告：没有 script(1)。npm 只在 stdin/stdout 都是终端时才走网页认证流程，\n' +
        '  缺它会导致二次验证拿不到可转发的链接；ensure-tools 会尝试安装（util-linux）。\n',
    );
  }
  return 0;
}

/**
 * Make sure npm is usable, since login and publish go through it.
 *
 * npm ships with every official Node image, so this is a check, not an install:
 * a missing npm means a broken image, and an npm older than the floor cannot
 * expose the 2FA `authUrl`/`doneUrl` pair. Either condition is a hard failure —
 * carrying on would only strand the release at a timeout.
 */
async function ensureNpm(env) {
  const { spawnSync } = await import('node:child_process');
  if (!binaryOnPath('npm', env)) {
    process.stderr.write(
      '找不到 npm：官方 Node 镜像自带 npm（container.image 默认 node:22-bookworm）。\n' +
        '请改用自带 Node/npm 的镜像，或修复镜像。\n',
    );
    return 1;
  }
  const version = npmVersion(spawnSync, env);
  const reason = unsupportedReason(version);
  if (reason) {
    process.stderr.write(`${reason}\n请升级：npm i -g npm@latest（或在镜像里预装 npm ≥ ${MIN_VERSION_TEXT}）。\n`);
    return 1;
  }
  process.stdout.write(`npm ${version || '(版本未知)'} 可用\n`);
  return 0;
}

/**
 * Install the container tools the release needs, with the image's own package
 * manager and through the configured proxy.
 *
 * Set SKIP_TOOL_INSTALL=true to opt out (air-gapped images that prepackage the
 * tools). A missing tool that cannot be installed is a warning: the publish
 * step reports the real problem, and images that already carry the tools never
 * reach the install path at all.
 */
async function ensureTools(env) {
  const { spawnSync } = await import('node:child_process');

  // A `*_PROXY` value may be a real forward proxy or an internal mirror: classify
  // it once and remember the answer for the later steps (install-deps needs the
  // npm side of it, and a mirror must never be handed to npm as a proxy).
  await resolveNpmEndpoint(env);

  // npm is what logs in and publishes; the lockfile's own manager is what
  // installs dependencies, so both are checked on every path.
  const finish = async () => {
    const npm = await ensureNpm(env);
    return npm !== 0 ? npm : ensureLockfileManager(env);
  };
  const missing = missingTools(REQUIRED_TOOLS, spawnSync);
  if (missing.length === 0) {
    process.stdout.write(`工具齐全（${REQUIRED_TOOLS.join(', ')}），无需安装\n`);
    return finish();
  }
  process.stdout.write(`缺少工具：${missing.join(', ')}\n`);

  const manager = detectPackageManager(env, spawnSync);
  if (!manager) {
    process.stderr.write(
      `没有可用的包管理器（apk/apt-get/yum）来安装 ${missing.join(', ')}；请改用自带这些工具的镜像\n`,
    );
    return finish();
  }

  const packages = packagesFor(manager, missing);
  const plan = await resolveEndpoint(manager, env);
  if (plan.source === 'proxy-as-mirror') {
    process.stdout.write(`${managerEndpointVar(manager)} 指向的是镜像（探测到仓库索引），按仓库使用\n`);
  }
  const repositories = plan.mirror;
  const proxy = proxyEnv(manager, env, { explicit: plan.proxy });
  const aptSourcesFile = manager === 'apt-get' ? writeAptSources(repositories, env) : '';
  const yumReposDir = isYumFamily(manager)
    ? writeYumRepos(repositories, env, { warn: (message) => process.stderr.write(`${message}\n`) })
    : '';
  const resolved = { repositories, aptSourcesFile, yumReposDir };
  const proxyNote =
    Object.keys(proxy).length > 0
      ? `（代理：${plan.proxy || Object.keys(proxy).join(', ')}）`
      : '（未配置代理）';
  const repoNote = repositories.length > 0 ? `（附加仓库：${repositories.join(', ')}）` : '';
  process.stdout.write(`使用 ${manager} 安装：${packages.join(', ')} ${proxyNote}${repoNote}\n`);

  if (!canInstall(env)) {
    process.stderr.write(
      `不是 root 且没有 sudo，跳过安装；请手动执行：${installHint(manager, packages, env, resolved)}\n`,
    );
    return finish();
  }

  const result = installTools({ manager, tools: missing, env, proxy, ...resolved });
  const still = missingTools(REQUIRED_TOOLS, spawnSync);
  if (still.length === 0) {
    process.stdout.write(`已安装 ${result.installed.join(', ')}，工具齐全\n`);
  } else {
    process.stderr.write(`仍缺少：${still.join(', ')}\n`);
    process.stderr.write(`请手动执行：${installHint(manager, packages, env, resolved)}\n`);
  }
  return finish();
}

/** The `*_PROXY` variable that names this manager's endpoint, for log lines. */
export function managerEndpointVar(manager) {
  return (MANAGER_PROXY_VARS[manager] || [])[0] || `${String(manager).toUpperCase()}_PROXY`;
}

function isYumFamily(manager) {
  return manager === 'yum' || manager === 'dnf' || manager === 'microdnf';
}

/** Make a resolved value visible to the following workflow steps. */
function exportEnv(key, value) {
  process.env[key] = value;
  const file = process.env.GITHUB_ENV;
  if (!file) return;
  try {
    appendFileSync(file, `${key}=${value}\n`);
  } catch {
    /* the value still applies to this process */
  }
}

/**
 * Decide what `NPM_PROXY` means and pass the verdict on.
 *
 * A registry mirror is used for **dependency installation only**
 * (`NPM_INSTALL_REGISTRY`), because login/publish must keep talking to the real
 * npmjs — the Action publishes there, and an internal registry cannot complete
 * npm's web login anyway. A real proxy becomes npm's own proxy setting.
 */
async function resolveNpmEndpoint(env) {
  const plan = await resolveEndpoint('npm', env);
  if (plan.source === 'proxy-as-mirror') {
    exportEnv('NPM_INSTALL_REGISTRY', plan.mirror[0]);
    process.stdout.write(`NPM_PROXY 指向的是 registry：依赖安装将使用 ${plan.mirror[0]}（登录/发布仍走 npmjs）\n`);
  } else if (plan.source === 'proxy') {
    exportEnv('NPM_CONFIG_PROXY', plan.proxy);
    process.stdout.write(`NPM_PROXY 指向的是代理：npm 将使用 ${plan.proxy}\n`);
  }
}

/**
 * `install-deps` follows the repository's lockfile, so whatever manager that
 * lockfile names has to exist. npm ships with the image and is checked above;
 * pnpm and yarn normally come from corepack, which the Node images bundle but
 * do not activate, so a bare `pnpm install` would die with ENOENT.
 *
 * `package.json`'s `packageManager` field is honoured too: a repository that
 * declares pnpm there but commits no lockfile still gets pnpm, because its own
 * scripts may call it.
 */
async function ensureLockfileManager(env) {
  const { spawnSync } = await import('node:child_process');
  const dir = packageDir(env);
  const root = workspaceDir(env);
  if (!existsSync(join(dir, 'package.json'))) return 0;
  const pkg = readPackageJson(dir);
  const lockManager = packageManagerFor(dir, root);
  const declared = declaredManager(pkg);
  if (lockManager === 'npm') {
    process.stdout.write('依赖将用 npm 安装（package-lock.json 或没有锁文件）\n');
  }
  if (declared && declared !== lockManager) {
    process.stdout.write(`package.json 声明 packageManager: ${pkg.packageManager}\n`);
  }
  // A lockfile makes its manager mandatory (install-deps cannot proceed without
  // it); a bare `packageManager` declaration is only a hint — the project's own
  // scripts may need it, but npm can still install and the run should not die
  // over a missing convenience.
  const required = new Set([lockManager].filter((manager) => manager && manager !== 'npm'));
  const wanted = [...new Set([lockManager, declared])].filter((manager) => manager && manager !== 'npm');

  const hasCorepack =
    String(env.SKIP_TOOL_INSTALL || '').toLowerCase() !== 'true' &&
    spawnSync('sh', ['-c', 'command -v corepack'], { stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
  for (const manager of wanted) {
    if (binaryOnPath(manager, env)) {
      process.stdout.write(`${manager} 可用\n`);
      continue;
    }
    if (hasCorepack) {
      process.stdout.write(`PATH 上没有 ${manager}，尝试用 corepack 启用…\n`);
      spawnSync('corepack', ['enable', manager], { stdio: ['ignore', 'inherit', 'inherit'] });
      spawnSync(
        'corepack',
        ['prepare', corepackPin(lockfileDir(dir, root) || dir, manager, pkg.packageManager), '--activate'],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (binaryOnPath(manager, env)) {
        process.stdout.write(`已通过 corepack 启用 ${manager}\n`);
        continue;
      }
      process.stderr.write('corepack 启用失败。\n');
    }
    if (!required.has(manager)) {
      process.stderr.write(
        `警告：package.json 声明了 ${manager}，但 PATH 上没有它${hasCorepack ? '' : '（也没有可用的 corepack）'}；` +
          `若项目脚本要用它，请在镜像里预装或改用自带它的镜像。\n`,
      );
      continue;
    }
    process.stderr.write(
      `这个仓库的锁文件要求用 ${manager} 安装依赖，但 PATH 上没有它${hasCorepack ? '' : '，也没有可用的 corepack'}。\n` +
        `  请改用自带 ${manager} 的镜像、在镜像里预装它，或删掉 ${manager} 锁文件改用 npm。\n`,
    );
    return 1;
  }
  return 0;
}

/** The manager named by `package.json`'s `packageManager` field, or ''. */
export function declaredManager(pkg) {
  const spec = String(pkg?.packageManager || '').trim();
  const name = spec.split('@')[0].trim();
  return ['npm', 'pnpm', 'yarn'].includes(name) ? name : '';
}

/** The corepack spec that matches the declaration, else the lockfile in the repo. */
export function corepackPin(dir, manager = packageManagerFor(dir), declared = '') {
  // "pnpm@9.15.0" / "yarn@stable" already is a corepack spec.
  const pinned = String(declared || '').trim();
  if (pinned.includes('@', 1) && pinned.split('@')[0] === manager) return pinned;
  if (manager !== 'yarn') return `${manager}@latest`;
  try {
    // Yarn 1 writes "# yarn lockfile v1"; Berry (2+) writes __metadata:.
    const head = readFileSync(join(dir, 'yarn.lock'), 'utf8').slice(0, 256);
    return /yarn lockfile v1/i.test(head) ? 'yarn@1.22.22' : 'yarn@stable';
  } catch {
    return 'yarn@stable';
  }
}

/** The command a human would run, for log messages. */
export function installHint(manager, packages, env = process.env, resolved = {}) {
  const repositories = resolved.repositories ?? repositoriesFor(manager, env);
  const aptSourcesFile =
    resolved.aptSourcesFile ?? (manager === 'apt-get' ? writeAptSources(repositories, env) : '');
  const yumReposDir = resolved.yumReposDir ?? (isYumFamily(manager) ? writeYumRepos(repositories, env) : '');
  const built = installCommand(manager, packages, { repositories, aptSourcesFile, yumReposDir });
  if (!built) return `用 ${manager} 安装 ${packages.join(' ')}`;
  return [...commandPrefix(), built[0], ...built[1]].join(' ');
}

/**
 * Yarn 1 (classic) calls the reproducible-install flag `--frozen-lockfile`;
 * Yarn 2+ (Berry) renamed it to `--immutable`. Passing the wrong one aborts the
 * install with "unknown option", so the major version decides.
 */
export function yarnInstallArgs(env = process.env, run = spawnSync, cwd = undefined) {
  const result = run('yarn', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
  const major = Number((/(\d+)/.exec(String(result.stdout || '')) || [])[1] || 0);
  return major >= 2 ? ['install', '--immutable'] : ['install', '--frozen-lockfile'];
}

async function installDeps(env) {
  const dir = packageDir(env);
  const root = workspaceDir(env);
  const pkg = readPackageJson(dir);
  if (!pkg) {
    process.stderr.write(`缺少 package.json：${dir}（monorepo 请设置变量 PKG_TARGET_DIR）\n`);
    return 1;
  }
  const manager = packageManagerFor(dir, root);
  // A monorepo keeps its lockfile at the workspace root while PKG_TARGET_DIR
  // points at a member, so the install runs where the lockfile is: that is what
  // makes pnpm/yarn workspaces work instead of npm-installing the member alone.
  const installDir = lockfileDir(dir, root) || dir;
  // `NPM_PROXY` pointing at a registry is resolved by ensure-tools into this
  // variable (and only here): the release itself must keep using npmjs.
  const registry = String(env.NPM_INSTALL_REGISTRY || '').trim();
  const registryEnv = registry
    ? { npm_config_registry: registry, YARN_NPM_REGISTRY_SERVER: registry }
    : {};
  const withRegistry = { ...env, ...registryEnv };
  if (manager === 'pnpm') return runCommand('pnpm', ['install', '--frozen-lockfile'], { cwd: installDir, env: withRegistry });
  if (manager === 'yarn') return runCommand('yarn', yarnInstallArgs(env, spawnSync, installDir), { cwd: installDir, env: withRegistry });
  if (existsSync(join(installDir, 'package-lock.json'))) {
    return runCommand('npm', registry ? ['ci', '--registry', registry] : ['ci'], { cwd: installDir, env: withRegistry });
  }
  return runCommand('npm', registry ? ['install', '--registry', registry] : ['install'], { cwd: installDir, env: withRegistry });
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
  const manager = packageManagerFor(dir, workspaceDir(env));
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
    case 'ensure-tools':
      return ensureTools(env);
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
    case 'prepare':
      // Publish always uploads the tarball Prepare made, so npm never runs the
      // project's prepublishOnly itself. `prepack`/`prepare`/`postpack` still run
      // inside `npm pack` below; this restores prepublishOnly for repositories
      // that use it as a release gate.
      if (shouldRunPrepublish(env)) {
        process.stdout.write('RUN_PREPUBLISH_ONLY=true：打包前先执行项目自己的 prepublishOnly\n');
        const code = await runPackageScript('prepublishOnly', env);
        if (code !== 0) {
          process.stderr.write(`prepublishOnly 以退出码 ${code} 结束，已中止发布\n`);
          return code;
        }
      }
      return runSubprocessProgram(name, env);
    default:
      return runSubprocessProgram(name, env);
  }
}

/**
 * Should the project's own `prepublishOnly` be run explicitly before packing?
 *
 * Off by default: publishing the prepared tarball already skips it, the Test and
 * Build steps ran the same commands, and that script is the one place a release
 * most often reaches for tooling the image does not have. Turn it on for a
 * repository that uses prepublishOnly as a real gate.
 */
export function shouldRunPrepublish(env = process.env) {
  return String(env.RUN_PREPUBLISH_ONLY || '').toLowerCase() === 'true';
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
