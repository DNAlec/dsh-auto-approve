# AGENTS.md

给在本仓库开发的 agent。先读 [README.md](README.md) / [README.zh.md](README.zh.md)，再改代码。

## 这是什么

DeepSeek Harness 的 Cordis 插件：审核模型自动审批 + 设置页。范围仅限审批。
对 DSH 审批栈是一个 `approval/request` answerer：允许 / 拒绝直接返回 outcome；转人工 `await next()` 交给原网页框。
Host API 以 DeepSeek Harness 源码为准（审批 / 预设 / LLM）。

## 硬约束

- **改名必须四同步**：`package.json` name、`cordis.patch.yml` 的 name、`src/util.mjs` 的 `NAME`（→ index.mjs `export const name`）、`client.js` 的 `__ModuleLoader__.load({ id })` + `exports.name`。只改 package.json 重装会炸 `loaded without registering "..."`（client bundle 找不到注册）。RPC 路径 `/api/<名>` 与 client.js 的 `rpc.call('/api', '<名>')` 需一致（可独立于插件名）。
- `permissionPresets.current(session)`，禁止 `session.events`。
- Host Session 工作目录是 `session.header.cwd`，没有 `session.cwd`。
- `danger-full-access` 进入同一条判定管道，不因模式名短路。
- 管道：关键词（拒绝 > 人工 > 允许）→ 审核表由模型归类、程序按表执行。解析失败转人工。风险类默认拒绝；「安全」默认允许；「其他」默认人工（拿不准）。分类解析**取最后一个**「类别: id」行（卡片回显可能排在结论前面）；严格解析失败才模糊兜底，兜底跳过 `other` 与 allow 行，所以兜底只可能落 reject/human。
- 审核提示词语言 `judgePromptLang`（`zh`|`en`）只换框架、卡片标签和该语言出厂提示词，不改当前审核表。恢复默认审核表按该语言加载出厂包。理由与框架同语言。出厂提示词必须与审核表解耦：只讲通用归类规则，不点名出厂 id（deletion/safe/other 等）；表相关特例写在各行 description。`judgePrompts.zh` / `judgePrompts.en` 可覆盖出厂模板，空则用 `shippedJudgePromptTemplate`；模板用 `{{criteria}}` 插入当前审核表。设置页可改、可恢复默认。
- 关键词只匹配工具名 + command + 路径 + workdir（workdir 含 `session.header.cwd`；相对 `file_path`/`path` 会拼到 cwd/workdir 上），不匹配理由、description、文件正文。允许桶不匹配工具名，也不匹配会话目录名（cwd 不进允许干草）。审核模型看网页工具卡片同款字段（含内容/code/url 等），不以模型理由为准。禁止 JSON.stringify live exec。点文件凭据词（`.env` / `.netrc`）在命令干草里要求前置分隔（不误伤 `process.env`），在**路径干草**（`formatPathKeywordHay`，只有路径字段）里放宽，所以 `prod.env` 也命中；`id_rsa` / `id_ed25519` 后面跟 `.pub` 不算凭据。
- 空字符串参数要保留（`write` 的 `content=''` 是截断文件）；审核卡片用 `(空)` / `(empty)` 展示。缺工具参数（无 command/path/content 等）转人工，禁止自动放行。任一字段超过送审限额算截断：仍可关键词拒绝，禁止关键词允许或模型标 safe。
- allowlist / 插件配置读失败不写盘；设置页除明确覆盖外不得覆盖损坏文件。恢复默认关键词必须含路径拒绝词（`shippedRejectKeywords()`），不能只用 `DEFAULT_DENY_KEYWORDS`。
- 设置页审核表 label/description 若用非受控 `defaultValue`，必须随 snapshot 换 `key` 重挂，否则恢复默认后 blur 会把旧文案写回。
- `auto-approve` 预设沙箱由设置 `presetSandbox`（`workspace-write` | `read-only`）写入 profile patch；改完需重启，并重新选择预设或开新会话。patch 文件路径由 `ctx.baseUrl`（app-boot 锚在 profile 目录）推导，可用插件配置 `profilePatch` 显式覆盖，拿不到才回落 `profiles/web`。
- **patch 写入必须过 `preset-patch.mjs` 的纯函数**：判断「是否已有 auto-approve」用缩进键锚定（`findAutoApproveKey`），禁止 `includes('auto-approve:')`（注释、description、块标量 `description: |` 里的同名行都会骗到它，结果预设永不安装）；空 patch（`[]`、`[] # 注释`、`---` + `[]`、注释 + `[]`、只有注释）必须**整段替换**那个 `[]`，禁止拼出 `[]` 后面还有条目的 YAML（DSH 解析失败 → profile 起不来）。插入位置按 `presets:` 的相对缩进算（支持 `- insert:` 里缩进的 permission 行），不写死空格数。sandbox 行匹配词表外的值（如手改成 `danger-full-access`）要改写；块里没有 sandbox 行要报 `err.presetSandboxMissing`，不能返回 ok。
- patch 里列 0 的 `---` / `...` 是文档标记：写盘前必须去掉（`stripDocumentMarkers`），否则追加条目会产出多文档 YAML。「是否已有 auto-approve」只看 **permission 行自己的 presets 块**，别的插件 presets 里的同名键不算。permission 行没有 `presets:` 时：块状 `config:` 就插进去（保留它的其它键），没有 config 就追加整块，行内 flow config 明确报 `err.noPresetsKey`。
- 分类解析前先 `stripJudgeCardEcho` 剥掉回显的卡片围栏：卡片正文里的 `类别: safe` 不能成为「最后一个匹配」，否则模型复述卡片就能把结论改成 allow。
- 迁移只增不删：`normalizeAllowlist` 不得静默删除用户文件里已有的关键词（分不清出厂继承 vs 用户手写），也不得覆盖用户改过的 label/description（逐字段比对出厂中/英原文才刷新）。
- 配置只存在用户 `~/.dsh/auto-approve/`，禁止提交。
- 不改 `req`，不 abort `req.signal`。转人工必须 `await next()` 并把 outcome 原样返回。
- 不提供可写结算 API。只读过程用 `auto-approve/decision` 叶子字段。
- Host API 走已鉴权 `connection.rpc`，不上无鉴权 HTTP。Connection RPC 失败必须 `{ code, message, details }`（`rpcFail`）；缺 `message` 会让 client `parseConnectionResponse` TypeError。
- 纯 JS：无 TS / JSX / import 变换；Client React 用 `createElement`。网页文案源是 `locales.mjs` 的 zh/en（键集以 zh 为准），经 `ctx.locale.register`；client.js 里那两行内联字典由 `npm run locales:sync`（`scripts/sync-locales.mjs`）从 locales.mjs 生成，改文案只改 locales.mjs，`npm run check` 会校验是否同步。
- 命名导出 `name` / `inject` / `apply`，禁止 default export。

## 结构

```
src/index.mjs         宿主：approval/request、RPC、审计
src/rules.mjs         管道纯函数
src/preset-patch.mjs  把 auto-approve 写入 profile patch
src/util.mjs          路径与 JSON / 审计
client.js             绿/橙条、审批 tab、设置页、访问模式芯片盾牌+A
locales.mjs           Client zh/en 字典（唯一文案源；client.js 内联副本由 scripts/sync-locales.mjs 生成）
scripts/sync-locales.mjs  文案同步 / 校验（npm run locales:sync）
```

Host `inject`：`approval`、`permissionPresets`、`llm`、`timer`。**不要放 `webServer`**：它是 fiber 的必需服务，`webserver` 行只在 web-app bundle 里，放进来会让 headless / acp / sdk 组合停在 PENDING、连审批门控都不挂载。RPC 用 `ctx.inject(['connection'], …)` + `connection.fetch.register({ path: '/api/dsh-auto-approve' })`（不需要 webServer）。禁止 `rpc.handle`（它会在 connection 自己的 ctx 上碰 `webServer`）。
Client 插件 `inject`：`connection`、`slots`、`locale`；`rpc.call('/api', 'dsh-auto-approve', { endpoint, payload })`。
`package.json` 的 `dsh.client.inject` 是打包时声明依赖的其它 client 包（connection / locale / settings-general），不是本插件 `apply` 的 inject 列表。

客户端盾牌+A：`permissionGlyph` 只认三个内建预设值，`auto-approve` 只能靠 DOM 注入。
注入点必须覆盖「触发器按钮」与「`[role=menuitem]` 的自动审批项」，并且对 childList 记录
**额外沿 target 向上找最近的触发器/menu 项重扫**——React 先插入空按钮再插标签，
只看 addedNodes 会让下拉项永远拿不到徽标。切走后必须能摘掉（幂等双向）。

预设表冻结（patch 语义：按 id 覆盖时 config 是整块赋值，不做深合并）：DSH 新增出厂预设不会
自动进本 profile。启动时用 `readBasePresetKeys` + `presetDrift` 比对并提示，**不要**自动改写用户文件。

RPC、Slot 全部进 Fiber disposer。`bundle.patch` 只插入本插件行，不整表替换 `permission`。
安装：`dsh plugin --profile web add <本仓库路径>`，重启 `dsh web`。
