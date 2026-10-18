# npm-publish

Forgejo Action：**推送 tag 即发版**。版本校验 → 测试构建 → 打包检查 → 发布 → 建 Release，**没有人工确认环节**；npm 需要登录或二次验证时，把**一次性验证网址**用 `POST + application/json` 推送到指定 webhook，人工在浏览器完成后 **npm 自己继续**。

```
      ├─ 测试、构建、npm pack + sha256              Test / Build / prepare
      ├─ npm whoami → 未登录则 npm login --auth-type=web
      │     └─ npm 打印一次性登录链接 → 原样推给你
      │     └─ npm 进程继续轮询 doneUrl，等你点完授权后自己结束
      ├─ npm publish --access public --tag <dist-tag>       publish
      │     ├─ 需要二次验证 → EOTP 里的 authUrl → 再推给你
      │     └─ npm 轮询 doneUrl 拿到一次性 token，自己带 --otp 重试完成提交
      ├─ 创建 Forgejo Release（changelog）          release
      └─ 失败时只在输出里确实带着未走完的授权链接时才推送
```

**不需要任何 registry token**：认证完全由人工在浏览器完成，runner 里不保存凭据，工作流不读取也不传递 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。

## 安装

把整个 `npm-publish/` 目录复制到目标仓库，并改名为 `.forgejo`：

```bash
cp -r npm-publish /path/to/target-repo/.forgejo
```

复制后的目录结构（**必须整目录复制**：workflow 只是编排，逻辑都在脚本里）：

```
.forgejo/
├── workflows/
│   └── npm-publish.yml            # 只有编排，每步一行
└── scripts/                       # 全部逻辑，普通 .mjs 文件
    ├── run.mjs                    # 分发器：每个步骤一行调用它
    ├── deps.mjs                   # 缺工具时用 apk/apt/yum 安装 + 代理映射
    ├── pty.mjs                    # script(1) 包装：给 npm 一个伪终端
    ├── is-direct.mjs              # 「本文件是否被直接执行」判定（各程序共用）
    ├── locate-action.mjs          # 找 Action 目录，导出 FORGEJO_DIR
    ├── notify-lib.mjs             # webhook 载荷、投递、授权链接判定
    ├── publisher.mjs              # 发版工具（npm）与命令构造
    ├── registry-auth.mjs          # 从输出里提取授权链接与结构化错误
    ├── verification-parse.mjs     # 文案回退：候选排序 + 验证码提取
    ├── resolve.mjs                # tag → 版本/dist-tag/运行信息
    ├── preflight.mjs              # 预检：private/tag 未移动/registry 比对/幂等
    ├── prepare.mjs                # 产物校验 + 对齐版本 + npm pack + sha256
    ├── publish.mjs                # 网页登录 → 二次验证 → 发布
    └── release.mjs                # 建 Forgejo Release
```

workflow 里除定位步骤外每一步都是一行（`配置里没有内嵌脚本`）：

```yaml
      - name: Publish to npm
        if: steps.preflight.outputs.already_published != 'true'
        env:
          MESSAGE_PUSHER_TOKEN: ${{ secrets.MESSAGE_PUSHER_TOKEN }}
        run: node "$FORGEJO_DIR/scripts/run.mjs" publish
```

唯一的例外是定位步骤本身 —— 它必须先找到 `run.mjs` 才能调用它，所以有 3 行引导（依次尝试
`${{ github.action_path }}`、`$GITHUB_WORKSPACE/.forgejo`、在仓库内搜索 `*/scripts/run.mjs`）。
`locate-action.mjs` 随后把 `FORGEJO_DIR` 写进 `$GITHUB_ENV`（同时保留 `forgejo_dir` step output），
所以后面的步骤不需要再插值路径。

可用子命令：`locate-action`、`ensure-tools`、`verify-action`、`install-deps`、`resolve`、`preflight`、
`test`、`build`、`prepare`、`publish`、`release`；都能在本地直接跑，例如
`GITHUB_WORKSPACE=$PWD node scripts/run.mjs locate-action`、
`APT_PROXY=https://apt.internal node scripts/run.mjs ensure-tools`。

复制不全会被 `verify-action` 拦下并逐个列出缺哪个文件。

还要在目标仓库里配置：

1. `设置 → Actions`：勾选 **Enable Repository Actions**。
2. `设置 → Actions → Secrets`：`FORGEJO_TOKEN`、`MESSAGE_PUSHER_TOKEN` 按需（没有 npm token 类配置）。
3. `设置 → Actions → Variables`：**`MESSAGE_PUSHER_URL`（必填）** —— 推送到哪个地址由仓库配置决定，Action 里不内置任何地址，因此换仓库不会被带到别处。
4. 该仓库有可用的 runner，且 runner 能出网访问 registry 与你的推送地址。

### 容器镜像要求

| 需要 | 说明 |
| --- | --- |
| `sh` | 工作流用 `shell: sh` 运行，**不依赖 bash**（Alpine、distroless 等都能跑） |
| `node` | 镜像里要有 Node ≥ 18；`container.image` 默认 `node:22-bookworm` |
| `npm ≥ 10.9` | **认证流程完全由 npm 驱动**：只有 10.9 起 npm 才会在 `EOTP` 里带 `authUrl`/`doneUrl`。官方 Node 镜像自带；更低的版本会被 `ensure-tools` 与 `publish` 提前拒绝并给出升级方式 |
| `script` | **必需**。npm 只在 stdin 与 stdout 都是终端时才走网页认证分支（见下），所以 `npm login` / `npm publish` 都通过 `script(1)` 运行；Alpine/BusyBox 默认没有，`Ensure container tools` 会用 util-linux 装上 |

**缺失的工具会自动安装**：`Ensure container tools` 步骤会探测 `git`/`script`，缺哪个就用镜像自带的包管理器（`apk` / `apt-get` / `yum` / `dnf` / `microdnf`）装，并通过下面的代理变量走网。用 `SKIP_TOOL_INSTALL=true` 可关闭（离线镜像已经预装工具时用）。非 root 且无 `sudo` 时会跳过安装并打印需要手动执行的命令。

**为什么必须有伪终端**：npm 的网页认证分支写在 `if (!process.stdin.isTTY || !process.stdout.isTTY) throw err` 之后 —— 没有终端时它只会抛一个不带任何链接的 `EOTP`/`E401`，脚本就没有网址可转发。`script -c` 只是分配一个伪终端，不解析输出；同时设置 `npm_config_browser=false`，让 npm 打印网址后立即返回，不等待回车、也不会去启动浏览器。

```yaml
    container:
      image: node:22-alpine      # 也可以，script 会被自动装上
```

### 发布链路：只用 npm

| | 说明 |
| --- | --- |
| 版本 | **npm ≥ 10.9**（官方 Node 22/24 镜像均满足）；低于此版本立刻失败并说明如何升级 |
| 登录 | `npm login --auth-type=web`，一次性链接打印后 npm 自己轮询 `doneUrl` |
| 发布 | **上传 Prepare 打包并校验过的那个 tarball**：`npm publish <tarball> --access <级别> --tag <t>`（可加 `--otp <code>`）。`--access` 取自 `publishConfig.access`，其次是 `PUBLISH_ACCESS`，都没有才默认 `public`。npm 只对"目录发布"执行项目自己的 `prepublishOnly`，发 tarball 不会——避免把 Test/Build 再跑一遍，也避免它依赖 runner 里没有的工具；想让它照跑就设 `RUN_PREPUBLISH_ONLY=true`（见下） |
| 二次验证 | npm 收到 `EOTP` 后打印 `authUrl`、轮询 `doneUrl`、拿到 token 后**自己重试**；脚本只负责转发网址 |
| 凭据 | npm 自己写入 `~/.npmrc`；登录与发布是同一个 npm，不会冲突 |
| 其它命令 | 版本对齐 `npm version`、打包 `npm pack --json`、查询 registry `npm view <pkg> versions dist-tags --json` |

### 锁文件与包管理器

登录与发布固定走 npm；**依赖安装 / 测试 / 构建按仓库的锁文件选管理器**。查找方式是从 package 目录向上找到 checkout 根为止（**就近优先**），并且安装命令在**锁文件所在目录**执行 —— 所以 monorepo（`PKG_TARGET_DIR=packages/plugin` + 根目录 `pnpm-lock.yaml`）会正确走 pnpm workspace，而不会在子目录里 `npm install`。

| 仓库里的锁文件 | install-deps / test / build 用 | 没有该包管理器时 |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `Ensure container tools` 用 corepack 启用（`pnpm@latest`，仓库有 `packageManager` 时以它为准） |
| `yarn.lock`（Yarn 1） | `yarn install --frozen-lockfile` | corepack 启用 `yarn@1.22.22` |
| `yarn.lock`（Berry） | `yarn install --immutable` | corepack 启用 `yarn@stable` |
| `package-lock.json` / 没有锁文件 | `npm ci` / `npm install` | npm 由镜像提供，无需准备 |

`package.json` 的 `packageManager` 字段也认：即使仓库没提交锁文件，只要声明了 `"packageManager": "pnpm@9.x"`，`Ensure container tools` 就会按这个版本用 corepack 启用它（项目脚本可能直接调用它）；万一镜像没有 corepack，只**警告**不中断（锁文件要求的那种才是硬失败）。

corepack 缺失（较新的 Node 镜像已不再内置）或启用失败时，`Ensure container tools` **直接失败并给出处理办法**，不会等到 `install-deps` 抛 `ENOENT`。设 `SKIP_TOOL_INSTALL=true` 可完全关闭这些自动准备（离线镜像自行预装时用）。corepack 取版本、pnpm/yarn 下载依赖都要出网，分别走 `HTTPS_PROXY` 与 `NPM_CONFIG_PROXY`。

### 项目自己的 npm 生命周期钩子，谁跑谁不跑

实测（npm 10 与 12 行为一致）：

| 命令 | 运行的钩子 |
| --- | --- |
| `npm pack`（**Prepare 步骤执行**） | `prepack` → `prepare` → `postpack` |
| `npm publish`（目录发布） | `prepublishOnly` → `prepack` → `prepare` → `postpack` → `publish` → `postpublish` |
| `npm publish <tarball>`（**本 Action 的发布方式**） | 无 |

所以：**准备包内容的钩子（`prepack`/`prepare`）照旧会跑**，跑在 Prepare 打包那一次；被跳过的只有 `prepublishOnly`（以及 `publish`/`postpublish`，和 prepack/prepare/postpack 的"第二遍"）。

这么做的原因：

- 发布的就是 Prepare **打包并记录 sha256** 的那个文件，内容与校验一致；目录发布会现场重新打包，第二次 `prepare` 可能改掉产物，哈希就对不上了；
- `prepublishOnly` 按 npm 自己的定位是"发布前的检查/测试钩子"（官方文档明确不建议用它准备包内容），而本 Action 的 Test/Build 步骤已经跑过同样的事；
- 它也是唯一会因为 runner 里缺少某个工具而炸掉发布的地方（典型：脚本里写死 `pnpm`，仓库却没有锁文件/`packageManager` 可供 Action 准备）。

需要它照跑时：设 `RUN_PREPUBLISH_ONLY=true`，Action 会用仓库的包管理器在**打包前**执行 `prepublishOnly`，失败即中止发布（顺序与 npm 目录发布一致：钩子 → 打包）。

### 代理、镜像与 registry（内网怎么接）

runner 没有直连外网时，先分清三件不同的事：**代理**（forward proxy）、**镜像/仓库**（repository）、**registry**（npm / Go module proxy）。填错变量的典型症状是 `unable to select packages`、`HTTP 404/308`、`Connection refused`。

**最省事的用法：只填下面这几个地址。**
`APT_PROXY` / `NPM_PROXY` 的值可以是**真代理**，也可以是**内网镜像/registry**：`Ensure container tools` 会**探测一次**（直接取该地址自己的仓库索引 / `/-/ping`），再决定怎么用。apk / yum 没有 `*_PROXY`，镜像直接填 `APK_REPO` / `YUM_REPO`（不探测）。

| 变量 | 你填什么 | 判为**镜像 / registry** | 判为**代理** |
| --- | --- | --- | --- |
| `APT_PROXY` | Debian/Ubuntu 镜像根，如 `https://apt.internal` | 生成临时 sources（`<根>/debian` 或 `/ubuntu` + 镜像里的 codename）→ `apt-get -o Dir::Etc::sourcelist=…` | 作为 apt 的 `http_proxy`/`https_proxy` |
| `NPM_PROXY` | 内网 npm registry，如 `https://npm.internal` | **只用于装依赖**：`install-deps` 变成 `npm install --registry <url>`（`login`/`publish` 仍走 npmjs） | 作为 npm 的 `proxy` |
| `GOPROXY`（或 `GO_PROXY`） | Go module proxy（Athens 等） | 直接作为 `GOPROXY`，给项目自己的 build/test 脚本用 | — |

判别规则：直接 GET 索引文件，**2xx = 镜像**；拿到明确的 HTTP 错误（404/400/308…）= 代理；**完全没有响应**（连不上/超时）= 仍按镜像处理 —— 那正是你填的地址，报错信息也更贴切。

apk / yum 的镜像用这两个（显式指定，**不探测**；设了就优先于任何 `*_PROXY`）：

| 变量 | 指向什么 |
| --- | --- |
| `APK_REPO` | Alpine 镜像**根地址或完整仓库 URL**（逗号分隔）：根地址会按镜像里的 `VERSION_ID` 展开成 `<根>/alpine/vX.Y/{main,community}` |
| `YUM_REPO` | yum/dnf 镜像**根地址或完整 baseurl**（逗号分隔；根地址按 `VERSION_ID` 展开成 `<根>/centos/<N>-stream/{BaseOS,AppStream}/x86_64/os`）；生成 `.repo` 目录 + `--setopt=reposdir=`，镜像自带的 `/etc/pki/rpm-gpg/RPM-GPG-KEY*` 会写进 `gpgkey`（`gpgcheck=1`），一个密钥都没有时才降级为 `gpgcheck=0` 并在日志里说明。旧的 `APK_REPOSITORY` / `YUM_REPOSITORY` 仍可识别 |

registry 的两个显式覆盖：

| 变量 | 指向什么 |
| --- | --- |
| `NPM_INSTALL_REGISTRY` | **只给 `install-deps` 用**的 registry（`NPM_PROXY` 自动判别出的结果也写进这个） |
| `NPM_CONFIG_REGISTRY` | npm 的 `registry` 配置，`login` / `publish` / `view` 全部生效。**注意**：本 Action 的认证走 npm 的网页登录（`POST /-/v1/login`），Verdaccio 这类内网 registry 会返回 404，登录会退化成“Username:”提示并立即失败——所以发布目标别设它 |

**真正的 HTTP 转发代理**也可以用这些通用变量（它们只当代理，不做判别）：

| 变量 | 作用 |
| --- | --- |
| `ALL_PROXY` | 通用兜底（`socks5://…` 也可以） |
| `HTTP_PROXY` / `HTTPS_PROXY` | 标准 HTTP 代理 |
| `NO_PROXY` | 不走代理的地址（如 `localhost,.internal`） |
| `NPM_CONFIG_PROXY` | npm 自己的变量名（npm 会读成 `proxy`） |

取值优先级（以 apt 为例）：`APT_PROXY`（判为代理时）→ `HTTP_PROXY`/`HTTPS_PROXY` → `ALL_PROXY`。变量会同时以大写和小写形式导出（`http_proxy`/`HTTP_PROXY`），因为不同工具认不同写法；`NO_PROXY` 也一样。

想自己确认某个地址是哪一类：

```bash
# 是镜像/仓库？自己的路径就有包索引
curl -sI https://HOST/alpine/v3.24/main/x86_64/APKINDEX.tar.gz | head -1   # Alpine（分支带 v）
curl -sI https://HOST/debian/dists/bookworm/InRelease | head -1            # Debian/Ubuntu
curl -sI https://HOST/centos/9-stream/BaseOS/x86_64/os/repodata/repomd.xml # CentOS Stream

# 是 npm registry？  <- /-/ping 返回 {}
curl -s https://HOST/-/ping

# 是代理？能替别人取东西
curl -x http://HOST:PORT -o /dev/null -w '%{http_code}\n' https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz
```

socks5 代理只能给 `ALL_PROXY`/`HTTP(S)_PROXY` 用，apt/apk 不能；内网源形式特殊（多组件、多 suite、非 CentOS 的 RPM 发行版）时，直接写进镜像的 `sources.list` / `.repo` / `.npmrc` 更省事。

### runner 标签与镜像（重要）

workflow 里的两者都是变量，带默认值，**不配置也能跑**：

```yaml
    runs-on: ${{ vars.NPM_PUBLISH_RUNNER_LABEL || 'docker' }}
    container:
      image: ${{ vars.NPM_PUBLISH_IMAGE || 'node:22-bookworm' }}
```

对应到 runner 的 `runner-config.yml`：

```yaml
runner:
  labels:
    - docker:docker://node:22-bookworm
```

规则（依据 [Forgejo Runner 配置文档](https://forgejo.org/docs/latest/admin/actions/configuration/)）：

| 你的 runner 标签 | 是否可跑 |
| --- | --- |
| `docker:docker://node:22-bookworm` | ✅ 推荐，默认镜像与 Action 要求一致 |
| `docker:docker://node:20-bookworm` | ✅ 可以，标签名匹配即可，镜像被 workflow 的 `container.image` 覆盖 |
| `docker` / `docker:docker` | ✅ 可以，runner 默认镜像就是 `node:22-bookworm`（见 runner 源码 `ArgDocker`） |
| `docker1:docker://…` | ❌ 标签名必须与 `runs-on` 一致；此时设 `NPM_PUBLISH_RUNNER_LABEL=docker1` 即可 |
| `docker:lxc://…` | ⚠️ 名字匹配但走 LXC 后端，需要宿主装好 LXC，且模板名要写标准值（如 `debian:bookworm`） |

只有**冒号左边的标签名**参与 `runs-on` 匹配；冒号右边只是**默认镜像**，会被 workflow 的 `container.image` 覆盖（runner 逻辑：`containerImage` 非空优先，否则用标签默认）。

## 触发方式

| 触发 | 说明 |
| --- | --- |
| 推送 tag `v1.4.0` / `1.4.0` | 主路径，版本 = tag（允许 `v` 前缀，允许 `1.4.0-rc.1` 预发布） |
| 手工 `workflow_dispatch` | `version` 必须对应一个**已存在的 tag**（`1.4.0` 与 `v1.4.0` 都接受）；`otp` 用于该 registry 只接受手输验证码的场景；`dist_tag` 覆盖 dist-tag；`dry_run` 只演练 |

> 手工触发请**在 tag 对应的提交上运行**：preflight 会校验 tag 指向的提交与当前 checkout 一致，不一致时直接失败（避免用 `main` 的内容发 `v1.4.0` 的包）。

dist-tag 默认：正式版 `latest`，含 `-` 的预发布版 `next`；可用仓库变量 `RELEASE_DIST_TAG` 或 dispatch 输入覆盖。

## 配置项

### Secrets

| 名称 | 必需 | 说明 |
| --- | --- | --- |
| `FORGEJO_TOKEN` | 否 | 建 Forgejo Release 用的 PAT（仓库写权限）。**只挂在 `Create Forgejo release` 这一步**；未配置时该步打印跳过，只发包 |
| `MESSAGE_PUSHER_TOKEN` | 否 | 你的推送服务设了 token 时填写；**只挂在 `Publish to npm` 这一步**，自定义 Webhook 下作为 `Authorization: Bearer` 发送 |

> 两个 secret 都**不在 job 级 env** 里：`Install dependencies` / `Test` / `Build` 会执行仓库与依赖的代码（含 postinstall），不应该看得到它们。
> 没有任何 registry 凭据类 secret。

### Variables

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `NPM_PUBLISH_RUNNER_LABEL` | `docker` | 覆盖 `runs-on` 的标签名。仓库的 runner 标签叫别的名字（如 `docker1`）时设它 |
| `NPM_PUBLISH_IMAGE` | `node:22-bookworm` | 覆盖 job 容器镜像。需要内网镜像时设它 |
| `MESSAGE_PUSHER_URL` | **必填** | 通知接收地址。脚本里不内置任何地址；未配置时预检直接失败（dry-run 除外）。含 `/push/` 时按 message-pusher 原生接口发送，否则发送原始 v1 信封 |
| `MESSAGE_PUSHER_TOKEN` | 空 | 见上（Secret） |
| `MESSAGE_PUSHER_REQUIRE_TOKEN` | 空 | `true` 时，`/push/` 地址缺 token 直接失败 |
| `NOTIFY_REQUIRED` | `true` | **授权链接投递失败时是否让 job 失败**。人工没有链接就无法完成认证，所以默认失败；`false` 只告警并继续（会一直等到超时） |
| `NOTIFY_TITLE_REPO_ONLY` | `false` | `true` 时 `title` 只取仓库名（`repo`），默认 `owner/repo` |
| `NOTIFY_ATTEMPTS` / `NOTIFY_TIMEOUT_MS` | `3` / `10000` | 单次投递的重试次数与超时 |
| `REQUIRED_ARTIFACTS` | 空（不检查） | 构建产物必含清单，逗号分隔、**相对 package 目录**（monorepo 下设了 `PKG_TARGET_DIR` 就相对那个子目录），两侧空格会被忽略，例如 `lib/index.js,lib/client.js,cordis.patch.yml`。**在 Build 之后、npm pack 之前**校验；留空表示不检查（模板不预设任何项目专属路径） |
| `PKG_TARGET_DIR` | 空 | monorepo 子目录，例如 `packages/plugin` |
| `SKIP_TEST` / `SKIP_BUILD` | 空 | `true` 跳过测试 / 构建（无 build 脚本时自动跳过） |
| `RUN_PREPUBLISH_ONLY` | 空（不跑） | `true` 时在**打包前**先执行项目自己的 `prepublishOnly`（用仓库的包管理器，失败即中止发布）。默认不跑：发布的是 Prepare 的 tarball，而 `prepack`/`prepare`/`postpack` 仍由 `npm pack` 正常执行 |
| `SKIP_TOOL_INSTALL` | 空 | `true` 时 `Ensure container tools` 不安装任何东西（离线镜像已预装时用） |
| `PKG_MANAGER` | 空 | 强制 `apk`/`apt-get`/`yum`/`dnf`/`microdnf`，跳过自动探测 |
| `RELEASE_DIST_TAG` | 空 | 固定 dist-tag |
| `PUBLISH_ACCESS` | 空 | `public` / `restricted`，覆盖发布级别。默认取 `publishConfig.access`，都没有才 `public`（仓库声明 `restricted` 时不会被本 Action 擅自公开） |
| `NPM_AUTH_WAIT_MINUTES` | `15` | **整个认证过程的总预算**（登录 + 二次验证 + 重试共用同一个 deadline），超时后推送失败通知；不是每一步各算一次 |
| `APT_PROXY` / `NPM_PROXY` | 空 | 内网端点：**自动判别**是真代理还是镜像/registry，见「代理、镜像与 registry」。例：`APT_PROXY=https://apt.internal` |
| `ALL_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY` / `NPM_CONFIG_PROXY` | 空 | 真正的 HTTP 转发代理（不参与判别） |
| `APK_REPO` / `YUM_REPO` | 空 | 显式仓库地址（跳过判别），根地址即可：Alpine 镜像根 / yum-dnf 镜像根。旧的 `APK_REPOSITORY` / `YUM_REPOSITORY` 仍可识别 |
| `NPM_INSTALL_REGISTRY` | 空 | 只给 `install-deps` 用的 registry（`NPM_PROXY` 判为 registry 时也写进它） |
| `NPM_CONFIG_REGISTRY` | 空 | 内网 npm **registry**，`login`/`publish`/`view` 都走它（发布目标一般别设） |
| `GOPROXY` / `GO_PROXY` | 空 | 内网 **Go module proxy**（Athens 等），只影响项目自己的 build/test 脚本 |

### `REQUIRED_ARTIFACTS` 怎么设

在 `设置 → Actions → Variables` 里新增 `REQUIRED_ARTIFACTS`，值是逗号分隔的相对路径（相对 package 目录；monorepo 下设了 `PKG_TARGET_DIR` 就相对那个子目录，空格会被忽略）：

```yaml
# 仓库变量
REQUIRED_ARTIFACTS: lib/index.js,lib/client.js,cordis.patch.yml
```

- 校验发生在 `Prepare package`，即 **Build 之后、`npm pack` 之前**：构建产物没生成就会在这里停住，并一次性列出所有缺失项。
- **不设置或留空 = 不校验**（模板不预设任何项目专属路径，避免复制到别的仓库后误报）。
- 它检查的是工作区里的文件，不是 tarball 的内容；只想知道"构建有没有产出这些文件"就够了。产物路径不适用时（比如纯源码包）保持留空即可。

## webhook 载荷契约（v1）

顶层包含非空的 `title`（仓库名）与 http(s) `url`（**只放 npm 给出的一次性授权链接**）。没有可用链接时**整条通知不发送** —— 宁可不发，也不拿 run 页面或 registry 首页顶替，所以接收端的提取规则 `{"title": "title", "url": "url"}` 取到的每一条都值得点。

二次验证场景（`phase: npm-2fa`）：

```json
{
  "title": "owner/repo",
  "url": "https://registry.npmjs.org/-/auth/login/abc123",
  "schema": "dsh.release.notify/v1",
  "event": "release",
  "phase": "npm-2fa",
  "repository": "owner/repo",
  "version": "1.4.0",
  "package": "@scope/name",
  "dist_tag": "latest",
  "prerelease": false,
  "dry_run": false,
  "summary": "请打开链接完成二次验证，完成后发布即完成：https://registry.npmjs.org/-/auth/login/abc123",
  "auth": {
    "kind": "npm-2fa",
    "url": "https://registry.npmjs.org/-/auth/login/abc123",
    "code": "",
    "expires_at": ""
  },
  "release": {
    "npm_url": "https://www.npmjs.com/package/@scope/name/v/1.4.0",
    "tarball": "scope-name-1.4.0.tgz"
  },
  "request_id": "owner/repo@1.4.0-42-1",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

实际会发送的 `phase` 只有三种：

| `phase` | 何时 | `url` 来源 |
| --- | --- | --- |
| `npm-login-required` | npm 未登录 | `npm login --auth-type=web` 打印的 `Login at:` 链接（`/auth/cli/<uuid>` 或 `/login?next=/login/cli/<uuid>`） |
| `npm-2fa` | 发布需要二次验证 | `EOTP` 里的 `authUrl`（`…/-/auth/login/<id>`） |
| `failed` | 发布失败，且失败输出里恰好带着一条没走完的授权链接 | 同上的链接；没有链接时同样不发 |

版本已存在时按幂等成功静默退出，不推送，避免重复推 tag 刷屏；普通进度、成功、以及不带链接的失败都**不会**打扰你。

**只会发送一次性授权链接**：`/auth/cli/<uuid>`、`/login?next=/login/cli/<uuid>`、`/-/auth/login/<id>`；run 页面（`https://git.…/actions/runs/11`）、registry 首页（`https://registry.npmjs.org`）、`/-/web-login`、`/signin` 这类泛登录页、以及验证挑战的 `doneUrl`（`…/-/auth/done/<id>`）**永远不会被发送**；没有可用链接时宁可不发。因此收到 webhook 就等于"有一条需要你点的链接"。

**不同网址都会推送**（登录一条、二次验证一条）；**完全相同的网址只推一次**（同一 run 内用 `RUNNER_TEMP` 里以 `request_id + url` 的摘要命名的标记文件去重）。

### 接收端配置（message-pusher 自定义 Webhook）

**提取规则**：

```json
{ "title": "title", "url": "url" }
```

如果想在消息正文里也带上状态与版本，可另加提取项（键名随意，构建规则里用 `$` 引用），例如：

```json
{ "title": "title", "url": "url", "phase": "phase", "version": "version", "summary": "summary" }
```

**构建规则**（键固定，值必须是字符串）：

```json
{
  "title": "$title",
  "description": "$summary",
  "content": "$summary",
  "url": "$url"
}
```

### 校验投递

不依赖 Forgejo，本地即可验证载荷与投递（`node` ≥ 20）：

```bash
# 起个假接收端
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.writeHead(200,{'content-type':'application/json'});s.end('{\"success\":true}')})}).listen(8791)"
# 另一个终端：打印一次 npm-2fa 信封
node -e "
import('/absolute/path/to/.forgejo/scripts/notify-lib.mjs').then(async (lib) => {
  const env = { RUNNER_TEMP: '/tmp', MESSAGE_PUSHER_URL: 'http://127.0.0.1:8791/webhook/test', GITHUB_REPOSITORY: 'owner/repo' };
  const payload = lib.buildPayload({ phase: 'npm-2fa', env, core: { repo: 'owner/repo', name: '@scope/name', version: '1.4.0' }, auth: { kind: 'npm-2fa', url: 'https://registry.npmjs.org/-/auth/login/abc123' } });
  console.log(JSON.stringify(payload, null, 2));
  console.log(await lib.deliver(payload, { env }));
});
"
```

等价 curl（自定义 Webhook 收到的最小字段）：

```bash
curl -sS -X POST "$MESSAGE_PUSHER_URL" \
  -H 'Content-Type: application/json' \
  -d '{"title":"owner/repo","url":"https://registry.npmjs.org/-/auth/login/abc123"}'
```

也可以直接检查「漏配地址」与「链接是否会被发送」：

```bash
node -e "import('/absolute/path/to/.forgejo/scripts/notify-lib.mjs').then((lib) => {
  try { lib.assertNotifyConfigured({}); } catch (error) { console.log('如预期报错：' + error.message); }
  console.log('registry 首页会被发送吗：' + lib.isAuthUrl('https://registry.npmjs.org/'));
})"
```

## 行为细节

- **只在 tag 上发布**：工作流不 commit、不 push、不打标签；`prepare` 只把 `package.json` 的 version 对齐到 tag 版本（不提交），发布完成后工作区不再有用。
- **幂等**：preflight 查询 `npm view <pkg> versions dist-tags --json`；版本已存在时写 `already_published=true` 并退出 0，workflow 中 Test/Build/Prepare/Publish 都带 `if: steps.preflight.outputs.already_published != 'true'`。重推同一个 tag 会得到一次绿色的空操作，而不会在 registry 上撞出 `cannot publish over the previously published versions`。
- **查询失败不等于首次发布**：只有确认 `E404` 才按首次发布继续；网络错误、权限错误、包名写错都会直接失败，避免把包发到错误的 name 上。
- **tag 未移动**：tag 的提交与当前 checkout（`HEAD`）不一致时拒绝发布。用 `HEAD` 而不是事件里的 `GITHUB_SHA`，因为 annotated tag 的 SHA 可能是 tag 对象本身。
- **产物校验在 Build 之后**：`REQUIRED_ARTIFACTS` 在 `Prepare package` 里、`npm pack` 之前校验；留空则不检查。
- **dry-run 什么都不写**：`npm publish --dry-run` 不写 registry，**也不会创建 Forgejo Release**，并且跳过通知地址校验与登录。
- **认证总预算是单一时限**：`NPM_AUTH_WAIT_MINUTES` 覆盖登录、二次验证与重试的全部等待，不会出现"每一步各等一次、加起来超过 job 超时"的情况。
- **一次性验证码不落日志**：`--otp` 的值在日志里显示为 `***`，失败通知里的原始输出也会先做同样处理并截断到 1.2 KB。
- **地址必须由仓库提供**：脚本里没有任何内置地址。预检阶段校验 `MESSAGE_PUSHER_URL`（dry-run 除外），缺失或不是 http(s) 就直接失败。

## 已知限制

- 只发布到 npm registry。Forgejo 自带包注册表 / 容器镜像不在本 Action 范围内。
- 依赖 runner 提供 `docker` label 的容器任务；默认镜像 `node:22-bookworm`。
- 依赖 `actions/checkout@v4`（Forgejo 默认 actions registry）。若实例无法访问，请改成全限定 URL `https://code.forgejo.org/actions/checkout@v4`。
- **npm ≥ 10.9 且镜像里有 `script(1)`**：这是网页认证的两个前提。缺 `script` 时登录/二次验证拿不到可转发的链接（`Ensure container tools` 会尝试装上）。
- npm 输出的文案由 npm 决定；若 npm 改版，链接提取可能落到回退解析（仍只认一次性授权链接），最坏情况是没有可发送的链接（宁可不发）。
- **手工 `workflow_dispatch` 必须在 tag 对应的提交上触发**，否则 preflight 会以"tag 指向的提交与当前 checkout 不一致"拒绝。
- 该 registry 只接受手输验证码（不返回 `authUrl`）时，没有可转发的链接；此时用 dispatch 的 `otp` 输入完成发布。
- **`github.action_path` 在这里是空的**：该变量只在 runner 执行「本地 action」（`uses: ./…`）时才有值，而本目录是**工作流**，不是 action。因此 `Locate action directory` 步骤不依赖它，按以下顺序定位：
  1. `$GITHUB_WORKSPACE/.forgejo`（`.forgejo` 复制到仓库根目录的标准布局）；
  2. `$GITHUB_WORKSPACE` 下任意含 `workflows/` + `scripts/publish.mjs` 的目录（应对 `checkout` 指定了 `path:` 或目录被重命名）；
  3. 从 `$GITHUB_WORKSPACE` 向上最多 3 层（应对旧版 runner 把仓库挂在工作区旁边）。

  三者都失败时会打印 `github.action_path`、`GITHUB_WORKSPACE`、工作区内候选路径、以及工作区上/下级目录，便于直接定位布局问题。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `未配置通知地址` | 在 `设置 → Actions → Variables` 里加 `MESSAGE_PUSHER_URL`（本 Action 不内置地址） |
| `找不到 Action 目录` | 确认 `.forgejo/` 整目录在仓库里（含 `workflows/` 与 `scripts/notify-lib.mjs`）；报错里会列出实际找到的路径 |
| `找不到 npm` / `npm 10.x 低于 10.9.0` | 换用官方 Node 镜像（自带 npm），或在镜像里预装较新的 npm |
| apk/apt/yum 报 `unable to select packages`、`Could not connect`、`HTTP 404/308` | 多半是把**镜像站**当成了代理。apk/yum 镜像填 `APK_REPO` / `YUM_REPO`，apt 镜像填 `APT_PROXY`（会自动识别，见「代理、镜像与 registry」）；真要给 apk/yum 配代理就用通用的 `HTTP_PROXY`/`HTTPS_PROXY` |
| `该仓库的锁文件要求用 pnpm/yarn 安装依赖…` | 镜像里没有该包管理器也没有 corepack。换用自带它的镜像、在镜像里预装，或删掉对应锁文件改用 npm |
| 两个 run 同时发同一个 tag，后者报 `EPUBLISHCONFLICT` | 正常竞态：Preflight 都通过了，谁先发谁赢。Action 会向 registry 核对这个版本确实已经在线上，然后**按已发布处理**（绿），不会把并发的后一棒判红；只有冲突的不是本次版本时才失败 |
| `registry 对 <包> 返回空结果` | 第三方 registry 的已知行为（npm/cli#6408：包在，但 `npm view` 什么都不输出）。Action 会改用 `npm view <包>@<dist-tag> version` 再确认一次，仍拿不到就按首次发布继续，发布本身是最后一道保险 |
| 发布时 `sh: pnpm: not found`、`npm error code 127` | 这是**项目自己的脚本**（通常是 `prepublishOnly`）调用了 runner 里没有的命令。发布走的是 Prepare 的 tarball，本就**不会**触发 `prepublishOnly`；若仍报错说明 Test/Build 脚本里也调了它 —— 在该仓库 `package.json` 加 `"packageManager": "pnpm@<版本>"`（Action 会用 corepack 装上），或把脚本改成用 npm |
| `npm 无法完成二次验证，也没有给出可网页完成的链接` | 镜像缺 `script(1)`（装 util-linux）、npm 太旧、或该 registry 只认手输验证码（用 dispatch 的 `otp` 输入） |
| `授权链接投递失败` | webhook 地址 / token 配错。人工没有链接就无法完成认证，所以默认让 job 失败；确认接收端可用后可临时设 `NOTIFY_REQUIRED=false` |
| `版本必须严格大于 registry 上的 latest` | tag 版本比 npm 上的旧；删掉 tag 换新版本，或确认是否想重发 |
| `构建产物缺失` | 检查 `REQUIRED_ARTIFACTS`（默认不检查）或该项目的产物路径；注意它是在 Build 之后校验的 |
| `npm 退化为用户名/密码提示` | 该 registry 不支持 npm 的网页登录（Verdaccio / 多数内网 registry 都是）。把 `NPM_CONFIG_REGISTRY` 指回 npmjs；只想让装依赖走内网镜像时，用项目 `.npmrc` + `publishConfig.registry`，或改用 trusted publishing (OIDC)。检测到该提示会**立即失败**，不会空等认证预算 |
| `查询 registry 失败，无法确认 …是否已发布` | `npm view` 非 404 失败（网络/权限）。修好 registry 或 `NPM_CONFIG_REGISTRY` 再重试；只有确认 404 才会按首次发布继续 |
| `npm 认证状态：未登录` | 正常现象：把推送里的登录网址在浏览器打开完成登录；工作流会在预算内自动重试 |
| 重推同一个 tag | 版本已存在时是**绿色空操作**，Test/Build/Prepare/Publish 会被跳过；如果只是缺 Release，`Create Forgejo release` 仍会补建 |
| 收不到推送 | 正常情况之一：本 Action **只在有一次性授权链接时才推送**，普通进度/失败/成功不会打扰你。确认 `MESSAGE_PUSHER_URL`（如需 `MESSAGE_PUSHER_TOKEN`）配置正确即可 |

## 首次使用需要在真实实例上确认的点

本目录的代码在源仓库经过了单元测试与端到端冒烟（用假 npm 驱动真实的分段程序，并在有 `script(1)` 的环境里跑过真实伪终端路径），以下几项只有真实 Forgejo + runner 才能确认，建议第一次先推一个 `-rc` 预发布 tag 或先用 `dry_run` 演练：

1. `Locate action directory` 能否找到 `.forgejo`，以及 `$GITHUB_ENV` 里的 `FORGEJO_DIR` 是否对后续步骤可见（失败时会打印候选路径与目录树）。
2. runner 是否提供 `docker` label，以及 `container: node:22-bookworm` 能否拉取。
3. `actions/checkout@v4` 在该实例的 actions registry 是否可达（否则改用全限定 URL）。
4. npm 需要登录/二次验证时的实际输出是否被成功提取并转发（日志会打印是否命中）。
5. `FORGEJO_TOKEN` 是否有创建 Release 的权限（未配置时该步骤打印跳过）。

## 测试

本目录的代码在源仓库 `test/` 下有完整测试（直接 import 这里发布的同一批 `.mjs` 文件，另有把整目录复制成 `.forgejo` 后按真实步骤跑通的端到端用例）：

```bash
node --test test/*.test.mjs       # 运行全部测试
```
