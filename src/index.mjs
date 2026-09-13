/**
 * dsh-auto-approve — Host 半。
 *
 * 职责：在 `approval/request` 瀑布上做自动审批门控。
 * 允许 / 拒绝直接返回 outcome；转人工则 `await next()` 交给原网页审批框。
 * 不改 req，不 abort req.signal，不平行结算。
 * 管道（仅当会话预设为「自动审批」）：
 *   1. 关键词：拒绝 > 人工 > 允许（只匹配工具名 + command + 路径 + workdir）
 *   2. 审核表：模型只输出类别 id，程序按表执行允许 / 拒绝 / 人工
 * 缺工具参数、解析失败、超时、插件异常 → 转人工，禁止在空卡片上自动放行。
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
  clipToolArgsForEvent,
  formatKeywordHay,
  formatAllowKeywordHay,
  formatPathKeywordHay,
  formatJudgeCard,
  hasToolPayload,
  rememberCachedCall,
  takeCachedCall,
  lookupCriteria,
  cloneAllowlist,
  copyAllowlistInto,
  mutateAllowlistOp,
  fail,
  effectiveJudgeTimeoutMs,
  judgeMaxTokens,
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
    put('label', 80)
    put('reason', 600)
    put('raw', 800)
    put('error', 400)
    put('errorCode', 80)
    put('errorMs', 20)
    put('errorDetail', 400)
    put('errorEffort', 40)
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
    if (o.cwd) ev.cwd = String(o.cwd).slice(0, 400)
    if (o.keyword) ev.keyword = String(o.keyword).slice(0, 120)
    const args = clipToolArgsForEvent(o.args)
    if (Object.keys(args).length) ev.args = args
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
   * 分类提示全部折进 user 文本。带推理档位时输出预算要留出推理 token，否则空文本会被当成解析失败。
   */
  async function callJudge(userText, signal, route, system) {
    const prompt = system || buildJudgePrompt(allowlist.criteria, pluginCfg.judgePromptLang, resolveJudgePromptTemplate(pluginCfg, pluginCfg.judgePromptLang))
    const opts = {
      provider: route.provider,
      model: route.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt + '\n\n' + userText }],
      }],
      temperature: 0,
      maxTokens: judgeMaxTokens(route.reasoningEffort),
      signal,
    }
    if (route.reasoningEffort) opts.reasoningEffort = route.reasoningEffort
    let text = ''
    for await (const chunk of llm.stream(opts)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
        const err = new Error('err.judgeCall')
        err.code = 'err.judgeCall'
        err.details = { error: String(failure) }
        throw err
      }
    }
    return text
  }

  async function judgeOnce(toolName, mode, justification, args, signal, route, cwd) {
    const criteria = allowlist.criteria || DEFAULT_CRITERIA
    const lang = normalizeJudgePromptLang(pluginCfg.judgePromptLang)
    const user = formatJudgeCard(toolName, mode, justification, args, cwd, lang)
    const text = await callJudge(user, signal, route, buildJudgePrompt(criteria, lang, resolveJudgePromptTemplate(pluginCfg, lang)))
    try {
      return { ...parseJudgeClassify(text, criteria), raw: String(text || '').slice(0, 800) }
    } catch (error) {
      error.raw = String(text || '').slice(0, 800)
      throw error
    }
  }

  /**
   * 单次判定 + 超时 + 重试。
   * `outerSignal` 是审批请求自己的取消信号：请求被取消后不该继续烧模型调用。
   * 注意**不要**去 abort `req.signal`，这里只观察它。
   */
  async function withRetry(runFn, label, timeoutMs, outerSignal) {
    const cancelled = () => Boolean(outerSignal && outerSignal.aborted)
    const runOnce = async () => {
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
        const call = runFn(controller.signal)
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
    let last = { failed: true }
    try {
      const first = await runOnce()
      if (first.aborted) return first
      if (!first.timedOut) return first
      last = { failed: true, timedOut: true, errorCode: 'err.judgeTimeout', error: 'err.judgeTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 超时(${timeoutMs}ms)，转人工`)
      return last
    } catch (error) {
      last = {
        failed: true,
        errorCode: error && error.code ? error.code : 'err.judgeFailed',
        error: error && error.code ? error.code : 'err.judgeFailed',
        errorDetail: error && error.details && error.details.error ? String(error.details.error) : '',
        raw: error && error.raw ? String(error.raw).slice(0, 800) : '',
      }
      const code = error && error.code
      if (code === 'err.judgeParse' || code === 'err.judgeEmpty') {
        console.error(`[${NAME}] ${label} 输出无法解析，转人工`, error)
        return last
      }
      console.error(`[${NAME}] ${label} 异常，重试 1 次`, error)
    }
    try {
      const second = await runOnce()
      if (second.aborted) return second
      if (!second.timedOut) return second
      last = { failed: true, timedOut: true, errorCode: 'err.judgeRetryTimeout', error: 'err.judgeRetryTimeout', errorMs: String(timeoutMs) }
      console.warn(`[${NAME}] ${label} 重试超时(${timeoutMs}ms)`)
      return last
    } catch (error) {
      last = {
        failed: true,
        errorCode: error && error.code ? error.code : 'err.judgeFailed',
        error: error && error.code ? error.code : 'err.judgeFailed',
        errorDetail: error && error.details && error.details.error ? String(error.details.error) : '',
        errorMs: last.errorMs,
        raw: error && error.raw ? String(error.raw).slice(0, 800) : last.raw,
      }
      console.error(`[${NAME}] ${label} 重试仍异常`, error)
      return last
    }
  }

  async function judgeOperation(toolName, mode, justification, args, cwd, requestSignal) {
    const route = await resolveJudgeRoute()
    const meta = {
      provider: route.provider || '',
      model: route.model || '',
      effort: route.reasoningEffort || '',
    }
    if (!route.ok) {
      audit(`FAILED  judge route: ${route.code || route.error || ''}`)
      return { action: 'human', criterion: 'other', reason: '', failed: true, errorCode: route.code || 'err.judgeUnconfigured', error: route.code || 'err.judgeUnconfigured', errorDetail: route.details && route.details.error ? String(route.details.error) : '', errorEffort: route.details && route.details.effort ? String(route.details.effort) : '', ...meta }
    }
    const timeoutMs = effectiveJudgeTimeoutMs(allowlist, pluginCfg)
    const result = await withRetry(
      (signal) => judgeOnce(toolName, mode, justification, args, signal, route, cwd),
      '审核模型',
      timeoutMs,
      requestSignal,
    )
    if (result.aborted) {
      return { aborted: true, criterion: 'other', reason: '', ...meta }
    }
    if (result.failed) {
      return {
        action: 'human',
        criterion: 'other',
        reason: '',
        failed: true,
        timedOut: Boolean(result.timedOut),
        errorCode: result.errorCode || result.error || 'err.judgeFailed',
        error: result.errorCode || result.error || 'err.judgeFailed',
        errorMs: result.errorMs || '',
        errorDetail: result.errorDetail || '',
        raw: result.raw || '',
        ...meta,
      }
    }
    const row = lookupCriteria(allowlist.criteria, result.criterion)
    return { ...result, action: row.action, label: row.label, ...meta }
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
        return forwardToHuman({
          ...baseInfo,
          path,
          category: category || '',
          judgeReason: extra && extra.judgeReason,
          judge: extra && extra.judge,
        }, next)
      }
      humanFallback = toHuman
      // 没看见命令/路径就转人工，禁止关键词允许或模型标 safe。
      if (!cached.found || !hasToolPayload(toolArgs)) {
        const why = cached.found ? 'err.missingPayload' : 'err.missingPayloadUncaptured'
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} missing-payload | ${why}`)
        return toHuman('missing-payload', 'other', { judgeReason: why })
      }
      const hay = formatKeywordHay(toolName, reason, toolArgs, sessionCwd)
      const pathHay = formatPathKeywordHay(toolArgs, sessionCwd)
      const kw = matchKeywordBuckets(hay, allowlist, formatAllowKeywordHay(toolArgs), pathHay)

      const eventDetail = { args: toolArgs, cwd: sessionCwd }
      if (kw && kw.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-reject', {
          kind: 'auto', path: 'keyword-reject', ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, { verdict: 'keyword-reject', path: 'keyword-reject', outcome: 'rejected' }))
        return 'rejected'
      }
      if (toolArgsTruncated(toolArgs)) {
        const why = 'err.truncatedPayload'
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
      if (judged.failed) {
        audit(`FAILED  ${toolName} mode=${mode || 'none'} → 人工 | ${judged.error || reason.slice(0, 120)}`)
        return toHuman('judge-failed', criterion, {
          judgeReason: judged.error || judgeReason,
          judge: judged,
        })
      }
      if (judged.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} criteria=${criterion} | ${judgeReason || reason.slice(0, 120)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-reject', {
          kind: 'auto', category: criterion, path: 'criteria-reject', judgeReason, judge: judged, ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'criteria-reject', path: 'criteria-reject', outcome: 'rejected', category: criterion, judgeReason,
        }))
        return 'rejected'
      }
      if (judged.action === 'allow') {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} criteria=${criterion} | ${judgeReason || reason.slice(0, 120)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-allow', {
          kind: 'auto', category: criterion, path: 'criteria-allow', judgeReason, judge: judged, ...eventDetail,
        })
        emitDecision(decisionLeaf(baseInfo, {
          verdict: 'criteria-allow', path: 'criteria-allow', outcome: 'allowed-once', category: criterion, judgeReason,
        }))
        return 'allowed-once'
      }
      audit(`HUMAN   ${toolName} mode=${mode || 'none'} criteria=${criterion} | ${judgeReason || reason.slice(0, 120)}`)
      return toHuman('criteria-human', criterion, { judgeReason, judge: judged })
    } catch (error) {
      console.error(`[${NAME}] 判断过程出错，回退人工`, error)
      if (forwarded) return 'unavailable'
      if (humanFallback) {
        try {
          return await humanFallback('plugin-error', 'other', {
            judgeReason: (error && error.code) || 'err.pluginError',
            judge: {
              errorCode: (error && error.code) || 'err.pluginError',
              errorDetail: String((error && error.message) || error),
            },
          })
        } catch (again) {
          console.error(`[${NAME}] 转人工仍失败，交回系统默认`, again)
        }
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
                version: allowlist.version || 18,
                corrupt: allowlistCorrupt,
                rejectKeywords: allowlist.rejectKeywords || [],
                humanKeywords: allowlist.humanKeywords || [],
                allowKeywords: allowlist.allowKeywords || [],
                denyKeywords: allowlist.humanKeywords || [],
                criteria: allowlist.criteria || [],
                judgeTimeoutMs: allowlist.judgeTimeoutMs || 20000,
              },
              predefined: {
                denyKeywords: DEFAULT_DENY_KEYWORDS,
                rejectKeywords: shippedRejectKeywords(),
                humanKeywords: [],
                criteria: shippedCriteria(pluginCfg.judgePromptLang),
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
          let value = body.value
          if (String(body.kind || '') === 'criteria' && String(body.op || '') === 'reset') {
            const lang = normalizeJudgePromptLang(
              (value && typeof value === 'object' && value.lang) || pluginCfg.judgePromptLang,
            )
            value = { lang }
          }
          const result = applyRuleOp(String(body.op || ''), String(body.kind || ''), value)
          if (result.ok && String(body.kind || '') === 'judgeTimeoutMs') {
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
