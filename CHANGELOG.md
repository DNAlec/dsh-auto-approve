# Changelog

## 0.4.0

> 自动拒绝不再只给模型一句 `the user rejected tool "…"`（那是**错误归因**：关键词红线、审核表判定、插件异常全成了「用户拒绝」），而是附上机器判定的原因；可选开启「模型转人工」，让模型把某次被拒的操作交回人决定。

### 行为变化

- **`other` 行的出厂说明改为「以上条目全部不符合或无法确认」**（英文 `None of the rows above fit, or it cannot be confirmed`）：更短，且与提示词里「没有任何一行能确认符合时才选那一行」同义，不再自带「拿不准 / 看着无害也选」这种分类指引。**allowlist 版本 20 → 21**；迁移只替换仍是上一版出厂原文的说明，用户自己改过的不动、三格更不碰（与 `prevVersion < 18` 那次刷文案同一套做法）。
- **拒绝原因回传（默认生效）**：走 `tools/post-execute` 的 `additionalContexts`——`ApprovalOutcome` 是闭集字符串，服务层把 `rejected` 统一渲染成 `the user rejected tool "…"`，插件没有别的位置能附带原因。原因**只由闭集派生**：命中的关键词（你自己的词表）、审核表类别 id 与等级（含是否走了兜底档）、缺参/截断、判定失败的具体来源；**审核模型那段「理由」原文不回传**（含命令片段与文件内容，回灌上下文等于开一次注入入口）。自由文本一律单行化 + 截断，卡片围栏字样中和。
- **`other` 行与任何一行同权**：类别、等级、理由一律照给，不加「兜底 / 没跑成」之类措辞——它唯一的特殊之处是不能删除。是否落 `other` 由模型按行说明决定。
- **三种口径分清楚**：自动拒绝（可附转人工入口）、**人明确拒绝**（不再指路转人工）、**转人工但没拿到结论**（说清「不是人拒的」——DSH 给模型的原文仍是「用户拒绝」）。后两态都不是「还在等人」：人工框只有「允许 / 拒绝」两个按钮，`cancelled` 来自请求被中止、`unavailable` 来自没人在场应答。
- **归因只在判定落定后记**：同一条路径既可能 reject 也可能 allow/human（`truncatedAction`、三格动作），在解析侧记会让「人工批准放行」的调用也收到一条「已拒绝」通知。
- **模型转人工工具**（设置页开启，默认关闭）：工具常驻注册，名字来自 `humanReview.toolName`（默认 `request_human_approval`），开关只在 execute 里判。四条语义：① 转人工请求**永远由人决定**（不查关键词、不查审核表、不查三格——否则请求本身被自动拒绝就是自锁死循环）；② 人工批准只对**同会话 + 同工具 + 参数规范化后完全相同**的一次调用有效，用一次即销毁，参数一变走完整管道；③ 人工拒绝是终局（本会话不再问第二次，模型被告知别再试）；④ 在途同键去重，凭证与暂存在 Fiber 析构时清空。
- 审核提示词末尾**追加**一段转人工说明（仅开启时）：只讲通用角色，不点名出厂 id，也不在模板之外再规定一次输出格式。
- 事件新增闭集字段 `denyReason`（keyword / criterion / judge-timeout / …），`auto-approve/decision` 在拒绝时也带它——「为什么被拒」不再需要从 `path` + `src` + `category` 里各拼一半。
- `humanReview` 插件配置逐键合并：设置页只提交改过的那一项，不会把用户改过的工具名冲回默认。
- `tools` 服务用 `ctx.get('tools')` 取，**不进 `inject`**（同 `webServer` 的理由：headless / acp / sdk 组合没有它会停在 PENDING，连门控都不挂载）；注册前查重名，冲突只警告。
- 设置页新增「模型转人工」卡片与总览步骤；「看不见这次操作时」的提示改为说明拒绝原因会回传。
- **送审改成「要么完整、要么不问模型」：单字段限额体系整套删除，换成一个全局送审上限**。删掉的东西：`TOOL_ARG_LIMITS`（20 个字段各自的限额）、`argLimitFor` 在**送审**路径上的按键尾限额（函数本身留着，只服务事件存档）、`toolArgsTruncated`、`formatTruncatedNote`、`assertJudgeArgsWithinLimits`（上一版刚加的断言）、`clipToolArgsForJudge`，以及卡片上的「以下字段过大未展示」与 `omitted` 记账。现在的规则只有一条：`formatJudgeCard` 不切任何字段、不设条数上限；闸门量**整条请求**（系统提示词 + 卡片）与设置页新增的 **送审内容上限**（`judgeRequestBudget`，默认 20000 字符；下限经两轮 review 从 2000 提到 4096、再到 **8192**——英文出厂框架 ~5.8k 字符，见下），超了就按「看不见这次操作时」里「内容超过送审上限」的动作处理。**触发必写日志 + 审计**：`console.warn` + 审计行 `err.judgePayloadOversize request=<实际>>预算`，事件走 `src=truncated`，不会静默转人工。
- **取消收集阶段的深度与键数上限（安全修复）**：旧的 6 层 / 200 键会在超限时**静默丢弃**字段，而被丢的字段既不进参数字典、也不进关键词干草——实测「批量 250 个文件路径、门控配置在末位」时红线整条失效（`~/.dsh/auto-approve/allowlist.json` 既不被关键词命中、也不上卡片），旧版会照常送审甚至可能被 `safe` 放行。现在只保留一个不可配的字节护栏 `RAW_COLLECT_GUARD_BYTES = 8MB`（正常调用差三个数量级；实测 10 万叶子约 2.9MB 干草 / 225ms），撞到即标记 `over`，与超预算走**同一个**动作并记 `oversize=collect>8388608`。顺带修好了旧限额在嵌套下算不准的问题（单数组收 199、`params.files` 只收 198）。
- **卡片去重定稿：每个参数恰好一行，不丢也不重**。旧实现按「键尾等于某个已知字段名」剔除，`{args:{file_path:'x'}, extra:{file_path:'y'}}` 只渲染 `x`、`y` 消失；中途试过的「按值去重」修好了那个，但代价是 `{url, body}` 同值、`{file_path, path}` 并存时**另一个参数整条消失**（模型在看不见的参数上给结论）。现在的规则是四条：① 每个键恰好一行；② 只在「同一个参数的两个位置」上合并（被渲染过的键与它自己的嵌套变体）；③ 不按值去重；④ 键尾相同也不合并。同时收敛标签：`query`/`input`/`text`/`body`/`message`/`pattern`/`selector` 不再各有一个中文名，改印成「参数 <名>: 」（`CARD_PLAIN_KEYS`），只有 `code`/`url`/`script`/`sql` 保留语义标签。契约测试按「行归属」判定（值相同也抓得住重复与丢失）。
- **自定义提示词超限不再静默截断**：旧版把超过 20000 字符的模板 `slice(0, 20000)` 存盘，而模板尾巴通常正是输出格式与等级要求——被砍掉后模型不再输出等级行，**全部判定静默落 `levels.fallback`**，且设置页回显的就是被砍过的版本。现在保存时直接报 `err.judgePromptTooLong`（带 `{chars}`/`{max}`），一个字节都不写盘。
- **闸门顺序修正：关键词拒绝现在能拦住「缺参 / 超预算」的调用**。缺参分支此前在关键词层之前 `return`，于是用户把危险工具名或词写进拒绝桶时，对它**静默无效**（实测：`mcp__deploy__run` 在拒绝桶里，缺参调用照样弹人工框）。现在顺序是 `拒绝关键词 → 参数没采集到（无条件拒绝）→ 人工关键词 → 收集/预算闸门 → 允许关键词 → 判定`：两个关键词桶都先行（那是用户显式的「不要做」），允许**必须过闸门**（没采集到/超预算禁放行）。新增「闸门顺序」用例覆盖三个方向。
- **MCP 的 `description` 不再被当成「模型自述」**：内建工具里它是元数据，但 MCP 的 schema 里它常常就是正文参数（jira 的 description、issue body）。此前这种调用被整条归成「没有可审的操作内容」→ 转人工，而人工框只看得到工具名，等于让人在盲审里拍板。现在按既有原则处理——**键名不在 `TOOL_ARG_KEYS` 里就是这个工具自己的参数**（当时的判据函数 `isCustomToolName` 已随后面的闸门删除一并清理），`mcp__*` 的 description 算内容、送审核模型；内建工具的 description 语义不变。
- **数字/布尔参数不再等于「没给参数」**：MCP 工具的 schema 里大量是开关（`recursive` / `force` / `include_archived` / `limit`），以前这些调用收集到的 `args` 是空的，于是被归成 `missing-payload`（默认转人工）——可 `recursive:true, force:true` 恰恰是判断危险性最需要的信息，关键词层与审核模型却都看不到。现在标量也收成文本（`'true'` / `'42'`）与字符串参数同形：上卡片、进事件（当时还参与载荷判定 `hasToolPayloadIncludingScalars`，那个判据已随后面的闸门删除），但**不进关键词干草**（`true`/`100` 进干草只会误命中，由 `scalars` 集合区分）。空串仍然不算载荷；`{description:'x'}` 仍然算「没给参数」（语义没变）。
- **「参数没采集到」改成直接拒绝 + 告诉模型重发**（不再走 `truncatedAction`、不再弹人工框）：它是插件侧瞬时故障（缓存未命中 / 已消费 / 被挤出 256 条），让人为插件故障拍板没有意义（人也看不到任何内容），而且这一态**没有参数可做一次性凭证的键**。拒绝经 post-execute 旁路带一条通知回给模型，档位是新的 `payload-uncaptured`，措辞明确「这是插件侧采集故障、与内容大小无关、重新发起同一次调用即可」——**与 `payload-truncated`（内容超过上限，「别再发」）严格分开**，否则模型会朝错方向重试。恢复闭环有测试覆盖：重发一次就正常走完管道。
- **「参数没采集到」在审批记录里自带标记**：事件加 `argsCaptured: false`（pending 与人工结论两条都有），审批 tab 在 `args` 为空且该标记为 false 时显示告警「⚠ 未采集到这次调用的参数……批准等于同意一次你没看到内容的操作」，不再和「这次调用真的没有参数」一样显示 `(空)`。触发场景四种：请求没有 `callId`、会话键对不上、同一 callId 被取两次、缓存超过 256 条被挤出（无 TTL）。
- **判定前只剩一个开关：`missingPayloadAction` 整套删除**（用户要求：「无论如何，只要没有超过上限，都把内容原样交给审核模型去判断」）。删掉的东西：配置项、设置页那一行、rule-op 的 kind、`hasToolPayloadIncludingScalars` 与 `isCustomToolName` 在判定路径上的调用，以及 `missing-payload` 这条 path 与 `denyReason.payload-missing` / `payload-oversize` 两个档位。**内容多少不再是一道闸门**：空参数、只有 `description`/`workdir`、纯数字/布尔开关——一律照常送审，由模型按卡片判（`normalizeAllowlist` 里 `delete cfg.missingPayloadAction` 丢掉老配置的残留键）。判定前只剩 `truncatedAction`：它承接两件**都属于「插件看不见这次操作」**、但操作本身确实太大的事——撞收集护栏（`src=oversize`）与整条请求超送审上限；**参数没采集到不吃这个开关**（它永远直接拒绝，见上一条）。三者同走 `truncated-payload`，各带 `src` + `judgeReason` 证据、各打 `console.warn`、各写审计行（此前「撞护栏转人工」这条路径**审计行是缺的**，已补）。
- **排障信息补齐（审批记录/事件）**：① 撞收集护栏此前会被记成「工具没给参数」——护栏标记产生在 `pre-execute` 采集时，缓存只存了 `args`，闸门再也看不出 `over`；现在缓存存 `{args, over}`，护栏触发记 `err.payloadOversize oversize=collect>8388608` 并标 `src=oversize`，`denyReason` 新增 `payload-uncaptured` 档（与「内容超过送审上限」分开）。② 超上限**拒绝**路径此前只有 `argsOmitted`、没有任何原因字段，现在与转人工一样写 `judgeReason: err.judgePayloadOversize request=<实际>>预算`。③ `denyReason` 此前按「verdict 以 reject 结尾」判定，导致 `truncated-payload`/`missing-payload`（既可能拒绝也可能转人工）永远不写；改为拒绝类事件一律按 path 派生，并排除放行类（此前 allow 事件会带 `judge-call`）。④ 审批 tab 的「管道」一行现在同时显示闭集拒绝原因。
- **设置页文案与结构修正**（UI 走查，逐条都可复现）：① 五处出厂文案里写着 markdown 粗体 `**…**`，而设置页是纯文本渲染，用户看到的是**字面星号**——改为普通措辞；② `set.unjudgeableSub`（中文）里混进了一整句英文、英文版结尾多一个 `**`；③ 同一段说明还在讲「这两类默认都转人工」和「没有可审的操作内容」——那是 `missingPayloadAction` 时代的事实，现在参数没采集到**永远直接拒绝且不可配**，已改写；④ 关键词折叠行与总览芯片复用了 `set.counts`（「三格合计 拒/人/允」）而关键词不是三格，新增 `set.kwCounts`；⑤ 「审批总览」的管道说明写成「关键词（拒绝>人工>允许）」，与真实顺序（允许在闸门**之后**）不符，且漏掉闸门这一格——文案改写并给总览补上闸门芯片（跳转 `data-ab-stage="unjudgeable"`）；⑥ 「提示词语言怎么切」原本写在**审核表**卡片里，而语言影响的是**审核模型**卡片里的提示词——移到提示词下方，审核表卡片留 `set.criteriaLangNote`；⑦ 加载态用了成功色 `.ab-set-ok`（绿色「加载中…」），新增 `.ab-set-muted`；⑧ 清理死文案 `set.criteriaActionsHint` 与死 CSS `.ab-tag-neutral` / `.ab-set-input-ui` / `.ab-set-crit-fixed`；⑨ 审核表行的删除按钮补 `title` / `aria-label`（读屏原先只念一个 `✕`）。卡片标题「无法判定时」改为「看不见这次操作时」（卡片里唯一的开关本来就是「插件看不见这次操作」）。
- **设置页第二轮走查：草稿、可达性、密度、静默失败**。① **未保存的提示词不再被别的卡片冲掉**：快照刷新与本地编辑态彻底分开（`load({ reseed })`，只有首载 / 保存审核设置 / 恢复默认提示词 / 覆盖损坏配置才播种本地态），此前改一句提示词、再去点「模型转人工」的下拉（或让工具名输入框失焦），草稿会静默消失——那是一次 RPC 写入顺手把另一个卡片的编辑态重置了。`judgePromptLang` 每次刷新都跟随（它是服务端状态），中英草稿分开存，所以切语言不丢另一份；提示词右上角的标签同时补成三态（**未保存** / 已自定义 / 默认）——草稿现在活得比以前久，更需要看得见它还没落盘。② 可访问性：所有表单控件补可访问名（动作下拉、等级三格、`truncatedAction`、模型转人工三行、审核模型的三个下拉与两个数字输入）；关键词文本从 `<span onClick>` 改成 `<button>`（原先**键盘完全不可达**，只能用鼠标点）；模式按钮加 `aria-pressed`；删除按钮补 `title`/`aria-label`（读屏原先只念一个 ✕）；三格与关键词的动作下拉顺序统一为 **拒绝 > 人工 > 允许**（`actionOptions()`，与管道优先级、列表分组一致）；`<summary>` 里改放 `<span>`（`<div>`/`<p>` 在 summary 里是无效 HTML）。③ 信息密度：三张折叠卡片的长说明移进展开区（折叠态只剩标题 + 计数，此前一屏三个大段落）、关键词「添加」行从 27 条出厂词**下面**移到列表**上面**、审核表行在窄列下允许换行（外壳内容列实为 564px，英文档下长 id 会跟三格挤在一行）、审核模型提示词区的说明收敛（「模板没要求等级 → 走兜底档」与「风险等级」卡片重复，删掉）。④ 静默失败：`judge-catalog` / `judge-info` 失败不再被 catch 吞掉，显示 `err.catalog` / `err.info`（此前模型下拉只剩「跟随默认模型」，看不出是加载失败还是真没有模型）；关键词「预置」标签改为覆盖**拒绝桶 + 人工桶**（原先只标拒绝桶）。
- 事件层的存档裁剪（`EVENT_ARG_LIMITS` / `EVENT_ARGS_BUDGET` / `argsOmitted`）保留不变：它只压 `events.jsonl` 体积，与「模型看到什么」无关；`argsOmitted` 的含义明确为「当时完整送审过、只是存档短」。
- **设置页说明大幅精简，长说明移进 README；「看不见这次操作时」卡片取消**（用户要求：「设置页面中不需要那么多说明，尽量精简，说明写到文档中，超过送审上限不需要单独开个卡片」）。① **闸门不再有独立卡片**：那张卡片唯一的控件是 `truncatedAction`，现在它就在**审核模型**卡片里、紧挨着「送审内容上限」——触发条件与动作必须挨着放，否则「超上限怎么办」会被拆到两个屏幕外；总览芯片相应变成 关键词 → 审核表 → 审核模型 → 模型转人工（原「闸门芯片」跳的 `data-ab-stage="unjudgeable"` 已无落点），管道顺序仍在 `set.overviewSub` 里一行写清（拒绝关键词 → 人工关键词 → 闸门 → 允许关键词 → 审核模型）。② **页面只留一行提示**：`set.intro` / `set.overviewSub` / `set.kwSub` / `set.criteriaSub` / `set.levelsSub` / `set.levelFallbackHint` / `set.judgePromptHint` / `set.langByRestore` / `set.judgeRequestBudgetHint` / `set.humanReviewSub` / `set.humanReviewWarn` / `set.humanReviewToolHint` / `set.driftBody` / `set.modeHint` 全部改写为一行，只在 `set.intro` 末尾留一句「详细说明见 README」。③ **被删掉的说明都进了 README 的「设置」一节**（中英同步）：关键词盲区（写入内容 / 代码正文 / 数字布尔开关）、id 与说明的写法、三档说明进提示词、**兜底档同时决定后果**（high 拒绝 / medium 人工 / low 放行）、审核模型卡片里现在有哪些项（含超上限 / 撞护栏动作与「参数没采集到永远直接拒绝」）、提示词占位符与恢复默认的语言语义、模型转人工的四条语义与警告；「怎么判定」里指向旧卡片的两处改指「审核模型」卡片。④ 删除已无渲染点的文案键 `set.unjudgeableTitle` / `set.unjudgeableSub` / `set.unjudgeableHint` / `set.judgeSubTail`，并留下约定（AGENTS.md）：**设置页只留一行，长说明一律写 README，删卡片要同步删文案键**。⑤ **审核表行上的「等级认不出 → 动作」删掉**（用户要求）：那个小灰字是按 `levels.fallback` 现算的、每行重复一遍，而兜底档与它的后果在**风险等级**卡片里已经写着；行上只剩 id、三格动作与说明，连带删掉死文案 `set.rowFallback`（中英）与死 CSS `.ab-set-crit-meta`。⑥ **审批总览里那排「`deletion · 高→拒绝` / `safe · 高→拒绝` …」芯片也删掉**（用户追问「还有用吗」）：它是每行在**兜底等级**下那一格的投影——v22 把三格统一成同一套刻度之前，出厂表是三种形状（风险行全拒绝 / `safe` 全允许 / `other` 全人工），那时这排芯片确实一眼看得出「哪些行会在等级认不出时放行」；统一刻度之后它们退化成同一个值的八次重复，而且颜色还容易被读成「`safe` 也会被拒绝」这种与正常判定无关的结论。要表达的东西本来就在**审核表**卡片（三格控件）与**风险等级**卡片（兜底档 + 它的后果）里自己的控件上；连带删掉 `.ab-set-invs` / `.ab-set-inv` / `.ab-set-inv-hard` / `.ab-set-inv-ok` / `.ab-set-inv-mode` 五条死 CSS。总览卡片现在只剩四个步骤芯片（导航 + 状态）。

- **审核模型判不出来时不再只剩「静默转人工」：重试预算按失败原因升级，失败与自检都搬到设置页**（起因是实测：`off` + 会思考的路由下，1024 与 2048 两次都被推理吃光、每次 `err.judgeEmpty` 都退化成人工弹框；`off` 在 DSH 与 pi-ai 两层都被折成「不发思考参数」，所以它从来不是「关闭思考」）。① `judgeEmptyRetryMaxTokens(first, finishKind)`：`finish=max-tokens`（`isTruncatedFinish`，即推理吃光预算把正文截断）重试**直接给 8192**（`JUDGE_MAX_TOKENS_TRUNCATED_RETRY`）；其余空输出（`finish=stop` / 没有 finish 事件）保持原来的「翻倍且 ≥1024」——对前者翻倍没有意义（实测 2048 仍是空的）。失败关闭的语义不变：仍是「判定没跑成 → 固定转人工」，只是先把预算给够。② **判定健康度**：`withRetry` 每个终态记一次（**取消**与**超预算**不记：前者没有结局、后者压根没问模型），`snapshot.judgeHealth` 交给设置页——本次运行出现过「空输出转人工」时，审核模型卡片顶部显示计数告警（含「换大预算救回 N 次」），重启 `dsh web` 清零。③ **测试判定**：审核模型卡片新增按钮，走 `judge-selftest` RPC 拿固定小卡片真跑一次（同一套预算阶梯），回显 `类别 / 正文长度 / finish / 耗时`，失败时写出 `err.judgeEmpty finish=max-tokens …`；不写任何配置、不计入健康度，只在审计留一行 `SELFTEST`。④ README 新增「审核模型：off 不等于不思考」一节（三条修法：换非推理模型 / 给该路由 `reasoningEfforts.off` 配字符串 wire 值 / 显式选低档），并写明插件**不会**去改用户的 `settings.yaml`。
- **修复：人工复核的审批框里看不到要批准的命令**（用户实测发现）。DSH 的审批框只渲染两样东西：`reason`，以及按 `callId` 在会话里找到那次工具调用的**顶层 `command`**（`conversation.approval.detail` 槽位，`ui-chat` 的 `ApprovalCommand` 只读 `args.command`）。而模型主动求的复核用的是**转人工工具自己那次调用**的 id（`exec.callId`；原调用的 id 在 `approval/request` 里没有可用字段带过来），于是详情行永远是空的——人只看到「模型请求人工复核 bash」，就得决定放不放行。现在复核请求把参数摘要压成一行写进 `reason`：新增 `formatReviewOperation(args)`（命令优先、含 `params.command` 这类嵌套形态；没有命令就列前三个键值对，`write` 因此能看到 `file_path` 与 `content` 片段；单行化 + 240 字截断），由 `formatReviewRequestReason(tool, why, lang, operation)` 拼进正文；摘要为空时省掉那一段。README 里「模型转人工」那条也改成「提示框会写清被批准的操作本身 + 模型理由」。
- **复核框补齐「判断依据」：判决 + 操作 + 模型理由（定稿排版，用户拍板）**。对话框现在是一句：`模型请求人工复核「bash」。自动判定：bulk · high。操作：rm -rf …。模型理由：必须执行`。三处改动：① **判决**——人是在覆盖一个机器决定，却一直看不到机器说过什么：`rememberDeny` 的归因会被 post-execute 的 `takeDeny` 消费掉，而复核发生在之后的轮次。新增 `createVerdictMemo()`（有界、挂 Fiber、键与一次性凭证**同一个参数投影**），由 `decisionLeaf` 在 `MACHINE_REJECT_PATHS`（keyword/criteria/truncated/plugin 四类机器否决）上留档；`formatVerdictBrief` 渲染成短形态（审核表 `bulk · high`，等级走兜底档带注记；关键词/超上限/插件异常沿用闭集措辞），**不是机器否决的 path 一律不写**——落到 `denyReasonFor` 的 `judge-call` 兜底就会把「没结论」写成「审核模型调用失败」，那是错误归因。② **不再写「（自动审批已拒绝）」**：`自动判定：…` 已说明被否决过；而且转人工工具并不强制先有一次拒绝（只查参数齐、没被人工拒过、没有在途同键），对没被拒过的事求复核时那句话就是撒谎——现在没有判决时自然退化成「模型请求人工复核「bash」。」。③ **操作摘要不再静默截断**：`formatReviewOperation(args, lang, max=600)` 超长时留首尾并写明「（共 N 字；尾部：…）」，参数只列前 4 个时写「（共 K 个参数，仅列前 4 个）」——固定 240 字硬砍且不加标记，等于让人替看不见的尾巴签字。三段用「。」连接而不是换行：审批框标题是普通文本节点，换行会被 HTML 折成空格。（另注：`write`/MCP 这类没有顶层 `command` 的工具走 DSH **原生**越权框时依旧只有标题——`ApprovalCommand` 只读 `args.command`，那是 DSH 侧的行为，插件改不了；复核框不受此限。）
- **转人工工具删掉冗余的第二个「理由」字段**（用户指出「不是有两个重复的字段了吗，为什么要写两遍理由」）。可选的 `reason`（参数说明写着「给人看的补充说明」）与必填的 `justification` 是同一件事、同一个位置、同一类内容：全仓只有**一处**引用——拼接时用 ` — ` 接在 `justification` 后面，既不进审计/事件，也不参与一次性凭证与在途去重（`grantArgs` 只看 `arguments`）。于是模型只能把同一段话写两遍，人读到的是一句被破折号连起来的复述。现在 schema 只剩 `tool` / `arguments` / `justification`（`required` 与 `additionalProperties: false` 不变，多送未知参数仍然直接失败），复核框正文只保留一段「模型理由」。契约测试盯着两件事：`properties` 里不许再出现 `reason`、复核正文里「模型理由 / Model's reason」只出现一次。
- **同义字段 / 别名残留清理**（用户追问「检查一下还有没有这样的问题」后的全仓排查，四类同源问题）：① **`allowlist.json` 里的 `denyKeywords` 是 `humanKeywords` 的历史别名，却一直被写回盘**——用户文件里两份同义列表，`normalizeAllowlist` / `cloneAllowlist` / `copyAllowlistInto` / `moveKeyword` / 关键词增删改与「恢复默认」六个分支都在镜像它。现在只保留 v4 迁移来源（`legacyDeny`）这一处读取，归一化后 `delete cfg.denyKeywords`（与 `missingPayloadAction` 同一套做法），克隆/复制/rule-op 都不再造出来，`denyKeywords` 也不再是合法 op kind（报 `err.unknownKind`）；快照与客户端里的兜底读取一并删除。② **审核失败事件同时写 `error` 与 `errorCode`（同值）**，客户端只能写成 `errorCode || error`——现在只留 `errorCode`（写入侧 7 处、读取侧 4 处一起收敛）。③ `clipJudgeForEvent` 还给早已取消的 `label` 留着一个槽位（没有任何生产者）——删掉，并加断言禁止它回流。④ **快照里 `predefined.denyKeywords` 用旧名指「出厂拒绝词」，而 `config.denyKeywords` 指「人工桶」**（一名两义）——两个都删，真名只有`rejectKeywords` / `humanKeywords`。排查同时确认没有别的同类残留：文案键无死键（动态拼接的 `src.*` / `verdict.*` / `path.*` / `denyReason.*` / `err.*` 这类前缀查询另算）、客户端 CSS 无死类、导出符号无死码、`pluginCfg` 没有只写不读的键。
- **卡片不再规定输出格式**（review 修复）：`formatJudgeCard` 的尾巴固定写着「只输出两行：类别 / 理由」，而模板从 0.3.0 起要求三行含 `风险等级`——卡片是模型读到的最后一段文字，它照办就会让等级行整个消失，`normalizeJudgeLevel('')` 落空 → **每个判定都落 `levels.fallback`**，用户拉开的 (行, 等级) 格子静默失效。现在卡片只留一句「请归类这次调用。」，格式只在提示词模板里规定一次。
- **关键词「人工」桶提到闸门之前**：它和拒绝桶一样是用户显式写的意图，不能被 `truncatedAction` 静默盖过（超预算 / 撞收集护栏的调用现在照用户的意思弹框）。顺序变成 **关键词拒绝 → 参数没采集到（无条件拒绝）→ 关键词人工 → 收集/预算闸门 → 关键词允许 → 判定**；「参数没采集到」仍是唯一不给人工框的例外——那一态连参数都没有，弹框等于让人盲批，而且做不出一次性凭证的键。
- **已知键的非字符串值不再整条消失**（安全修复）：旧收集器只把「已知键 + 字符串」收进参数，其余在第二个循环里被整条跳过——`{query:{match:{…}}}`、`{content:{…}}`、`{command:{…}}`、`{file_path:42}` 这类调用**既不上卡片、也不进关键词干草**，红线层完全看不见它。现在它们与未知键走同一条路，递归收成 `query.match.q` 这样的叶子。
- **字面点号键不再被嵌套路径覆盖**：`{'a.b':'LITERAL', a:{b:'NESTED'}}` 以前只剩一个值（谁后到谁赢）。现在撞车的键带 `#2` 后缀另起一格，两个值都在卡片上——点号是拍平路径的分隔符，撞车是必然会发生的事。
- **嵌套同尾参数只在值也相同时才合并**：`{file_path:'/a', args:{file_path:'/b'}}` 以前会丢掉 `/b`（按「键尾相同」合并，不看值）。现在值不同就各自成行，值相同才合并；`workdir` 等于 cwd 时那一行不印，但另一个位置的 `workdir`（不同值）照常出现。
- **人工批准凭证两侧统一参数投影**（功能修复）：签发侧用模型原始 `arguments`、校验侧用采集后的 `toolArgs`（标量转文本、嵌套拍平），于是 `{timeout:30}` 与 `{timeout:'30'}` 被判成「参数变了」——**人批了等于没批**：模型重试再被拒一次，而 `isDenied` 也查不到，通知里又给一次转人工入口，形成批准/重试循环。现在两侧都走 `pickToolArgsDetailed(raw).args`。
- **凭证快通道挪到采集闸门之后**：没采集到时 `toolArgs` 是 `{}`，而 `{}` 是个合法凭证键（人批准过一次无参数的同名操作就会有），那等于让凭证放行一次「没人看见参数」的调用。
- **请求没有 callId 时归因不丢**：DSH 侧可以不传 callId，而 post-execute 只拿得到 session 与工具名。以前这条路径完全出不了原因（模型看到的还是 `the user rejected tool "…"`）；现在用 session + 工具名兜底，且用一次即消耗。
- **事件新增显式 `outcome`**（`rejected` / `allowed-once`）：`denyReason` 的判据一直写着 `ev.outcome === undefined`，但这个字段从来没被赋值过——「放行事件不写拒绝原因」只靠 path 白名单兜着，`plugin-error`、`criteria-human` 这类「既可能拒绝也可能放行」的 path 就漏了（一次放行会带上「为什么被拒」）。现在结局显式落盘，审批历史与提示条据此渲染：**`truncated-payload` 这类拒绝以前会显示成绿色的「自动放行」**。
- **等级说明跟随提示词语言**：语言在 `config.json`、等级说明在 `allowlist.json`，读盘时拿不到彼此，于是换英文提示词的用户会拿到中文等级说明。现在每次重载补一步同步：仍是出厂原文的（哪个语言都算）换成当前语言的原文，用户改过的一个字不动。
- **`other` 的说明重新变成可改**：0.3.0 把它锁成只读结构行，但兜底行的说明是提示词指认它的唯一途径，用户需要能改；现在只剩「不能删除」这一条限制（`err.criterionOtherLocked`）。
- **闸门事件补 `src`**（`truncated` / `oversize` / `uncaptured`）：审批历史的「判定来源」以前在超预算这条路上是空的。
- **审批历史「参数没采集到」的告警以前是坏的**：它被当成单元格占位符传进去（`Detail()` 的 `emptyText` 语义是「这一格空着时显示什么」），于是要么显示在「模型理由」这类不相干的标签下面，要么整条不显示。现在单独成行。
- 设置页与 README 同步：**收集护栏（8MB）也是 `truncatedAction` 的触发条件之一**（以前只有 README 写了，设置页只说「超过送审上限」）。
- 死代码清理：`formatArgsNote`（`keys=` 审计证据，`src` 里零调用）、`PREJUDGE_ACTIONS`、`hasToolPayload`（已不决定判定）、`collectLeaf` 的三个无用参数，以及四个已不可达的文案键（`err.missingPayload` / `err.judgeParse` / `verdict.missing-payload` / `path.missing-payload`）。
- **量不出请求大小的判定改为失败关闭**：`judgeRequestFits()` 对非数字的 `chars` 以前返回「放行」（等于「量不出来就问问看」），而这条规则里只有「完整送审」与「不问模型」两档；审计证据串也改成印**归一后**的预算，不再出现 `request=1500>100` 这种与实际比较不符的写法。
- **同一个 `callId` 被记两次时两个都不判**：网关/代理复用 id 时旧实现直接覆盖缓存，于是第一次调用的审批看的是**第二次调用的参数**（判的是 A、执行的是 B），第二次自己反而变成「没采集到」。现在撞车即两侧都转成 `found=false`，按「参数没采集到」直接拒绝。
- 越界设置归一化时写日志：`judgeRequestBudget` 与 `judge.timeoutMs` 读盘时本来就会被 clamp（设置页对同一个越界值是报错），现在 `console.warn` 里说明原值、归一结果与区间——行为不一致可以接受，**静默**不可以。

### Review 修复（发版前全仓复审）

六路独立复审（rules / index / client / human-review+preset-patch+util / locales+文档 / DSH 真实 API 对照）逐条落地：

- **全新安装的预设写入还有三种「静默不装」（`preset-patch.mjs`）**：① 块标量防护只看紧邻上一行，`description: |` **第二行起**的同名行仍会被当成真键 → 预设永不安装而 UI 说「已配置」，现在按 YAML 缩进规则整段判定（`scalarBodyLines`，块标量与普通多行标量都覆盖）；② 键行带**行尾注释**或**行内 flow 值**时认不出 → 又插一份，同一 mapping 两个 `auto-approve:` → DSH `yaml.load` 抛 `Map keys must be unique`、profile 起不来，现在两者都算「已存在」，且 `auto-approve: { sandbox: read-only, … }` 这种行内写法**也能读改 sandbox**（否则设置页会说「预设里没有 sandbox 行」，而 sandbox 明明在里面）；③ 空 patch 里的 `[]` **只替换第一个**，`[]\n[]\n` 会拼出 `[]` + 条目的非法 YAML，现在整段删掉所有 `[]` 行。写入一律改走 `util.writeAtomic`（这份文件是 `dsh web` 启动的必需输入）。
- **取消竞态仍会造出判定**：`judgeOperation` 在「路由解析失败」分支之前没有检查取消，`resolveModelInfo` 慢/失败期间被 abort 的调用照样写事件、发决策叶子、补拒绝通知。现在解析一结束就先判 `requestSignal.aborted`（与走完 `withRetry` 的那条路同一条规则）。
- **人工结局被安上机器拒绝原因**：`keyword-human` / `criteria-human` / `human-review` 三条转人工路径此前兜底成 `judge-call`——审批历史把一次正常转人工显示成「审核模型调用失败」，`humanUnavailable` 那句还会把这个假原因**送进模型上下文**。现在这三条路径返回**空归因**（`denyReason` 字段不写、通知里不出现「原因：」），只有判定真没跑成才归因失败；`src=none`（答了但类别认不出）归 `judge-unparsed`，不再伪装成「审核表判定: other」。等级走 `levels.fallback` 的注记也只说等级（旧的「判定没跑成或认不出，按兜底行处理」把成功的判定说成失败，还把兜底**行**与兜底**等级**混为一谈）。
- **「人拒即死」在 64 条之后失效**：`denied` 与 `grants` 共用一个条数上限，长会话里最早被人工拒绝的操作会被挤掉 → 同一个操作再弹一次框问同一个人。现在 `denied` 存**定长摘要**（键里含参数全文，不能直接无限攒）因此可以留满整个会话，终局语义不再与访问顺序相关。
- **events.jsonl 会被读不懂的内容清空**：`trimEventsFile` 在「一行都解析不出来」或「读失败」时把 `records` 当空数组，于是把审批历史写成 0 字节。现在这两种情况都**不写盘**并打印错误（与 allowlist / config 的「损坏不覆盖」同一条原则）。
- **自定义提示词在读盘时被静默截断**：`pickJudgePrompts` 会把超过 20000 字符的模板 `slice` 掉，而 `judgePrompts` 会被任何一次保存整份写回磁盘——尾巴（输出格式与等级要求）于是永久消失。现在读盘**不截断**（保存路径照旧报 `err.judgePromptTooLong`），越界时 `console.warn` 说明后果（会顶爆送审上限 → 每次都按「看不见这次操作」处理）。
- **行首 markdown 装饰容忍不全**：`### 类别: safe` / `+ 类别:` / `1. 类别:` / `**类别**:` 落不进严格解析 → 掉进「按表序取第一个出现的 id」的模糊兜底，用户表里 allow 行排在前面时会把一次 reject 读成 allow（等级行带装饰则静默落兜底档）。装饰类改成「非字母数字（不吃冒号）」并按行首任意装饰匹配（**第二轮又改成窄/宽两趟，见下**），`理由: 类别: safe` 这类回显不会成为**严格**结论（整段只剩这一行时仍可能被模糊兜底认成 safe，`src=fuzzy`——那是既有的已知代价）。
- **人工关键词吃不到路径干草的点文件放宽**：拒绝桶命中 `prod.env` 时人工桶不命中（用户显式写的「这个我要自己看」在路径形态下静默失效），现在两桶同权。
- **卡片与审批历史里消失的参数**：① 卡片去重的锚点必须是**顶层**键（印出来的键自己是嵌套键时，更深一层的 `x.args.file_path` 是另一个参数）；② `cwd` 与 `workdir` 都是空串时 `workdir` 整条不印，现在它自己成行；③ 审批历史/预览此前把 `params.command` 这类**嵌套**叶子当成「已有专门行」而排除，而专门行读的是顶层键——含 `params.command` 的拒绝在历史里参数一个都看不到，现在嵌套键自成一行（超过 50 个时显示「还有 N 个字段」，不再静默丢弃）。
- **设置页**：总览步骤芯片顺序改为与真实管道一致（关键词 → 闸门 → 审核表 → 审核模型 → 模型转人工）；等级兜底下拉、审核提示词 textarea、关键词编辑框补齐可访问名；**刷新失败不再被静默吞掉**（首次加载成功之后的每次失败此前都不显示，页面继续展示旧快照与上一次的成功提示）。
- **`scripts/sync-locales.mjs` 的写回用函数式替换**：`$&` / `` $` `` / `$'` / `$1` 在替换串里会被展开，文案含这些字符时 `--write` 会把 `client.js` 写坏（校验模式发现不了，坏的是「写」那一侧）。
- 其它：`appendLine`（审计写入）失败不再完全静默；`clipNoticeText` 覆盖 U+0085/U+2028/U+2029，截断按 UTF-16 码元（与 DSH `boundContextSummary` 同一语义）但避开代理对中间（不再切出孤立高位）；`judgeMaxTokens` 的注释改成与 DSH 适配层真实语义一致（省略档位会继承路由 profile 的默认值）；`tools` 用 `ctx.get` 的理由改回「可选能力」（「headless 组合没有 tools」与源码不符——`tools` 行在 base 组合里）；无 callId 的归因键撞车时放弃本次归因（宁可不写也不写错）；静态 `<option>` 补 `key`（React 开发模式不再告警）；`save-plugin` 在 `judgeTimeoutMs` 写盘失败时整体回滚（此前客户端报失败、磁盘上的审核模型却已换掉），`rule-op` 的「恢复默认表 + 切语言」在 config 写失败时回滚 allowlist 的语言。

### Review 修复（第二轮：对第一轮修复本身的复审）

第二轮四路复审（解析/归因、宿主与 patch、客户端与文档、全仓对抗）逐条验证了第一轮修复，并找出了**修复引入的新问题**：

- **`rule-op` 的语言回滚是空操作**：回滚用的 allowlist 快照取在 `applyRuleOp` **之后**，那时它已经被改成新语言并落盘——于是「回滚」把新语言又写了一遍，审计行还宣称已回滚。现在快照取在动作之前；`judgeTimeoutMs` 写盘失败也把 allowlist 一起退回（超时的权威来源是 allowlist，不能出现「RPC 报失败、磁盘已是新值」）。
- **解析的装饰类放宽过头，回显行能覆盖真结论**：为了吃下 `### 类别:` / `+ 类别:` / `1. 类别:` 把行首装饰改成「任意非字母数字」，于是 `+ 类别: safe` 这类**工具回显形态**也进了严格解析，而类别取「最后一个匹配」——真结论 `类别: deletion` 之后跟一行 `+ 类别: safe`，一次 reject 会被翻成 allow（卡片里带 content/code/diff 时，这是攻击者可影响的文本）。现在分两趟：先用窄装饰集合（旧行为）取最后一个，窄趟拿不到**表内** id 才用宽集合。**整段像 JSON 时两趟都跳过**（`{"category":"safe"}` 只能走模糊兜底，这是 AGENTS 写明的契约，之前被宽装饰破坏了）。
- **patch 键形态只修了一半，根因还在**：引号键（`'auto-approve':` / `"auto-approve":`）、冒号前空格、引号/flow 形态的 `presets`、引号 `- id: 'permission'` 之前都认不出来 → 再插一份同名键 → `dsh web` 起不来而设置页报成功。现在：键正则与 `permission` 行都认引号与空格；`presets: {…}`（flow）明确报 `err.noPresetsKey`，**不再**往里插键；「直接子键」的缩进取块里第一个键行的缩进（用户可以用 4 空格，写死 `+2` 会漏判→重复键），更深一层的 `my-preset.actions.auto-approve:` 不再被当成预设；写盘前加最后一道自检——插入后的文本里「像 auto-approve 键」的行（含显式键语法 `? auto-approve`、引号键、注释行以外的任何形态）**必须恰好一条**：判据是绝对值而不是「比插入前多一条」，否则插入前那个**没被认出来**的键正好会让「多一条」成立、冲突照样发生。认不出就不写盘（宁可报错，也不动用户的 profile）。
- **BOM + `[]` 会拼出非法 YAML**：Windows 编辑器/PowerShell 另存出的 `\uFEFF[]` 判不出「空 patch」，于是走追加分支写出「`[]` + 条目」。现在所有入口先剥行首 BOM。
- **flow sandbox 的三种误读**：多行 flow 映射会落到块状分支、把条目逗号一起吃掉（写出解析不了的 patch），行尾注释里的 `sandbox:` 被当成真值（只改注释还报成功），带引号的值带着引号返回。现在匹配前先切行尾注释、值去引号，**未加引号的跨行 flow 直接报错**（`err.presetSandboxMissing`，不动文件；带引号键的 flow 走块扫描，产物仍合法）。
- **送审上限的下限低于系统提示词本身**：`2000` 时连 `echo x` 都会撞上限（实测 `request=6486>2000`），审核模型一次都不会被调用、全部按 `truncatedAction` 执行——而设置页看不出哪里不对。下限提到 **4096**（出厂框架 ~2.2k），并在读盘时对「预算 ≤ 框架长度」告警（自定义表更大时也能看见）。
- 其它小修：SSE 摘要改用 `clipNoticeText`（原先 `slice(0,120)` 会把 emoji 代理对切成孤立高位）；静态 `<option>` 补 `key`（React 开发模式告警）；`clipNoticeText` 的截断语义回到 UTF-16 码元但避开代理对中间。
- **测试补齐**（第二轮变异测试发现 7 处新防护没有任何用例守着，删掉它们 `npm test` 仍全绿）：转人工工具「认领失败交回系统默认」的用例此前是空转（夹具没有 `tools`/`effect`，注册名恒为空串、分支不可达）——现在夹具补上真注册，并把工具名放进拒绝桶，去掉防护即变红；新增取消竞态、档位不支持、人工结局归因、`denied` 终局、跨文件回滚、`writeAtomic` 清理、`appendLine` 上报、解读取正文、CRLF、双 `[]`、JSON 契约、装饰回显等用例；`setTimeout(abort, 10)` 那条时间相关的用例改成在假 stream 内部取消。

### Review 修复（第三轮：对第二轮修复的复审）

第三轮两路复审继续验证第二轮修复，又找出一批**只在「真结论本身带装饰」「英文提示词」「YAML 等价键写法」这些边角上才出现**的问题：

- **宽装饰真结论 + 装饰回显仍会翻结论**（fail-open）：第二轮的「窄趟先、宽趟后」只在**真结论用窄装饰**时有效；模型把真结论也写成 `#类别:deletion` 时窄趟一条都拿不到，宽趟退化成「取最后一个」，于是卡片回显的 `+类别:safe` 成了结论。现在宽趟**出现互相矛盾的多个类别行时不取最后一个**，按失败关闭落兜底行（`src=none`）；等级同理——同一趟里矛盾就交给 `levels.fallback`，不让回显压低风险等级。`#类别:deletion\n+类别:safe` 从 allow 变回「兜底行（默认 human）」。
- **JSON 里的 allow 行会借理由文本放行**：`{"category":"other","reason":"looks safe"}` 走模糊兜底时按表序扫全文，`safe` 抢先命中 → 放行。现在**JSON 分支**的模糊扫描跳过「三格全 allow」的行（散文分支保持原样，那是 AGENTS 写明的既有代价）；这类 JSON 现在落兜底行。
- **送审上限的下限仍然不够**：英文出厂框架 ~5785 字符（中文只有 ~2236），第二轮定的 4096 在 `judgePromptLang=en` 时依然会让**每一次判定都撞上限**（实测该 profile 的审核表仍是中文时 `request=4436>4096`、0 次模型调用；换成纯英文出厂表后框架本身就有 5785）。下限提到 **8192**（覆盖英文框架 + 卡片余量），设置页的输入下限、文案、README 同步；读盘告警本来就按当前语言算框架长度。
- **写盘闸门对 YAML 等价键写法失明**：`!!str auto-approve:`、`&a auto-approve:`、`"auto\u002Dapprove":`、`? auto-approve` 这些写法在 YAML 里与普通键等价，但文本扫描认不出——于是又插一份、同名键冲突、`dsh web` 起不来。现在闸门按「目标 mapping 里提到 `auto-approve` 的行必须恰好一条」判，并且**任何认不出的键写法（标签 / 锚点 / 别名 / 转义 / 显式键 / 序列项）一律拒绝写盘**（文件逐字节不动）；`presets:` 的值写在下一行的 flow 集合同样按「插不进去」报 `err.noPresetsKey`。
- **BOM 只在部分入口被剥掉**：`\uFEFF- id: permission` 会让 `findPermissionRows` 一条都认不出 → 追加整块 → 第二条 permission 行把用户自己的 presets 整块覆盖。现在读盘入口（`ensureAutoApprovePreset` / `getSetupState` / `readAutoApproveSandbox` / `setAutoApproveSandbox` / `migratePresetCopy`）统一 `stripBom`。
- **审计行会说谎**：`applyRuleOp` 在 allowlist 写盘时就打 `CONFIG … reset …`，而这次动作可能因为 config.json 写不动整体回滚——审计于是留下一条假的成功行。现在审计行推迟到跨文件提交成功之后才刷；失败分支写一条**真实**的纠正行（回滚写盘也失败时明说「已留在新语言」）。切语言成功后会顺手把跟随语言的等级说明落盘（此前只改内存，磁盘要等下一次写盘才收敛）。
- **客户端两处小漏**：`file_path` 与 `path` 同时存在时 `path` 在详情里整条看不见（专用行只渲染一个）；手改 `allowlist.json` 放同桶重复关键词会让 React key 撞车（现在 key 带序号）。
- **测试补齐**（第三轮变异测试指出 4 处防护无人守）：外层 `catch`（`plugin-error` 路径）此前**整段零覆盖**——现在用「`session.header` getter 抛错」钉住「从 req 现算身份」与「`reqInfo` 提前」；无 callId 的归因撞车守卫、`trimEventsFile` 的「读不出来」分支（连日志一起断言）也各有用例；exotic 键形态、多行 flow、4 空格子键缩进、JSON 契约、宽装饰歧义等各补用例（`scalarBodyLines` 的整段标量判定在第四轮才补上用例）。

### Review 修复（第四轮：对第三轮修复的复审）

第四轮复审确认第三轮的修复行为上全部成立，又指出四条真问题与一批测试空白：

- **窄趟也有「取最后一个」的 fail-open**：第三轮只给宽趟加了歧义闸门，而**普通形态**的两条类别行（`类别: deletion` + 卡片回显的 `类别: safe`）仍走 last-wins——卡片正文是逐字渲染的，回显照抄就能把 reject 翻成 allow。现在窄趟出现**两条不同**的表内类别行同样按失败关闭落兜底行（`src=none`，默认 human）；重复写同一行不算歧义。这推翻了 0.3.0 起「一律取最后一个」的契约，`tests/rules.test.mjs` 的相应用例与 AGENTS.md 同步改。
- **结构化输出但类别认不出时，理由里的 `safe` 会救回放行**：`类别: risky-cleanup` + `理由: cleanup is safe` 会走模糊兜底按表序扫全文命中 `safe`。现在「整段像 JSON 或**带类别标签行**」时，模糊扫描跳过「三格全 allow」的行（纯散文保持既有代价：`this looks safe to me` 仍可能落 allow）。
- **一次成功的跨文件动作写两条一模一样的审计行**：`pendingAudit` 在语言切换分支刷一次、函数尾部又刷一次。现在只在末尾刷一次（失败路径一条都不刷，只留纠正行）。
- **`config.presets` 才是 DSH 真正读的那一层**：行级错位的 `presets:`（写在 `- id: permission` 下、不在 `config` 里）此前会被当成目标——插进去以后 UI 说「已配置」而预设根本不存在；反过来，认了它还会让「已配置」判定为假、每次启动再插一份。现在 `findAutoApproveKey` / `extractPresetKeysFromPatchText` / `ensureAutoApprovePreset` 统一只认 `config.presets`（同一个 helper），并对「块标量正文里的 `presets:` 诱饵」免疫。
- **写盘闸门的判据收紧**：此前「这一行提到 `auto-approve`」会把**名字里含该子串的兄弟键**（`my-auto-approve:`）算成冲突、永久拒写合法文件。现在只认「键名恰好是 `auto-approve`」（去掉行首 `- `/`? `、标签/锚点与引号后比较）；标签/锚点/转义等认不出的写法仍由「认不出的键写法」守卫拒绝。
- **测试补齐**（第四轮变异测试存活的那几条）：下一行 flow `presets:` 的拒绝、块标量正文里的 `config:`/`presets:` 诱饵、行级错位 `presets:` 的幂等性、兄弟键名含子串不误拦、送审下限按**英文**出厂框架标定、客户端「同组落选的键（`path`）要进通用区」各有用例。

### Review 修复（第五轮：对第四轮修复的复审）

第五轮复审在第四轮的解析改动里找出一处**相对第一轮的功能回归**，以及一批测试与文档空白：

- **两趟解析（窄先宽后）本身就是漏洞**：窄趟一旦拿到唯一结果就不再跑宽趟，于是「真结论带宽装饰 + 普通形态回显」——`### 类别: deletion` 后面跟一行 `类别: safe`——窄趟只看见回显，allow 行胜出（504 组合穷举里 allow 胜出 144 条，第五轮降到 0）。现在**只跑一趟宽集合**（宽集合是窄集合的超集），并对结果要求**唯一**：两条不同的表内类别行 → 歧义 → 失败关闭落兜底行；只有一条（无论带什么装饰）才认。等级同样只认唯一值，矛盾就交给 `levels.fallback`。
- **去重发生在归一之前造成假歧义**：`类别: remote` 与 `Category: REMOTE` 被当成两条不同的行 → 转人工。现在 `allByDecor` 先小写归一再去重。
- **`looksJson` 过宽**：`[类别: safe]` 这种「模型用方括号包了一行结论」被当成 JSON 整条丢掉（与「宽集合吃 `[`」的契约矛盾）。判据收紧为「`[`/`{` 后面确实跟着 JSON 记号」。
- **预设写进了会被覆盖的那一行**（高）：`findPermissionPresets` 取**第一条**带 config 的 permission 行，而 DSH 的 patch 语义是同一 id **后写的 config 整块覆盖**前面的——两条 permission 行时插件把键写进被覆盖的那条，RPC 报成功、UI 说「已配置」、DSH 合成后 `config.presets` 里根本没有它（400 例 fuzz 里 50 次）。现在只看**最后一条** permission 行，且 `presets` 只在**同一条**行的 config 下找。
- **客户端那个 helper 是死代码**：第四轮加的 `detailExtraKeys` 只有定义、导出与测试在用，真实渲染路径还是内联三元（只覆盖 `file_path`/`path` 一对）。现在渲染路径改成调 `detailExtraKeys`（并加一条**源码级接线断言**——helper 级用例抓不到「又被改回内联」）。
- 测试补齐：失败路径审计「一条都不刷」、最后一条 permission 行的目标选择、引号键/标签键两侧行为、大小写归一的 `src=strict`、`looksJson` 收窄。

### Review 修复（第六轮：最终验证）

第六轮独立验证确认第五轮改动行为成立，但指出**同一类静默失效还留在检测侧**，外加两处测试空白：

- **检测侧只看「生效行」**（高）：第五轮把**写入**目标改成「最后一条带 config 的 permission 行」，而 `findAutoApproveKey`（以及 `hasAutoApprovePreset` / `getSetupState` / `readAutoApproveSandbox*` / `replaceAutoApproveSandbox`）仍在**扫全部行**、first-match-wins。于是「键只存在于被覆盖的那一行」会被判成「已配置」：`ensureAutoApprovePreset` 报 `already`、永不修复，UI 说已配置而 DSH 生效的 `config.presets` 里没有它——这正是第五轮想消灭的那个状态（升级用户正好会落进去）。现在检测与写入用**同一个目标选择**（`findPermissionPresets`），并补了「键只在首行 → `hasAutoApprovePreset===false` → 修复后生效行拿到 presets」的用例。
- **空的 `presets:`（无子键 / `null` / `~`）不能只插一个键**（中）：直接插入会把 mapping 实体化，**吃掉 permission 插件的 schema 默认表**（`workspace-write` / `danger-full-access` 被 default 顶掉）。现在补的是**整张出厂表**；显式 `null`/`~` 会先把值去掉再补子键（留着 `null` 会让后面的缩进行被解析成多行标量），空值写成 `presets: ~ # 注释` 也认。
- **「带类别标签但认不出」也是一个冲突信号**（低）：`类别: risky-cleanup` 后面跟一行 `类别: safe` 时，唯一性只数表内行就会放行——那是「模型自己都没定下来」的形态。现在认不出的标签行同样参与冲突判定（表内唯一 + 没有认不出的标签行，才算识别成功）。
- **本来就解析不了的 patch 不再报假成功**（低）：根部同时有裸 `[]` 与条目的文件（插件从不写坏它，但也不该在它上面「报成功」）现在直接拒绝写盘并给出明确错误。
- **CRLF 文件里的空 `presets:` 也要能补齐**（第七轮验证发现）：`split('\n')` 之后 CRLF 行尾还带 `\r`，而 `.` 不匹配 `\r` —— 去掉 `null` 值那一步会静默 no-op，子键被插到 `null` 之下变成多行标量（写盘自检拦住，但功能等于废了）。现在去值前先剥 `\r` 再补回，插入的行也跟随原文件的换行风格（不留混合换行）。
- 测试补齐：检测侧只看生效行、空 `presets` 三种写法（含 CRLF）、`hasCategoryLabel` 的英文/中文两个变体、客户端渲染路径的接线断言（helper 级用例抓不到「改回内联」）。

### 出厂三格改成「等级刻度」+ 判定失败固定转人工

用户要求：**审核表所有行的 low 默认允许、medium 默认人工、high 默认拒绝**，并且**判定压根没跑成时转人工**（而不是按 high 硬拒）。

- **出厂三格**（`DEFAULT_ROW_ACTIONS` / `defaultRowActions()`）：中英两套**各 8 行**（deletion / credential / remote / system / bulk / approval-config / safe / other）统一 `low=allow / medium=human / high=reject`——等级就是默认风险刻度，不再有「风险行三格全 reject / safe 三格全 allow / other 三格全 human」这种按行固定的动作。`sameActions(action)` 退成**旧形状**，只用于迁移判断与「老文件只有单数 `action` 时播种三格」。
- **allowlist v22 迁移**：只把**仍是该行旧出厂形状**的行改成新刻度（`LEGACY_SHIPPED_SHAPES`：deletion/credential/remote/system/bulk/approval-config 三格 reject、safe 三格 allow、other 三格 human）。用户自己拉开过的格子（哪怕只差一格）一动不动——那是他的判断。**一个已知取舍**：`other` 的旧出厂形状本来就是「三格全 human」，所以「用户故意把 other 设成全 human」与「从没动过」无法区分，会被一起迁移（`safe` 被改成全 human 则不会被迁移——那不是它的出厂形状）。
- **等级缺失/认不出** 仍走 `levels.fallback`（默认 `high`）→ 现在等于**拒绝**：模型漏写等级、或写了个认不出的词（`critical`/`高危`），出厂表下就是拒绝。想让「认不出 → 人工」把兜底档改成 `medium` 即可（设置页可改）。
- **判定压根没跑成固定转人工**（`JUDGE_FAILURE_SRCS` / `resolveFallbackAction`）：空输出、超时、调用失败、无可用路由、插件异常这些**不是模型的结论**，不再按 `other` 的三格执行——按 high 格执行会变成「没有任何人参与的硬拒绝」，一次网络抖动就成了阻断，而 low 格的自动放行更不该由故障触发。**类别认不出（`src=none`）仍走 `other` 的三格**：那是真实回答，只是无法归类。
- 顺带修好两处被这次改动带出来的问题：① 模糊兜底的「别让理由里的 allow 词变成放行」护栏原本判「三格全 allow」，新三格下没有任何一行满足 → 护栏空转；现在改成判「**在 `levels.fallback` 那一格会放行**」（`autoAllowsOnFallback`），并把 `levels` 传进解析；② 插件异常走转人工时，`toHuman` 用的是**还没建成的** `baseInfo`，会丢掉 sessionId / 工具名——现在 catch 把自己从 `req` 现算的身份传下去，并且 `humanFallback` 还没挂上时也会先写 `plugin-error` 事件与归因再交回系统默认。

### 工程

- 版本号跳到 **0.4.0**：`missingPayloadAction` 消失、事件新增 `outcome`，属于破坏性变更。README 的安装命令不再钉具体 tag（需要可复现时自己加 `#vX.Y.Z`，发布流程会校验 tag 与 `package.json` 一致）。
- CHANGELOG 里五个「未发布」小节合并：本版是 0.4.0，另外三段（风险等级与三格动作、自定义工具参数送审、判定预算与空输出重试）本来就是 0.3.0 的第二、三、四部分，已在 0.3.0 一节内归位。

### 代价（写在这里，不藏在代码里）

- 开启后，人工审批框就是**模型可以主动触发的通道**，包括它正被不可信内容驱动的时候。所以默认关闭。
- 回传的是**归因**，不是审核模型的推理过程：想知道「模型当时怎么想的」请看审批历史的「审核理由」，那里只有人能看到。


---

## 0.3.0

> 这一版把「什么交给关键词、什么交给审核模型」重新划了一遍：**审核表只留 id + 说明**（`label` 取消，`other` 成为内容不可改的结构行），**出厂关键词表从 66 条精简到 27 条**（只留零上下文就确定灾难的红线，其余交给审核模型按各行说明判），**提示词语言改成在「恢复默认」时选**。
> **升级提示**：① 老文件里已有的关键词不会被自动删掉（迁移不删用户手写的词），想用新出厂表请在设置页点一次「恢复默认关键词」；② 审核表的 `label` 字段会在下一次写盘时自动消失（旧 label 落进说明，行不会变得不可归类）；③ `other` 的说明从这一版起固定不可改，动作仍可改。

### 行为变化

- **审核表一行 = 英文 `id` + `description`（什么情况下选这个 id）+ `action`，没有 label**。送审文本变成 `- deletion：…`，模型只输出 `类别: <id>` + 理由，动作仍由程序按表执行；审批历史、设置页、决策事件一律显示 id（客户端删掉 `criterion.*` 文案与 `criterionLabel` 回落）。**说明成为必需字段**：新增行或把说明改空都会被拒（`err.criterionNeedDesc`）；id 必须是英文小写 slug，中文/非法字符报 `err.criterionNeedId`。
- **`other` 是结构行**：不可删除、**说明不可改**（`err.criterionOtherFixed`，设置页只读展示），只有动作能改。理由：关键词表缩小后「拿不准 → 转人工」是主要安全网，而框架只能靠这一行的说明指认它（不点名 id、也没有占位符），文案必须由插件保证。
- **关键词表只留三类确定性红线（27 条）**：① 清根 `rm -rf /`（写法同时覆盖 `rm -rf /*`、`sudo rm -rf /`）；② 裸设备覆写/格式化（`of=/dev/` 一条前缀词 + 伪设备例外、`mkfs`、`wipefs`、`Format-Volume`、`Clear-Disk`、`diskutil eraseDisk`）；③ 门控自身配置（`auto-approve/allowlist`、`auto-approve/config.json`、`.dsh/auto-approve`、`.dsh/profiles`、`.dsh/config.yml`、`cordis.patch.yml`）与私钥/云端凭据（`id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`、`.pem`/`.p12`/`.pfx`/`.jks`、`authorized_keys`、`.netrc`、`.git-credentials`、`.pypirc`、`~/.aws/credentials`、`~/.kube/config`）。
- **其余一律交给审核模型**（都记进 `RETIRED_DEFAULT_KEYWORDS` 留档）：递归删除家族（`rm -rf`、`rm -fr`、`sudo rm`、`Remove-Item -Recurse -Force`、`rd /s /q`、`del /f /s /q`）、`chmod 777 /`、`chmod -R 777`、`git push --force`/`-f`、`drop table`/`drop database`/`delete from`/`truncate table`、`terraform destroy`、`docker volume rm`/`prune`、`docker system prune`、关机重启，以及 `.env`/`.npmrc`/`docker config.json` 这类工具会自己改写的凭据文件。判断标准：需要看分支、看目录、看 SQL 语句、看会话状态才能判危险的一律不给词表。**人工桶默认留空**（机制保留，用户可自己加词）。
- **提示词语言没有独立开关**：在「恢复中文/英文默认审核表」「恢复中文/英文默认提示词」时选，选中同时决定框架、卡片文案与理由语言（Host 在 `rule-op` 成功后同步落 `pluginCfg.judgePromptLang` 并写 config，写盘失败回滚内存值）。恢复默认审核表只换表、不动自定义提示词；**保存审核模型/超时不再携带 `judgePromptLang`**，避免把语言写回旧值。
- allowlist 版本 18 → 19；迁移允许丢结构字段（`label`），但仍不静默删除用户手写的关键词、不覆盖用户改过的说明。

### 审核表与提示词

- **8 行说明重写**成「什么情况下选它（看哪个字段）；什么不算」的统一句式：`bulk` 明确排除可再生成的依赖/构建/缓存/临时目录，`system` 补用户与权限管理（含放宽到 777），`deletion` 补清空/截断/覆盖写，`remote` 补强制推送、破坏性 SQL、云资源删除，`safe` 补清日志/缓存/临时目录。
- **本地/临时开发库的信号写进三行**（`deletion`/`remote`/`safe`）：能确认是 `sqlite3 dev.db`、一次性测试库的常规改动不算；`remote` 保留「连接目标不明确时仍按本行判」，`psql $PROD_URL -c "drop table"` 这类不透明目标仍拒绝，拿不准落 `other` 转人工。
- **框架补两条安全网**：一条命令有多段（管道 / `&&` / `;`）时按其中最不可回补的一段归类；多行都像时选后果更不可回补、更贴说明的一行。
- **围栏与解析加固**：卡片正文里的 `TOOL_CARD` 中和成 `TOOL-CARD`（内容自带的 `TOOL_CARD>>>` 曾能把注入文本顶到围栏外）；输出格式只规定一次并要求纯文本（不要加粗/引号/代码块/JSON）；解析容忍行首/值两侧的 markdown 装饰与「整段就是一个表格 id」的裸 id（JSON 与散文仍只走模糊兜底）；模糊兜底跳过 `other` 与 allow 行，落点只可能是 reject/human；理由按框架语言输出。
- **框架与审核表解耦**：不点名出厂 id、不引用任何出厂说明文案（含意译）、不写死卡片字段清单（改为「卡片里除模型理由和描述外的字段都是操作本身」，覆盖 URL/code/SQL 等额外字段）；送审文本不出现「关键词 / keyword layer / err.*」这类插件内部词汇（有用例锁住）。

### Fixes

- **升级不退回旧误伤**：出厂已下架的 `.env` / `push --force` 的例外条目继续生效（迁移不删用户关键词），`git push --force-with-lease`、`cat .env.example` 不再被硬拒。
- **关键词漏判**：`dd if=/dev/zero of=/dev/sda` 这类 `if=` 在前的常规写法以前整条漏判，改用 `PREFIX_MATCH_KEYWORDS`（只要求词首边界），一条 `of=/dev/` 覆盖全部块设备前缀，`of=/dev/null` 不误伤。
- **`bulk` 不再一刀切**：`dd` 只指「向块设备写」，容器清理只点名销毁数据卷的形态（`docker volume rm/prune`、`docker system prune --volumes`），写镜像/备份与裸 prune 交回模型。
- **门控自身兜底补全**：`auto-approve/config.json`（自定义 `DSH_HOME` 时 `.dsh/auto-approve` 匹配不到）。
- **文档对齐**：README 中英审核表按实际出厂包重写；设置页提示同步结构行语义；`approval-config` 说明不再钉死 `~/.dsh`。

### 工程

- 新增用例：围栏中和与注入、交接覆盖（关键词删词不能删能力）、老用户下架词例外、`other` 锁定但动作可改、本地开发库三行信号、送审文本不泄露内部机制、两条安全网文案；`npm test` 154 通过、`npm run check` 通过。

---

### 风险等级与三格动作（本次发布的第二部分）

> 审核模型从「只输出类别 id」变成「输出类别 + 风险等级 + 理由」，每行三个动作格（low / medium / high），**完全由用户决定**。同时把「非表内结果」的归宿统一到兜底行 `other` 的三格，插件里不再有任何硬编码动作。
> **升级提示**：老文件的 `action` 会自动播种到三格，**行为与旧版逐字节一致**，只有你自己把三格拉开了才有区别；`other` 的说明现在可改（不再固定）；自定义提示词模板需要加 `{{levels}}` 与第三行输出，否则等级一律按兜底档执行。

### 行为变化

- **一行 = `id` + 说明 + `actions` 三格**（`{low, medium, high}`）。模型输出第三行 `风险等级: <low|medium|high>`，程序按 **(行, 等级)** 查格执行（`resolveCriterionAction`）。出厂表**所有行同一套三格：low 允许 / medium 人工 / high 拒绝**（v22 起）；设置页每行三个下拉，并显示「等级认不出 → 实际动作」。
- **等级配置可配、可恢复默认**：`allowlist.json` 新增 `levels`（三档说明 + `fallback`）。id 固定 `low|medium|high`（程序按 id 查格、解析是闭集），说明自由编辑（非空校验 `err.levelNeedDesc`）；**等级认不出时按哪一档可配**（`levels.fallback`，默认 `high`），模型少写一行、写了 `critical`/`高危` 这类认不出的词、或自定义提示词没要求输出等级时都用它。恢复默认等级说明有独立的按钮与 `rule-op {op:'reset',kind:'levels'}`（并进审核表的 reset 会让用户修表时顺手冲掉自定义说明）。
- **非表内结果一律落 `other` 的三格**：输出认不出（`src=none`）、空输出（`empty`）、超时（`timeout`）、调用失败（`call`）、无可用路由（`route`）、插件异常（`plugin`）。此前这些情况一律转人工；出厂 `other` 三格都是 `human`，所以**默认行为不变**，只有用户把 `other` 的格子放宽才会变化。审计行与事件顶层新增 `src`，`judge` 对象带 `level` / `levelSrc`——这是「模型答了 other」与「判定压根没跑成」的唯一区分手段。请求被取消仍不产生判定。
- **分类解析不出 = `other`**（`src=none`），不再抛 `err.judgeParse` 直接转人工；该错误码退出路由，只作展示标记。只有正文为空才抛 `err.judgeEmpty`（仍换更大预算重试一次）。
- **模糊兜底不再排除 `other` 与 allow 行**：归类顺序是 严格 → 整段裸 id → 模糊兜底（全表）→ `other`。「兜底只可能落 reject/human」这条性质**有意取消**（用户要求「不属于表中的其它内容都落 other」），代价是 `this looks safe to me` 这类散文现在可能落到 allow，靠事件里的 `src=fuzzy` 事后统计。
- **`other` 的唯一特殊之处是不能删除**：说明与三格都可改（`err.criterionOtherFixed` 取消，只留 `err.criterionOtherLocked`）。它现在同时承接「拿不准」「输出认不出」「判定没跑成」三种情况。
- **缺工具参数 / 字段截断改成配置项**：`missingPayloadAction` / `truncatedAction`（`human` 或 `reject`，默认 `human`）。这两类没有模型参与，所以不查审核表、不查等级；顺序仍是 `关键词拒绝 → 截断开关 → 其余`，截断的 `rm -rf /` 仍直接被关键词拒掉，截断时仍禁止关键词允许。审计行补上证据：缺参记 `keys=`（键名与长度），截断记 `fields=字段:长度>限额`——此前只有一个错误码，看不出是哪个字段。
- 出厂提示词（zh/en）改为三行输出（类别 / 风险等级 / 理由），新增 `{{levels}}` 占位符，并把「多段命令按最不可回补的一段」与「多行都像时选更不可回补的一行」两条兜底面扩展到等级。**占位符缺失时只追加定义、不追加输出格式**（格式只在模板里规定一次）。兜底档**不写进提示词**：那是程序侧行为，告诉模型只会让它偷懒不判。
- allowlist 版本 19 → 20。迁移：`action` 播种到三格（缺失的格回落该行旧 `action`，写盘后 `action` 消失）；`prevVersion < 7 / 11 / 12` 三步改用 `seedRowActions`（规范化后行上已无 `action`，直接写 `row.action` 会静默失效）；某一格写坏只让该格失败关闭为 `human`。
- 文案中性化：`verdict/path.missing-payload`、`verdict/path.truncated-payload`、`verdict/path.plugin-error` 去掉「转人工」字样（这两个开关可以配成拒绝，由 outcome 标签表达结果）。

### 设置页

- 审核表卡片：每行三个下拉（低/中/高），行下显示「等级认不出 → 实际动作」；`other` 行说明改为可编辑（上方保留一行提示）；总览计数改为三格合计。
- 新增「风险等级」卡片：三档说明 + 「等级认不出时按」下拉 + 中文/英文恢复默认。
- 新增「无法判定时」卡片：缺工具参数 / 参数过长被截断两个下拉，说明「选拒绝后不弹框，模型只会收到被拒」。
- 审批详情新增「风险等级」（走兜底档时标注）与「判定来源」。

### 自定义工具（MCP）参数送审（本次发布的第三部分）

> 修的是「自定义 MCP 每一条调用都转人工」：自定义工具的参数名不在插件的字段表里（`{cmd: …}`、`{params: {command: …}}`），旧版 `hasToolPayload()` 一律判成「缺工具参数」→ 走 `missingPayloadAction`（默认转人工），关键词层也看不见内容。**判定权交给审核模型，而不是交给参数名。**

### 行为变化

- **参数名认不出不再等于缺参**：`pickToolArgs` 除已知字段外还收未知键与嵌套叶子（键带路径 `params.command`，深度 6 / 键数 200 / 单叶 2000 字符各有上限；只取自有键，getter 抛错不算数）。这些字段同时进关键词干草、审核卡片（`参数 <键>: 值`，嵌套的已知名会渲染成卡片原有的「命令/路径/写入内容」行，不重复出现）与审批事件。`justification` 顶层与嵌套都不收：那是模型理由，不是操作。
- **关键词层不再对这类调用瞎判**：`{cmd: 'rm -rf /'}` 现在照样命中清根红线（此前关键词干草里只有工具名和 cwd）。**允许桶不跟着放宽**——放行仍只能靠已知命令/路径字段，参数名认不出时绝不自动放行；嵌套的路径字段（`params.file_path`）会拼 cwd 进路径干草，自定义工具写 `.netrc` 这类凭据文件仍命中。
- **限额按键尾认**：`params.command` 用 `command` 的限额（8000），未知字段默认 2000，超限仍走 `truncatedAction`（默认转人工）——「看不见后半截」这条安全网不动。送审/事件另有全局字符预算，预算外的大字段记进 `events.jsonl` 的 `argsOmitted`、卡片写明「以下字段过大未展示」，不悄悄砍一半交给模型判。
- 文案：`verdict/path.missing-payload` 从「缺少工具参数」改成「工具没给参数」，`set.missingPayloadAction` 改成「工具没给参数：」，`set.unjudgeableSub` 说明自定义工具参数现在由模型判。

### 设置页 / 审批历史

- 「无法判定时」卡片的说明改写：自定义工具参数名认不出不再算缺参；下拉标签改成「工具没给参数：」。
- 审批历史的详情多一段「参数 &lt;键&gt;」，列出这类通用参数（`params.command` 这类卡片另有专行的键不重复列）；条子预览在认不出命令字段时改用这些参数，不再只剩一句模型理由。

### 判定预算与空输出重试（本次发布的第四部分）

> 修的是 2026-09-14 那次「21 次判定失败 20 次」的第二阶段：**推理 token 把审核调用的输出预算吃光 → 正文为空 → `err.judgeEmpty` → 全量转人工**。当时线上档位是 `off`（等于没配），而 `judgeMaxTokens()` 只按「配没配档位」给预算，于是仍然是 256。

### 行为变化

- **预算按路由能力给，不再按「配没配档位」给**（`judgeMaxTokens(reasoningEffort, modelInfo)`）：只要 `llm.resolveModelInfo()` 报告了 `off` 之外的档位就给 1024。原因是 **`off` 与「不配档位」在适配层是同一个请求**——pi-ai 把 `off` 归一成 `undefined`，即不传思考参数，模型仍按自己的默认值思考，推理 token 与正文共享 `maxTokens`；旧实现把「用户选了 off」误当成「不会推理」。不推理的路由仍是 256。
- **空输出换更大预算重试一次**：`err.judgeEmpty` 用 `judgeEmptyRetryMaxTokens()`（首次预算翻倍且 ≥1024）再试一次，仍空才转人工。`err.judgeParse`（吐了但认不出）依旧不重试，直接转人工；请求已取消时不重试。
- **判定失败的现场写进审计与事件**：审计行变成 `FAILED … | err.judgeEmpty 空输出 finish=max-tokens reasoningChars=812 maxTokens=2048 已换更大预算重试`，事件带 `emptyOutput` / `emptyRetry` / `finishKind` / `reasoningChars` / `maxTokens`。此前正文为空时 `raw` 是空串，而事件层会把空字符串字段整条丢掉，于是 events.jsonl 上「模型一个字都没吐」和「原始输出没记上」长得一模一样。
- 设置页文案：`off` 从「off（建议）」改成「off（等同模型默认）」，并删掉「建议思考强度 off」——按上面的语义它和「模型默认」是同一个请求，不该当成规避推理的手段来推荐。

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
