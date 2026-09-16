/**
 * 「自动审批拒绝 → 告知模型为什么 → 模型可请求转人工」的纯函数与状态容器。
 *
 * 三件事在这里收口，全部是纯逻辑，方便单测：
 *   1. 归因：把 (path, src, criterion, level, keyword) 变成一句**闭集**的拒绝原因。
 *      绝不回灌审核模型那段 `理由:` 散文——它含命令片段/文件内容，是攻击者可影响的文本。
 *   2. 提示：拼模型看到的那条 notice（原因 + 转人工入口）。
 *   3. 凭证台账：一次性批准 + 人拒即死 + 在途去重。
 *
 * DSH 的审批结果 `ApprovalOutcome` 是闭集字符串（没有附带字段的位置），
 * 所以原因**必须**走 `tools/post-execute` 的 `additionalContexts` 旁路——
 * 那条路对 deny 结果照样跑（`ToolRuntime.execute` 把 deny 也送进 post-execute 瀑布）。
 */

import { createHash } from 'node:crypto'

/**
 * 拒绝原因（模型可见、设置页可见）的闭集词汇。
 * `src` 就是既有事件字段那套值（strict/bare/fuzzy/none/empty/timeout/call/route/plugin），
 * 这里只做**归类展示**，不改变任何执行语义。
 */
export const DENY_REASONS = [
  'keyword',
  'criterion',
  'payload-truncated',
  'payload-uncaptured',
  'judge-empty',
  'judge-timeout',
  'judge-call',
  'judge-route',
  'judge-unparsed',
  'plugin-error',
]

const DENY_REASON_SET = new Set(DENY_REASONS)

/**
 * 判定失败的 `src` → 拒绝原因。认不出的一律算调用失败，绝不猜。
 * `none`（模型答了、但类别认不出，于是程序落兜底行）也算「没跑成」：
 * 那不是模型选了兜底行，而是输出无法归类——`judge-unparsed` 这一档就是为它存在的。
 */
const SRC_TO_REASON = Object.freeze(Object.assign(Object.create(null), {
  none: 'judge-unparsed',
  empty: 'judge-empty',
  timeout: 'judge-timeout',
  call: 'judge-call',
  route: 'judge-route',
  plugin: 'plugin-error',
}))

/**
 * 「转人工」这条路本身不是机器拒绝：用户显式写的人工关键词、审核表判到 human 格，
 * 都还没有机器结论（人可能批准）。只有判定压根没跑成时才有失败原因可归。
 */
const HUMAN_PATHS = new Set(['keyword-human', 'criteria-human', 'human-review'])

/** 工具名允许的字符集：模型工具名一律走这个形状，认不出就回落默认名。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,47}$/

export const DEFAULT_HUMAN_REVIEW_TOOL = 'request_human_approval'

/**
 * 归因结果 → 拒绝原因（空串 = 这次没有机器拒绝原因，调用方不要补一个）。
 *
 * 关键词层单独一档：那一层不查审核表、也没有等级，命中的词本身就是原因。
 * 审核表拒绝里「模型真答了某行（含 other）」与「兜底行 other 的格子恰好是 reject」
 * 对模型的意义相同（这件事不该自动做）；但**判定压根没跑成**不是类别问题，
 * 所以先按 `src` 归因（认不出 / 空输出 / 超时 / 调用失败 / 无路由 / 插件异常），
 * 只有真的答出了类别时才用 `criterion`。
 */
export function denyReasonFor(path, detail) {
  const d = detail && typeof detail === 'object' ? detail : {}
  const src = String(d.src || '')
  if (path === 'keyword-reject') return 'keyword'
  // 「参数没采集到 / 撞收集护栏 / 超预算」走同一条 path，但**只有"没采集到"有专属档位**：
  // 它是插件侧的瞬时故障（缓存未命中），重发一次通常就好——这句话直接决定模型怎么重试。
  if (path === 'truncated-payload' && src === 'uncaptured') return 'payload-uncaptured'
  if (path === 'truncated-payload') return 'payload-truncated'
  if (path === 'plugin-error') return 'plugin-error'
  // 转人工/人工结论：没有机器拒绝原因。「为什么不执行」的答案是「人还没答」或者「人说不」，
  // 只有判定压根没跑成（`empty` / `timeout` / `call` / `route` / `plugin` / `none`）才归因失败。
  // 返回空串 = 这次没有可归因的机器原因；调用方不得把它换成 `judge-call`（那是错误归因）。
  if (HUMAN_PATHS.has(String(path || ''))) return SRC_TO_REASON[src] || ''
  // 审核表拒绝：先按 src 分「判定没跑成」与「模型答了某行」——后者才是类别问题。
  if (path === 'criteria-reject') return SRC_TO_REASON[src] || 'criterion'
  // 非表内结果（认不出 / 空输出 / 超时 / 无路由 / 调用失败 / 插件异常）按 src 归因。
  return SRC_TO_REASON[src] || 'judge-call'
}

/**
 * 单行化 + 去控制字符 + 截断：任何要写进模型可见文本的自由文本都得过这一关。
 * U+0085 / U+2028 / U+2029 也是行分隔符（模型会把它们当换行读），与 `\n` 同等处理。
 * 截断按 **UTF-16 码元**（与 DSH 侧 `boundContextSummary` 的 `.length` 同一套语义），
 * 但截断点要避开代理对中间——切出孤立高位是无效 UTF-16，落进日志/上下文就是乱码。
 */
export function clipNoticeText(value, max) {
  const limit = Number(max) > 0 ? Number(max) : 120
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n\t\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** 卡片围栏字样必须中和：正文自带一个 `TOOL_CARD>>>` 就能提前闭合围栏（与审核卡片同源的处理）。 */
function sanitizeNoticeText(value, max) {
  return clipNoticeText(value, max).replace(/TOOL[-_]CARD/gi, 'TOOL-CARD')
}

const REASON_LABELS = {
  zh: {
    keyword: '命中关键词红线',
    criterion: '审核表判定',
    'payload-truncated': '内容超过送审上限',
    'payload-uncaptured': '审批插件没有采集到这次调用的参数',
    'judge-empty': '审核模型没有输出',
    'judge-timeout': '审核模型超时',
    'judge-call': '审核模型调用失败',
    'judge-route': '没有可用的审核路由',
    'judge-unparsed': '审核输出无法归类',
    'plugin-error': '审核插件异常',
  },
  en: {
    keyword: 'matched a red-line keyword',
    criterion: 'judged by the criteria table',
    'payload-truncated': 'the judge request exceeded its limit',
    'payload-uncaptured': 'the approval plugin never captured the arguments of this call',
    'judge-empty': 'the judge model produced no output',
    'judge-timeout': 'the judge model timed out',
    'judge-call': 'the judge model call failed',
    'judge-route': 'no judge route was available',
    'judge-unparsed': 'the judge output could not be classified',
    'plugin-error': 'the approval plugin errored',
  },
}

/**
 * 等级走 `levels.fallback` 时的标注。
 *
 * 只说**等级**这一件事：`levelSrc === 'fallback'` 与「哪一行」「判定跑没跑成」都无关
 * （模型可能明确答了 `deletion`，只是没给等级）。曾经这里写的是「判定没跑成或认不出，
 * 按兜底行处理」——那会把一次完全成功的判定说成失败，还把兜底**行**和兜底**等级**混为一谈。
 */
const JUDGE_FALLBACK_NOTE = {
  zh: (level) => `（等级按兜底档 ${level} 执行）`,
  en: (level) => ` (level fell back to ${level})`,
}

/**
 * 归因 → 一句中文/英文原因。给的是**闭集派生**的信息：
 * 关键词本身（用户词表里的词，已经出现在命令里）、审核表的类别 id 与等级。
 * 不含审核模型的自由文本。没有可归因的原因时返回空串（例如「转人工」本身不是拒绝）。
 * @param {{ path?: string, reason?: string, keyword?: string, criterion?: string, level?: string, levelSrc?: string, src?: string }} detail
 * @param {string} [lang]
 */
export function formatDenyReason(detail, lang) {
  const d = detail && typeof detail === 'object' ? detail : {}
  const l = lang === 'en' ? 'en' : 'zh'
  const reason = DENY_REASON_SET.has(d.reason) ? d.reason : denyReasonFor(d.path, d)
  if (!reason) return ''
  const label = REASON_LABELS[l][reason] || REASON_LABELS[l]['judge-call']
  if (reason === 'keyword') {
    const word = sanitizeNoticeText(d.keyword, 80)
    return word ? `${label}: ${word}` : label
  }
  if (reason === 'criterion') {
    const category = sanitizeNoticeText(d.criterion, 40)
    const level = sanitizeNoticeText(d.level, 20)
    // 等级兜底是**等级**自己的事：措辞里不许出现「兜底行 / 判定没跑成」。
    const tail = d.levelSrc === 'fallback' && level ? JUDGE_FALLBACK_NOTE[l](level) : ''
    if (!category) return label
    return level ? `${label}: ${category} · ${level}${tail}` : `${label}: ${category}${tail}`
  }
  return label
}

/**
 * 「参数没采集到」专属的一句：告诉模型**下一步干什么**。
 *
 * 必须与「内容超过送审上限」分开说：那个是"操作本身太大，别再发了"，这个是插件侧的瞬时故障，
 * 而模型没有别的手段能把参数送到插件眼前——只有"重新发起同一次调用"这一条路。
 */
const UNCAPTURED_TAIL = {
  zh: '（这是审批插件侧的采集故障，与操作内容大小无关。重新发起同一次调用即可——重发通常就能被采集到。）',
  en: ' (This is a capture failure on the approval plugin side, unrelated to the size of the operation. Re-issue the same call: a retry is usually captured.)',
}

const HEAD_LINE = {
  zh: (tool) => `自动审批拒绝了 ${tool}（机器判定，不是用户拒绝）。原因：`,
  en: (tool) => `Auto-approve rejected ${tool} (a machine verdict, not a user rejection). Reason: `,
}

/**
 * 人工框给出结论之后的口径。
 *
 * DSH 给模型的原文按结局分：`rejected` → `the user rejected tool "…"`；
 * `cancelled` → `approval for tool "…" was cancelled`；`unavailable` →
 * `tool "…" requires approval, but no approval channel is available`
 * （`core/tools/src/index.ts` 的 `serviceAsk`）。后两者**都不是人拒的**，
 * 而插件这条通知是它们唯一的着笔处，所以必须把「人明确说不」（别再问了）与
 * 「转过去但没人回答」（通道不可用，可以再走别的路）分开写。前者再指路转人工毫无意义。
 */
const HUMAN_HEAD_LINE = {
  zh: {
    // 这句**只**用于原生审批框的结论：模型主动求复核的那次调用不追加 notice（工具结果里已写清结局）。
    // 所以不许写「模型请求复核」——原生框里人看到的是这次操作的详情行与升级理由，压根没有复核请求，
    // 对没发生的事下断言就是撒谎（与「不许写（自动审批已拒绝）」同一条规则，实测踩过）。
    denied: (tool) => `人工审批拒绝了 ${tool}。人明确拒绝了这次操作，不要再请求同一个操作。`,
    // 句尾**不带**「原因：」：转人工本来就没有机器原因，硬拼一句「审核模型调用失败」是错误归因。
    // 只有判定压根没跑成时才有 `why`，那时才补「原因：<闭集原因>」。
    unavailable: (tool) => `自动审批把 ${tool} 转给了人工，但没有拿到人工结论（没人在场或审批通道不可用）。`,
  },
  en: {
    denied: (tool) => `A human rejected ${tool}. A person explicitly declined this operation; do not request it again.`,
    unavailable: (tool) => `Auto-approve escalated ${tool} to a human, but no decision arrived (nobody present or no approval channel).`,
  },
}

/** 「转人工但没结论」里，有真实失败原因时才补的那半句。 */
const REASON_LEAD = { zh: '原因：', en: ' Reason: ' }

const USE_TOOL_LINE = {
  zh: (tool, name) => `如果你认为这一步必须执行，调用 ${name} 转人工审批，并在 justification 里写一句理由；操作参数原样传给它。人工批准后立刻用**完全相同的参数**重试 ${tool}，那次会被放行；被拒绝就不要再试。`,
  en: (tool, name) => `If you believe this step is required, call ${name} to request human review, passing the original arguments in \`arguments\` plus a one-line \`justification\`. After the human approves, retry ${tool} immediately with the exact same arguments — that retry is allowed; if it is denied, do not try again.`,
}

/**
 * 拼模型看到的那条 notice。
 *
 * 只讲归因、拒绝后该怎么办、以及**怎么把决定权交回人**——不教任何绕过手段（没有「换个说法重试」）。
 * 明确写「不是用户拒绝」：在此之前模型看到的原文是 `the user rejected tool "…"`，
 * 那会把自动判定误导成人工否决，模型于是停下来道歉而不是换安全路径。
 *
 * 三种口径，取决于这次到底是谁否掉的：
 *   - 自动拒绝（未转人工）：机器判定 + 可选的转人工入口；
 *   - 人工拒绝：人看过「模型请求复核」之后明确说不——不再指路转人工（问了也没用）；
 *   - 转人工但没有结论：说清「不是人拒的」，同样不指路（通道本来就不可用）。
 *
 * @param {{ toolName?: string, reason?: string, path?: string, keyword?: string, criterion?: string, level?: string, levelSrc?: string, src?: string, humanDenied?: boolean, humanUnavailable?: boolean }} detail
 * @param {{ lang?: string, toolName?: string, canEscalate?: boolean }} [options]
 * @returns {string} 已单行化、截断的模型可见文本；不可升级时不提工具。
 */
export function formatDenyNotice(detail, options) {
  const d = detail && typeof detail === 'object' ? detail : {}
  const o = options && typeof options === 'object' ? options : {}
  const l = o.lang === 'en' ? 'en' : 'zh'
  const tool = sanitizeNoticeText(d.toolName, 60) || (l === 'en' ? 'the tool' : '该工具')
  const escalateTool = sanitizeNoticeText(o.toolName, 48)
  if (d.humanDenied) return HUMAN_HEAD_LINE[l].denied(tool)
  if (d.humanUnavailable) {
    const why = formatDenyReason(d, l)
    // 没有机器原因就**不写**「原因：」——转人工本身不是拒绝，不需要也不该有一条假原因。
    return why ? HUMAN_HEAD_LINE[l].unavailable(tool) + REASON_LEAD[l] + why : HUMAN_HEAD_LINE[l].unavailable(tool)
  }
  const reason = DENY_REASON_SET.has(d.reason) ? d.reason : denyReasonFor(d.path, d)
  const why = formatDenyReason(d, l) || (l === 'en' ? 'the approval plugin gave no reason' : '审批插件没给出原因')
  const head = HEAD_LINE[l](tool) + why
    + (reason === 'payload-uncaptured' ? UNCAPTURED_TAIL[l] : '')
  if (!o.canEscalate || !escalateTool) return head
  return `${head}\n${USE_TOOL_LINE[l](tool, escalateTool)}`
}

/**
 * 只有这些 path 是「机器否决」——复核框里的「自动判定」只对它们成立。
 * 人工结论（`*-human` / `human-review` / `cancelled` / `unavailable`）与未知 path 都不算：
 * 那种情况下没有「机器说过什么」，写一句 `judge-call` 兜底就是**错误归因**
 * （人会读成「审核模型调用失败」）。
 */
export const MACHINE_REJECT_PATHS = new Set(['keyword-reject', 'criteria-reject', 'truncated-payload', 'plugin-error'])

/**
 * 复核框里那句「自动判定：…」。
 *
 * 审核表拒绝用**短形态**（`bulk · high`）：前缀已经写了「自动判定」，再重复一遍「审核表判定」
 * 只是占地方；等级走兜底档时保留那个注记（机器其实没给等级，是人应该知道的一处细节）。
 * 其余档位沿用闭集文案（`命中关键词红线: wipefs` / `内容超过送审上限` / …）——同一份措辞，
 * 与审批 tab、与回传给模型的那句同源。
 */
export function formatVerdictBrief(detail, lang) {
  const d = detail && typeof detail === 'object' ? detail : {}
  const l = lang === 'en' ? 'en' : 'zh'
  /**
   * 不是机器否决就什么都不写。**判据只看 path**：`reason` 只是「在闭集里挑哪句文案」的输入，
   * 不能当成「这确实是机器否决」的证据——否则调用方随手多带一个 `reason:'judge-call'`，
   * 人工转来的框就会显示成「审核模型调用失败」（错误归因）。宁可少一句，也不瞎写。
   */
  if (!MACHINE_REJECT_PATHS.has(String(d.path || ''))) return ''
  const reason = DENY_REASON_SET.has(d.reason) ? d.reason : denyReasonFor(d.path, d)
  if (reason === 'criterion') {
    const category = sanitizeNoticeText(d.criterion, 40)
    const level = sanitizeNoticeText(d.level, 20)
    if (!category) return formatDenyReason(d, lang)
    const tail = d.levelSrc === 'fallback' && level ? JUDGE_FALLBACK_NOTE[l](level) : ''
    return level ? `${category} · ${level}${tail}` : `${category}${tail}`
  }
  return formatDenyReason(d, lang)
}

/**
 * 转人工提示框里的一句话。三段，按信息的重要性排：
 *
 *   模型请求人工复核「bash」。自动判定：bulk · high。操作：rm -rf …。模型理由：必须执行
 *
 * - **不写「（自动审批已拒绝）」**：`自动判定：…` 这半句已经说明机器否决过；而且转人工工具本身
 *   不强制「先有一次拒绝」（工具只查参数齐、没被人工拒过、没有在途同键），万一模型对没被拒过的
 *   事求复核，写「已拒绝」就是撒谎——没有判决时这句话自然退化成「模型请求人工复核「bash」。」。
 * - `operation` 是 `formatReviewOperation(args)` 压出来的参数摘要。**必须有**：DSH 的审批框只渲染
 *   `reason` 与按 `callId` 查到的那次调用的顶层 `command`，而复核请求的 `callId` 是转人工工具
 *   自己那次调用——详情行永远是空的，人只能看到「模型请求复核 bash」。让人批准一个自己看不见的
 *   命令，是这套设计里最不该有的东西。
 * - 三段之间用「。」而不是换行：审批框标题是普通文本节点，换行会被 HTML 折成空格。
 */
export function formatReviewRequestReason(toolName, justification, lang, operation, verdict) {
  const l = lang === 'en' ? 'en' : 'zh'
  const tool = sanitizeNoticeText(toolName, 60) || 'unknown'
  const whyFull = sanitizeNoticeText(justification, 100000)
  const whyCut = sanitizeNoticeText(justification, 300)
  // 模型理由也要交代截断：静默砍到 300 字，人以为自己读完了它的全部理由
  // （「操作」那一段本来就有这个标记，两段口径一致）。
  const why = whyCut + (whyFull.length > whyCut.length ? (l === 'en' ? ' (truncated)' : '（已截断）') : '')
  const op = sanitizeNoticeText(operation, 600)
  const v = sanitizeNoticeText(verdict, 120)
  if (l === 'en') {
    return `Model-requested human review of "${tool}".`
      + (v ? ` Machine verdict: ${v}.` : '')
      + (op ? ` Operation: ${op}.` : '')
      + ` Model's reason: ${why}`
  }
  return `模型请求人工复核「${tool}」。`
    + (v ? `自动判定：${v}。` : '')
    + (op ? `操作：${op}。` : '')
    + `模型理由：${why}`
}

/**
 * 追加在**审核模型**系统提示词末尾的那段说明。
 *
 * 它写给的是**审核模型**（一个只做归类的纯补全），不是执行调用的那个模型，所以：
 * ① 不点转人工工具的名字——那个名字属于**执行模型**，由拒绝通知（`formatDenyNotice` 里的
 *    「调用 X 转人工审批」）告诉它；写在这里曾经渲染成「自动审批已拒绝 request_human_approval」，
 *    既假（转人工工具永远不会被自动拒绝）又自指（下一句还得声明它不在此列）。
 * ② 不教审核模型「调用工具 / 批准后重试」——它没有工具，也不需要替人下「这一步必须执行」的结论；
 *    这里只需要告诉它：**人类复核这条路是开着的**，所以拿不准时照实给出你判断的那一行与等级。
 */
const ESCALATION_NOTE = {
  zh: '本 profile 开启了模型转人工：拿不准这次调用该不该放行时，照上面的表给出你判断的那一行与真实等级即可——'
    + '程序会按配置把它交给人工审批，不需要你替人下「这一步必须执行」的结论。',
  en: 'Model-initiated human review is enabled in this profile: when you are unsure whether a call should go through, '
    + 'just report the row and level you judge — the plugin hands it to a human per its configuration; '
    + 'you do not need to decide that the step must happen.',
}

/**
 * 审核**系统提示词**末尾追加的一段：让模型知道存在转人工这条路。
 *
 * 追加而不是改写：自定义模板必须原样保留，这里只是在末尾补一段说明——
 * 与 `{{criteria}}` / `{{levels}}` 缺失时「只追加定义」的处理同源。
 * @param {string} prompt
 * @param {{ lang?: string }} [options]
 */
export function withEscalationNote(prompt, options) {
  const o = options && typeof options === 'object' ? options : {}
  const l = o.lang === 'en' ? 'en' : 'zh'
  return `${String(prompt || '')}\n\n${ESCALATION_NOTE[l]}`
}

/**
 * 稳定序列化工具参数：键排序 + 只认 JSON 值。
 * 凭证绑定的键必须对同一个调用的每次到达都一致，所以不能用 `JSON.stringify` 的插入序。
 * 循环引用/不可序列化 → `''`，调用方据此拒绝签发（宁可让人再点一次，不可错放）。
 */
export function canonicalArgsForGrant(value) {
  const seen = new WeakSet()
  const walk = (node) => {
    if (node === null) return null
    const t = typeof node
    if (t === 'string' || t === 'boolean') return node
    if (t === 'number') return Number.isFinite(node) ? node : undefined
    if (t !== 'object') return undefined
    if (seen.has(node)) throw new Error('canonicalArgsForGrant: circular')
    seen.add(node)
    let out
    if (Array.isArray(node)) {
      out = node.map((item) => {
        const v = walk(item)
        return v === undefined ? null : v
      })
    } else {
      out = {}
      for (const key of Object.keys(node).sort()) {
        const v = walk(node[key])
        // 必须建**自有**属性：`out['__proto__'] = v` 走的是原型 setter，键会被静默丢掉，
        // 于是两次参数不同的调用算出同一个凭证键（人没批准过的那次被放行）。
        if (v !== undefined) {
          Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true })
        }
      }
    }
    seen.delete(node)
    return out
  }
  try {
    const normalized = walk(value === undefined ? {} : value)
    if (normalized === undefined) return ''
    return JSON.stringify(normalized)
  } catch {
    return ''
  }
}

/**
 * 机器否决判决的备忘（给**复核框**用，不是给模型的）。
 *
 * 为什么需要它：`rememberDeny` 那份归因会被 post-execute 的 `takeDeny` 消费掉（模型要在同一轮
 * 拿到「为什么被拒」），而模型主动求复核发生在**之后的轮次**——等它调 `request_human_approval`
 * 时，判决早就没了。人却在覆盖一个机器决定，必须看得见机器说过什么（「自动判定：bulk · high」）。
 *
 * 键与一次性凭证**同一个投影**（`canonicalArgsForGrant` 归一后的参数）：签发/校验两侧用不同的
 * 形状去比，就会出现「人批了等于没批」那类问题，备忘也一样。有界（默认 128 条，FIFO），
 * 生命周期跟着 Fiber。
 */
export function createVerdictMemo(options) {
  const o = options && typeof options === 'object' ? options : {}
  const maxEntries = Number(o.maxEntries) > 0 ? Number(o.maxEntries) : 128
  const entries = new Map()

  function keyOf(sessionId, toolName, args) {
    const canonical = canonicalArgsForGrant(args)
    if (!canonical) return ''
    return String(sessionId || '') + '\u0000' + String(toolName || '') + '\u0000' + canonical
  }

  return {
    /** 记下一次机器否决（同键覆盖，并把这条挪到最新）。 */
    remember(sessionId, toolName, args, verdict) {
      const key = keyOf(sessionId, toolName, args)
      if (!key || !verdict || typeof verdict !== 'object') return false
      entries.delete(key)
      entries.set(key, { ...verdict, at: Date.now() })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return true
    },
    /** 读回判决（副本，调用方改不动内部状态）；没有就返回 null。 */
    read(sessionId, toolName, args) {
      const hit = entries.get(keyOf(sessionId, toolName, args))
      return hit ? { ...hit } : null
    },
    size() { return entries.size },
    dispose() { entries.clear() },
  }
}

/**
 * 归因闭集 → 设置页/事件用的文案键。
 * reason 已在闭集里就直接用，否则由 path/src 派生（与 `denyReasonFor` 同一份判定）。
 */
export function denyReasonKey(detail) {
  const d = detail && typeof detail === 'object' ? detail : {}
  if (DENY_REASON_SET.has(d.reason)) return d.reason
  return denyReasonFor(d.path, d)
}

/**
 * 一次性批准凭证台账。
 *
 * 语义（三条都不能松）：
 *   - 批准只对**同一个调用**（工具名 + 参数 + 会话）有效，用一次即销毁；
 *   - 人工拒绝是**终局**：同一会话里再请求同一个操作直接拒绝，不再弹框；
 *   - 相同的请求还在等人时不重复弹框（在途去重），避免模型并行刷屏。
 *
 * 生命周期跟着 Fiber：`dispose()` 由插件的 `ctx.effect` 调用。
 */
export function createGrantLedger(options) {
  const o = options && typeof options === 'object' ? options : {}
  const maxEntries = Number(o.maxEntries) > 0 ? Number(o.maxEntries) : 64
  /** sessionId → { grants: Map, denied: Set, inflight: Map } */
  const sessions = new Map()

  function bucket(sessionId) {
    const key = String(sessionId || '')
    let b = sessions.get(key)
    if (!b) {
      b = { grants: new Map(), denied: new Set(), inflight: new Map() }
      sessions.set(key, b)
    }
    return b
  }

  /**
   * `denied` 里存**定长摘要**而不是原始凭证键。
   *
   * 原始键里含参数规范化后的全文（可能很大），所以它必须限量（`grants` 64 条）；
   * 但 `denied` 一旦按条数淘汰，「人工拒绝是终局」就变成「前 64 个才算数」——
   * 同一个操作会再弹一次框问同一个人，而那正是 AGENTS 明令的语义。
   * 摘要把每条记录压到 32 个字符，于是 `denied` 可以**留满整个会话**（代价可忽略），
   * 终局语义不再依赖访问顺序。碰撞（不同操作摘到同一个值）只会让「不再问第二次」
   * 变得过于保守——失败方向是拒绝，不是放行。
   */
  function digestKey(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 32)
  }

  function trim(b) {
    while (b.grants.size > maxEntries) {
      const oldest = b.grants.keys().next()
      if (oldest.done) break
      b.grants.delete(oldest.value)
    }
  }

  return {
    /**
     * 调用的凭证键。`canonical` 为空（不可序列化）时返回空串，调用方必须据此拒绝签发。
     */
    keyOf(sessionId, toolName, args) {
      const canonical = canonicalArgsForGrant(args)
      if (!canonical) return ''
      return `${String(sessionId || '')}\u0000${String(toolName || '')}\u0000${canonical}`
    },

    /** 人工批准：签发一次性凭证。 */
    grant(sessionId, toolName, args, now) {
      const key = this.keyOf(sessionId, toolName, args)
      if (!key) return false
      const b = bucket(sessionId)
      if (b.denied.has(digestKey(key))) return false
      b.grants.set(key, Number(now) || Date.now())
      trim(b)
      return true
    },

    /** 调用到达门控：命中即消耗。返回 true 表示本次放行且凭证已销毁。 */
    take(sessionId, toolName, args, now, ttlMs) {
      const key = this.keyOf(sessionId, toolName, args)
      if (!key) return false
      const b = sessions.get(String(sessionId || ''))
      if (!b || !b.grants.has(key)) return false
      const stamped = b.grants.get(key)
      b.grants.delete(key)
      const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 600000
      return (Number(now) || Date.now()) - stamped <= ttl
    },

    /** 人工拒绝：终局。 */
    deny(sessionId, toolName, args) {
      const key = this.keyOf(sessionId, toolName, args)
      if (!key) return
      const b = bucket(sessionId)
      b.grants.delete(key)
      b.denied.add(digestKey(key))
      trim(b)
    },

    /** 该操作是否已被人工拒绝过（终局判定）。 */
    isDenied(sessionId, toolName, args) {
      const key = this.keyOf(sessionId, toolName, args)
      if (!key) return false
      const b = sessions.get(String(sessionId || ''))
      // `denied` 存的是定长摘要、且不按条数淘汰：终局语义与访问顺序无关。
      return Boolean(b && b.denied.has(digestKey(key)))
    },

    /** 在途请求去重：同键已有等待中的人工框时返回 false，调用方直接复用。 */
    beginInflight(sessionId, toolName, args) {
      const key = this.keyOf(sessionId, toolName, args)
      if (!key) return ''
      const b = bucket(sessionId)
      if (b.inflight.has(key)) return ''
      b.inflight.set(key, true)
      return key
    },

    endInflight(sessionId, key) {
      if (!key) return
      const b = sessions.get(String(sessionId || ''))
      if (b) b.inflight.delete(key)
    },

    /** 该会话是否有人在等人工框（设置页/历史只读展示用）。 */
    inflightCount(sessionId) {
      const b = sessions.get(String(sessionId || ''))
      return b ? b.inflight.size : 0
    },

    /** Fiber 析构：所有凭证与终局记录一起消失，热更新不会留下能绕过门控的残留。 */
    dispose() {
      sessions.clear()
    },
  }
}

/**
 * 在途转人工请求的暂存区（工具 execute ↔ approval/request 处理器之间传参）。
 *
 * 工具的 `callId` 就是它自己那次审批请求的 `callId`（DSH 原样透传），
 * 所以这里用 `sessionId:callId` 作键，两个半场无需额外握手。
 *
 * 记录在人工框结算后**不立刻销毁**：`tools/post-execute` 还要读它，
 * 才能在那条「转人工请求已被拒」的 notice 里说清为什么没转成。
 */
export function createPortalStore(options) {
  const o = options && typeof options === 'object' ? options : {}
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : 900000
  const pending = new Map()
  const key = (sessionId, callId) => `${String(sessionId || '')}\u0000${String(callId || '')}`

  /** 过期清理：工具崩在 handler 之前时记录会没有归宿，不能无限攒。 */
  function prune(now) {
    const at = Number(now) || Date.now()
    for (const [k, rec] of pending) {
      if (at - Number(rec.at || 0) > ttlMs) pending.delete(k)
    }
  }

  return {
    put(sessionId, callId, record, now) {
      if (!callId) return
      prune(now)
      pending.set(key(sessionId, callId), { ...record, at: Number(now) || Date.now() })
    },
    /** 只读：给 post-execute 拼 notice 用，不消耗记录。 */
    get(sessionId, callId) {
      return pending.get(key(sessionId, callId))
    },
    /**
     * 认领：approval/request 处理器取走并标记「已处理过」。
     *
     * 认领本身就把 `forwarded` 置真，所以调用方**不能**再用它判断
     * 「这条记录是不是别人处理过的」——那会让分支永远不成立，转人工请求于是
     * 掉回普通管道（这正是第一版的 bug）。重复处理由 `handled` 挡住：
     * 已经处理过的记录不再被认领，请求回落系统默认，不会二次弹框。
     */
    claim(sessionId, callId, now) {
      const k = key(sessionId, callId)
      const found = pending.get(k)
      if (!found || found.handled) return undefined
      const claimed = { ...found, forwarded: true, handled: true, at: Number(now) || Date.now() }
      pending.set(k, claimed)
      return claimed
    },
    /**
     * 人工框结算：把结果写回记录本身。
     *
     * 不另开结果表：工具在等的是「我这次请求的结局」，
     * 拆成两张表就有两个键、两处清理、两种可能不一致。
     */
    settleRecord(sessionId, callId, patch) {
      const k = key(sessionId, callId)
      const found = pending.get(k)
      if (!found) return
      pending.set(k, { ...found, ...patch, settledAt: Date.now() })
    },
    dispose() {
      pending.clear()
    },
  }
}
