# npm-publish

Forgejo Action：**推送 tag 即发版**。流程参照仓库根目录的 `release.sh`（版本校验 → 测试构建 → 打包检查 → 发布 → 建 Release），但**没有人工确认环节**；npm 需要登录或二次验证时，把**验证网址 / 登录网址**用 `POST + application/json` 推送到指定 webhook，人工在浏览器完成后 npm 自己继续。

```
push tag v1.4.0
      │
      ├─ 解析版本（tag 即版本）             resolve
      ├─ 预检：private/产物/tag 未移动/registry 版本比对   preflight
      ├─ 测试、构建、npm pack + sha256      Test / Build / prepare
      ├─ npm whoami → 未登录则发起 npm login --auth-type=web
      │     └─ npm 打印 https://www.npmjs.com/auth/cli/<uuid> → 原样推给你
      │     └─ npm 进程持续轮询，等你浏览器点完授权后自己结束
      ├─ npm publish（--access public --tag <dist-tag>）        publish
      │     ├─ 需要二次验证 → npm 再返回一个 auth/cli/<uuid> 网址 → 再推给你
      │     └─ 你在浏览器确认后 npm 自己完成提交
      ├─ 创建 Forgejo Release（changelog）   release
      └─ 任一步失败 → 推送 failed 通知（url 回退为 run 页面）
```

**不需要任何 npm token**：认证完全由人工完成，runner 里不保存凭据。

## 安装

把整个 `npm-publish/` 目录复制到目标仓库，并改名为 `.forgejo`：

```bash
cp -r npm-publish /path/to/target-repo/.forgejo
```

复制后的目录结构（**必须整目录复制**：workflow 只是编排，逻辑都在脚本里）：

```
.forgejo/
├── workflows/
│   └── npm-publish.yml            # 165 行，只有编排；唯一的 shell 是定位入口那 3 行
└── scripts/                       # 全部逻辑，普通 .mjs 文件
    ├── run.mjs                    # 分发器：每个步骤一行调用它
    ├── deps.mjs                   # 缺工具时用 apk/apt/yum 安装 + 代理映射
    ├── locate-action.mjs          # 找 Action 目录（github.action_path 为空的情况）
    ├── notify-lib.mjs             # webhook 载荷、投递、认证链接判定
    ├── verification-parse.mjs     # 从 npm 输出里提取授权链接与验证码
    ├── resolve.mjs                # tag → 版本/dist-tag/运行信息
    ├── preflight.mjs              # 预检：private/产物/tag 未移动/registry 比对
    ├── prepare.mjs                # 对齐版本 + npm pack + sha256
    ├── publish.mjs                # 网页登录 → 二次验证 → 发布
    ├── release.mjs                # 建 Forgejo Release
    └── notify-failure.mjs         # 失败收尾
```

workflow 里每一步都长这样（`配置里没有内嵌脚本`）：

```yaml
      - name: Publish to npm
        run: |
          dir="${{ steps.locate.outputs.forgejo_dir }}"
          node "$dir/scripts/run.mjs" publish
```

唯一的例外是定位步骤本身 —— 它必须先找到 `run.mjs` 才能调用它，所以有 3 行引导（依次尝试
`${{ github.action_path }}`、`$GITHUB_WORKSPACE/.forgejo`、在仓库内搜索 `*/scripts/run.mjs`）。

可用子命令：`locate-action`、`ensure-tools`、`verify-action`、`install-deps`、`resolve`、`preflight`、
`test`、`build`、`prepare`、`publish`、`release`、`notify-failure`；都能在本地直接跑，例如
`GITHUB_WORKSPACE=$PWD node scripts/run.mjs locate-action`、
`APK_PROXY=http://proxy:8080 node scripts/run.mjs ensure-tools`。

复制不全会被 `verify-action` 拦下并逐个列出缺哪个文件。

还要在目标仓库里配置：

1. `设置 → Actions`：勾选 **Enable Repository Actions**。
2. `设置 → Actions → Secrets`：`FORGEJO_TOKEN`、`MESSAGE_PUSHER_TOKEN` 按需（没有 npm token 类配置）。
3. `设置 → Actions → Variables`：**`MESSAGE_PUSHER_URL`（必填）** —— 推送到哪个地址由仓库配置决定，Action 里不内置任何地址，因此换仓库不会被带到别处。
4. 该仓库有可用的 runner，且 runner 能出网访问 registry 与你的推送地址。

### 容器镜像要求（Alpine / 精简镜像）

| 需要 | 说明 |
| --- | --- |
| `sh` | 工作流用 `shell: sh` 运行，**不依赖 bash**（Alpine、distroless 等都能跑） |
| `node` | 镜像里要有 Node ≥ 18；`container.image` 默认 `node:22-bookworm` |
| `script` | **可选**。npm ≥ 11.9.0 用管道就能拿到授权链接；只有更旧的 npm 才需要它（作为回退） |
| `timeout` | 用于给登录/验证设定等待上限（busybox 自带） |

**缺失的工具会自动安装**：`Ensure container tools` 步骤会探测 `git`/`script`/`timeout`，缺哪个就用镜像自带的包管理器（`apk` / `apt-get` / `yum` / `dnf` / `microdnf`）装，并通过下面的代理变量走网。用 `SKIP_TOOL_INSTALL=true` 可关闭（离线镜像已经预装工具时用）。非 root 且无 `sudo` 时会跳过安装并打印需要手动执行的命令。

**Alpine 用户**：直接可用，不需要额外装包。

```yaml
    container:
      image: node:22-alpine
```

原因：`npm login` 在没有终端时也会打印登录网址；`npm publish` 需要二次验证时会以 EOTP 报错并在其中带上 `authUrl`/`doneUrl`（npm ≥ 11.9.0）。脚本从这些输出里取链接，并轮询 `doneUrl` 换到一次性 token，再用 `--otp` 重试 —— 全程不用终端，因此也不需要 `script(1)`。

跑到 `Verify action scripts` 步骤时日志会打印能力探测结果：

```
运行环境：sh=ok script(PTY)=缺失 timeout=ok
```

`script(PTY)=缺失` 在 npm ≥ 11.9.0 时**不影响发布**；只有当镜像里的 npm 更旧、且需要网页登录/二次验证时，`ensure-tools` 才会去装 `util-linux`（提供 `script`）作为回退。

### 代理（无直连出网时）

runner 没有直连外网时，把下列仓库变量填上；它们会同时用于**包管理器安装**、`npm`、`git`：

| 变量 | 作用 |
| --- | --- |
| `ALL_PROXY` | 通用兜底（`socks5://…` 也可以） |
| `HTTP_PROXY` / `HTTPS_PROXY` | 标准 HTTP 代理 |
| `NO_PROXY` | 不走代理的地址（如 `localhost,.internal`） |
| `APT_PROXY` | apt 专用，**优先于**上面的通用变量（apt 不支持 socks5，就需要它单独指 HTTP 代理） |
| `APK_PROXY` | apk 专用，同上 |
| `YUM_PROXY` | yum/dnf 专用，同上 |
| `GO_PROXY` | Go 模块代理 |
| `NPM_CONFIG_PROXY` | 只影响 npm |

取值优先级（以 apt 为例）：`APT_PROXY` → `HTTP_PROXY`/`HTTPS_PROXY` → `ALL_PROXY`。变量会同时以大写和小写形式导出（`http_proxy`/`HTTP_PROXY`），因为不同工具认不同写法；`NO_PROXY` 也一样。

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
| 手工 `workflow_dispatch` | `version` 必须与已有 tag 一致；`otp` 用于 npm 二次验证；`dist_tag` 覆盖 dist-tag；`dry_run` 只演练 `npm publish --dry-run` |

dist-tag 默认：正式版 `latest`，含 `-` 的预发布版 `next`；可用仓库变量 `RELEASE_DIST_TAG` 或 dispatch 输入覆盖。

## 配置项

### Secrets

| 名称 | 必需 | 说明 |
| --- | --- | --- |
| `FORGEJO_TOKEN` | 否 | 建 Forgejo Release 用的 PAT（仓库写权限）。未配置时自动跳过建 Release，只发 npm |
| `MESSAGE_PUSHER_TOKEN` | 否 | 你的推送服务设了 token 时填写；自定义 Webhook 下会作为 `Authorization: Bearer` 发送 |

> 没有任何 npm 凭据类 secret：`NPM_TOKEN` / `NODE_AUTH_TOKEN` 都不需要，工作流不读取、也不传递它们。

### Variables

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `NPM_PUBLISH_RUNNER_LABEL` | `docker` | 覆盖 `runs-on` 的标签名。仓库的 runner 标签叫别的名字（如 `docker1`）时设它 |
| `NPM_PUBLISH_IMAGE` | `node:22-bookworm` | 覆盖 job 容器镜像。需要内网镜像时设它，例如 `registry.example.com/mirror/node:22-bookworm` |
| `MESSAGE_PUSHER_URL` | **必填，无默认值** | 通知接收地址，例如 `https://<你的域名>/webhook/<id>`。脚本里不内置任何地址，必须由目标仓库配置；未配置时预检直接失败并提示。含 `/push/` 时按 message-pusher 原生接口发送，否则发送原始 v1 信封 |
| `NOTIFY_REQUIRED` | `true` | 通知投递最终失败时是否让 job 失败（`false` 只告警） |
| `NOTIFY_TITLE_REPO_ONLY` | `false` | `true` 时 `title` 只取仓库名（`repo`），默认 `owner/repo` |
| `REQUIRED_ARTIFACTS` | `lib/index.js,lib/client.js,cordis.patch.yml` | 构建产物必含清单，逗号分隔；不适用时设成空字符串 |
| `PKG_TARGET_DIR` | 空 | monorepo 子目录，例如 `packages/plugin` |
| `SKIP_TEST` | 空 | `true` 跳过 `npm test` |
| `SKIP_BUILD` | 空 | `true` 跳过 `npm run build`（无 build 脚本时自动跳过） |
| `RELEASE_DIST_TAG` | 空 | 固定 dist-tag |
| `NPM_AUTH_WAIT_MINUTES` | `15` | 每次等待人工授权的上限（`npm login` 与 `npm publish` 各自计时）；超时后推送 `failed` |
| `NPM_LOGIN_POLL_MINUTES` | `5` | 登录进程退出后仍继续探测 `npm whoami` 的额外窗口 |
| `NPM_AUTH_RETRY_DELAY_SECONDS` | 空 | 每次重试之间的等待秒数（默认 30s；从网址拿到验证码时 5s）。主要给测试用 |

## webhook 载荷契约（v1）

顶层**始终**包含非空的 `title`（仓库名）与非空的 http(s) `url`（验证/登录网址，无验证场景回退为本次 run 页面），因此接收端的提取规则 `{"title": "title", "url": "url"}` 一定能取到值。

二次验证场景（`phase: npm-2fa`）：

```json
{
  "title": "owner/repo",
  "url": "https://www.npmjs.com/auth/cli/9f0d0e3c?code=654321",
  "schema": "dsh.release.notify/v1",
  "event": "release",
  "phase": "npm-2fa",
  "repository": "owner/repo",
  "version": "1.4.0",
  "package": "@scope/name",
  "dist_tag": "latest",
  "prerelease": false,
  "dry_run": false,
  "summary": "npm 要求二次验证或登录，请在 10 分钟内完成：https://www.npmjs.com/auth/cli/9f0d0e3c?code=654321",
  "auth": {
    "kind": "npm-2fa",
    "url": "https://www.npmjs.com/auth/cli/9f0d0e3c?code=654321",
    "code": "654321",
    "expires_at": ""
  },
  "release": {
    "run_url": "https://forgejo.example.com/owner/repo/actions/runs/42",
    "npm_url": "https://www.npmjs.com/package/@scope/name/v/1.4.0",
    "tarball": "scope-name-1.4.0.tgz"
  },
  "request_id": "owner/repo@1.4.0-42-1",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`phase` 取值：`publishing`、`npm-2fa`、`npm-login-required`、`published`、`failed`。（版本已存在时按幂等成功静默退出，不推送，避免重复推 tag 刷屏。）

**只会发送认证链接，其它一律不发**：载荷的 `url` 必须是 npm 打印的授权链接（路径含 `auth`/`login`/`signin`/`web-login`/`oauth`）。run 页面（`https://git.…/actions/runs/11`）、registry 首页（`https://registry.npmjs.org`）这类地址**永远不会被发送**；没有可用认证链接时宁可不发，也不会拿别的地址替代。因此收到 webhook 就等于"有一条需要你点的链接"。

`url` **永远是 npm 进程自己打印的那一条**，不做任何拼接或兜底：

| 阶段 | `phase` | 来源 |
| --- | --- | --- |
| 需要登录 | `npm-login-required` | `npm login --auth-type=web` 打印的 `auth/cli/<uuid>` |
| 需要二次验证 | `npm-2fa` | `npm publish` 打印的第二个 `auth/cli/<uuid>` |

关键点：**不需要伪终端**。npm 在无终端时同样会暴露授权链接：

| 场景 | 脚本从哪里拿到网址 | 拿到之后 |
| --- | --- | --- |
| 未登录 | `npm login --auth-type=web` 打印 `Login at:` + 链接 | **边打印边转发**（见下）；npm 自己轮询，脚本也可轮询 `doneUrl` |
| 需要二次验证 | `npm publish --json` 失败，错误 JSON 里的 `error.authUrl` / `error.doneUrl` | 转发 `authUrl`，轮询 `doneUrl`（202 继续等 / 200 返回 `{token}`），再用 `--otp=<token>` 重试 |

两个必须注意的实现点：

1. **登录链接必须边读边发**。`npm login` 打印链接后**不会退出**，它要一直轮询到你完成登录。如果等命令结束再取输出，就会死锁：你收不到链接 → 无法登录 → 命令不结束。脚本因此在输出流里一发现完整链接就立刻转发。
2. **npm 会先打印 registry 首页**：`npm notice Log in on https://registry.npmjs.org/` 紧跟真正的 `Login at:` 链接。脚本只认带会话的一次性链接（`/auth/cli/<uuid>` 或 `/login?next=/login/cli/<uuid>`），registry 首页、`/-/web-login`、普通 `/signin` 这类"点了也没用"的页面一律不发送。分块到达时，只有确认链接已完整（后面跟到分隔符）才发送，避免发出被截断的地址。

解析要点：npm 的报错 JSON 每一行都带 `npm error ` 前缀，脚本会先剥掉前缀再按 `{`…`}` 解析。

只有 **npm < 11.9.0** 才需要回退到 `script(1)` 伪终端（此时 `NPM_FORCE_PTY=true` 可强制启用）。脚本会先探测 npm 版本再决定。

**不同网址都会推送**（登录一条、二次验证一条）；**完全相同的网址只推一次**。

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
  const payload = lib.buildPayload({ phase: 'npm-2fa', env, core: { repo: 'owner/repo', name: '@scope/name', version: '1.4.0', runUrl: 'https://forgejo.example.com/owner/repo/actions/runs/1' }, auth: { kind: 'npm-2fa', url: 'https://www.npmjs.com/auth/cli/abc?code=123456', code: '123456' } });
  console.log(JSON.stringify(payload, null, 2));
  console.log(await lib.deliver(payload, { env }));
});
"
```

等价 curl（自定义 Webhook 收到的最小字段）：

```bash
curl -sS -X POST "$MESSAGE_PUSHER_URL" \
  -H 'Content-Type: application/json' \
  -d '{"title":"owner/repo","url":"https://www.npmjs.com/auth/cli/abc?code=123456"}'
```

也可以直接检查「漏配地址」的报错：

```bash
node -e "import('/absolute/path/to/.forgejo/scripts/notify-lib.mjs').then((lib) => {
  try { lib.assertNotifyConfigured({}); } catch (error) { console.log('如预期报错：' + error.message); }
})"
```

## 行为细节

- **只在 tag 上发布**：工作流不 commit、不 push、不打标签；`prepare` 只把 `package.json` 的 version 对齐到 tag 版本（不提交），发布完成后工作区不再有用。
- **二次验证转发**：日志原样输出 npm 的提示；同时从输出里提取 `auth/cli/<uuid>`（含查询串里的验证码）或旧版 `login` 链接，命中即推送一次；同一 run 内用 `RUNNER_TEMP` 标记去重。完全没有匹配到网址时，回退推送截断后的原始输出（≤4KB），保证提示能到人。
- **`pnpm login` 不适用**：容器里没有交互终端，工作流不会尝试登录。要用 OTP 就在 dispatch 时填 `otp`，或者用免 2FA 的 token。
- **幂等**：`npm view <pkg> versions` 已包含本次版本时直接成功退出；tag 与 `GITHUB_SHA` 不一致（tag 被移动）时拒绝发布。
- **通知幂等**：同一 `request_id` 在一个 job 内只投递一次。
- **地址必须由仓库提供**：脚本里没有任何内置地址（避免复制 Action 时把某个仓库的推送端带到别处）。预检阶段校验 `MESSAGE_PUSHER_URL`，缺失或不是 http(s) 就直接失败，不会在不知道往哪通知的情况下发布。

## 已知限制

- 只发布到 npm registry（`npm publish`）。Forgejo 自带包注册表 / 容器镜像不在本 Action 范围内。
- 依赖 runner 提供 `docker` label 的容器任务；容器镜像固定为 `node:22-bookworm`，使用 `corepack` 驱动 pnpm/yarn。
- 依赖 `actions/checkout@v4`（Forgejo 默认 actions registry）。若实例无法访问，请改成全限定 URL `https://code.forgejo.org/actions/checkout@v4`。
- npm 二次验证的输出格式由 npm 决定；若 npm 改了文案，转发可能只能回退到「推送原始输出」。
- **`github.action_path` 在这里是空的**：该变量只在 runner 执行「本地 action」（`uses: ./…`）时才有值，而本目录是**工作流**，不是 action。因此 `Locate action directory` 步骤不依赖它，按以下顺序定位：
  1. `$GITHUB_WORKSPACE/.forgejo`（`.forgejo` 复制到仓库根目录的标准布局）；
  2. `$GITHUB_WORKSPACE` 下任意含 `workflows/` + `scripts/notify-lib.mjs` 的 `.forgejo` 目录（应对 `checkout` 指定了 `path:` 或目录被重命名）；
  3. 从 `$GITHUB_WORKSPACE` 向上最多 3 层的 `.forgejo`（应对旧版 runner 把仓库挂在工作区旁边）。

  三者都失败时会打印 `github.action_path`、`GITHUB_WORKSPACE`、工作区内候选路径、以及工作区上/下级目录，便于直接定位布局问题。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `未配置通知地址` | 在 `设置 → Actions → Variables` 里加 `MESSAGE_PUSHER_URL`（本 Action 不内置地址） |
| `找不到 Action 目录` | 确认 `.forgejo/` 整目录在仓库里（含 `workflows/` 与 `scripts/notify-lib.mjs`）；报错里会列出实际找到的路径 |
| `npm 认证状态：未登录` | 正常现象：把推送里的登录网址在浏览器打开完成登录；工作流会在等待窗口内自动重试 |
| `版本必须严格大于 registry 上最新版` | tag 版本比 npm 上的旧；删掉 tag 换新版本，或确认是否想重发 |
| `构建产物缺失` | 检查 `REQUIRED_ARTIFACTS`，或该项目的产物路径 |
| 收不到推送 | 正常情况之一：本 Action **只在有认证链接时才推送**，普通进度/失败/成功不会打扰你。确认 `MESSAGE_PUSHER_URL`（如需 `MESSAGE_PUSHER_TOKEN`）配置正确即可 |
| 想知道投递内容 | 见上方「校验投递」；日志里也会打印「已把验证网址转发到 webhook（title=…）」 |

## 首次使用需要在真实实例上确认的点

本目录的代码在源仓库经过了单元测试与端到端冒烟（用假 npm 驱动真实的分段程序），但以下几项只有真实 Forgejo + runner 才能确认，建议第一次先推一个 `-rc` 预发布 tag 或先用 `dry_run` 演练：

1. `Locate action directory` 能否找到 `.forgejo`（它先试 `$GITHUB_WORKSPACE/.forgejo`，再做标记搜索；失败时会打印候选路径与目录树，照着报错调整即可）。
2. runner 是否提供 `docker` label，以及 `container: node:22-bookworm` 能否拉取、`corepack` 是否可用。
3. `actions/checkout@v4` 在该实例的 actions registry 是否可达（否则改用全限定 URL）。
4. npm 需要二次验证时的实际输出格式是否被成功提取并转发（日志会打印是否命中）。
5. `FORGEJO_TOKEN` 是否有创建 Release 的权限（未配置时该步骤直接跳过）。

## 测试

本目录的代码在源仓库 `test/` 下有完整测试（131 个用例，直接 import 这里发布的同一批 `.mjs` 文件，另有把整目录复制成 `.forgejo` 后按真实步骤跑通的端到端用例）：

```bash
node --test test/*.test.mjs                 # 运行全部测试
```
