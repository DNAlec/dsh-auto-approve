/**
 * dsh-auto-approve — Host 半。
 *
 * 职责：在 `approval/request` 瀑布上做自动审批门控。
 * 允许 / 拒绝直接返回 outcome；转人工则 `await next()` 交给原网页审批框。
 * 不改 req，不 abort req.signal，不平行结算。
 * 管道（仅当会话预设为「自动审批」）：
 *   1. 关键词**拒绝**（最高优先：用户显式写的「不要做」）
 *   2. 参数没采集到 → **无条件直接拒绝**（插件侧瞬时故障，没有参数可看、也做不出凭证的键）
 *   3. 关键词**人工**（用户显式写的「我自己看」；不能被下面的闸门静默盖过）
 *   4. 收集护栏 / 送审上限闸门 → 按 `truncatedAction`（默认转人工）
 *   5. 关键词**允许**（必须放在闸门之后：看不见内容的调用禁止被放行）
 *   6. 审核模型只输出「类别 id + 风险等级 + 理由」，程序按 (行, 等级) 查三格动作
 * 关键词匹配工具名 + command + 路径 + workdir **与自定义工具（MCP 等）的未知参数值**
 * （数字/布尔标量与内容型字段不进干草：那条分工写在 AGENTS.md）。
 * 非表内结果（认不出、空输出、超时、调用异常、路由不可用、插件异常）一律落 other 的格子；
 * 请求被取消不产生 verdict；判定前只剩 `truncatedAction` 一个开关。插件不含任何硬编码动作。
 *
 * 预设沙箱 `presetSandbox` 是 auto-approve 的底线，不是管道步骤。
 * `danger-full-access` 不因模式名短路。
 *
 * 命名导出 name / inject / apply。禁止 default export（Loader unwrapExports 会丢掉 inject）。
 */
import {
  NAME,
  pathsFor,
  resolveProfilePatchPath,
  tryLoadJson,
  saveJson,
  audit as appendAudit,
  readEventsSince,
  maxEventId,
  appendEvent,
  ensureDir,
} from './util.mjs'
import {
  shippedRejectKeywords,
  DEFAULT_CRITERIA,
  shippedCriteria,
  shippedLevels,
  normalizeJudgePromptLang,
  normalizeHumanReview,
  normalizeAllowlist,
  syncShippedLevels,
  JUDGE_REQUEST_BUDGET_MIN,
  JUDGE_REQUEST_BUDGET_MAX,
  mergePluginConfig,
  pickMigratablePluginConfig,
  parseReason,
  matchKeywordBuckets,
  buildJudgePrompt,
  resolveJudgePromptTemplate,
  shippedJudgePromptTemplate,
  parseJudgeClassify,
  judgePromptOverLimit,
  MAX_JUDGE_PROMPT_CHARS,
  pickToolArgs,
  pickToolArgsDetailed,
  formatJudgeRequestNote,
  formatOversizeNote,
  judgeRequestFits,
  normalizeJudgeRequestBudget,
  clipToolArgsForEvent,
  formatKeywordHay,
  formatAllowKeywordHay,
  formatPathKeywordHay,
  formatJudgeCard,
  formatReviewOperation,
  rememberCachedCall,
  takeCachedCall,
  lookupCriteria,
  resolveCriterionAction,
  resolveFallbackAction,
  cloneAllowlist,
  copyAllowlistInto,
  mutateAllowlistOp,
  fail,
  effectiveJudgeTimeoutMs,
  judgeMaxTokens,
  judgeEmptyRetryMaxTokens,
  judgeFailureNote,
} from './rules.mjs'
import { dirname } from 'node:path'
import {
  clipNoticeText,
  createGrantLedger,
  createPortalStore,
  denyReasonKey,
  formatDenyNotice,
  formatReviewRequestReason,
  formatVerdictBrief,
  createVerdictMemo,
  MACHINE_REJECT_PATHS,
  withEscalationNote,
} from './human-review.mjs'
import {
  getSetupState,
  migratePresetCopy,
  presetDrift,
  readBasePresetKeys,
  setAutoApproveSandbox,
} from './preset-patch.mjs'

export const name = NAME
/**
 * 只列门控真正需要的服务。**不要**放 `webServer`：cordis 把插件 `inject` 当必需服务，
 * 缺一个就停在 PENDING、apply 完全不执行（`vendor/cordis/src/fiber.ts`），
 * 而 `webserver` 行只在 web-app bundle 里 —— headless / acp / sdk 组合下会连审批门控一起失踪。
 * RPC 侧自己用 `ctx.inject(['connection'], …)`，`connection.fetch.register` 不需要 webServer。
 */
export const inject = ['approval', 'permissionPresets', 'llm', 'timer']

/** Host Session 的工作目录在 header.cwd，没有 session.cwd。 */
export function readSessionCwd(session) {
  const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
  return cwd
}

/** Connection RPC 失败必须带 message，否则 client parseConnectionResponse 会 TypeError。 */
export function rpcFail(code, details) {
  const c = String(code || 'err.internal')
  const d = details && typeof details === 'object' && !Array.isArray(details) ? details : {}
  return { ok: false, error: { code: c, message: c, details: d } }
}

/**
 * 插件入口。热更新规则文件；权限预设写入 profile patch 后需重启才进会话下拉。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const paths = pathsFor()
  // 真实 profile 目录从 ctx.baseUrl 推导；拿不到才回落到 profiles/web。
  paths.profilePatch = resolveProfilePatchPath(ctx, rawConfig, paths.profilePatch)
  ensureDir(paths.auto)
  migratePresetCopy(paths.profilePatch)

  // 损坏的 allowlist 只用内存默认，绝不写盘，避免把用户规则清掉。
  const loadedAllowlist = tryLoadJson(paths.allowlist)
  let allowlist
  let allowlistCorrupt = false
  if (!loadedAllowlist.ok) {
    console.error(`[${NAME}] allowlist 无法读取，本进程用默认规则且不覆盖磁盘`, loadedAllowlist.error)
    allowlist = normalizeAllowlist(null)
    allowlistCorrupt = true
  } else {
    allowlist = normalizeAllowlist(loadedAllowlist.value)
  }

  const loadedPlugin = tryLoadJson(paths.pluginConfig)
  let pluginCfgCorrupt = false
  let pluginCfg
  let migratedPlugin = false
  if (!loadedPlugin.ok) {
    console.error(`[${NAME}] 插件配置无法读取，本进程用默认且不覆盖磁盘`, loadedPlugin.error)
    pluginCfgCorrupt = true
    pluginCfg = mergePluginConfig(rawConfig, null)
  } else if (loadedPlugin.missing) {
    const legacy = tryLoadJson(paths.legacyPluginConfig)
    const picked = (legacy.ok && !legacy.missing) ? pickMigratablePluginConfig(legacy.value) : null
    pluginCfg = mergePluginConfig(rawConfig, picked)
    if (picked && saveJson(paths.pluginConfig, pluginCfg)) {
      migratedPlugin = true
      console.log(`[${NAME}] 已从 approval-bridge/config.json 迁移判定配置到 auto-approve/config.json`)
    }
  } else {
    pluginCfg = mergePluginConfig(rawConfig, loadedPlugin.value)
  }
  warnClampedSettings(loadedPlugin.ok && !loadedPlugin.missing ? loadedPlugin.value : null)
  syncLevelLanguage()
  if (loadedAllowlist.ok && loadedAllowlist.missing && Number(pluginCfg.judge.timeoutMs) > 0) {
    allowlist.judgeTimeoutMs = Number(pluginCfg.judge.timeoutMs)
  }
  const diskVersion = (loadedAllowlist.ok && loadedAllowlist.value && typeof loadedAllowlist.value === 'object')
    ? (Number(loadedAllowlist.value.version) || 0)
    : 0
  if (loadedAllowlist.ok && (loadedAllowlist.missing || diskVersion < allowlist.version)) {
    saveJson(paths.allowlist, allowlist)
  }
  // 损坏配置不写沙箱。缺失配置若 patch 里已有 auto-approve，也不用默认 workspace-write 去加宽。
  if (!pluginCfgCorrupt) {
    const already = getSetupState(paths.profilePatch).configured
    const writeSandbox = (loadedPlugin.ok && !loadedPlugin.missing) || migratedPlugin || !already
    if (writeSandbox) {
      const presetSetup = setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox)
      if (presetSetup.ok && presetSetup.needRestart) {
        console.log(`[${NAME}] 已写入 auto-approve 权限预设（sandbox=${pluginCfg.presetSandbox}）；live patch 重载后会话权限会出现「自动审批」`)
      } else if (!presetSetup.ok) {
        console.error(
          `[${NAME}] 写入 auto-approve 预设失败（${presetSetup.code || presetSetup.error || 'err.preset'}）：${paths.profilePatch}`,
          presetSetup.details || '',
        )
      }
    }
  }
  {
    // 出厂预设表比本 profile 那份新：只警告，不自动改写用户文件（patch 里 config 是整块替换）。
    const drift = presetSetupState().drift
    if (drift.baseKnown && drift.missing.length) {
      console.warn(
        `[${NAME}] DSH 出厂权限预设表多了 ${drift.missing.join(', ')}，`
        + `但 profile 的 permission 行是本插件写入的副本（patch 整块替换 config），不会自动包含；`
        + `请更新插件或手工合并 ${paths.profilePatch}`,
      )
    }
  }
  let eventSeq = maxEventId(paths.events)
  let rpcTail = Promise.resolve()
  /**
   * 审核模型的健康度（进程内累计，只给设置页看）。
   *
   * 「判定失败固定转人工」是安全行为，但**每次判定都转人工**在用户眼里就是插件坏了——
   * 设置页必须能说出「本次运行有 N 次判定输出为空」以及「换更大预算救回了 M 次」，
   * 否则现场只剩 audit.log 里一排 `err.judgeEmpty` 和一句「为什么又弹人工框」。
   * 自检调用（`judge-selftest`）不计入这里：它不是真实判定。
   */
  const judgeHealth = {
    ok: 0,
    failed: 0,
    empty: 0,
    timeout: 0,
    recovered: 0,
    lastError: null,
    lastAt: '',
  }
  function noteJudgeOutcome(result, opts) {
    const extra = opts || {}
    const at = new Date().toISOString()
    judgeHealth.lastAt = at
    if (result && result.failed) {
      const code = result.errorCode || 'err.judgeFailed'
      judgeHealth.failed += 1
      if (code === 'err.judgeEmpty') judgeHealth.empty += 1
      if (code === 'err.judgeTimeout' || code === 'err.judgeRetryTimeout') judgeHealth.timeout += 1
      judgeHealth.lastError = {
        at,
        code,
        finishKind: result.finishKind || '',
        reasoningChars: result.reasoningChars === undefined ? '' : result.reasoningChars,
        maxTokens: result.maxTokens === undefined ? '' : result.maxTokens,
        retried: Boolean(extra.retried),
        ms: extra.ms === undefined ? '' : extra.ms,
      }
      return
    }
    judgeHealth.ok += 1
    if (extra.retried) judgeHealth.recovered += 1
  }
  function judgeHealthSnapshot() {
    return {
      ok: judgeHealth.ok,
      failed: judgeHealth.failed,
      empty: judgeHealth.empty,
      timeout: judgeHealth.timeout,
      recovered: judgeHealth.recovered,
      lastAt: judgeHealth.lastAt,
      lastError: judgeHealth.lastError ? { ...judgeHealth.lastError } : null,
    }
  }
  /**
   * 自检用的固定调用：一张最小但真实的卡片（工具名 + 沙箱模式 + 命令），
   * 让模型有东西可归类，也让「压根判不出结果」和「判出来了但表里认不出」在自检结果里分得开。
   */
  const SELFTEST_TOOL = 'bash'
  const SELFTEST_MODE = 'danger-full-access'
  const SELFTEST_COMMAND = 'echo dsh-auto-approve selftest'
  function enqueueRpc(fn) {
    const run = rpcTail.then(fn, fn)
    rpcTail = run.then(() => undefined, () => undefined)
    return run
  }
  /**
   * tools/pre-execute 缓存的工具卡片叶子字段。
   * DSH 的 approval/request 没有 command/path，必须提前记下。
   * key 为 sessionId:callId，避免多会话共用 call-0 互相覆盖。
   */
  const pendingCalls = new Map()
  /**
   * 拒绝归因：sessionId:callId → 为什么被拒（闭集 + 命中词/类别/等级）。
   * 由 approval/request 写、由 tools/post-execute 读。
   * 必须走 post-execute 旁路：`ApprovalOutcome` 是闭集字符串，拒绝没有附带原因的通道，
   * 模型否则只会看到 DSH 硬编码的 `the user rejected tool "…"`——那是**错误归因**
   * （关键词红线、插件异常都变成了「用户拒绝」）。
   */
  const denyReasons = new Map()
  /** 转人工工具 ↔ approval/request 处理器之间的在途暂存。 */
  const portal = createPortalStore()
  /** 一次性批准凭证 + 人拒即死。 */
  const ledger = createGrantLedger()
  /** 机器否决的判决备忘：复核框要告诉人「机器为什么说不」（归因记录那时已被消费掉）。 */
  const verdictMemo = createVerdictMemo()
  const log = (line) => console.log(`[${NAME}] ${line}`)
  const audit = (line) => appendAudit(paths.audit, line)

  /**
   * 一条拒绝归因，供 post-execute 拼模型可见的原因。
   * 只存闭集字段：关键词（用户词表里的词）、类别 id、等级、判定来源。
   * **绝不**存审核模型的 `理由:` 散文——它含命令片段与文件内容，回灌上下文就是一次注入机会。
   *
   * 记的时机必须是**判定落定之后**，不能在解析侧记：同一条路径既可能 reject
   * 也可能 allow/human（三格动作），在解析侧记会让
   * 「人工批准放行」的调用也拿到一条「自动审批拒绝了…」的通知。
   *
   * 转人工的归因由 `forwardToHuman` 记账、由人工结局回填（`settleDeny`）：
   * 门控 `await next()` 期间那次调用根本没有结果，post-execute 也还没轮到它，
   * 所以不存在「通知比人工结论先到」的窗口。
   */
  const denyKey = (sessionId, callId) => `${String(sessionId || '')}:${String(callId)}`
  // 请求没有 callId 时的兜底键。DSH 侧可以不传 callId，而 post-execute 只拿得到 session 与工具名；
  // 没有这个兜底，「参数没采集到 → 直接拒绝」那条路径就完全出不了原因，模型看到的还是
  // `the user rejected tool "…"`——正是这个特性要消灭的错误归因。键用 \u0000 前缀，
  // 不可能与 `session:callId` 撞车；只在 callId 缺失时写，且用一次即消耗。
  const denyFallbackKey = (sessionId, toolName) => `\u0000${String(sessionId || '')}:${String(toolName || '')}`

  function pruneDenyReasons() {
    if (denyReasons.size <= 512) return
    const now = Date.now()
    for (const [key, value] of denyReasons) {
      if (now - Number(value.at || 0) > 600000) denyReasons.delete(key)
    }
    while (denyReasons.size > 512) {
      const oldest = denyReasons.keys().next()
      if (oldest.done) break
      denyReasons.delete(oldest.value)
    }
  }

  function rememberDeny(sessionId, callId, detail) {
    const entry = { ...detail, at: Date.now() }
    if (callId) {
      denyReasons.set(denyKey(sessionId, callId), entry)
    } else if (entry.toolName) {
      // 无 callId 时键只有 session+工具名：同会话两个并发同名调用会互相吃掉归因，
      // 而「给模型一个**错的**原因」比「这次没有原因」更糟（后者模型仍会看到 DSH 原文）。
      // 已有未消费记录就放弃本次归因，宁缺勿错。
      const key = denyFallbackKey(sessionId, entry.toolName)
      if (denyReasons.has(key)) return
      denyReasons.set(key, entry)
    } else return
    pruneDenyReasons()
  }

  /** 先按 callId 精确查，查不到再用 session+工具名兜底（只可能是「无 callId」那条路径写的）。 */
  function lookupDeny(sessionId, callId, toolName) {
    if (callId) {
      const key = denyKey(sessionId, callId)
      const found = denyReasons.get(key)
      if (found) return { key, found }
    }
    if (toolName) {
      const key = denyFallbackKey(sessionId, toolName)
      const found = denyReasons.get(key)
      if (found) return { key, found }
    }
    return null
  }

  function takeDeny(sessionId, callId, toolName) {
    const hit = lookupDeny(sessionId, callId, toolName)
    if (!hit) return undefined
    denyReasons.delete(hit.key)
    return hit.found
  }

  /** 只读：判定「这次该不该出通知」时先看，确认要出才 `takeDeny` 消耗掉。 */
  function getDeny(sessionId, callId, toolName) {
    const hit = lookupDeny(sessionId, callId, toolName)
    return hit ? hit.found : undefined
  }

  function forgetDeny(sessionId, callId) {
    if (!callId) return
    denyReasons.delete(denyKey(sessionId, callId))
  }

  /**
   * 人工框结算后回填归因。四种结局只落到三档，因为人只能点两个按钮：
   *
   * 批准（`allowed-once`）→ 忘掉：放行了，没有「被拒」这回事，模型不该收到拒绝通知。
   * 拒绝（`rejected`）→ `humanDenied`：人在被明确告知「模型请求复核」之后说不。
   * 取消（`cancelled`：请求信号 abort，比如用户中止了本轮）/
   * 无结论（`unavailable`：答案链里没人在场应答）→ `humanUnavailable`：
   * **不是人拒的**，而 DSH 给模型的原文仍然是 `the user rejected tool "…"`，必须纠正这一句。
   */
  function settleDeny(sessionId, callId, outcome) {
    if (!callId) return
    const key = denyKey(sessionId, callId)
    const found = denyReasons.get(key)
    if (!found) return
    if (outcome === 'allowed-once') {
      denyReasons.delete(key)
      return
    }
    found.humanDenied = outcome === 'rejected'
    found.humanUnavailable = outcome !== 'rejected'
    found.at = Date.now()
    denyReasons.set(key, found)
  }

  /** 转人工开关（每次读盘后取，设置页保存即热生效）。 */
  function humanReview() {
    return normalizeHumanReview(pluginCfg && pluginCfg.humanReview)
  }

  /**
   * **实际注册**的工具名。
   *
   * 不能直接用配置里的名字：注册发生在 apply 时，而配置是热读的——
   * 用户刚改完工具名的那一刻，通知里若写新名字，模型会去调一个还不存在的工具。
   * 所有对模型指路的地方（通知、工具自己、识别自己那次调用）一律用这一个来源。
   */
  let registeredReviewTool = ''

  /**
   * setup 状态 + 预设表漂移。
   * 插件写进 profile patch 的 `permission` 行会整块替换 base 的 config（patch 语义不做深合并），
   * 所以 DSH 出厂表新增预设时本 profile 不会有：读 base 的 patch 比一比，只提示、不自动改写。
   */
  function presetSetupState() {
    const setup = getSetupState(paths.profilePatch)
    const base = readBasePresetKeys(dirname(paths.profilePatch))
    if (!base.ok) return { ...setup, drift: { baseKnown: false, missing: [], extra: [] } }
    return { ...setup, drift: { baseKnown: true, baseKeys: base.keys, ...presetDrift(base.keys, setup.presets) } }
  }
  const llm = ctx.llm
  const permissionPresets = ctx.permissionPresets
  const agentDefaultModel = ctx.get('agentDefaultModel')

  /**
   * 等级说明跟随提示词语言：仍是出厂原文的（哪个语言都算）换成当前语言的原文，用户改过的不动。
   * 语言存在 config.json、说明存在 allowlist.json，读盘时拿不到彼此，所以每次重载后补一步同步。
   */
  function syncLevelLanguage() {
    try {
      allowlist.levels = syncShippedLevels(allowlist.levels, normalizeJudgePromptLang(pluginCfg && pluginCfg.judgePromptLang))
    } catch (error) {
      console.warn(`[${NAME}] 等级说明语言同步失败`, error)
    }
  }

  function reloadAllowlist() {
    const loaded = tryLoadJson(paths.allowlist)
    if (!loaded.ok) {
      allowlistCorrupt = true
      return
    }
    if (loaded.missing) return
    allowlist = normalizeAllowlist(loaded.value)
    allowlistCorrupt = false
    syncLevelLanguage()
  }

  function reloadPluginCfg() {
    const loaded = tryLoadJson(paths.pluginConfig)
    if (!loaded.ok) {
      pluginCfgCorrupt = true
      return
    }
    pluginCfgCorrupt = false
    pluginCfg = mergePluginConfig(rawConfig, loaded.missing ? null : loaded.value)
    warnClampedSettings(loaded.missing ? null : loaded.value)
  }

  /**
   * 越界的设置会被**归一**（不是拒绝），过程必须留痕：`judgeRequestBudget` 与
   * `judge.timeoutMs` 读盘时都会被 clamp，而设置页对同一个越界值报的是错误提示——
   * 两边行为不一致本身没问题，**静默**才有问题（用户手改文件后看不出发生了什么）。
   */
  function warnClampedSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {}
    const budget = Number(r.judgeRequestBudget)
    if (Number.isFinite(budget)
      && (budget < JUDGE_REQUEST_BUDGET_MIN || budget > JUDGE_REQUEST_BUDGET_MAX)) {
      console.warn(`[${NAME}] judgeRequestBudget=${budget} 越界，已归一为 `
        + `${normalizeJudgeRequestBudget(budget)}（区间 ${JUDGE_REQUEST_BUDGET_MIN}..${JUDGE_REQUEST_BUDGET_MAX}）`)
    }
    const timeout = Number(r.judge && r.judge.timeoutMs)
    if (Number.isFinite(timeout) && timeout <= 0) {
      console.warn(`[${NAME}] judge.timeoutMs=${timeout} 非法，已回落为 20000`)
    }
    // 预算低于「系统提示词本身」的长度时，任何调用都送不进审核模型（每次都会按
    // 「看不见这次操作」的动作执行）。这是可配项，所以不能拒绝，但必须让用户看见。
    const budgetValue = normalizeJudgeRequestBudget(r.judgeRequestBudget)
    try {
      const framework = judgeFramework(
        (allowlist && allowlist.criteria) || DEFAULT_CRITERIA,
        normalizeJudgePromptLang(pluginCfg && pluginCfg.judgePromptLang),
      ).length
      if (budgetValue <= framework) {
        console.warn(`[${NAME}] judgeRequestBudget=${budgetValue} 不大于系统提示词本身长度 `
          + `${framework}：审核模型不会被调用，每次判定都会按 truncatedAction 处理。请调大该值。`)
      }
    } catch { /* 框架构造失败不影响读盘 */ }
    // 超长的自定义提示词**不截断**（截断会被下一次保存写回磁盘、永久丢掉尾巴），
    // 但必须留痕：它会顶爆送审上限，于是每次判定都按「看不见这次操作」的动作处理。
    const prompts = r.judgePrompts && typeof r.judgePrompts === 'object' ? r.judgePrompts : {}
    for (const lang of ['zh', 'en']) {
      const text = String(prompts[lang] == null ? '' : prompts[lang])
      if (judgePromptOverLimit(text)) {
        console.warn(`[${NAME}] judgePrompts.${lang} 有 ${text.length} 字符，超过上限 `
          + `${MAX_JUDGE_PROMPT_CHARS}：保存会被拒绝，且每次判定都会因超送审上限而按`
          + '「看不见这次操作」的动作处理。请在设置页删减后再保存。')
      }
    }
  }

  function persistPluginCfg(opts) {
    if (pluginCfgCorrupt && !(opts && opts.overwriteCorrupt)) return false
    if (!saveJson(paths.pluginConfig, pluginCfg)) {
      reloadPluginCfg()
      return false
    }
    pluginCfgCorrupt = false
    return true
  }

  function applyRuleOp(op, kind, value, pendingAudit) {
    if (allowlistCorrupt && op !== 'reset') {
      return fail('err.allowlistCorrupt')
    }
    const draft = cloneAllowlist(allowlist)
    const result = mutateAllowlistOp(draft, op, kind, value)
    if (!result.ok) return result
    if (!saveJson(paths.allowlist, draft)) return fail('err.allowlistWrite')
    copyAllowlistInto(allowlist, draft)
    allowlistCorrupt = false
    // 调用方给了 pendingAudit 就**由它决定何时刷**（跨文件动作要等 config 也落定），
    // 没人给就立刻写（其它调用点没有第二个文件要改）。
    if (result.auditLine) {
      if (Array.isArray(pendingAudit)) pendingAudit.push(result.auditLine)
      else audit(result.auditLine)
    }
    return result
  }

  function clipJudgeForEvent(j) {
    if (!j || typeof j !== 'object') return undefined
    const out = {}
    const put = (key, max, asBool) => {
      if (j[key] === undefined || j[key] === null || j[key] === '') return
      if (asBool) {
        if (j[key]) out[key] = true
        return
      }
      out[key] = String(j[key]).slice(0, max)
    }
    put('provider', 80)
    put('model', 120)
    put('effort', 40)
    put('criterion', 40)
    put('action', 20)
    // 三格动作：这一条判定实际命中了哪一档、等级是模型给的还是走 levels.fallback 来的。
    put('level', 20)
    put('levelSrc', 20)
    // 判定来源：strict / bare / fuzzy / none / empty / timeout / call / route / plugin。
    put('src', 20)
    put('reason', 600)
    put('raw', 800)
    put('error', 400)
    put('errorCode', 80)
    put('errorMs', 20)
    put('errorDetail', 400)
    put('errorEffort', 40)
    // 空正文诊断：raw 为空会被上面的规则整条丢掉，所以「一个字都没吐」必须自己带标记。
    put('emptyOutput', 0, true)
    put('emptyRetry', 0, true)
    put('finishKind', 40)
    put('reasoningChars', 20)
    put('maxTokens', 20)
    put('failed', 0, true)
    put('timedOut', 0, true)
    return Object.keys(out).length ? out : undefined
  }

/** 这些路径的处置是放行（或交给人后由人放行），事件里没有「拒绝原因」可言。 */
const NON_DENY_PATHS = new Set(['keyword-allow', 'criteria-allow', 'human-grant', 'human-review'])
  function recordEvent(sessionId, toolName, mode, reason, justification, verdict, opts) {
    eventSeq += 1
    const o = opts || {}
    const ev = {
      id: eventSeq,
      ts: new Date().toISOString(),
      sessionId: String(sessionId || ''),
      tool: String(toolName || 'unknown'),
      mode: String(mode || ''),
      reason: String(reason || '').slice(0, 600),
      justification: String(justification || '').slice(0, 400),
      verdict: String(verdict || 'auto'),
    }
    if (o.kind) ev.kind = o.kind
    if (o.category) ev.category = o.category
    if (o.judgeReason) ev.judgeReason = String(o.judgeReason).slice(0, 600)
    if (o.path) ev.path = o.path
    // 这次判定的结局。`denyReason` 的判据（下面那句）一直写着 `ev.outcome === undefined`，
    // 但这个字段从来没被赋值过——等于「放行事件不写拒绝原因」这条约定只靠 NON_DENY_PATHS 兜着，
    // 而像 `plugin-error`、`criteria-human` 这种「既可能拒绝也可能放行」的 path 就漏了：
    // 一次放行的事件会带上「为什么被拒」。现在把结局显式落下来，两个面都用它。
    if (o.outcome) ev.outcome = String(o.outcome)
    // 拒绝原因的**闭集**归类（keyword / criterion / payload-truncated / judge-timeout / …）：
    // 由 path + src 派生，与回传给模型的那句同一个判据，事后能直接统计「为什么被拒」。
    //
    // 条件是「有 path 且不是放行结局」而不是「verdict 以 reject 结尾」：`truncated-payload`
    // （超预算 / 撞护栏）与 `plugin-error` 既可能拒绝也可能转人工/放行——按 verdict 判会让它们
    // 永远不写。**`outcome` 必须显式落盘**：这一行以前写的是 `ev.outcome === undefined`，
    // 而那个字段从来没被赋值过，等于「放行事件不写拒绝原因」只靠 `NON_DENY_PATHS` 兜着。
    // 客户端也用它（`isAutoReject`）：只按 verdict 后缀判会把一次真拒绝渲染成绿色的「自动放行」。
    if (ev.outcome !== 'allowed-once' && o.path && !NON_DENY_PATHS.has(String(o.path))) {
      // 归因闭集可能给出**空串**（「转人工」本身不是机器拒绝）：空串不写字段，
      // 绝不补一个假的（补 `judge-call` 会让一次正常转人工显示成「审核模型调用失败」）。
      const reason = String(denyReasonKey({ path: String(o.path || ''), src: String(o.src || '') }) || '')
      if (reason) ev.denyReason = reason
    }
    if (o.source) ev.source = o.source
    // 判定来源（strict/bare/fuzzy/none/empty/timeout/call/route/plugin）：放事件顶层，便于统计与展示。
    if (o.src) ev.src = String(o.src).slice(0, 20)
    if (o.cwd) ev.cwd = String(o.cwd).slice(0, 400)
    if (o.keyword) ev.keyword = String(o.keyword).slice(0, 120)
    // 「这次调用没采集到参数」是审批记录里必须自带的事实：光看 `args` 缺失分不清
    // 「真没有参数」与「插件没拿到」——而人工批准的一方正是靠它才知道自己在批准什么。
    if (o.argsCaptured === false) ev.argsCaptured = false
    const eventOmitted = []
    const args = clipToolArgsForEvent(o.args, eventOmitted)
    if (Object.keys(args).length) ev.args = args
    // 卡片没给全（预算外的大字段）时留证据：模型只能在缺字段的情况下判，事件要能看出这件事。
    if (eventOmitted.length) ev.argsOmitted = eventOmitted.slice(0, 12).join(',')
    const judge = clipJudgeForEvent(o.judge)
    if (judge) ev.judge = judge
    try {
      appendEvent(paths.events, ev)
    } catch (error) {
      console.error(`[${NAME}] 记录审批事件失败`, error)
    }
    return ev
  }

  function emitDecision(leaf) {
    try {
      ctx.emit('auto-approve/decision', leaf)
    } catch (error) {
      console.error(`[${NAME}] auto-approve/decision 失败`, error)
    }
  }

  function decisionLeaf(info, extra) {
    const e = extra || {}
    const leaf = {
      sessionId: String(info.sessionId || ''),
      tool: String(info.toolName || ''),
      path: String(e.path || info.path || ''),
      verdict: String(e.verdict || ''),
    }
    if (e.outcome) leaf.outcome = String(e.outcome)
    if (e.category || info.category) leaf.category = String(e.category || info.category || '')
    if (e.level || info.level) leaf.level = String(e.level || info.level || '')
    if (e.src || info.src) leaf.src = String(e.src || info.src || '')
    if (e.judgeReason || info.judgeReason) leaf.judgeReason = String(e.judgeReason || info.judgeReason || '').slice(0, 600)
    // 机器否决的判决留一份备查：模型之后可能调 `request_human_approval` 求复核，而那条归因
    // 记录早被 post-execute 消费掉了——人要在框里看到「机器为什么说不」。
    if (leaf.outcome === 'rejected' && MACHINE_REJECT_PATHS.has(leaf.path)) {
      verdictMemo.remember(leaf.sessionId, leaf.tool, info && info.args, {
        path: leaf.path,
        keyword: String(e.keyword || ''),
        criterion: leaf.category || '',
        level: leaf.level || '',
        levelSrc: String(e.levelSrc || ''),
        src: leaf.src || '',
      })
    }
    // 拒绝的闭集归因：与事件里的 `denyReason`、回传给模型的那句同源。
    if (leaf.outcome === 'rejected') {
      // 人工拒绝没有机器归因（`denyReasonKey` 给空串）：空串不写字段。
      const reason = String(denyReasonKey({ path: leaf.path, src: leaf.src, keyword: e.keyword }) || '')
      if (reason) leaf.denyReason = reason
    }
    return leaf
  }

  function fallbackSelection() {
    try {
      const sel = agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
        ? agentDefaultModel.currentSelection()
        : undefined
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch (error) {
      console.error(`[${NAME}] agentDefaultModel.currentSelection() failed`, error)
    }
    return null
  }

  function configuredRoute() {
    reloadPluginCfg()
    const fb = fallbackSelection()
    const provider = String(pluginCfg.judge.provider || '').trim() || (fb && fb.provider) || ''
    const model = String(pluginCfg.judge.model || '').trim() || (fb && fb.model) || ''
    const reasoningEffort = String(pluginCfg.judge.reasoningEffort || '').trim()
    return { provider, model, reasoningEffort }
  }

  async function resolveJudgeRoute() {
    const route = configuredRoute()
    if (!route.provider || !route.model) {
      return { ok: false, code: 'err.judgeUnconfigured', ...route }
    }
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const efforts = (info && info.reasoning && Array.isArray(info.reasoning.efforts))
        ? info.reasoning.efforts.map((e) => e.id)
        : []
      if (route.reasoningEffort && efforts.length > 0 && !efforts.includes(route.reasoningEffort)) {
        return { ok: false, code: 'err.judgeEffort', details: { effort: route.reasoningEffort }, ...route }
      }
      // 档位表为空（路由不支持推理）：配了档位就必须报错，不能放行——适配层会抛
      // UNSUPPORTED_REASONING_EFFORT，于是**每一次判定**都以调用失败告终、静默落兜底行。
      // 这里与「档位不在列表里」同一条失败路径，诊断信息也一样。
      if (route.reasoningEffort && efforts.length === 0) {
        return { ok: false, code: 'err.judgeEffort', details: { effort: route.reasoningEffort, efforts: 0 }, ...route }
      }
      return { ok: true, ...route, info }
    } catch (error) {
      return { ok: false, code: 'err.judgeUpstream', details: { error: String((error && error.message) || error) }, ...route }
    }
  }

  /**
   * 调用审核模型。不要传 messages.system：部分 OpenAI 兼容网关会把 system 映射成 developer 导致 400。
   * 分类提示全部折进 user 文本。预算按**路由会不会推理**给（`judgeMaxTokens` 收 `route.info`）：
   * `off` / 未配档位时适配层只是不传思考参数，模型照样可能思考，推理 token 与正文共享这个预算。
   * 返回 `{ text, maxTokens, reasoningChars, finishKind }`：后三项用于判定失败时的现场诊断。
   */
  async function callJudge(userText, signal, route, system, maxTokensOverride) {
    const prompt = system || judgeFramework(allowlist.criteria, normalizeJudgePromptLang(pluginCfg.judgePromptLang))
    const maxTokens = Number(maxTokensOverride) > 0 ? Number(maxTokensOverride) : judgeMaxTokens(route.reasoningEffort, route.info)
    const opts = {
      provider: route.provider,
      model: route.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt + '\n\n' + userText }],
      }],
      temperature: 0,
      maxTokens,
      signal,
    }
    if (route.reasoningEffort) opts.reasoningEffort = route.reasoningEffort
    let text = ''
    let reasoningChars = 0
    let finishKind = ''
    for await (const chunk of llm.stream(opts)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoningChars += String(chunk.text || '').length
      else if (chunk.type === 'finish') {
        finishKind = String((chunk.reason && chunk.reason.kind) || '')
        if (finishKind === 'error' || finishKind === 'aborted') {
          const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : finishKind
          const err = new Error('err.judgeCall')
          err.code = 'err.judgeCall'
          err.details = { error: String(failure) }
          throw err
        }
      }
    }
    return { text, maxTokens, reasoningChars, finishKind }
  }

  /**
   * 送审的判定框架。
   *
   * 开启「模型转人工」时在末尾**追加**一段说明：让审核模型知道转人工这条路存在，
   * 于是遇到「拿不准但看起来必须做」的操作可以选兜底行而不是硬猜一个动作。
   * 只是追加——自定义模板必须原样保留，与 `{{criteria}}` / `{{levels}}` 缺失时
   * 「只追加定义、绝不追加输出格式」同源。
   */
  function judgeFramework(criteria, lang) {
    const base = buildJudgePrompt(criteria, allowlist.levels, lang, resolveJudgePromptTemplate(pluginCfg, lang))
    const hr = humanReview()
    if (!hr.enabled) return base
    if (!registeredReviewTool) return base
    return withEscalationNote(base, { lang: hr.noticeLang, toolName: registeredReviewTool })
  }

  /** 全局送审预算的当前值（设置页可改，默认 20000）。 */
  function judgeRequestBudget() {
    return normalizeJudgeRequestBudget(pluginCfg.judgeRequestBudget)
  }

  /**
   * 关键词层之后、送审之前的闸门：**只有"完整送审"或"根本不问模型"两种结局**。
   *
   * 判定依据是这一次调用的实际负载（收集护栏 + 整条请求预算），不是某个字段多长：
   *   - 撞到收集护栏 → 连插件自己都没收全，红线层与模型都看不全；
   *   - 整条请求（系统提示词 + 卡片）超预算 → 想看全就得超上下文，只能不问。
   * 两种都返回证据串，由调用方按 `truncatedAction` 执行并写进审计与事件。
   */
  function judgePayloadOverflow(toolName, mode, justification, args, cwd) {
    const detailed = pickToolArgsDetailed(args)
    if (detailed.over) return { over: true, why: `err.judgePayloadOversize ${formatOversizeNote()}` }
    const lang = normalizeJudgePromptLang(pluginCfg.judgePromptLang)
    const card = formatJudgeCard(toolName, mode, justification, detailed.args, cwd, lang)
    const chars = judgeFramework(allowlist.criteria || DEFAULT_CRITERIA, lang).length + card.length
    const budget = judgeRequestBudget()
    if (judgeRequestFits(chars, budget)) return { over: false, why: '' }
    return {
      over: true,
      why: `err.judgePayloadOversize ${formatJudgeRequestNote(chars, budget)}`,
    }
  }

  async function judgeOnce(toolName, mode, justification, args, signal, route, cwd, maxTokens) {
    const criteria = allowlist.criteria || DEFAULT_CRITERIA
    const lang = normalizeJudgePromptLang(pluginCfg.judgePromptLang)
    const system = judgeFramework(criteria, lang)
    let user
    try {
      user = formatJudgeCard(toolName, mode, justification, args, cwd, lang)
    } catch (error) {
      // 卡片构造抛错（例如参数超限的不变式被破坏）：**绝不**退回"少送一点"——那正是
      // 「模型在信息不全下判定」的来源。标记不重试（重试也改不了结果），交给闸门处理。
      error.noRetry = true
      throw error
    }
    // 全局预算量的是**整条请求**（系统提示词 + 卡片）。超过就整条不问模型，
    // 抛给闸门按 `truncatedAction` 处理：只有"完整送审"或"根本不问"两种结局。
    if (!judgeRequestFits(system.length + user.length, pluginCfg.judgeRequestBudget)) {
      const err = new Error('err.judgeRequestOverBudget')
      err.code = 'err.judgeRequestOverBudget'
      err.noRetry = true
      err.details = {
        chars: system.length + user.length,
        budget: normalizeJudgeRequestBudget(pluginCfg.judgeRequestBudget),
      }
      throw err
    }
    const res = await callJudge(user, signal, route, system, maxTokens)
    // 诊断跟着错误走：正文为空时 raw 是空串，事件层会把它丢掉，不能只靠 raw 分辨现场。
    const diag = { maxTokens: res.maxTokens, reasoningChars: res.reasoningChars, finishKind: res.finishKind }
    try {
      return { ...parseJudgeClassify(res.text, criteria, allowlist.levels), raw: String(res.text || '').slice(0, 800), ...diag }
    } catch (error) {
      error.raw = String(res.text || '').slice(0, 800)
      error.judgeDiag = diag
      throw error
    }
  }

  /**
   * 单次判定 + 超时 + 重试。
   * `outerSignal` 是审批请求自己的取消信号：请求被取消后不该继续烧模型调用。
   * 注意**不要**去 abort `req.signal`，这里只观察它。
   * 重试策略：调用异常重试一次；`err.judgeEmpty`（模型一个字都没吐）换更大预算重试一次，
   * 预算按 `finish` 分档（`judgeEmptyRetryMaxTokens`）——被 `max-tokens` 截断的给 8192，
   * 其余翻倍。分类解析不出**不**重试（重试也认不出），但也不再直接转人工——
   * 它和所有其它非表内结果一样，由调用方落 other 的格子。
   *
   * 每个终态都记一次 `noteJudgeOutcome`（设置页据此显示「本次运行 N 次空输出」），
   * 但**取消**与**超预算**不算：前者没有结局，后者压根没问模型。
   */
  async function withRetry(runFn, label, timeoutMs, outerSignal, opts) {
    const track = !opts || opts.track !== false
    const startedAt = Date.now()
    const settled = (result, extra) => {
      if (track) noteJudgeOutcome(result, { ms: Date.now() - startedAt, ...extra })
      return result
    }
    const cancelled = () => Boolean(outerSignal && outerSignal.aborted)
    const runOnce = async (maxTokens) => {
      if (cancelled()) return { aborted: true }
      const controller = new AbortController()
      let cancelTimer
      const onOuterAbort = () => controller.abort(`${NAME}: ${label} 请求已取消`)
      const linkable = outerSignal && typeof outerSignal.addEventListener === 'function'
      if (linkable) {
        outerSignal.addEventListener('abort', onOuterAbort, { once: true })
        // 竞态窗口：cancelled() 之后、addEventListener 之前就 abort 了，事件不会再触发。
        if (outerSignal.aborted) onOuterAbort()
      }
      const timed = new Promise((resolve) => {
        cancelTimer = ctx.timeout(() => resolve({ timedOut: true }), timeoutMs)
      })
      try {
        const call = runFn(controller.signal, maxTokens)
          .then((r) => ({ ...r, timedOut: false }))
          .catch((error) => ({ judgeError: error }))
        const result = await Promise.race([call, timed])
        if (cancelled()) return { aborted: true }
        if (result.judgeError) throw result.judgeError
        return result
      } finally {
        if (typeof cancelTimer === 'function') {
          try { cancelTimer() } catch { /* disposer */ }
        }
        if (linkable && typeof outerSignal.removeEventListener === 'function') {
          outerSignal.removeEventListener('abort', onOuterAbort)
        }
        controller.abort(`${NAME}: ${label} 结束`)
      }
    }
    let emptyRetried = false
    const failureOf = (error, previous) => {
      const prev = previous || {}
      const diag = (error && error.judgeDiag) || {}
      const code = error && error.code ? error.code : 'err.judgeFailed'
      return {
        failed: true,
        errorCode: code,
        errorDetail: error && error.details && error.details.error ? String(error.details.error) : '',
        errorMs: prev.errorMs || '',
        raw: error && error.raw ? String(error.raw).slice(0, 800) : prev.raw || '',
        emptyOutput: code === 'err.judgeEmpty',
        emptyRetry: emptyRetried,
        finishKind: diag.finishKind || '',
        reasoningChars: diag.reasoningChars === undefined ? '' : diag.reasoningChars,
        maxTokens: diag.maxTokens === undefined ? '' : diag.maxTokens,
      }
    }
    let last = { failed: true }
    let retryMaxTokens = 0
    try {
      const first = await runOnce()
      if (first.aborted) return first
      if (!first.timedOut) return settled(first, { retried: false })
      last = { failed: true, timedOut: true, errorCode: 'err.judgeTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 超时(${timeoutMs}ms)，转人工`)
      return settled(last, { retried: false })
    } catch (error) {
      last = failureOf(error)
      const code = error && error.code
      // 不变式断言（超限参数不该走到这里）：结果不会因为重试而改变，也不该被当成模型调用异常。
      if (error && error.noRetry) {
        const details = error.details || {}
        const reason = details.reason
          || (error.code === 'err.judgeRequestOverBudget'
            ? `err.judgePayloadOversize ${formatJudgeRequestNote(details.chars, details.budget)}`
            : error.code)
        console.warn(`[${NAME}] ${label} 送审内容超过预算，按 truncatedAction 处理 | ${reason}`)
        last = {
          failed: true,
          errorCode: 'err.truncatedPayload',
          errorDetail: String(reason),
          oversize: true,
        }
        // 压根没问模型，不计入判定健康度。
        return last
      }
      if (code === 'err.judgeEmpty') {
        if (cancelled()) return { aborted: true }
        retryMaxTokens = judgeEmptyRetryMaxTokens(last.maxTokens, last.finishKind)
        console.warn(`[${NAME}] ${label} ${judgeFailureNote(last)}，改用 maxTokens=${retryMaxTokens} 重试 1 次`)
        emptyRetried = true
        last.emptyRetry = true
      } else {
        console.error(`[${NAME}] ${label} 异常，重试 1 次`, error)
      }
    }
    try {
      const second = await runOnce(retryMaxTokens || undefined)
      if (second.aborted) return second
      // 重试成功：这一次判定有结论，同时记一笔「救回来了」（设置页用来说清大预算重试确实在起作用）。
      if (!second.timedOut) return settled(second, { retried: true })
      last = { failed: true, timedOut: true, emptyRetry: emptyRetried, errorCode: 'err.judgeRetryTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 重试超时(${timeoutMs}ms)`)
      return settled(last, { retried: true })
    } catch (error) {
      const prev = { errorMs: last.errorMs, raw: last.raw }
      last = failureOf(error, prev)
      console.error(`[${NAME}] ${label} 重试仍异常`, error)
      return settled(last, { retried: true })
    }
  }

  /**
   * 非表内结果的路（`other` 行）：**判定失败固定转人工**，其余按 (other, 等级) 查格。
   * 动作仍然不在插件里硬编码——「失败转人工」是 `resolveFallbackAction` 里那一条规则，
   * 与 `truncatedAction`（用户可配）不是一回事：超预算走 truncatedAction，不走这里。
   */
  function otherRowVerdict(level, src, extra) {
    const row = lookupCriteria(allowlist.criteria, 'other')
    const resolved = resolveFallbackAction(row, level, allowlist.levels, src)
    return {
      criterion: 'other',
      reason: '',
      level: resolved.level,
      levelSrc: resolved.levelSrc,
      action: resolved.action,
      src,
      ...extra,
    }
  }

  /** 判定失败的原因 → 审计/事件里的 src。这些值同时是「为什么落到 other」的唯一证据。 */
  function failureSrc(errorCode) {
    const code = String(errorCode || '')
    if (code === 'err.judgeEmpty') return 'empty'
    if (code === 'err.judgeTimeout' || code === 'err.judgeRetryTimeout') return 'timeout'
    if (code === 'err.judgeUnconfigured' || code === 'err.judgeUpstream' || code === 'err.judgeEffort') return 'route'
    if (code === 'err.judgeCall' || code === 'err.judgeFailed') return 'call'
    return 'call'
  }

  async function judgeOperation(toolName, mode, justification, args, cwd, requestSignal) {
    const route = await resolveJudgeRoute()
    const meta = {
      provider: route.provider || '',
      model: route.model || '',
      effort: route.reasoningEffort || '',
    }
    /**
     * 解析路由可能很慢（`resolveModelInfo` 是异步的），这期间请求可能已经被取消。
     * 取消必须**最先**判定：否则路由失败/不支持档位时我们会给一次已经没人等的调用
     * 造出一个 verdict（事件、决策叶子、拒绝通知全都有了），违反「取消不产生判定」。
     */
    if (requestSignal && requestSignal.aborted) {
      return { aborted: true, criterion: 'other', reason: '', ...meta }
    }
    if (!route.ok) {
      const code = route.code || 'err.judgeUnconfigured'
      audit(`FAILED  judge route: ${code}`)
      return otherRowVerdict('', 'route', {
        failed: true,
        errorCode: code,
        errorDetail: route.details && route.details.error ? String(route.details.error) : '',
        errorEffort: route.details && route.details.effort ? String(route.details.effort) : '',
        ...meta,
      })
    }
    const timeoutMs = effectiveJudgeTimeoutMs(allowlist, pluginCfg)
    const result = await withRetry(
      (signal, maxTokens) => judgeOnce(toolName, mode, justification, args, signal, route, cwd, maxTokens),
      '审核模型',
      timeoutMs,
      requestSignal,
    )
    if (result.aborted) {
      // 请求已被取消：没有需要答复的调用，不产生 verdict。
      return { aborted: true, criterion: 'other', reason: '', ...meta }
    }
    if (result.failed) {
      const code = result.errorCode || 'err.judgeFailed'
      // 送审内容超预算不是"判定失败"：它是"根本没问模型"，处置按用户设置的
      // 「参数过长」动作（与送审前的闸门同一条规则、同一个 path）。
      if (result.oversize) {
        return {
          criterion: 'other',
          reason: '',
          action: allowlist.truncatedAction,
          level: '',
          levelSrc: '',
          src: 'truncated',
          failed: true,
          timedOut: false,
          errorCode: code,
          errorDetail: result.errorDetail || '',
          // 事件顶层也留一份：判定路径上的超预算不该只能靠 judge.errorCode 认出来。
          judgeReason: result.errorDetail || '',
          ...meta,
        }
      }
      return otherRowVerdict('', failureSrc(code), {
        failed: true,
        timedOut: Boolean(result.timedOut),
        errorCode: code,
        errorMs: result.errorMs || '',
        errorDetail: result.errorDetail || '',
        raw: result.raw || '',
        // 现场诊断：空正文时 raw 是空串（事件层会整条丢掉），这几项才是可分辨的证据。
        emptyOutput: Boolean(result.emptyOutput),
        emptyRetry: Boolean(result.emptyRetry),
        finishKind: result.finishKind || '',
        reasoningChars: result.reasoningChars === undefined ? '' : result.reasoningChars,
        maxTokens: result.maxTokens === undefined ? '' : result.maxTokens,
        ...meta,
      })
    }
    const row = lookupCriteria(allowlist.criteria, result.criterion)
    return { ...result, ...resolveCriterionAction(row, result.level, allowlist.levels), ...meta }
  }

  function applyHumanOutcome(ctxInfo, outcome) {
    const { sessionId, toolName, mode, reason, justification, category, path, args, cwd, judgeReason, judge } = ctxInfo
    audit(`OUTCOME ${toolName} outcome=${outcome} source=web | ${reason.slice(0, 80)}`)
    const detail = {
      category, path, source: 'web', args, cwd, judgeReason, judge,
      argsCaptured: ctxInfo.argsCaptured,
      // 人工结局也是结局：批准的事件不该带「为什么被拒」（此前 path=criteria-human 的
      // manual-approved 事件会写上一个拒绝原因，回看时像是被拒过）。
      outcome: outcome === 'allowed-once' ? 'allowed-once' : (outcome === 'rejected' ? 'rejected' : ''),
    }
    if (outcome === 'allowed-once') {
      recordEvent(sessionId, toolName, mode, reason, justification, 'manual-approved', {
        kind: 'manual-approved', ...detail,
      })
    } else if (outcome === 'rejected') {
      recordEvent(sessionId, toolName, mode, reason, justification, 'manual-rejected', {
        kind: 'manual-rejected', ...detail,
      })
    } else {
      recordEvent(sessionId, toolName, mode, reason, justification, String(outcome || 'cancelled'), {
        kind: outcome === 'cancelled' ? 'manual-cancelled' : 'manual-unavailable',
        ...detail,
      })
    }
  }

  /**
   * 转人工：记 pending，再把同一条请求交给瀑布里的下一个 answerer（网页框）。
   * 必须 await next() 并把 outcome 原样返回，观察者才能看到人工结果。
   */
  async function forwardToHuman(info, next) {
    recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'manual-pending', {
      kind: 'manual-pending',
      category: info.category || '',
      path: info.path,
      src: info.src || '',
      args: info.args,
      cwd: info.cwd,
      judgeReason: info.judgeReason,
      judge: info.judge,
      argsCaptured: info.argsCaptured,
    })
    emitDecision(decisionLeaf(info, { verdict: 'human', path: info.path }))
    try {
      const outcome = await next()
      try {
        // 归因要跟着人工结局回填：批准 → 没有拒绝这回事；拒绝 → 让模型知道是人拒的。
        settleDeny(info.sessionId, info.callId, outcome)
        applyHumanOutcome(info, outcome)
        emitDecision(decisionLeaf(info, { verdict: 'human', path: info.path, outcome }))
      } catch (error) {
        console.error(`[${NAME}] 记录人工结果失败`, error)
      }
      return outcome
    } catch (error) {
      console.error(`[${NAME}] 网页审批框失败`, error)
      try {
        // 审批框自己炸了：归因也要收口，否则会以「还在等人」的样子永久挂住。
        settleDeny(info.sessionId, info.callId, 'unavailable')
        applyHumanOutcome(info, 'unavailable')
        emitDecision(decisionLeaf(info, { verdict: 'human', path: info.path, outcome: 'unavailable' }))
      } catch (again) {
        console.error(`[${NAME}] 记录 unavailable 失败`, again)
      }
      return 'unavailable'
    }
  }

  // 必须在工具体升级审批之前记下参数；用完在 approval/request 里 take 掉。
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const id = exec && exec.callId
      if (id) {
        const session = exec.agent && exec.agent.session
        const sid = session && typeof session.id === 'string' ? session.id : ''
        // 缓存**收集结果 + 护栏标记**：`pickToolArgs` 把超限字段丢掉后就再也看不出
        // 「这里曾经有个 9MB 的字段」，而闸门只能读到缓存。少了这一项，撞护栏的调用
        // 会被记成「工具真没给参数」（排障方向完全错）。
        rememberCachedCall(pendingCalls, sid, id, pickToolArgsDetailed(exec.arguments))
      }
    } catch (error) {
      console.error(`[${NAME}] 记录工具参数失败`, error)
    }
    return next()
  })

  /** 把人工框的结局写回在途记录，等着的工具与 post-execute 都读这一份。 */
  function settlePortal(record, outcome) {
    if (!record || !record.sessionId || !record.callId) return
    const status = outcome === 'allowed-once'
      ? 'approved'
      : (outcome === 'rejected' ? 'denied' : (outcome === 'cancelled' ? 'cancelled' : 'unavailable'))
    portal.settleRecord(record.sessionId, record.callId, { status, outcome: String(outcome || '') })
  }

  /**
   * 工具描述。**按 `humanReview.noticeLang` 分中英**，与拒绝通知同一语言。
   * 参数里字段的 description 保持英文：那是给模型的机械说明，与 DSH 自带工具
   * （`bash` / `write`）的风格一致，不跟着用户语言漂移。
   */
  const REVIEW_TOOL_DESC = {
    zh: '把一次已被自动审批拒绝的操作转成人工审批，由人来决定是否放行。'
      + '只在自动审批的拒绝提示里说了「这一步必须执行」时才用；调用时把原工具的**原样参数**放进 arguments，'
      + '并在 justification 里写一句人看得懂的理由（为什么必须做这件事）。'
      + '人工批准后，立刻用完全相同的参数重试原工具调用——那一次会被放行（凭证只有一次）；'
      + '人工拒绝后不要再用它请求同一个操作，本会话内不会再问第二次。',
    en: 'Escalate one auto-approve-rejected operation to a human decision.'
      + ' Use it only when the auto-approve rejection notice says the step is required: '
      + 'pass the original tool\'s exact arguments in `arguments` and one human-readable sentence in `justification` '
      + '(why this has to happen). After the human approves, retry the original call immediately with the exact same '
      + 'arguments — that retry is allowed exactly once. After a denial, do not request the same operation again; '
      + 'this session will not ask the human twice.',
  }

  /**
   * 工具参数。**只有一个「理由」字段**：`justification`。
   *
   * 曾经还有一个可选的 `reason`（「补充说明」），但它跟 `justification` 是同一件事、
   * 同一个位置（复核框标题里那一句）、同一类内容——全仓只有一处引用（拼接时接在
   * `justification` 后面），模型只能把同一段话写两遍，人读到的是一句被 ` — ` 连起来的
   * 复述。人只需要一个「为什么」，所以整个删掉。
   */
  const REVIEW_TOOL_PARAMS = {
    tool: 'Exact name of the rejected tool to re-run after approval (for example "bash", "write").',
    arguments: 'The rejected call\'s original arguments, verbatim and unchanged.',
    justification: 'One sentence, for the human: why this operation must execute.',
  }

  /** 结果 → 模型可见文本。分支写死在这里，模型不需要（也不该）去猜状态词汇。 */
  function renderReviewResult(args, value) {
    const v = value && typeof value === 'object' ? value : {}
    const tool = clipNoticeText(v.tool || (args && args.tool), 60) || 'the tool'
    const status = String(v.status || '')
    if (status === 'approved') {
      return [
        `Human review APPROVED for "${tool}".`,
        `Retry the original call now with the exact same arguments. That one retry is allowed; do not change the arguments, and do not ask for review again for this call.`,
      ].join(' ')
    }
    if (status === 'denied') {
      return [
        `Human review DENIED for "${tool}".`,
        `A person reviewed this and said no. Do not retry it and do not request review for the same operation again in this session.`,
      ].join(' ')
    }
    if (status === 'refused') {
      return `Human review is not available for "${tool}" in this deployment (${String(v.code || 'refused')}). Do not retry; either continue without this step or tell the user what you need.`
    }
    return [
      `Human review UNAVAILABLE for "${tool}": no answer arrived.`,
      `Do not retry on your own. Either continue without this step or report the blocked step to the user.`,
    ].join(' ')
  }

  /**
   * 注册「转人工」工具。
   *
   * 工具**常驻注册**（只在 apply 时注册一次），开关只在 execute 里判：
   * 否则每次保存设置都会让工具在模型视野里忽隐忽现，且热更新期可能注册到半个对象。
   * 关掉时它仍然可被调用，但只会明确回一句「本部署未开启」，这比名字突然消失更好解释。
   */
  function mountHumanReviewTool() {
    // `tools` 走 `ctx.get`、**不进 `inject`**：它是**可选能力**，缺了只是少一个「模型转人工」
    // 工具，门控本身照常工作（`inject` 里的服务一旦缺席，整个 fiber 会停在 PENDING，
    // 连审批门控一起不挂载）。`tools` 行确实在 base 组合里（headless/acp/sdk 也含 base），
    // 但可选能力不该赌组合形状——安装方随时可以裁掉这一行。
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      console.warn(`[${NAME}] tools 服务不可用，转人工工具未注册（其余门控不受影响）`)
      return
    }
    const hr = humanReview()
    let taken = new Set()
    try {
      const list = typeof tools.schemas === 'function' ? tools.schemas() : []
      taken = new Set((list || []).map((s) => String(s && s.name ? s.name : '')))
    } catch (error) {
      console.error(`[${NAME}] 读取工具表失败，按无冲突处理`, error)
    }
    if (taken.has(hr.toolName)) {
      console.warn(`[${NAME}] 工具名 ${hr.toolName} 已被占用，转人工工具未注册；请在设置页改一个名字`)
      return
    }
    const definition = {
      name: hr.toolName,
      description: REVIEW_TOOL_DESC[hr.noticeLang === 'en' ? 'en' : 'zh'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string', description: REVIEW_TOOL_PARAMS.tool },
          arguments: { type: 'object', description: REVIEW_TOOL_PARAMS.arguments },
          justification: { type: 'string', description: REVIEW_TOOL_PARAMS.justification },
        },
        required: ['tool', 'arguments', 'justification'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            tool: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['status'],
        },
        render: (args, value) => [{ type: 'text', text: renderReviewResult(args, value) }],
      },
      execute: async (args, exec) => {
        const hrNow = humanReview()
        const session = exec && exec.agent && exec.agent.session
        const sessionId = session && typeof session.id === 'string' ? session.id : ''
        const target = String((args && args.tool) || '').trim()
        const targetArgs = args && args.arguments && typeof args.arguments === 'object' ? args.arguments : null
        const why = String((args && args.justification) || '').trim()
        const refuse = (code) => ({ status: 'refused', tool: target, code })
        if (!hrNow.enabled) return refuse('disabled')
        if (!sessionId || !exec || !exec.callId) return refuse('no-session')
        if (!target || target === hrNow.toolName) return refuse('bad-tool')
        // 用户刚改了工具名、插件还没重载：此时不发请求，避免人在框里看到的名字对不上。
        if (registeredReviewTool && hrNow.toolName !== registeredReviewTool) return refuse('tool-renamed')
        if (!targetArgs) return refuse('bad-arguments')
        if (!why) return refuse('need-justification')
        // 人拒即死：同一个操作在本会话里被人工拒过就不再问第二次。
        const grantArgs = grantArgsOf(targetArgs)
        if (!grantArgs) return refuse('bad-arguments')
        if (ledger.isDenied(sessionId, target, grantArgs)) return refuse('already-denied')
        const inflightKey = ledger.beginInflight(sessionId, target, grantArgs)
        if (!inflightKey) return refuse('in-flight')
        const callId = String(exec.callId || '')
        try {
          portal.put(sessionId, callId, {
            sessionId,
            callId,
            toolName: target,
            arguments: targetArgs,
            justification: why,
          })
          /**
           * 请求人工审批。`reason` 是人在网页框里读到的正文：
           * 必须说清这是**模型主动求的复核**、带上**要批准的具体操作**（`formatReviewOperation`
           * 把参数压成一行——审批框的详情行按 `callId` 查原命令，而这里的 `callId` 是转人工
           * 工具自己那次调用，查不到原命令，所以不能指望它），再附上模型自己的理由
           * （`justification`，唯一一个理由字段——不再有第二个可选的「补充说明」）。
           * 人拿到的是一个可当场判断的具体请求，而不是又一次「某工具要审批」。
           * 这次请求会被本插件的 approval/request 处理器认领并直接转人工（永不走审核表）。
           */
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            toolName: registeredReviewTool || hrNow.toolName,
            callId: exec.callId,
            reason: formatReviewRequestReason(
              target,
              why,
              hrNow.noticeLang,
              formatReviewOperation(targetArgs, hrNow.noticeLang),
              (() => {
                const memo = verdictMemo.read(sessionId, target, grantArgs)
                return memo ? formatVerdictBrief(memo, hrNow.noticeLang) : ''
              })(),
            ),
            ...exec.signal ? { signal: exec.signal } : {},
          })
          settlePortal({ sessionId, callId }, outcome)
          // 认领用的记录不是拒绝归因，任何结局都要把它清掉。
          forgetDeny(sessionId, callId)
          if (outcome === 'allowed-once') {
            // 只对这一个调用有效，用一次即销毁。签发失败（参数不可序列化）就等于没批。
            if (!ledger.grant(sessionId, target, grantArgs)) return refuse('grant-failed')
            return { status: 'approved', tool: target }
          }
          if (outcome === 'rejected') {
            ledger.deny(sessionId, target, grantArgs)
            return { status: 'denied', tool: target }
          }
          return { status: 'unavailable', tool: target, code: String(outcome || 'unavailable') }
        } catch (error) {
          console.error(`[${NAME}] 转人工请求失败`, error)
          return { status: 'unavailable', tool: target, code: 'request-failed' }
        } finally {
          ledger.endInflight(sessionId, inflightKey)
        }
      },
    }
    try {
      ctx.effect(() => tools.register(definition), `${NAME}: ${hr.toolName}`)
      registeredReviewTool = hr.toolName
      log(`已注册转人工工具 ${hr.toolName}（默认关闭，设置页开启）`)
    } catch (error) {
      console.error(`[${NAME}] 注册转人工工具失败`, error)
    }
  }

  /**
   * 凭证与「人拒即死」判定的**参数投影**。
   *
   * 签发侧拿到的是模型给的原始 `arguments`，校验侧拿到的是 `pickToolArgsDetailed` 收下来的
   * `toolArgs`（标量转文本、嵌套拍平）。拿两个不同形状的对象去比，`{timeout:30}` 与
   * `{timeout:'30'}`、`{params:{command}}` 与 `{'params.command'}` 都会被判成「参数变了」——
   * 人工批准于是被静默忽略：模型重试走完整管道再被拒一次，而 `isDenied` 也查不到，
   * 通知里又提供转人工入口，变成批准/重试循环。两侧统一走这里。
   */
  function grantArgsOf(raw) {
    try {
      return pickToolArgsDetailed(raw).args
    } catch {
      return null
    }
  }

  mountHumanReviewTool()
  // 凭证台账与在途暂存都挂 Fiber：热更新后不会留下能绕过门控的一次性放行。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      portal.dispose()
      ledger.dispose()
      verdictMemo.dispose()
    }, `${NAME}: 转人工凭证台账`)
  }

  /**
   * 拒绝原因回传：把「为什么被拒」挂到那次被拒的调用后面。
   *
   * 为什么必须在 post-execute：DSH 的 `ApprovalOutcome` 是闭集字符串，服务层把
   * `rejected` 统一渲染成 `the user rejected tool "…"`（`tools/src/index.ts` 的
   * `serviceAsk`），插件没有别的位置能附带原因。而 deny 结果**照样**走 post-execute
   * 瀑布（`ToolRuntime.execute` 的 deny 分支），`additionalContexts` 也确实会
   * ferry 到下一轮请求（repeat-tool-reminder 就是靠这个打断重试循环）。
   */
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    try {
      if (!exec || !exec.agent) return decision
      const session = exec.agent.session
      const sessionId = session && typeof session.id === 'string' ? session.id : ''
      const toolName = String(exec.name || '')
      const deny = getDeny(sessionId, exec.callId, toolName)
      const record = portal.get(sessionId, exec.callId)
      const hr = humanReview()
      const isReviewCall = Boolean(record) && Boolean(registeredReviewTool) && toolName === registeredReviewTool
      // 在途记录到这里就算走完了：工具结果已经交给模型，没人再需要它。
      // 工具超时/崩溃那种没有归宿的记录由 store 自己的 TTL 清理。
      if (record) portal.settleRecord(sessionId, exec.callId, { consumed: true })
      // 转人工请求自己那次调用不再追加 notice：工具结果里已经写清了结局，
      // 两条消息说同一件事只会让模型重复解读。
      if (!deny || isReviewCall) return decision
      const notice = formatDenyNotice(
        { ...deny, toolName },
        {
          lang: hr.noticeLang,
          toolName: registeredReviewTool,
          // 人已经拒过同一个操作（或根本没人在场）时，再指路转人工毫无意义。
          canEscalate: hr.enabled && !deny.humanDenied && !deny.humanUnavailable,
        },
      )
      // 只在真的要出通知时才消耗归因：还在等人时提前 take 掉，等结论回来就没有依据了。
      takeDeny(sessionId, exec.callId, toolName)
      if (!notice) return decision
      // 摘要取第一行（不含升级路径那句），UI 上的 notice 卡片不跟着变长。
      // 摘要同样过 `clipNoticeText`：直接 `slice(0,120)` 会把 emoji 代理对切成孤立高位。
      const summary = clipNoticeText(notice.split('\n')[0], 120)
      const message = {
        role: 'user',
        content: [{ type: 'text', text: `[${NAME}] ${notice}` }],
        source: { kind: 'plugin', plugin: NAME, form: 'notice', summary },
      }
      return { ...decision, additionalContexts: [...(decision.additionalContexts || []), message] }
    } catch (error) {
      console.error(`[${NAME}] 追加拒绝原因失败`, error)
      return decision
    }
  })

  ctx.on('approval/request', async (req, next) => {
    let humanFallback = null
    let forwarded = false
    // 最外层 catch 也要按 other 的格子处理，请求信息必须留在 try 之外可见。
    let reqInfo = null
    try {
      // 非「自动审批」预设交给系统默认 ask，本插件不管。
      reloadAllowlist()
      reloadPluginCfg()
      const session = req.agent && req.agent.session
      if (!session) return next()
      let preset
      try {
        preset = permissionPresets.current(session)
      } catch (error) {
        console.error(`[${NAME}] permissionPresets.current failed`, error)
        return next()
      }
      if (pluginCfg.onlyAutoApprovePreset !== false && preset !== 'auto-approve') return next()
      if (req.signal && req.signal.aborted) return next()

      const toolName = String(req.toolName || 'unknown')
      const reason = String(req.reason || '')
      const { mode, justification } = parseReason(reason)
      const sessionId = typeof session.id === 'string' ? session.id : ''
      const sessionCwd = readSessionCwd(session)

      const cached = takeCachedCall(pendingCalls, sessionId, req.callId)
      // `cached.args` 在 pre-execute 就已经收集过一遍（并带着护栏标记），这里直接用它，
      // 不要再收集一次：再收集一次既浪费，也会把「曾经撞过护栏」这件事抹掉。
      const cachedArgs = cached.args && typeof cached.args === 'object' ? cached.args : {}
      const toolArgs = cachedArgs.args && typeof cachedArgs.args === 'object' ? cachedArgs.args : cachedArgs
      const collectOver = cachedArgs.over === true
      // 数字/布尔标量：上卡片与事件，但**不进关键词干草**（`true`/`0` 进干草只会误命中）。
      const toolScalars = cachedArgs.scalars instanceof Set ? cachedArgs.scalars : new Set()
      const oversizeNote = () => `err.payloadOversize ${formatOversizeNote()}`
      const baseInfo = {
        sessionId, toolName, mode, reason, justification, cwd: sessionCwd, callId: req.callId || '',
        args: toolArgs,
      }

      const toHuman = (path, category, extra) => {
        forwarded = true
        const extraJudge = (extra && extra.judge) || null
        /**
         * 身份一律来自 `baseInfo`：它在本函数之前一次性构造完成（对象字面量，要么全有要么全无），
         * 所以「`humanFallback` 可用但 `baseInfo` 没建成」这个窗口不存在。
         * 异常发生在更早的时候（例如读 `session.header` 就抛）时 `humanFallback` 还是 null，
         * 走的是 catch 里那段自带身份的 recordEvent——两条路都不依赖这里兜底。
         */
        const id = baseInfo
        // 先挂上归因：人可能批准（`settleDeny` 会忘掉它）也可能拒绝（补成一条真拒绝）。
        rememberDeny(id.sessionId, id.callId, {
          path,
          toolName: id.toolName,
          src: (extraJudge && extraJudge.src) || '',
          criterion: (extraJudge && extraJudge.criterion) || category || '',
          level: (extraJudge && extraJudge.level) || '',
          levelSrc: (extraJudge && extraJudge.levelSrc) || '',
        })
        return forwardToHuman({
          ...id,
          path,
          category: category || '',
          judgeReason: extra && extra.judgeReason,
          judge: extraJudge,
          argsCaptured: extra && extra.argsCaptured === false ? false : undefined,
          // 判定来源与等级要跟着转人工一起落事件：默认 other=human 时，这是分辨
          // 「模型答了 other」和「判定压根没跑成」的唯一证据。
          src: extraJudge && extraJudge.src ? extraJudge.src : '',
          level: extraJudge && extraJudge.level ? extraJudge.level : '',
        }, next)
      }
      // 最外层 catch 也要按 other 的格子处理（含 reqInfo/humanFallback），所以两者在
      // **任何可能抛错的步骤之前**就要就绪：`baseInfo` 一算出来就挂上，别等到管道中段。
      humanFallback = toHuman
      reqInfo = baseInfo

      /**
       * 1.5 转人工工具自己那一次审批请求。
       *
       * 它**永远由人决定**：不查关键词、不查审核表、不查 (行, 等级) 三格。
       * 否则「转人工请求本身被自动拒绝」会变成一个自锁死循环，而这条路存在的意义
       * 恰恰是把机器判不了/不该判的决定交回人。
       * 认领不到在途记录（或已被认领过）说明这不是本插件这次注册的那个工具调用
       * （用户自建同名工具、或重复到达）→ 交回系统默认。
       */
      {
        const hr = humanReview()
        const portalCall = portal.claim(sessionId, req.callId)
        if (registeredReviewTool && toolName === registeredReviewTool && portalCall) {
          if (!hr.enabled) {
            portal.settleRecord(sessionId, req.callId, { status: 'refused', code: 'disabled' })
            return next()
          }
          const reviewInfo = {
            ...baseInfo,
            path: 'human-review',
            category: '',
            args: portalCall.arguments && typeof portalCall.arguments === 'object' ? portalCall.arguments : {},
            judgeReason: portalCall.justification,
          }
          const outcome = await forwardToHuman(reviewInfo, next)
          settlePortal(portalCall, outcome)
          // 人拒是终局：同一会话里再请求同一个操作直接拒，不再弹框。
          if (outcome === 'rejected') ledger.deny(sessionId, portalCall.toolName, grantArgsOf(portalCall.arguments) || {})
          return outcome
        }
        // 名字是我们的转人工工具、但认领不到在途记录（热更新清空暂存 / TTL 过期 / 重复到达）：
        // **必须交回系统默认**。放它进下面的关键词→闸门→审核表，就等于「转人工请求本身被自动拒绝」，
        // 而那正是这条路要避免的自锁死循环。用户自建的同名工具同理：那不是我们的工具，
        // 由系统默认（人）来决定最安全。
        if (registeredReviewTool && toolName === registeredReviewTool) return next()
      }

      /**
       * 1.6 一次性人工批准凭证。
       *
       * 转人工工具批准后模型会重发原调用，那次必须放行——但只对**同一个调用**
       * （同会话 + 同工具 + 同参数）有效，用一次即销毁。于是这个快速通道
       * 不可能被换个说法复用：参数一变就走完整管道重新判定。
       */
      // **必须在采集闸门之后**：没采集到时 `toolArgs` 是 `{}`，而 `{}` 是一个合法的凭证键
      // （人批准过一次没有参数的同名操作就会有）。放行一次「没人看见参数」的调用与
      // 「参数没采集到一律拒绝」直接冲突。
      //
      // 采集**撞了 8MB 护栏**（`collectOver`）时凭证仍然有效，这是有意的：那次调用已经在人工框里
      // 出现过、由人明确批过（那条路弹框时参数照样上卡片与事件），
      // 而把它挡回去只会变成「批准 → 重试 → 又撞护栏 → 又弹框」的死循环。区别在于人**看得见**
      // 这次操作（`argsCaptured` 为真），而上面那条「没采集到」是人什么都看不到。
      if (cached.found && ledger.take(sessionId, toolName, toolArgs)) {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} human-grant | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'human-grant', {
          kind: 'auto', outcome: 'allowed-once', path: 'human-grant', args: toolArgs, cwd: sessionCwd,
        })
        emitDecision(decisionLeaf(baseInfo, { verdict: 'human-grant', path: 'human-grant', outcome: 'allowed-once' }))
        return 'allowed-once'
      }

      const eventDetail = { args: toolArgs, cwd: sessionCwd }
      // 顺序：**关键词拒绝 → 参数没采集到（永远拒绝）→ 关键词人工 → 收集/预算闸门 → 关键词允许 → 判定**。
      //
      // 关键词（拒绝与人工）走在闸门前面，是因为它是用户**显式**写的意图：把某个工具名或某个词
      // 写进拒绝桶，必须对「超预算 / 撞护栏」这类兜底调用同样有效——否则用户给自己的危险工具名
      // 加了词，却因为该工具恰好没带字符串参数而落到转人工，等于配置被静默忽略（实测过）。
      // 反过来，闸门不过时**禁止关键词允许**：允许桶必须在看清之后才成立。
      //
      // 唯一的例外是「参数没采集到」：那一态连参数都没有，弹人工框等于让人对一份看不见的内容
      // 拍板（也做不出一次性凭证的键），所以它无条件拒绝，人工桶也不例外。
      const hay = formatKeywordHay(toolName, reason, toolArgs, sessionCwd, toolScalars)
      const pathHay = formatPathKeywordHay(toolArgs, sessionCwd)
      const kw = matchKeywordBuckets(hay, allowlist, formatAllowKeywordHay(toolArgs, toolScalars), pathHay)

      if (kw && kw.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-reject', {
          kind: 'auto', outcome: 'rejected', path: 'keyword-reject', keyword: kw.keyword || '', ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'keyword-reject', path: 'keyword-reject', outcome: 'rejected', keyword: kw.keyword || '',
        }))
        rememberDeny(sessionId, req.callId, { path: 'keyword-reject', toolName, keyword: kw.keyword || '' })
        return 'rejected'
      }
      // **参数没采集到**（缓存未命中 / 已消费 / 热更新后内存被清）→ 不许判。
      //
      // 这一条与"这次调用没有可审内容"是两件事，别合并：参数**在**、只是插件没拿到时，
      // 卡片上只剩工具名，模型等于在盲判；而"工具真没给内容"的调用，参数我们已经拿到了。
      // 前者**无条件直接拒绝**（见下面三条理由），不吃 `truncatedAction`——那一档是给
      // 「操作本身太大」（撞收集护栏 / 超送审上限）用的；后者照常送审。
      if (!cached.found) {
        // **直接拒绝，不等 `truncatedAction`，也不弹人工框。** 三条理由：
        //  ① 它是**插件侧的瞬时故障**（缓存未命中/已消费/被挤出），不是用户设置里那两类
        //     "操作本身太大"的场景——让人为一次插件故障拍板没有意义，人也看不到任何内容；
        //  ② 拒绝会带一条闭集原因的 notice 回给模型（`payload-uncaptured`），把"重发一次"
        //     写清楚，模型重新发起同一次调用通常就能被采集到——这是**可恢复**的；
        //  ③ 这一态**没有参数可做一次性凭证的键**，批准也没法复用。
        const why = 'err.missingPayloadUncaptured'
        console.warn(`[${NAME}] ${toolName} 没采集到参数（${why}），直接拒绝并提示模型重发`)
        audit(`REJECT  ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'truncated-payload', {
          kind: 'auto', outcome: 'rejected', path: 'truncated-payload', judgeReason: why, src: 'uncaptured',
          argsCaptured: false, ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, { verdict: 'truncated-payload', path: 'truncated-payload', outcome: 'rejected' }))
        rememberDeny(sessionId, req.callId, { path: 'truncated-payload', toolName, src: 'uncaptured' })
        return 'rejected'
      }
      // 关键词**人工**桶：与拒绝桶同层，不能被 `truncatedAction` 静默盖过——用户写了
      // 「这个我要自己看」，就该让他看。它排在「参数没采集到」之后（见上面的顺序说明）。
      if (kw && kw.action === 'human') {
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        return toHuman('keyword-human', '')
      }
      // 撞了收集护栏（连插件自己都没收全）同样不许判：与超预算同一个开关、同一个 path。
      if (collectOver) {
        const why = oversizeNote()
        console.warn(`[${NAME}] ${toolName} 参数撞收集护栏，按 truncatedAction=${allowlist.truncatedAction} 处理 | ${why}`)
        if (allowlist.truncatedAction === 'reject') {
          audit(`REJECT  ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'truncated-payload', {
            kind: 'auto', outcome: 'rejected', path: 'truncated-payload', judgeReason: why, src: 'oversize', ...eventDetail,
          })
          emitDecision(decisionLeaf(baseInfo, { verdict: 'truncated-payload', path: 'truncated-payload', outcome: 'rejected' }))
          rememberDeny(sessionId, req.callId, { path: 'truncated-payload', toolName, src: 'oversize' })
          return 'rejected'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
        return toHuman('truncated-payload', 'other', { judgeReason: why, judge: { src: 'oversize' } })
      }
      // 关键词拒绝优先于预算闸门：`rm -rf /` 不管多大都直接被拒。
      // 这里起，模型只可能看到**完整**内容，或者这次调用压根不问模型。
      const overflow = judgePayloadOverflow(toolName, mode, justification, toolArgs, sessionCwd)
      if (overflow.over) {
        const why = overflow.why
        // 触发必须留痕（用户要求：不能出现"不知道为什么转人工了"）。
        console.warn(`[${NAME}] ${toolName} 送审内容超过预算，按 truncatedAction=${allowlist.truncatedAction} 处理 | ${why}`)
        if (allowlist.truncatedAction === 'reject') {
          audit(`REJECT  ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'truncated-payload', {
            kind: 'auto', outcome: 'rejected', path: 'truncated-payload', judgeReason: why, src: 'truncated', ...eventDetail,
          })
          emitDecision(decisionLeaf(baseInfo, { verdict: 'truncated-payload', path: 'truncated-payload', outcome: 'rejected' }))
          rememberDeny(sessionId, req.callId, { path: 'truncated-payload', toolName, src: 'truncated' })
          return 'rejected'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
        return toHuman('truncated-payload', 'other', { judgeReason: why, judge: { src: 'truncated' } })
      }

      // 关键词**允许**放在闸门之后：看不见内容的调用禁止被允许桶放行（拒绝/人工已经在前面
      // 处理掉了，走到这里只剩允许）。
      if (kw && kw.action === 'allow') {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-allow', {
          kind: 'auto', outcome: 'allowed-once', path: 'keyword-allow', ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, { verdict: 'keyword-allow', path: 'keyword-allow', outcome: 'allowed-once' }))
        return 'allowed-once'
      }
      const judged = await judgeOperation(toolName, mode, justification, toolArgs, sessionCwd, req.signal)
      const criterion = judged.criterion || 'other'
      const judgeReason = judged.reason || ''
      if (judged.aborted) {
        // 请求已被取消（工具执行 signal abort）。审批服务会以 cancelled 结算并丢弃迟到结果，
        // 这里不再占坑、也不再调 next()，避免取消后还弹人工框。
        audit(`CANCEL  ${toolName} mode=${mode || 'none'} judge aborted`)
        return 'cancelled'
      }
      // 判定失败不再短路转人工：它和其它非表内结果一样落 other 的格子，src 记录真实原因。
      const cells = `criteria=${criterion} level=${judged.level || ''}${judged.levelSrc === 'fallback' ? '(兜底)' : ''} src=${judged.src || ''}`
      const tail = judged.failed
        ? `${judged.errorCode || 'err.judgeFailed'}${judgeFailureNote(judged) ? ' ' + judgeFailureNote(judged) : ''}`
        : (judgeReason || reason.slice(0, 120))
      const eventJudge = { category: criterion, judgeReason, judge: judged, src: judged.src, ...eventDetail }
      if (judged.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} ${cells} | ${tail}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-reject', {
          kind: 'auto', outcome: 'rejected', path: 'criteria-reject', ...eventJudge,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'criteria-reject', path: 'criteria-reject', outcome: 'rejected',
          category: criterion, level: judged.level, levelSrc: judged.levelSrc || '', src: judged.src, judgeReason,
        }))
        // 归因只带闭集字段：类别 id 与等级（用户自己的词表），**不带**审核模型那段理由散文。
        rememberDeny(sessionId, req.callId, {
          path: 'criteria-reject',
          toolName,
          src: judged.src || '',
          criterion,
          level: judged.level || '',
          levelSrc: judged.levelSrc || '',
        })
        return 'rejected'
      }
      if (judged.action === 'allow') {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} ${cells} | ${tail}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-allow', {
          kind: 'auto', outcome: 'allowed-once', path: 'criteria-allow', ...eventJudge,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'criteria-allow', path: 'criteria-allow', outcome: 'allowed-once',
          category: criterion, level: judged.level, src: judged.src, judgeReason,
        }))
        return 'allowed-once'
      }
      audit(`HUMAN   ${toolName} mode=${mode || 'none'} ${cells} | ${tail}`)
      return toHuman('criteria-human', criterion, { judgeReason: judgeReason || tail, judge: judged })
    } catch (error) {
      console.error(`[${NAME}] 判断过程出错，按 other 的格子处理`, error)
      if (forwarded) return 'unavailable'
      const code = (error && error.code) || 'err.pluginError'
      try {
        const row = lookupCriteria(allowlist.criteria, 'other')
        // 插件自己抛错（src=plugin）属于「判定没跑成」：固定转人工，不查 other 的三格。
        const resolved = resolveFallbackAction(row, '', allowlist.levels, 'plugin')
        const detail = {
          judgeReason: code,
          judge: {
            errorCode: code,
            src: 'plugin',
            level: resolved.level,
            levelSrc: resolved.levelSrc,
            action: resolved.action,
            errorDetail: String((error && error.message) || error),
          },
        }
        // `reqInfo` 在 `baseInfo` 之后就已就绪；更早的异常（preset / 缓存）也要能从 req 现算一份，
        // 否则事件的身份是空的：该会话的审批历史看不到，归因也因为没有工具名而根本不记。
        const info = reqInfo || (() => {
          const parsed = parseReason(String(req.reason || ''))
          const agentSession = req.agent && req.agent.session
          return {
            sessionId: agentSession && typeof agentSession.id === 'string' ? agentSession.id : '',
            toolName: String(req.toolName || 'unknown'),
            mode: parsed.mode,
            reason: String(req.reason || ''),
            justification: parsed.justification,
            callId: req.callId || '',
            args: {},
          }
        })()
        const label = `${info.toolName || 'unknown'} criteria=other level=${resolved.level}${resolved.levelSrc === 'fallback' ? '(兜底)' : ''} src=plugin`
        if (resolved.action === 'reject') {
          audit(`REJECT  ${label} | ${code}`)
          recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'plugin-error', {
            kind: 'auto', outcome: 'rejected', path: 'plugin-error', src: 'plugin', ...detail,
          })
          emitDecision(decisionLeaf(info, { verdict: 'plugin-error', path: 'plugin-error', outcome: 'rejected', src: 'plugin' }))
          rememberDeny(info.sessionId, info.callId, { path: 'plugin-error', toolName: info.toolName, src: 'plugin' })
          return 'rejected'
        }
        if (resolved.action === 'allow') {
          audit(`ALLOW   ${label} | ${code}`)
          recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'plugin-error', {
            kind: 'auto', outcome: 'allowed-once', path: 'plugin-error', src: 'plugin', ...detail,
          })
          emitDecision(decisionLeaf(info, { verdict: 'plugin-error', path: 'plugin-error', outcome: 'allowed-once', src: 'plugin' }))
          return 'allowed-once'
        }
        audit(`HUMAN   ${label} | ${code}`)
        if (humanFallback) return await humanFallback('plugin-error', 'other', detail)
        /**
         * `humanFallback` 还没挂上（异常发生在它被赋值之前，例如读 `session.header` 就抛）：
         * 交回系统默认的审批框，但**事件与归因照记**——否则这次插件异常在审批历史里
         * 完全看不见（那次 review 修的正是「外层 catch 整段零覆盖」）。
         */
        recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'plugin-error', {
          kind: 'manual-pending', path: 'plugin-error', src: 'plugin', ...detail,
        })
        emitDecision(decisionLeaf(info, { verdict: 'plugin-error', path: 'plugin-error', src: 'plugin' }))
        rememberDeny(info.sessionId, info.callId, { path: 'plugin-error', toolName: info.toolName, src: 'plugin' })
        // 人工结论必须回填归因：批准要**删掉**这条记录（否则模型被告知「机器判定拒绝了」，
        // 而调用其实被人放行、工具真的跑了），人拒要补成「人工审批拒绝」，
        // 没结论要落 `humanUnavailable`。正常转人工走 forwardToHuman → settleDeny，
        // 这条分支没有 forwardToHuman，所以要自己收口。
        const outcome = await next()
        settleDeny(info.sessionId, info.callId, outcome)
        return outcome
      } catch (again) {
        console.error(`[${NAME}] 按 other 处理仍失败，交回系统默认`, again)
      }
      return next()
    }
  }, { prepend: true })

  // ---- 鉴权 RPC：挂在已有 /api 通道上。不要用 rpc.handle 开独立前缀——
  // handle() 在 connection 自己的 ctx 上访问 webServer，而 connection 只注入
  // credentials，必炸 "webServer without inject"，设置页 POST 落到 SPA → 405。
  ctx.inject(['connection'], (c) => {
    const connection = c.connection
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      console.warn(`[${NAME}] connection.fetch 不可用，设置页/提示条 RPC 未注册（门控仍工作）`)
      return
    }

    async function dispatch(endpoint, payload) {
      try {
        reloadAllowlist()
        reloadPluginCfg()
        const body = payload && typeof payload === 'object' ? payload : {}
        if (endpoint === 'snapshot') {
          return {
            ok: true,
            value: {
              config: {
                version: allowlist.version || 22,
                corrupt: allowlistCorrupt,
                rejectKeywords: allowlist.rejectKeywords || [],
                humanKeywords: allowlist.humanKeywords || [],
                allowKeywords: allowlist.allowKeywords || [],
                criteria: allowlist.criteria || [],
                levels: allowlist.levels,
                truncatedAction: allowlist.truncatedAction,
                judgeTimeoutMs: allowlist.judgeTimeoutMs || 20000,
              },
              predefined: {
                rejectKeywords: shippedRejectKeywords(),
                humanKeywords: [],
                criteria: shippedCriteria(pluginCfg.judgePromptLang),
                levels: shippedLevels(pluginCfg.judgePromptLang),
                judgePrompts: {
                  zh: shippedJudgePromptTemplate('zh'),
                  en: shippedJudgePromptTemplate('en'),
                },
              },
              setup: presetSetupState(),
              plugin: pluginCfg,
              pluginCorrupt: pluginCfgCorrupt,
              providers: (() => {
                try {
                  return (llm.listProviders() || []).map((p) => ({ id: p.id, name: p.name || p.id }))
                } catch { return [] }
              })(),
              fallback: fallbackSelection() || { provider: '', model: '' },
              // 判定健康度：设置页据此显示「本次运行有 N 次判定输出为空」的告警。
              // 进程内累计（重启清零），不含自检调用。
              judgeHealth: judgeHealthSnapshot(),
            },
          }
        }
        if (endpoint === 'events') {
          const sessionId = String(body.sessionId || '')
          if (!sessionId) {
            return rpcFail('err.needSessionId')

          }
          const since = Number.parseInt(String(body.since || '0'), 10) || 0
          return { ok: true, value: { events: readEventsSince(paths.events, sessionId, since) } }
        }
        if (endpoint === 'rule-op') {
          const op = String(body.op || '')
          const kind = String(body.kind || '')
          let value = body.value
          const resetWithLang = (kind === 'criteria' || kind === 'levels') && op === 'reset'
          if (resetWithLang) {
            const lang = normalizeJudgePromptLang(
              (value && typeof value === 'object' && value.lang) || pluginCfg.judgePromptLang,
            )
            value = { lang }
          }
          // 回滚用的快照必须在 `applyRuleOp` **之前**取：它成功时会把 `allowlist` 原地改掉并落盘，
          // 之后再 clone 拿到的是「已经改过」的副本，回滚就成了把新值再写一遍的空操作。
          const prevLang = pluginCfg.judgePromptLang
          const prevTimeoutMs = allowlist.judgeTimeoutMs
          const prevAllowlist = cloneAllowlist(allowlist)
          /**
           * 审计行要等**跨文件提交**落定后再写：`applyRuleOp` 内部那条 `CONFIG … reset …`
           * 是在 allowlist 写盘时打的，而这次动作还可能因为 config.json 写不动而整体回滚——
           * 先写就成了「审计说改了、磁盘没改」，排障时把人往错方向带。
           */
          const pendingAudit = []
          const result = applyRuleOp(op, kind, value, pendingAudit)
          if (result.ok && resetWithLang && pluginCfg.judgePromptLang !== value.lang) {
            // 语言选项已取消：恢复默认审核表 / 等级说明时选的语言同时决定框架与卡片语言。
            // 这是**跨两个文件**的更新（allowlist 刚按新语言写完、语言在 config.json）：
            // 语言写盘失败就必须把 allowlist 一起回滚，否则磁盘上表是英文、等级说明与提示词
            // 还是中文，而 RPC 还报成功——用户看不出自己处在哪个语言。
            pluginCfg.judgePromptLang = value.lang
            if (persistPluginCfg()) {
              syncLevelLanguage()
              // R3-B-6：`syncShippedLevels` 只改内存，磁盘上的等级说明会停在旧语言，
              // 直到下一次别的写盘才收敛——这里顺手落盘（失败只告警，不推翻整个动作）。
              if (!saveJson(paths.allowlist, allowlist)) {
                console.error(`[${NAME}] 等级说明跟随语言同步后写盘失败，下一次写盘会再收敛`)
              }
              audit(`CONFIG  judgePromptLang → ${value.lang}`)
            } else {
              pluginCfg.judgePromptLang = prevLang
              copyAllowlistInto(allowlist, prevAllowlist)
              const rolledBack = saveJson(paths.allowlist, prevAllowlist)
              if (!rolledBack) console.error(`[${NAME}] 语言回滚写盘失败，allowlist 已留在新语言`)
              // 只写真实发生的事：回滚写盘也失败时不能说「已回滚」。
              audit(`CONFIG  ${kind} reset（lang=${value.lang}）失败（配置不可写）；审核表语言回滚`
                + `${rolledBack ? '成功' : '写盘失败，allowlist 已留在新语言'}`)
              return rpcFail('err.pluginWrite')
            }
            syncLevelLanguage()
          }
          if (result.ok && kind === 'judgeTimeoutMs') {
            pluginCfg.judge.timeoutMs = allowlist.judgeTimeoutMs
            if (!persistPluginCfg()) {
              // 超时的**权威来源是 allowlist**（`effectiveJudgeTimeoutMs`），所以配置写不动时
              // 要把它一起回滚，否则磁盘上 allowlist 是新值、config 是旧值，设置页刷新后显示新值
              // 而 RPC 刚报过失败——两个文件两个说法。
              pluginCfg.judge.timeoutMs = prevTimeoutMs
              allowlist.judgeTimeoutMs = prevTimeoutMs
              if (!saveJson(paths.allowlist, allowlist)) {
                console.error(`[${NAME}] judgeTimeoutMs 回滚写盘失败，allowlist 已留在新值`)
              }
              return rpcFail('err.pluginWrite')
            }
          }
          if (!result.ok) return rpcFail(result.code || 'err.allowlistWrite', result.details || {})
          for (const line of pendingAudit) audit(line)
          return { ok: true, value: result }

        }
        if (endpoint === 'setup') {
          const setupResult = setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox)
          if (!setupResult.ok) {
            return rpcFail(setupResult.code || 'err.preset', setupResult.details || { error: String(setupResult.error || '') })

          }
          return { ok: true, value: setupResult }
        }
        if (endpoint === 'save-plugin') {
          if (pluginCfgCorrupt && !body.overwriteCorrupt) {
            return rpcFail('err.pluginCorrupt')

          }
          // 模板超限一律报错，**不截断**：砍掉尾巴（通常正是输出格式与等级要求）会让判定
          // 行为静默改变，而设置页回显的是截断版，用户看不出发生了什么。
          if (body && body.judgePrompts && typeof body.judgePrompts === 'object') {
            for (const lang of ['zh', 'en']) {
              if (!judgePromptOverLimit(body.judgePrompts[lang])) continue
              return rpcFail('err.judgePromptTooLong', {
                lang,
                chars: String(body.judgePrompts[lang]).length,
                max: MAX_JUDGE_PROMPT_CHARS,
              })
            }
          }
          const next = mergePluginConfig(pluginCfg, body)
          const prev = pluginCfg
          pluginCfg = next
          if (!persistPluginCfg({ overwriteCorrupt: Boolean(body.overwriteCorrupt) })) {
            pluginCfg = prev
            return rpcFail('err.pluginWrite')

          }
          let preset = null
          if (body && Object.prototype.hasOwnProperty.call(body, 'presetSandbox')) {
            preset = setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox)
            if (preset && !preset.ok) {
              // 沙箱没写进 patch 就整个回滚：不能让 config.json 说 read-only、patch 还是全权限。
              pluginCfg = prev
              persistPluginCfg({ overwriteCorrupt: Boolean(body.overwriteCorrupt) })
              return rpcFail(preset.code || 'err.preset', preset.details || { error: String(preset.error || '') })

            }
          }
          if (typeof body.judgeTimeoutMs === 'number') {
            const timeoutResult = applyRuleOp('set', 'judgeTimeoutMs', body.judgeTimeoutMs)
            if (!timeoutResult.ok) {
              // config.json 已经落盘（judge/prompt 那一步），这一格失败必须**整体回滚**，
              // 否则客户端看到「保存失败」，磁盘上的审核模型却已经换掉了。
              pluginCfg = prev
              persistPluginCfg({ overwriteCorrupt: Boolean(body.overwriteCorrupt) })
              return rpcFail(timeoutResult.code || 'err.allowlistWrite', timeoutResult.details || {})

            }
            pluginCfg.judge.timeoutMs = allowlist.judgeTimeoutMs
            if (!persistPluginCfg()) {
              pluginCfg = prev
              persistPluginCfg({ overwriteCorrupt: Boolean(body.overwriteCorrupt) })
              return rpcFail('err.pluginWrite')

            }
          }
          audit('CONFIG  plugin 已更新')
          return { ok: true, value: { ok: true, plugin: pluginCfg, preset, setup: presetSetupState() } }
        }
        if (endpoint === 'judge-catalog') {
          const provider = String(body.provider || configuredRoute().provider)
          let models = []
          try {
            models = (await llm.listModels(provider)).map((m) => ({ id: m.id, name: m.name || m.id }))
          } catch (error) {
            return rpcFail('err.catalog', { error: String((error && error.message) || error) })

          }
          return { ok: true, value: { provider, models } }
        }
        if (endpoint === 'judge-info') {
          const provider = String(body.provider || '')
          const model = String(body.model || '')
          try {
            const info = await llm.resolveModelInfo(provider, model)
            const efforts = (info.reasoning && info.reasoning.efforts) || []
            return {
              ok: true,
              value: {
                provider: info.provider,
                id: info.id,
                name: info.name,
                efforts: efforts.map((e) => ({ id: e.id, name: e.name || e.id })),
                defaultEffort: info.reasoning && info.reasoning.defaultEffort,
              },
            }
          } catch (error) {
            return rpcFail('err.info', { error: String((error && error.message) || error) })

          }
        }
        if (endpoint === 'judge-selftest') {
          // 自检：拿一张固定的小卡片**真跑一次判定**，把「这条路由到底能不能判出结果」回显到设置页。
          // 装插件的人第一个问题就是「我这套审核模型行不行」——靠等一次真实判定失败（然后弹人工框）
          // 才知道太晚了。它不计入判定健康度（不是真实判定），也不写 ALLOW/REJECT/HUMAN，
          // 只在审计里留一行 SELFTEST 便于和时间线对照。
          const startedAt = Date.now()
          const route = await resolveJudgeRoute()
          if (!route.ok) {
            const code = route.code || 'err.judgeUnconfigured'
            audit(`SELFTEST FAILED route: ${code}`)
            return {
              ok: true,
              value: {
                ran: false,
                ok: false,
                ms: Date.now() - startedAt,
                provider: route.provider || '',
                model: route.model || '',
                effort: route.reasoningEffort || '',
                code,
                detail: route.details && route.details.error ? String(route.details.error) : '',
              },
            }
          }
          const timeoutMs = effectiveJudgeTimeoutMs(allowlist, pluginCfg)
          let attempts = 0
          const result = await withRetry(
            (signal, maxTokens) => {
              attempts += 1
              return judgeOnce(SELFTEST_TOOL, SELFTEST_MODE, '', { command: SELFTEST_COMMAND }, signal, route, '', maxTokens)
            },
            '自检',
            timeoutMs,
            null,
            { track: false },
          )
          const failed = Boolean(result.failed)
          const code = failed ? String(result.errorCode || 'err.judgeFailed') : ''
          const detail = failed
            ? (code === 'err.judgeEmpty' ? judgeFailureNote(result) : String(result.errorDetail || ''))
            : ''
          audit(
            `SELFTEST ${failed ? 'FAILED' : 'OK'} ${route.provider}/${route.model}`
            + (failed ? ` ${code}${detail ? ' ' + detail : ''}` : ` category=${result.criterion || ''} src=${result.src || ''}`),
          )
          return {
            ok: true,
            value: {
              ran: true,
              ok: !failed,
              ms: Date.now() - startedAt,
              provider: route.provider || '',
              model: route.model || '',
              effort: route.reasoningEffort || '',
              code,
              detail,
              category: failed ? '' : String(result.criterion || ''),
              src: failed ? '' : String(result.src || ''),
              retried: attempts > 1,
              finishKind: String(result.finishKind || ''),
              reasoningChars: result.reasoningChars === undefined ? '' : String(result.reasoningChars),
              maxTokens: result.maxTokens === undefined ? '' : String(result.maxTokens),
              bodyChars: String(result.raw || '').length,
            },
          }
        }
        return rpcFail('err.unknownEndpoint', { endpoint: String(endpoint || '') })

      } catch (error) {
        return rpcFail('err.internal', { error: String((error && error.message) || error) })

      }
    }

    /** 设置页 / 提示条 / 历史。仅 GUI；模型点不到这些按钮。 */
    async function serve(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json({ type: 'server-response', rpcId: 'invalid-request', result: rpcFail('err.badBody') })

      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const packed = body && body.payload && typeof body.payload === 'object' ? body.payload : {}
      const endpoint = String(packed.endpoint || '')
      const payload = packed.payload && typeof packed.payload === 'object' ? packed.payload : {}
      try {
        const result = await enqueueRpc(() => dispatch(endpoint, payload))
        return Response.json({ type: 'server-response', rpcId: rpcId, result: result })
      } catch (error) {
        return Response.json({ type: 'server-response', rpcId: rpcId, result: rpcFail('err.internal', { error: String(error) }) })

      }
    }

    try {
      c.effect(
        () => connection.fetch.register({
          path: '/api/dsh-auto-approve',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: serve,
        }),
        `${NAME}: /api/dsh-auto-approve`,
      )
      log('RPC 已注册：/api/dsh-auto-approve')
    } catch (error) {
      console.error(`[${NAME}] RPC 注册失败，设置页将无法加载`, error)
    }
  })

  log(`已挂载：关键词→审核表 sandbox=${pluginCfg.presetSandbox} profilePatch=${paths.profilePatch}`)
}
