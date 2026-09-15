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
- **出厂关键词表只保留三类「零上下文就确定灾难、不该让模型有发言权」的红线**：① 清根 `rm -rf /`（写法同时覆盖 `rm -rf /*` 与 `sudo rm -rf /`，因为 `/` 后跟非字母数字就算词尾）；② 裸设备覆写/格式化（`of=/dev/`、`mkfs`、`wipefs`、`Format-Volume`、`Clear-Disk`、`diskutil eraseDisk`）；③ 门控自身配置（`DEFAULT_APPROVAL_CONFIG_KEYWORDS`）与私钥/云端凭据（`DEFAULT_SECRET_PATH_KEYWORDS`，**不含** `.env`/`.npmrc`/`docker/config.json`——这些工具会自己改写，交给 `credential` 行判）。**需要上下文才能判危险的词一律不加回词表**（递归删除家族、`chmod -R 777`、`git push --force`、破坏性 SQL、`terraform destroy`、`docker prune`/`volume rm`、关机重启），由审核表按说明判；新增/删除出厂词时同步 `RETIRED_DEFAULT_KEYWORDS` 留档（已有用户文件里的同名词不会被迁移删除，用户可自行挪桶）。
- **管道：关键词（拒绝 > 人工 > 允许）→ 缺参/截断开关 → 审核模型（类别 + 风险等级 + 理由）→ 按 (行, 等级) 查三格动作**。一条命令有多段（管道 / `&&` / `;`）时，提示词要求**同时**按最不可回补的一段给出类别与等级，关键词层本来就看整条命令。出厂三格：风险行三格 reject、`safe` 三格 allow、`other` 三格 human。提示词里有两条兜底面：① 一条命令多段时按最不可回补的一段；② 多行都像时选后果更不可回补的一行、等级也按那一行给——关键词表缩小后这两条是主要安全网，改框架时不要删。类别**取最后一个**「类别:」行（卡片回显可能排在结论前面）。
- **非表内结果一律按兜底行 `other` 的三格执行**（认不出 `src=none`、空输出 `empty`、超时 `timeout`、调用失败 `call`、无可用路由 `route`、插件异常 `plugin`）。**插件里不存在任何硬编码动作**：失败路径也走 `other` 的格子（`otherRowVerdict` / `resolveCriterionAction`）。请求被取消（`judged.aborted`）不产生 verdict，直接返回 `cancelled`。判定来源写进审计行与事件顶层 `src`（`clipJudgeForEvent` 还带 `level` / `levelSrc`），它是「模型答了 other」与「判定压根没跑成」的唯一区分手段——不要顺手删掉。
- **审核调用的输出预算按路由能力给，不按「配没配档位」给**：`judgeMaxTokens(effort, modelInfo)` —— `off` 与不配档位在适配层是**同一个请求**（pi-ai `streamSimple` 里 `clampedReasoning === "off" ? undefined : …`，即不传思考参数，模型仍按默认值思考），所以只要 `resolveModelInfo()` 报告了 `off` 之外的档位就必须给 1024（推理 token 与正文共享 `maxTokens`；给少了就是空正文 → `err.judgeEmpty` → 全量转人工，2026-09-14 那次故障的根因）。不推理的路由仍是 256。`err.judgeEmpty` 用 `judgeEmptyRetryMaxTokens()`（翻倍且 ≥1024）**重试一次**；分类认不出不重试（重试也认不出），请求已取消不重试。放宽预算的前提是 `callJudge` 仍只累加 `text-delta`：不要把 `reasoning-delta` 拼进正文，只统计字符数。
- **判定失败的现场必须落审计与事件**：审计行是按 `other` 的格子执行后的 `ALLOW` / `REJECT` / `HUMAN`，`judgeFailureNote(judged)` 拼在 `|` 之后（`src=` 标明原因），事件里带 `emptyOutput` / `emptyRetry` / `finishKind` / `reasoningChars` / `maxTokens`。原因：正文为空时 `error.raw` 是空串，而 `clipJudgeForEvent` 的 `put()` 会把空字符串字段整条丢掉，于是 events.jsonl 里「模型一个字都没吐」和「原始输出没记上」无法区分（`finish=max-tokens` + `reasoningChars` 大 + 正文空 = 推理吃光预算）。
- **本地/临时开发库要写进三行**：`deletion`、`remote`、`safe` 各有一句「能确认是本地/临时开发库（`sqlite3 dev.db`、一次性测试库）的常规改动不算」。删关键词的前提就是把上下文交给模型，只写 `remote` 不够——本地库 `drop table` 也会命中 `deletion`，`safe` 不列出来模型不敢选；同时 `remote` 必须保留「连接目标不明确时仍按本行判」的保守条款，不透明的 `$PROD_URL` 不许当本地库。
- **审核表一行 = 英文 `id` + `description`（什么情况下选这个 id）+ `actions` 三格（low/medium/high），没有 label**。id 由 `slugCriterionId` 归一（中文/非法字符会变空 → 拒绝新增），模型只输出 `类别: <id>` + `风险等级: <low|medium|high>` + `理由:`，动作由程序按 **(行, 等级)** 查格执行（`resolveCriterionAction`）；送审文本只有 `- id：说明`（`formatCriteriaLines`）与 `- low：说明`（`formatLevelLines`），不得出现 label 或动作词。审批历史、设置页、决策事件一律显示 id（客户端不再有 `criterion.*` 文案）。`normalizeCriterion` 保证每行有说明与三格：旧文件的 `label` 只作兜底来源（先当 id、再当说明），**旧 `action` 播种到三格**，两者规范化后都不再保留，下次写盘即消失；某一格写坏（不是 allow/reject/human 也不是空）→ 该格失败关闭 `human`，不影响其它格。
- **出厂表三格相同**（`sameActions`），不带任何放宽格：升级后行为与旧版逐字节一致，差异只可能来自用户自己拉开的格子。`cloneAllowlist` 必须深拷三格与 `levels.descriptions`，草稿改动不能提前改到活对象。**迁移步骤改默认动作必须走 `seedRowActions`**：`normalizeCriteria` 之后行上不再有 `action`，`prevVersion < 7 / 11 / 12` 那三步直接写 `row.action` 就是静默空操作；判断「这行是不是出厂默认」用 `allRowActions(row, 'reject')` 这类整体比较。
- **`other` 不可删除（`err.criterionOtherLocked`），但说明与三格都可改**。它同时承接「拿不准」「输出认不出」「判定没跑成」，是唯一的兜底行。框架只能靠这一行的**说明**指认它（提示词不点名 id、也没有占位符），说明改到认不出来时兜底会失锚——这是用户的选择，设置页给提示（`set.criterionOtherNote`）。
- **归类顺序：严格 → 整段裸 id → 模糊兜底（全表，含 `other` 与 allow 行）→ `other`（`src=none`）**。模糊兜底不再排除 `other` 与 allow 行（用户明确要求「不属于表中的其它内容都落 other」），代价是 `this looks safe to me` 这类散文可能落 allow——`src=fuzzy` 是唯一的量化手段。只有**正文为空**才抛 `err.judgeEmpty`（那是「没有输出」不是分类问题，会换更大预算重试一次）；`err.judgeParse` 已退出路由，只作展示。
- **等级：`JUDGE_LEVELS` 固定三档**（id 不可配、说明可配，非空校验 `err.levelNeedDesc`），`levels.fallback` 默认 `high`（`err.levelFallback`）决定「等级认不出」查哪一格。等级取最后一个**认得出**的值（`normalizeJudgeLevel` 是闭集，`critical`/`高危` 一律算认不出）。**`fallback` 绝不写进提示词**：那是程序侧行为，告诉模型只会让它偷懒不判。
- 审核提示词语言 `judgePromptLang`（`zh`|`en`，默认 zh）**设置页没有开关**：只在「恢复中文/英文默认审核表」「恢复中文/英文默认提示词」时选，选中即写入 config，并同时决定框架、卡片文案与理由语言。恢复默认审核表走 `rule-op {op:'reset',kind:'criteria',value:{lang}}`、恢复默认等级说明走 `{op:'reset',kind:'levels',value:{lang}}`，两者**各有各的恢复按钮**（并进一个会让用户修表时顺手冲掉自定义的等级说明），Host 在 `applyRuleOp` 成功后同步落 `pluginCfg.judgePromptLang` 并写 config（写盘失败要回滚内存值）；恢复默认提示词走 `save-plugin {judgePromptLang: lang, judgePrompts: {[lang]: ''}}`；**保存审核模型/超时不得携带 `judgePromptLang`**（否则会把语言写回旧值）。恢复默认审核表只换表，不动自定义提示词；出厂中英包 id/action 相同，**只有说明不同**。设置页只编辑当前语言那一份提示词，另加一行只读的「当前语言」。理由与框架同语言（模板里写死「用中文」/「in English」）。出厂提示词必须与审核表解耦：只讲通用归类规则，不点名出厂 id（deletion/safe/other 等），也不得出现任何出厂说明文案（含意译，如旧版的「已确认常规/可回补」——用户改名后就是悬空引用）；兜底只讲通用角色（「不符合其它行 / 拿不准的那一行」），表相关特例写在各行说明里。卡片字段会随工具变化，提示词不得写死字段清单，只讲「除模型理由和描述外的字段都是操作本身」。「允许/拒绝/人工」是动作词而非保留 id（设置页可自建同名 id）。输出格式只在模板里规定一次，必须要求纯文本（不要加粗/引号/代码块/JSON）。`judgePrompts.zh` / `judgePrompts.en` 可覆盖出厂模板，空则用 `shippedJudgePromptTemplate`；模板用 `{{criteria}}` 插入当前审核表、`{{levels}}` 插入风险等级说明（`buildJudgePrompt(criteria, levels, lang, template)`）。**占位符缺失时只追加定义，绝不追加输出格式**（格式只在模板里规定一次，两处规定会打架）；自定义模板没要求输出等级 → 全部落兜底档。设置页可改、可恢复默认。
- 关键词只匹配工具名 + command + 路径 + workdir（workdir 含 `session.header.cwd`；相对 `file_path`/`path` 会拼到 cwd/workdir 上），不匹配理由、description、文件正文。允许桶不匹配工具名，也不匹配会话目录名（cwd 不进允许干草）。审核模型看网页工具卡片同款字段（含内容/code/url 等），不以模型理由为准。禁止 JSON.stringify live exec。点文件凭据词（`.env` / `.netrc`）在命令干草里要求前置分隔（不误伤 `process.env`），在**路径干草**（`formatPathKeywordHay`，只有路径字段）里放宽，所以 `prod.env` 也命中。
- **自定义工具（MCP 等）的参数名不在 `TOOL_ARG_KEYS` 里不是缺参**：`pickToolArgs` 除已知字段外还收**未知键与嵌套叶子**（键带路径 `params.command`，深度 `GENERIC_ARG_DEPTH`、键数 `GENERIC_ARG_MAX_KEYS`、单叶 `GENERIC_ARG_LIMIT_DEFAULT` 各有上限，取值走 `safeEntry`：只取自有键、getter 抛错不算数）。这些叶子进关键词干草（**允许桶不进**：放行只能靠已知命令/路径字段）、进审核卡片（`参数 <键>: 值`，卡片自带行的键用 `isExtraCardKey` 去重，`params.command` 这类嵌套路径会在**路径干草**里拼 cwd）、也进事件。`justification` 顶层与嵌套都不收（那是模型理由，卡片另有「模型理由」一行）。`description` 仍不算载荷：只有它等于没看见要审的操作。限额按**键尾**认（`argLimitFor`：`params.command` 用 `command` 的限额），送审/事件另有全局字符预算，预算外的大字段按 `clipWithBudget` 记进 `omitted`（卡片写明「过大未展示」，事件记 `argsOmitted`）而不是悄悄砍一半给模型。
- 关键词三条特殊规则，改词表时必须一起考虑：① `KEYWORD_EXCEPTIONS`——命中后紧跟该后缀就不算（`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa` 后跟 `.pub` 是公钥；`of=/dev/` 后跟 `null`/`zero`/`full`/`random`/`urandom`/`stdout`/`stderr` 是伪设备）；② `PREFIX_MATCH_KEYWORDS`——只要求词首边界，**不要求词尾**（`of=/dev/nvme0n1p2` 后面还是字母数字，套普通词尾边界会整条漏判）；③ **人工桶**（`DEFAULT_HUMAN_KEYWORDS` / `shippedHumanKeywords()`，默认空）：拒绝桶是直接拒掉工具调用、人工桶是弹网页框，拿不准的默认由审核表兜底行转人工；首次初始化和「恢复默认关键词」都要同时写回两个桶。
- 空字符串参数要保留（`write` 的 `content=''` 是截断文件）；审核卡片用 `(空)` / `(empty)` 展示。**「工具真没给任何字符串参数」与字段截断各由一个配置项决定**（`missingPayloadAction` / `truncatedAction`，默认 `human`，可配成 `reject`）：这两类没有模型参与，所以不查审核表、不查等级。**参数名认不出不算这类**（见上一条：自定义工具的参数照常送审、照常判），走到这里的只有空载荷与未捕获。顺序是 `关键词拒绝 → 截断开关 → 其余`：截断的 `rm -rf /` 仍直接被关键词拒掉，截断时**禁止关键词允许**（allow 桶在截断检查之后才匹配），也禁止模型标 safe。审计行必须记清证据：缺参记 `keys=`（键名与长度，`keys=(none)` 是空载荷、`keys=cmd:9` 是参数名认不出但照样送审了）、截断记 `fields=字段:长度>限额`（`formatArgsNote` / `formatTruncatedNote`）——它是这两种情况在事后唯一的区分手段。
- allowlist / 插件配置读失败不写盘；设置页除明确覆盖外不得覆盖损坏文件。恢复默认关键词必须含路径拒绝词（`shippedRejectKeywords()`），不能只用 `DEFAULT_DENY_KEYWORDS`。
- 设置页审核表说明若用非受控 `defaultValue`，必须随 snapshot 换 `key` 重挂（`c.id + ':desc:' + 说明`、等级说明用 `level + ':desc:' + 说明`），否则恢复默认后 blur 会把旧文案写回；`other` 行与其它行一样挂 textarea（只是不能删除），`set.criterionOtherNote` 作为它上方的一行提示。新增/修改审核项必须过 `err.criterionNeedId` / `err.criterionNeedDesc`：空说明的行模型认不出，绝不允许写进表。三格补丁走 `{ id, actions: { <level>: <action> } }`，未知档位报 `err.criterionLevel`；`levels` 走 `{ op:'set'|'reset', kind:'levels' }`。
- `auto-approve` 预设沙箱由设置 `presetSandbox`（`workspace-write` | `read-only`）写入 profile patch；改完需重启，并重新选择预设或开新会话。patch 文件路径由 `ctx.baseUrl`（app-boot 锚在 profile 目录）推导，可用插件配置 `profilePatch` 显式覆盖，拿不到才回落 `profiles/web`。
- **patch 写入必须过 `preset-patch.mjs` 的纯函数**：判断「是否已有 auto-approve」用缩进键锚定（`findAutoApproveKey`），禁止 `includes('auto-approve:')`（注释、description、块标量 `description: |` 里的同名行都会骗到它，结果预设永不安装）；空 patch（`[]`、`[] # 注释`、`---` + `[]`、注释 + `[]`、只有注释）必须**整段替换**那个 `[]`，禁止拼出 `[]` 后面还有条目的 YAML（DSH 解析失败 → profile 起不来）。插入位置按 `presets:` 的相对缩进算（支持 `- insert:` 里缩进的 permission 行），不写死空格数。sandbox 行匹配词表外的值（如手改成 `danger-full-access`）要改写；块里没有 sandbox 行要报 `err.presetSandboxMissing`，不能返回 ok。
- patch 里列 0 的 `---` / `...` 是文档标记：写盘前必须去掉（`stripDocumentMarkers`），否则追加条目会产出多文档 YAML。「是否已有 auto-approve」只看 **permission 行自己的 presets 块**，别的插件 presets 里的同名键不算。permission 行没有 `presets:` 时：块状 `config:` 就插进去（保留它的其它键），没有 config 就追加整块，行内 flow config 明确报 `err.noPresetsKey`。
- 分类解析前先 `stripJudgeCardEcho` 剥掉回显的卡片围栏：卡片正文里的 `类别: safe` 不能成为「最后一个匹配」，否则模型复述卡片就能把结论改成 allow。卡片正文里的围栏字样必须先用 `sanitizeJudgeCardText` 中和（`TOOL_CARD` → `TOOL-CARD`）：内容自带一个 `TOOL_CARD>>>` 就能提前闭合围栏，把注入文本顶到「围栏外」——与真正的输出格式指令同处一地。解析侧容忍行首/值两侧的 markdown 装饰，且整段输出就是一个表格 id 时按裸 id 认（必须整段只有 id，比模糊兜底严格）；JSON 与散文仍只走模糊兜底。等级行同理：剥掉回显后取最后一个**认得出**的值，`风险等级:` / `Risk level:` / `level:` 都认，卡片正文里伪造的等级行不能当结论。
- 迁移可以丢结构字段：`label` 已取消（旧文件里的 label 会在下一次写盘时消失，`normalizeCriterion` 先把它当 id、再当说明兜底，行不会因此变成不可归类）；单数 `action` 同样只读不写，读盘时播种到三格。但**不得静默删除用户手写的关键词**，也不得覆盖用户改过的说明（只有仍等于旧出厂原文的说明才被刷新）。
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
