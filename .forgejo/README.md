# npm-publish

Forgejo Action：**推送 tag 即发版**。流程参照仓库根目录的 `release.sh`（版本校验 → 测试构建 → 打包检查 → 发布 → 建 Release），但**没有人工确认环节**；npm 需要登录或二次验证时，把**验证网址 / 登录网址**用 `POST + application/json` 推送到指定 webhook，人工在浏览器完成后 npm 自己继续。

```
push tag v1.4.0
      │
      ├─ 解析版本（tag 即版本）             resolve
      ├─ 预检：private/产物/tag 未移动/registry 版本比对/token   preflight
      ├─ 测试、构建、npm pack + sha256      Test / Build / prepare
      ├─ npm publish（--access public --tag <dist-tag>）        publish
      │     └─ 出现验证网址 → POST 到 webhook（title=仓库名, url=网址）
      ├─ 创建 Forgejo Release（changelog）   release
      └─ 任一步失败 → 推送 failed 通知（url 回退为 run 页面）
```

## 安装

把整个 `npm-publish/` 目录复制到目标仓库，并改名为 `.forgejo`：

```bash
cp -r npm-publish /path/to/target-repo/.forgejo
```

复制后的目录结构（**请整目录复制，`scripts/notify-lib.mjs` 是必需的**）：

```
.forgejo/
├── workflows/npm-publish.yml     # 全部流程与内联的 Node 程序
└── scripts/notify-lib.mjs        # webhook 载荷与投递逻辑（被上面内联程序 import）
```

还要在目标仓库里配置：

1. `设置 → Actions`：勾选 **Enable Repository Actions**。
2. `设置 → Actions → Secrets`：至少 `NPM_TOKEN`（见下表）。
3. `设置 → Actions → Variables`：**`MESSAGE_PUSHER_URL`（必填）** —— 推送到哪个地址由仓库配置决定，Action 里不内置任何地址，因此换仓库不会被带到别处。
4. 该仓库有可用的 `docker` 类型 runner，且 runner 能出网访问 `registry.npmjs.org` 与你的推送地址。

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
| `NPM_TOKEN` | 是 | npm 发布令牌。**推荐 Automation token 或 Granular token（Bypass 2FA）**，可完全免 OTP；同时以 `NODE_AUTH_TOKEN` 注入给 npm |
| `FORGEJO_TOKEN` | 否 | 建 Forgejo Release 用的 PAT（仓库写权限）。未配置时自动跳过建 Release，只发 npm |
| `MESSAGE_PUSHER_TOKEN` | 否 | 你的推送服务设了 token 时填写；自定义 Webhook 下会作为 `Authorization: Bearer` 发送 |

### Variables

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `MESSAGE_PUSHER_URL` | **必填，无默认值** | 通知接收地址，例如 `https://<你的域名>/webhook/<id>`。脚本里不内置任何地址，必须由目标仓库配置；未配置时预检直接失败并提示。含 `/push/` 时按 message-pusher 原生接口发送，否则发送原始 v1 信封 |
| `NOTIFY_REQUIRED` | `true` | 通知投递最终失败时是否让 job 失败（`false` 只告警） |
| `NOTIFY_TITLE_REPO_ONLY` | `false` | `true` 时 `title` 只取仓库名（`repo`），默认 `owner/repo` |
| `REQUIRED_ARTIFACTS` | `lib/index.js,lib/client.js,cordis.patch.yml` | 构建产物必含清单，逗号分隔；不适用时设成空字符串 |
| `PKG_TARGET_DIR` | 空 | monorepo 子目录，例如 `packages/plugin` |
| `SKIP_TEST` | 空 | `true` 跳过 `npm test` |
| `SKIP_BUILD` | 空 | `true` 跳过 `npm run build`（无 build 脚本时自动跳过） |
| `RELEASE_DIST_TAG` | 空 | 固定 dist-tag |
| `NPM_OTP_WAIT_MINUTES` | `10` | 验证网址在推送文案里提示的有效期（仅文案提示，npm 自身轮询为准） |

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

`phase` 取值：`starting`、`publishing`、`npm-2fa`、`npm-login-required`、`published`、`failed`。（版本已存在时按幂等成功静默退出，不推送，避免重复推 tag 刷屏。）

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
| `缺少 NPM_TOKEN secret` | 在仓库 secrets 里配置 `NPM_TOKEN`（Automation / Granular token 均可） |
| `版本必须严格大于 registry 上最新版` | tag 版本比 npm 上的旧；删掉 tag 换新版本，或确认是否想重发 |
| `构建产物缺失` | 检查 `REQUIRED_ARTIFACTS`，或该项目的产物路径 |
| 收不到推送 | 检查 `MESSAGE_PUSHER_URL` 与（如需要）`MESSAGE_PUSHER_TOKEN`；把 `NOTIFY_REQUIRED` 设 `false` 可先不让它阻塞发布 |
| 想知道投递内容 | 见上方「校验投递」；日志里也会打印「已把验证网址转发到 webhook（title=…）」 |

## 首次使用需要在真实实例上确认的点

本目录的代码在源仓库经过了单元测试与端到端冒烟（用假 npm 驱动真实的分段程序），但以下几项只有真实 Forgejo + runner 才能确认，建议第一次先推一个 `-rc` 预发布 tag 或先用 `dry_run` 演练：

1. `Locate action directory` 能否找到 `.forgejo`（它先试 `$GITHUB_WORKSPACE/.forgejo`，再做标记搜索；失败时会打印候选路径与目录树，照着报错调整即可）。
2. runner 是否提供 `docker` label，以及 `container: node:22-bookworm` 能否拉取、`corepack` 是否可用。
3. `actions/checkout@v4` 在该实例的 actions registry 是否可达（否则改用全限定 URL）。
4. npm 需要二次验证时的实际输出格式是否被成功提取并转发（日志会打印是否命中）。
5. `FORGEJO_TOKEN` 是否有创建 Release 的权限（未配置时该步骤直接跳过）。

## 测试

本目录的代码在源仓库 `test/` 下有完整测试（57 个用例，含从 YAML 提取内联程序后真实执行的端到端冒烟）：

```bash
node test/extract-action-logic.mjs          # 校验 YAML 里的内联程序标记完整
node --test test/*.test.mjs                 # 运行全部测试
```
