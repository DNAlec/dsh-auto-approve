# Changelog

## 0.2.1

> 如果你用 0.2.0 装过、且 profile patch 还是出厂模板（注释 + `[]`），请升级：0.2.0 会把预设块追加在 `[]` 之后，写出 DSH 解析不了的 YAML，下次 `dsh web` 起不来。
> 0.2.1 还修掉了沙箱模式静默失效、非 web 组合不挂载、判定可被卡片回显诱导放行等问题。

### Fixes（本仓库 review 后的修复）

- **全新安装不再写坏 profile patch**：空 patch 的判定改为「剥掉注释后为空数组」，`注释 + []` 这种 DSH 出厂模板会被整段替换，不再产出 `[]` 后面跟条目的非法 YAML（那会让下次 `dsh web` 启动直接解析失败）。同时修掉「注释里提过 `auto-approve:` 就以为已配置」的子串假阳性。
- **沙箱模式不再静默失效**：`danger-full-access` 之类手改值会被改写；块里没有 `sandbox:` 行时返回 `err.presetSandboxMissing`，不再假装成功（以前 UI 说只读、实际全权限且不提示重启）。
- **profile 路径不再硬编码 `profiles/web`**：从 `ctx.baseUrl`（app-boot 锚在 profile 目录）推导，可用插件配置 `profilePatch` 覆盖；写入失败会打印具体文件与原因。
- **`inject` 去掉 `webServer`**：它是 fiber 的必需服务而 `webserver` 行只在 web-app bundle 里，之前 headless / acp / sdk 组合下整个审批门控都不会挂载。
- **判官卡片加围栏**（`<<<TOOL_CARD` … `TOOL_CARD>>>`）：出厂提示词明确声明围栏内是不可信数据；类别解析改为取**最后一个**「类别: id」行，卡片回显不能覆盖结论。
- **取消即停**：判定过程观察 `req.signal`，请求取消后不再跑完模型调用、也不再重试（返回 `cancelled`，不弹人工框）。
- **凭据关键词边界**：`.env` / `.netrc` 增加「路径干草」放宽匹配（`prod.env`、`x.env` 命中；命令里的 `process.env` 仍不误伤）；`id_rsa.pub` / `id_ed25519` 后跟 `.pub` 不再当凭据。
- **迁移只增不删**：不再从用户文件里删掉 `shutdown` / `reboot` 等旧预置词（分不清出厂继承与用户手写）；v10/v11 的出厂文案刷新改为逐字段比对出厂中/英原文，只刷新仍是原文的字段，不覆盖用户自定义 label/description。
- **缓存参数只按会话键取**：有 sessionId 时不再回落裸 `callId`，避免跨会话串味；裸键仍会在命中时清理。
- **推理档位留输出预算**：带 `reasoningEffort` 时 `maxTokens` 从 256 提到 1024，避免推理 token 吃光预算导致全量转人工。
- **访问模式徽标可撤销**：切走「自动审批」后盾牌+A 会被摘掉；扫描忽略文本节点，不再对每次文本变化做整篇 `querySelectorAll`。
- 新增：`CI`（push/PR 跑 test + check）、`npm run locales:sync`（client.js 内联字典由 `locales.mjs` 生成，`npm run check` 校验同步）。

### 复审补丁（修复本身的问题）

- 空 patch 判定再收紧：`[] # empty`（行尾注释）、`---` / `...` 文档标记也算空；`description: |` 之类**块标量**里的同名行不再被当成「已配置」。
- 预设插入位置改为按 `presets:` 的相对缩进计算，不再写死 4/6/8 空格：`- insert:` 形式（缩进的 `- id: permission`）、CRLF、`presets:` 下还没有子键、行尾带注释的 permission 行都能正确落位，不会追加出第二个 permission 行。
- `profilePatchFromBaseUrl` 用 URL 的 pathname 判断目录（`file:///x/?a=1` 不再少切一段），根目录 / 非法 URL 一律回落。
- `save-plugin` 改成事务式：沙箱写不进 patch 就回滚 `config.json`，避免「配置说只读、patch 是全权限」。
- 判官超时/重试的取消链接加了防御（`addEventListener` 不存在时不炸）、并补了竞态窗口；新增用例覆盖取消、卡片回显注入、决策事件、关键词改名、跨会话事件过滤。

### 复审第二轮（实机截图反馈 + 预设表冻结）

- **访问模式下拉里的「自动审批」现在也有盾牌+A**：React 先插入空按钮、再把标签塞进去，
  旧扫描只看 `addedNodes`，那条记录的 target 是标签自己，按钮永远不会被重新评估。
  现在对 childList 记录额外沿 target 向上找最近的触发器/menu 项重扫（不是扫整棵子树，
  流式输出时不会全量查询）。用 jsdom 复现并验证：静态渲染、分步提交、切走撤销、流式 20 次追加只触发 3 次子树查询。
- **下拉项徽标颜色对齐 DSH**：菜单行的注入图标改用 `var(--dsw-alias-label-tertiary)`（DSH `.itemIcon` 用的同一个 token），
  否则会继承菜单按钮的 `label-primary`，比旁边三个图标明显更黑；触发器保持 `color:inherit`（DSH `.trigger` 就是 `label-secondary`，与 `.triggerIcon` 一致）。
- **预设表冻结新增检测**：插件写进 profile patch 的 `permission` 行会整块替换 base 的 config
  （patch 语义不做深合并），DSH 新增出厂预设不会自动出现。启动时读 `@deepseek-ai/dsh-base`
  的 `cordis.patch.yml` 比对，缺哪些预设就打印日志并在设置页显示一张卡片（只提示，不自动改写用户文件）。

### 发布前复审（0.2.1 定稿）

- **文档结束标记不再写坏 patch**：列 0 的 `...`（以及 `---`）在写入前一律去掉。以前在 `...` 后面追加条目会产出**多文档** YAML，DSH 的 parsePatchList 直接抛错。
- **没有 `presets:` 的 permission 行不再变成死路**：行里有块状 `config:` 时把出厂表插进去（保留用户已有的 `defaultPreset` 等键）；连 `config` 都没有时追加整块；只有行内 flow config 才明确报 `err.noPresetsKey`（文本插入不安全，不猜）。
- **判定不再能被卡片回显诱导放行**：解析前先剥掉 `<<<TOOL_CARD … TOOL_CARD>>>` 围栏（未闭合的开围栏之后一律丢弃）。以前模型整段复述卡片时，卡片里的 `类别: safe` 会成为「最后一个匹配」。
- 「是否已配置」只看 permission 行自己的 `presets` 块：别的插件 presets 里的同名键不再被误认。

### Added

- Keyword layer: `.pem` matches as a file extension (`certs/server.pem`).
- Approval history shows empty write/edit bodies as `(empty)` / `(空)`, plus extra tool-card fields (input/text/body/message/pattern/selector/workdir).
- Settings: criteria label/description remount independently; add-forms clear only after RPC success; sandbox mode is not optimistic; judge catalog/info ignore stale responses.
- 关键词：`.pem` 按扩展名匹配（`certs/server.pem`）。
- 审批历史展示空写入/替换为 `(空)` / `(empty)`，并补齐工具卡片其它字段。
- 设置页：审核表标签/说明各自换 key；添加表单失败不清空；模式点选失败不改本地状态。
- Settings: mode applies on click (no extra Save). Judge model, prompt, and timeout share one Save. Status flashes at the top.
- 设置页：模式点选即写入；审核模型 / 提示词 / 超时共用一个保存。反馈条置顶。
- Settings: editable judge prompt per language, with restore-default. Empty `judgePrompts.zh` / `en` uses the shipped template (`{{criteria}}` inserts the current table).
- Shipped judge prompt is table-agnostic: generic classify rules only; no default criterion ids. Table-specific exceptions live in row descriptions.
- 设置页可按语言改审核提示词并恢复默认；空则用该语言出厂模板。
- 出厂提示词与审核表解耦，不再点名默认类别 id。
- Access chip: plugin client paints a shield+A on Auto-approve (no DSH patch).
- 访问模式芯片：插件客户端给「自动审批」补盾牌+A，不改 DSH。

## 0.2.0

### Breaking

- Human review is **Web-only**. QQ / WeChat / Feishu / Telegram channels are removed.
- Plugin config lives in `~/.dsh/auto-approve/config.json`. A readable 0.1.x `~/.dsh/approval-bridge/config.json` is migrated once (judge / preset / language only). QQ credentials are unused.

### Pipeline

- Keyword reject/human hay includes `session.header.cwd` (not `session.cwd`) and joins relative `file_path`/`path` onto cwd/workdir. Allow keywords still do not match the tool name or the session directory.
- Empty write/edit bodies are kept and shown on the judge card as `(empty)` / `(空)`. Missing payload still goes to a human.
- Connection RPC failures always include `{ code, message, details }` (`rpcFail`), matching the host `ConnectionRpcFailure` contract.
- Settings criteria label/description remount when the snapshot changes, so restore-defaults is not undone on blur.

### 中文

- **破坏性**：人工只走网页；去掉 QQ / 微信 / 飞书 / Telegram。插件配置改到 `~/.dsh/auto-approve/config.json`（可读的 0.1.x `approval-bridge/config.json` 会迁一次判定字段）。
- 关键词拒绝/人工干草含 `session.header.cwd`，相对路径会拼到 cwd/workdir；允许桶不含工具名和会话目录名。
- 空写入/替换仍进审核卡片（`(空)` / `(empty)`）。RPC 失败带 `message`。审核表恢复默认后输入框会随 snapshot 重挂。
