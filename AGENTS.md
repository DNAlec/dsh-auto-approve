# AGENTS.md

给在本仓库开发的 agent。先读 [README.md](README.md) / [README.zh.md](README.zh.md)，再改代码。

## 这是什么

DeepSeek Harness 的 Cordis 插件：审核模型自动审批 + 设置页。范围仅限审批。
对 DSH 审批栈是一个 `approval/request` answerer：允许 / 拒绝直接返回 outcome；转人工 `await next()` 交给原网页框。
Host API 以 DSH 源码为准：`/home/alec/deepseek-harness/`（审批 / 预设 / LLM）。

## 硬约束

- **改名必须四同步**：`package.json` name、`cordis.patch.yml` 的 name、`src/util.mjs` 的 `NAME`（→ index.mjs `export const name`）、`client.js` 的 `__ModuleLoader__.load({ id })` + `exports.name`。只改 package.json 重装会炸 `loaded without registering "..."`（client bundle 找不到注册）。RPC 路径 `/api/<名>` 与 client.js 的 `rpc.call('/api', '<名>')` 需一致（可独立于插件名）。
- `permissionPresets.current(session)`，禁止 `session.events`。
- Host Session 工作目录是 `session.header.cwd`，没有 `session.cwd`。
- `danger-full-access` 进入同一条判定管道，不因模式名短路。
- 管道：关键词（拒绝 > 人工 > 允许）→ 审核表由模型归类、程序按表执行。解析失败转人工。风险类默认拒绝；「安全」默认允许；「其他」默认人工（拿不准）。
- 审核提示词语言 `judgePromptLang`（`zh`|`en`）只换框架与卡片标签，不改当前审核表。恢复默认审核表按该语言加载出厂包。理由与框架同语言。
- 关键词只匹配工具名 + command + 路径 + workdir（workdir 含 `session.header.cwd`；相对 `file_path`/`path` 会拼到 cwd/workdir 上），不匹配理由、description、文件正文。允许桶不匹配工具名，也不匹配会话目录名（cwd 不进允许干草）。审核模型看网页工具卡片同款字段（含内容/code/url 等），不以模型理由为准。禁止 JSON.stringify live exec。
- 空字符串参数要保留（`write` 的 `content=''` 是截断文件）；审核卡片用 `(空)` / `(empty)` 展示。缺工具参数（无 command/path/content 等）转人工，禁止自动放行。任一字段超过送审限额算截断：仍可关键词拒绝，禁止关键词允许或模型标 safe。
- allowlist / 插件配置读失败不写盘；设置页除明确覆盖外不得覆盖损坏文件。恢复默认关键词必须含路径拒绝词（`shippedRejectKeywords()`），不能只用 `DEFAULT_DENY_KEYWORDS`。
- 设置页审核表 label/description 若用非受控 `defaultValue`，必须随 snapshot 换 `key` 重挂，否则恢复默认后 blur 会把旧文案写回。
- `auto-approve` 预设沙箱由设置 `presetSandbox`（`workspace-write` | `read-only`）写入 profile patch；改完需重启，并重新选择预设或开新会话。
- 配置只存在用户 `~/.dsh/auto-approve/`，禁止提交。
- 不改 `req`，不 abort `req.signal`。转人工必须 `await next()` 并把 outcome 原样返回。
- 不提供可写结算 API。只读过程用 `auto-approve/decision` 叶子字段。
- Host API 走已鉴权 `connection.rpc`，不上无鉴权 HTTP。Connection RPC 失败必须 `{ code, message, details }`（`rpcFail`）；缺 `message` 会让 client `parseConnectionResponse` TypeError。
- 纯 JS：无 TS / JSX / import 变换；Client React 用 `createElement`。网页文案走 `locales.mjs` 的 zh/en，经 `ctx.locale.register`。
- 命名导出 `name` / `inject` / `apply`，禁止 default export。

## 结构

```
src/index.mjs         宿主：approval/request、RPC、审计
src/rules.mjs         管道纯函数
src/preset-patch.mjs  把 auto-approve 写入 profile patch
src/util.mjs          路径与 JSON / 审计
client.js             绿/橙条、审批 tab、设置页
locales.mjs           Client zh/en 字典（键集以 zh 为准）
```

Host `inject`：`approval`、`permissionPresets`、`llm`、`timer`、`webServer`。RPC 用 `ctx.inject(['connection'], …)` + `connection.fetch.register({ path: '/api/dsh-auto-approve' })`。禁止 `rpc.handle`（它会在 connection 自己的 ctx 上碰 `webServer`）。
Client 插件 `inject`：`connection`、`slots`、`locale`；`rpc.call('/api', 'dsh-auto-approve', { endpoint, payload })`。
`package.json` 的 `dsh.client.inject` 是打包时声明依赖的其它 client 包（connection / locale / settings-general），不是本插件 `apply` 的 inject 列表。

RPC、Slot 全部进 Fiber disposer。`bundle.patch` 只插入本插件行，不整表替换 `permission`。
安装：`dsh plugin --profile web add <本仓库路径>`，重启 `dsh web`。
