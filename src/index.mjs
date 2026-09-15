/**
 * dsh-auto-approve — Host 半。
 *
 * 职责：在 `approval/request` 瀑布上做自动审批门控。
 * 允许 / 拒绝直接返回 outcome；转人工则 `await next()` 交给原网页审批框。
 * 不改 req，不 abort req.signal，不平行结算。
 * 管道（仅当会话预设为「自动审批」）：
 *   1. 关键词：拒绝 > 人工 > 允许（只匹配工具名 + command + 路径 + workdir）
 *   2. 缺工具参数 / 字段截断：按 missingPayloadAction / truncatedAction（默认转人工）
 *   3. 审核模型只输出「类别 id + 风险等级 + 理由」，程序按 (行, 等级) 查三格动作
 * 非表内结果（认不出、空输出、超时、调用异常、路由不可用、插件异常）一律落 other 的格子；
 * 请求被取消不产生 verdict；缺参数与截断按各自的配置项处理。插件不含任何硬编码动作。
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
  DEFAULT_DENY_KEYWORDS,
  shippedRejectKeywords,
  DEFAULT_CRITERIA,
  shippedCriteria,
  shippedLevels,
  normalizeJudgePromptLang,
  normalizeAllowlist,
  mergePluginConfig,
  pickMigratablePluginConfig,
  parseReason,
  matchKeywordBuckets,
  buildJudgePrompt,
  resolveJudgePromptTemplate,
  shippedJudgePromptTemplate,
  parseJudgeClassify,
  pickToolArgs,
  toolArgsTruncated,
  formatArgsNote,
  formatTruncatedNote,
  clipToolArgsForEvent,
  formatKeywordHay,
  formatAllowKeywordHay,
  formatPathKeywordHay,
  formatJudgeCard,
  hasToolPayload,
  rememberCachedCall,
  takeCachedCall,
  lookupCriteria,
  resolveCriterionAction,
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
  const log = (line) => console.log(`[${NAME}] ${line}`)
  const audit = (line) => appendAudit(paths.audit, line)

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

  function reloadAllowlist() {
    const loaded = tryLoadJson(paths.allowlist)
    if (!loaded.ok) {
      allowlistCorrupt = true
      return
    }
    if (loaded.missing) return
    allowlist = normalizeAllowlist(loaded.value)
    allowlistCorrupt = false
  }

  function reloadPluginCfg() {
    const loaded = tryLoadJson(paths.pluginConfig)
    if (!loaded.ok) {
      pluginCfgCorrupt = true
      return
    }
    pluginCfgCorrupt = false
    pluginCfg = mergePluginConfig(rawConfig, loaded.missing ? null : loaded.value)
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

  function applyRuleOp(op, kind, value) {
    if (allowlistCorrupt && op !== 'reset') {
      return fail('err.allowlistCorrupt')
    }
    const draft = cloneAllowlist(allowlist)
    const result = mutateAllowlistOp(draft, op, kind, value)
    if (!result.ok) return result
    if (!saveJson(paths.allowlist, draft)) return fail('err.allowlistWrite')
    copyAllowlistInto(allowlist, draft)
    allowlistCorrupt = false
    if (result.auditLine) audit(result.auditLine)
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
    put('label', 80)
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
    if (o.source) ev.source = o.source
    // 判定来源（strict/bare/fuzzy/none/empty/timeout/call/route/plugin）：放事件顶层，便于统计与展示。
    if (o.src) ev.src = String(o.src).slice(0, 20)
    if (o.cwd) ev.cwd = String(o.cwd).slice(0, 400)
    if (o.keyword) ev.keyword = String(o.keyword).slice(0, 120)
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
    const prompt = system || buildJudgePrompt(allowlist.criteria, pluginCfg.judgePromptLang, resolveJudgePromptTemplate(pluginCfg, pluginCfg.judgePromptLang))
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

  async function judgeOnce(toolName, mode, justification, args, signal, route, cwd, maxTokens) {
    const criteria = allowlist.criteria || DEFAULT_CRITERIA
    const lang = normalizeJudgePromptLang(pluginCfg.judgePromptLang)
    const user = formatJudgeCard(toolName, mode, justification, args, cwd, lang)
    const res = await callJudge(user, signal, route, buildJudgePrompt(criteria, allowlist.levels, lang, resolveJudgePromptTemplate(pluginCfg, lang)), maxTokens)
    // 诊断跟着错误走：正文为空时 raw 是空串，事件层会把它丢掉，不能只靠 raw 分辨现场。
    const diag = { maxTokens: res.maxTokens, reasoningChars: res.reasoningChars, finishKind: res.finishKind }
    try {
      return { ...parseJudgeClassify(res.text, criteria), raw: String(res.text || '').slice(0, 800), ...diag }
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
   * 重试策略：调用异常重试一次；`err.judgeEmpty`（模型一个字都没吐，常见于推理吃光预算）
   * 换更大预算重试一次。分类解析不出**不**重试（重试也认不出），但也不再直接转人工——
   * 它和所有其它非表内结果一样，由调用方落 other 的格子。
   */
  async function withRetry(runFn, label, timeoutMs, outerSignal) {
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
        error: code,
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
      if (!first.timedOut) return first
      last = { failed: true, timedOut: true, errorCode: 'err.judgeTimeout', error: 'err.judgeTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 超时(${timeoutMs}ms)，转人工`)
      return last
    } catch (error) {
      last = failureOf(error)
      const code = error && error.code
      if (code === 'err.judgeEmpty') {
        if (cancelled()) return { aborted: true }
        retryMaxTokens = judgeEmptyRetryMaxTokens(last.maxTokens)
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
      if (!second.timedOut) return second
      last = { failed: true, timedOut: true, emptyRetry: emptyRetried, errorCode: 'err.judgeRetryTimeout', error: 'err.judgeRetryTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 重试超时(${timeoutMs}ms)`)
      return last
    } catch (error) {
      const prev = { errorMs: last.errorMs, raw: last.raw }
      last = failureOf(error, prev)
      console.error(`[${NAME}] ${label} 重试仍异常`, error)
      return last
    }
  }

  /** 非表内结果一律落 other 的格子：动作仍由 (other, 等级) 查表得到，插件不含硬编码动作。 */
  function otherRowVerdict(level, src, extra) {
    const row = lookupCriteria(allowlist.criteria, 'other')
    const resolved = resolveCriterionAction(row, level, allowlist.levels)
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
    if (!route.ok) {
      const code = route.code || 'err.judgeUnconfigured'
      audit(`FAILED  judge route: ${code}`)
      return otherRowVerdict('', 'route', {
        failed: true,
        errorCode: code,
        error: code,
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
      const code = result.errorCode || result.error || 'err.judgeFailed'
      return otherRowVerdict('', failureSrc(code), {
        failed: true,
        timedOut: Boolean(result.timedOut),
        errorCode: code,
        error: code,
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
    const detail = { category, path, source: 'web', args, cwd, judgeReason, judge }
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
    })
    emitDecision(decisionLeaf(info, { verdict: 'human', path: info.path }))
    try {
      const outcome = await next()
      try {
        applyHumanOutcome(info, outcome)
        emitDecision(decisionLeaf(info, { verdict: 'human', path: info.path, outcome }))
      } catch (error) {
        console.error(`[${NAME}] 记录人工结果失败`, error)
      }
      return outcome
    } catch (error) {
      console.error(`[${NAME}] 网页审批框失败`, error)
      try {
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
        rememberCachedCall(pendingCalls, sid, id, pickToolArgs(exec.arguments))
      }
    } catch (error) {
      console.error(`[${NAME}] 记录工具参数失败`, error)
    }
    return next()
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
      const toolArgs = pickToolArgs(cached.args || {})
      const baseInfo = {
        sessionId, toolName, mode, reason, justification, cwd: sessionCwd, callId: req.callId || '',
        args: toolArgs,
      }

      const toHuman = (path, category, extra) => {
        forwarded = true
        const extraJudge = (extra && extra.judge) || null
        return forwardToHuman({
          ...baseInfo,
          path,
          category: category || '',
          judgeReason: extra && extra.judgeReason,
          judge: extraJudge,
          // 判定来源与等级要跟着转人工一起落事件：默认 other=human 时，这是分辨
          // 「模型答了 other」和「判定压根没跑成」的唯一证据。
          src: extraJudge && extraJudge.src ? extraJudge.src : '',
          level: extraJudge && extraJudge.level ? extraJudge.level : '',
        }, next)
      }
      humanFallback = toHuman
      // 最外层 catch 也要按 other 的格子处理，所以请求信息要留在 try 之外可见。
      reqInfo = baseInfo
      const eventDetail = { args: toolArgs, cwd: sessionCwd }
      // 没看见命令/路径：按 missingPayloadAction 处理（默认转人工，禁止关键词允许或模型标 safe）。
      if (!cached.found || !hasToolPayload(toolArgs)) {
        const why = cached.found ? 'err.missingPayload' : 'err.missingPayloadUncaptured'
        if (allowlist.missingPayloadAction === 'reject') {
          audit(`REJECT  ${toolName} mode=${mode || 'none'} missing-payload | ${why} ${formatArgsNote(toolArgs)}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'missing-payload', {
            kind: 'auto', path: 'missing-payload', ...eventDetail,
          })
          emitDecision(decisionLeaf(baseInfo, { verdict: 'missing-payload', path: 'missing-payload', outcome: 'rejected' }))
          return 'rejected'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} missing-payload | ${why} ${formatArgsNote(toolArgs)}`)
        return toHuman('missing-payload', 'other', { judgeReason: why })
      }
      const hay = formatKeywordHay(toolName, reason, toolArgs, sessionCwd)
      const pathHay = formatPathKeywordHay(toolArgs, sessionCwd)
      const kw = matchKeywordBuckets(hay, allowlist, formatAllowKeywordHay(toolArgs), pathHay)

      if (kw && kw.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-reject', {
          kind: 'auto', path: 'keyword-reject', ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, { verdict: 'keyword-reject', path: 'keyword-reject', outcome: 'rejected' }))
        return 'rejected'
      }
      // 关键词拒绝优先于截断配置：截断的 `rm -rf /` 仍直接被拒。
      if (toolArgsTruncated(toolArgs)) {
        const why = `err.truncatedPayload ${formatTruncatedNote(toolArgs)}`
        if (allowlist.truncatedAction === 'reject') {
          audit(`REJECT  ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'truncated-payload', {
            kind: 'auto', path: 'truncated-payload', ...eventDetail,
          })
          emitDecision(decisionLeaf(baseInfo, { verdict: 'truncated-payload', path: 'truncated-payload', outcome: 'rejected' }))
          return 'rejected'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
        return toHuman('truncated-payload', 'other', { judgeReason: why })
      }
      if (kw) {
        if (kw.action === 'allow') {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-allow', {
            kind: 'auto', path: 'keyword-allow', ...eventDetail,
          })
          emitDecision(decisionLeaf(baseInfo, { verdict: 'keyword-allow', path: 'keyword-allow', outcome: 'allowed-once' }))
          return 'allowed-once'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        return toHuman('keyword-human', '')
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
        ? `${judged.error || 'err.judgeFailed'}${judgeFailureNote(judged) ? ' ' + judgeFailureNote(judged) : ''}`
        : (judgeReason || reason.slice(0, 120))
      const eventJudge = { category: criterion, judgeReason, judge: judged, src: judged.src, ...eventDetail }
      if (judged.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} ${cells} | ${tail}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-reject', {
          kind: 'auto', path: 'criteria-reject', ...eventJudge,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'criteria-reject', path: 'criteria-reject', outcome: 'rejected',
          category: criterion, level: judged.level, src: judged.src, judgeReason,
        }))
        return 'rejected'
      }
      if (judged.action === 'allow') {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} ${cells} | ${tail}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-allow', {
          kind: 'auto', path: 'criteria-allow', ...eventJudge,
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
        const resolved = resolveCriterionAction(row, '', allowlist.levels)
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
        const info = reqInfo || { sessionId: '', toolName: '', mode: '', reason: '', justification: '' }
        const label = `${info.toolName || 'unknown'} criteria=other level=${resolved.level}${resolved.levelSrc === 'fallback' ? '(兜底)' : ''} src=plugin`
        if (resolved.action === 'reject') {
          audit(`REJECT  ${label} | ${code}`)
          recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'plugin-error', {
            kind: 'auto', path: 'plugin-error', src: 'plugin', ...detail,
          })
          emitDecision(decisionLeaf(info, { verdict: 'plugin-error', path: 'plugin-error', outcome: 'rejected', src: 'plugin' }))
          return 'rejected'
        }
        if (resolved.action === 'allow') {
          audit(`ALLOW   ${label} | ${code}`)
          recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'plugin-error', {
            kind: 'auto', path: 'plugin-error', src: 'plugin', ...detail,
          })
          emitDecision(decisionLeaf(info, { verdict: 'plugin-error', path: 'plugin-error', outcome: 'allowed-once', src: 'plugin' }))
          return 'allowed-once'
        }
        audit(`HUMAN   ${label} | ${code}`)
        if (humanFallback) return await humanFallback('plugin-error', 'other', detail)
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
                version: allowlist.version || 20,
                corrupt: allowlistCorrupt,
                rejectKeywords: allowlist.rejectKeywords || [],
                humanKeywords: allowlist.humanKeywords || [],
                allowKeywords: allowlist.allowKeywords || [],
                denyKeywords: allowlist.humanKeywords || [],
                criteria: allowlist.criteria || [],
                levels: allowlist.levels,
                missingPayloadAction: allowlist.missingPayloadAction,
                truncatedAction: allowlist.truncatedAction,
                judgeTimeoutMs: allowlist.judgeTimeoutMs || 20000,
              },
              predefined: {
                denyKeywords: DEFAULT_DENY_KEYWORDS,
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
          const result = applyRuleOp(op, kind, value)
          if (result.ok && resetWithLang) {
            // 语言选项已取消：恢复默认审核表 / 等级说明时选的语言同时决定框架与卡片语言。
            if (pluginCfg.judgePromptLang !== value.lang) {
              const prevLang = pluginCfg.judgePromptLang
              pluginCfg.judgePromptLang = value.lang
              if (persistPluginCfg()) audit(`CONFIG  judgePromptLang → ${value.lang}`)
              else pluginCfg.judgePromptLang = prevLang
            }
          }
          if (result.ok && kind === 'judgeTimeoutMs') {
            pluginCfg.judge.timeoutMs = allowlist.judgeTimeoutMs
            persistPluginCfg()
          }
          return result.ok ? { ok: true, value: result } : rpcFail(result.code || 'err.allowlistWrite', result.details || {})

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
              return rpcFail(timeoutResult.code || 'err.allowlistWrite', timeoutResult.details || {})

            }
            pluginCfg.judge.timeoutMs = allowlist.judgeTimeoutMs
            persistPluginCfg()
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
