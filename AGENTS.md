# AGENTS.md

给在本仓库开发的 agent。先读 [README.md](README.md) / [README.zh.md](README.zh.md)，再改代码。

## 这是什么

DeepSeek Harness 的 Cordis 插件：审核模型自动审批 + QQ 官方 Bot 审批推送 + 设置页。范围仅限审批；QQ 入站只进票据经纪，不注入 agent 会话。

Host API 以 DSH 源码为准：`/home/alec/deepseek-harness/`（审批 / 预设 / LLM）。

## 硬约束

- `permissionPresets.current(session)`，禁止 `session.events`。
- `danger-full-access` 进入同一条判定管道，不因模式名短路。
- 管道：关键词（拒绝 > 人工 > 允许）→ 审核表由模型归类、程序按表执行。解析失败转人工。风险类默认拒绝；「安全」默认允许；「其他」默认人工（拿不准）。
- 审核提示词语言 `judgePromptLang`（`zh`|`en`）只换框架与卡片标签，不改当前审核表。恢复默认审核表按该语言加载出厂包。理由与框架同语言。
- 关键词只匹配工具名 + command + 路径 + workdir，不匹配理由、description、文件正文。允许桶不匹配工具名。审核模型看网页工具卡片同款字段（含内容/code/url 等），不以模型理由为准。禁止 JSON.stringify live exec。
- 缺工具参数（无 command/path/content 等）转人工，禁止自动放行。任一字段超过送审限额算截断：仍可关键词拒绝，禁止关键词允许或模型标 safe。
- allowlist / 插件配置读失败不写盘；设置页除明确覆盖外不得覆盖损坏文件。QQ 凭据损坏不覆盖，除非重新保存凭据或扫码。恢复默认关键词必须含路径拒绝词（`shippedRejectKeywords()`），不能只用 `DEFAULT_DENY_KEYWORDS`。
- `auto-approve` 预设沙箱由设置 `presetSandbox`（`workspace-write` | `read-only`）写入 profile patch；改完需重启，并重新选择预设或开新会话。
- 凭据只存在用户 `~/.dsh/`，禁止提交。
- 推送目标是插件配置的 QQ 聊天，与网页 session id 无关。
- 本插件自持 qqbot 连接；入站只进审批经纪，不注入 agent 会话。按私人 bot 设计：未绑定 chatId 时，私聊回复「是」「确认」「用作审批」「yes」「ok」即绑定该聊天。不要让陌生人能私聊。
- 不要 abort `req.signal` 关网页框。
- Host API 走已鉴权 `connection.rpc`，不上无鉴权 HTTP。
- 纯 JS：无 TS / JSX / import 变换；Client React 用 `createElement`。网页文案走 `locales.mjs` 的 zh/en，经 `ctx.locale.register`；QQ 推送与审计日志仍为中文。
- 命名导出 `name` / `inject` / `apply`，禁止 default export。

## 结构

```
src/index.mjs         宿主：approval/request、RPC、审计
src/rules.mjs         管道纯函数
src/tickets.mjs       短号票据与 QQ 文案
src/qqbot.mjs         官方 Bot token / WS / 收发
src/provisioning.mjs  官方扫码创建机器人（connector + 本机二维码）
src/preset-patch.mjs  把 auto-approve 写入 profile patch
src/util.mjs          路径与 JSON / 审计
client.js             绿/橙条、审批 tab、设置页
locales.mjs           Client zh/en 字典（键集以 zh 为准）
```

`inject`：`approval`、`permissionPresets`、`llm`、`timer`、`webServer`。RPC 用 `ctx.inject(['connection'], …)` + `connection.fetch.register({ path: '/api/dsh-auto-approve' })`。禁止 `rpc.handle`（它会在 connection 自己的 ctx 上碰 `webServer`）。Client `inject`：`connection`、`slots`、`locale`；`rpc.call('/api', 'dsh-auto-approve', { endpoint, payload })`。

QQ 连接、定时器、RPC、Slot 全部进 Fiber disposer。`bundle.patch` 只插入本插件行，不整表替换 `permission`。

安装：`dsh plugin --profile web add <本仓库路径>`，重启 `dsh web`。
