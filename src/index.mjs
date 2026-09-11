/**
 * dsh-auto-approve — Host 半。
 *
 * 职责：在 `approval/request` 瀑布上做自动审批门控；人工请求同时走网页框和 QQ。
 * 不注入 agent 会话；QQ 入站只进票据经纪。
 *
 * 管道（仅当会话预设为「自动审批」）：
 *   1. 关键词：拒绝 > 人工 > 允许（只匹配工具名 + command + 路径）
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
  tryLoadJson,
  saveJson,
  saveSecretJson,
  audit as appendAudit,
  readEventsSince,
  maxEventId,
  appendEvent,
  maskSecret,
  ensureDir,
  forkAbortSignal,
  replaceRequestSignal,
} from './util.mjs'
import {
  DEFAULT_DENY_KEYWORDS,
  shippedRejectKeywords,
  DEFAULT_CRITERIA,
  shippedCriteria,
  normalizeJudgePromptLang,
  normalizeAllowlist,
  mergePluginConfig,
  parseReason,
  matchKeywordBuckets,
  buildJudgePrompt,
  parseJudgeClassify,
  pickToolArgs,
  toolArgsTruncated,
  clipToolArgsForEvent,
  formatKeywordHay,
  formatAllowKeywordHay,
  formatJudgeCard,
  hasToolPayload,
  rememberCachedCall,
  takeCachedCall,
  lookupCriteria,
  cloneAllowlist,
  copyAllowlistInto,
  mutateAllowlistOp,
  effectiveJudgeTimeoutMs,
} from './rules.mjs'
import { getSetupState, migratePresetCopy, setAutoApproveSandbox } from './preset-patch.mjs'
import { createTicketBroker, parseApprovalReply, isBindConfirmText, formatPendingList, formatApprovalPush, formatApprovalKeyboard, formatOutcomeLabel } from './tickets.mjs'
import { createQQBot } from './qqbot.mjs'
import { startQqProvisioning } from './provisioning.mjs'

export const name = NAME
/** webServer 本身不用，只为等 web 起来再注册 RPC。 */
export const inject = ['approval', 'permissionPresets', 'llm', 'timer', 'webServer']

/** 设置页 rule-op：改草稿再写盘，失败不碰内存中的活对象。`other` 不能删。 */

/**
 * 插件入口。热更新规则文件；权限预设写入 profile patch 后需重启才进会话下拉。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const paths = pathsFor()
  ensureDir(paths.auto)
  ensureDir(paths.bridge)
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
  if (!loadedPlugin.ok) {
    console.error(`[${NAME}] 插件配置无法读取，本进程用默认且不覆盖磁盘`, loadedPlugin.error)
    pluginCfgCorrupt = true
    pluginCfg = mergePluginConfig(rawConfig, null)
  } else {
    pluginCfg = mergePluginConfig(rawConfig, loadedPlugin.missing ? null : loadedPlugin.value)
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
  const presetSetup = setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox)
  if (presetSetup.ok && presetSetup.needRestart) {
    console.log(`[${NAME}] 已写入 auto-approve 权限预设（sandbox=${pluginCfg.presetSandbox}）；live patch 重载后会话权限会出现「自动审批」`)
  } else if (!presetSetup.ok) {
    console.error(`[${NAME}] 写入 auto-approve 预设失败`, presetSetup.error)
  }
  let eventSeq = maxEventId(paths.events)
  const tickets = createTicketBroker()
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
  /** @type {{ chatId: string, userId: string, username?: string, isGroup: boolean, ts: string, preview: string }[]} */
  const recentChats = []
  let qq = null
  let bindHintAt = 0

  const log = (line) => console.log(`[${NAME}] ${line}`)
  const audit = (line) => appendAudit(paths.audit, line)

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
      return { ok: false, error: '规则文件损坏，拒绝覆盖。请先「恢复默认」写回出厂规则，或修好磁盘上的 allowlist.json' }
    }
    const draft = cloneAllowlist(allowlist)
    const result = mutateAllowlistOp(draft, op, kind, value)
    if (!result.ok) return result
    if (!saveJson(paths.allowlist, draft)) return { ok: false, error: '写入 allowlist 失败' }
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
    if (o.ticket !== undefined) ev.ticket = o.ticket
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

  let qqbotCorrupt = false
  function loadQqCreds() {
    const loaded = tryLoadJson(paths.qqbot)
    if (!loaded.ok) {
      qqbotCorrupt = true
      return { appId: '', appSecret: '', ownerUserOpenid: '' }
    }
    qqbotCorrupt = false
    const data = loaded.value || {}
    return {
      appId: String(data.appId || ''),
      appSecret: String(data.appSecret || ''),
      ownerUserOpenid: String(data.ownerUserOpenid || ''),
    }
  }

  function persistQqCreds(next) {
    saveSecretJson(paths.qqbot, next)
    qqbotCorrupt = false
  }

  function rememberChat(msg) {
    const preview = String(msg.text || '').slice(0, 80)
    const ts = new Date().toISOString()
    const idx = recentChats.findIndex((c) => c.chatId === msg.chatId && c.userId === msg.userId)
    const row = {
      chatId: msg.chatId,
      userId: msg.userId,
      username: msg.username,
      isGroup: Boolean(msg.isGroup),
      ts,
      preview,
    }
    if (idx >= 0) recentChats.splice(idx, 1)
    recentChats.unshift(row)
    if (recentChats.length > 20) recentChats.length = 20
  }

  async function qqSend(chatId, text, extra) {
    if (!qq || !chatId) return false
    try {
      await qq.send(chatId, text, extra)
      return true
    } catch (error) {
      console.error(`[${NAME}] QQ 发送失败`, error)
      return false
    }
  }

  function inboundAllowed(msg) {
    reloadPluginCfg()
    const { chatId, userId } = pluginCfg.notify
    if (!chatId) return { kind: 'unbound' }
    if (msg.chatId !== chatId) return { kind: 'ignore' }
    if (String(chatId).startsWith('g:')) {
      if (!userId || msg.userId !== userId) return { kind: 'ignore' }
    }
    return { kind: 'ok' }
  }

  async function handleInbound(msg) {
    rememberChat(msg)
    const gate = inboundAllowed(msg)
    if (gate.kind === 'ignore') return

    if (gate.kind === 'unbound') {
      // 私人 bot：未绑定 chatId 时，任意 C2C「是」绑定该聊天。文档已标明。
      if (msg.isGroup) return
      const yes = isBindConfirmText(msg.text)
      if (yes) {
        pluginCfg.notify.chatId = msg.chatId
        if (!persistPluginCfg()) {
          await qqSend(msg.chatId, '绑定失败：无法写入配置文件。')
          return
        }
        await qqSend(msg.chatId, '已将本聊天设为审批通知目标。之后人工审批会推到这里。')
        audit(`QQBIND  chatId=${msg.chatId}`)
        return
      }
      const now = Date.now()
      if (now - bindHintAt > 60_000) {
        bindHintAt = now
        await qqSend(msg.chatId, '是否将本聊天用作审批通知？回复「是」确认。')
      }
      return
    }

    const parsed = parseApprovalReply(msg.text, tickets.pendingCount())
    if (!parsed) return

    const reply = async (text) => { await qqSend(msg.chatId, text) }

    if (parsed.kind === 'need-number') {
      await reply('有多条待处理审批，请带短号。' + formatPendingList(tickets.listPending()))
      return
    }

    let n = parsed.n
    if (parsed.kind === 'allow-bare' || parsed.kind === 'reject-bare') {
      const sole = tickets.solePending()
      if (!sole) {
        await reply('当前没有待处理审批')
        return
      }
      n = sole.n
    }

    const recent = tickets.recentOutcome(n)
    if (recent) {
      await reply(`#${n} 已处理`)
      return
    }
    const ticket = tickets.get(n)
    if (!ticket) {
      await reply(`没有待处理的 #${n}，${formatPendingList(tickets.listPending())}`)
      return
    }

    const allow = parsed.kind === 'allow' || parsed.kind === 'allow-bare'
    const ok = tickets.answer(n, {
      outcome: allow ? 'allowed-once' : 'rejected',
    })
    if (!ok) await reply(`没有待处理的 #${n}`)
  }

  let qqGen = 0
  /** @type {{ controller: AbortController, handle?: { cancel: () => void }, status: string, qrDataUrl: string, expiresAt: number, error: string } | null} */
  let provisionAttempt = null

  function provisionSnapshot() {
    const a = provisionAttempt
    if (!a) return { status: '', qrDataUrl: '', expiresAt: 0, error: '' }
    return {
      status: a.status || '',
      qrDataUrl: a.qrDataUrl || '',
      expiresAt: a.expiresAt || 0,
      error: a.error || '',
    }
  }

  async function cancelProvisioning() {
    const attempt = provisionAttempt
    provisionAttempt = null
    if (!attempt) return
    try { attempt.controller.abort() } catch { /* ignore */ }
    try { await Promise.resolve(attempt.handle && attempt.handle.cancel()) } catch { /* ignore */ }
  }

  async function startProvisioning() {
    await cancelProvisioning()
    const controller = new AbortController()
    const attempt = {
      controller,
      status: '登录中',
      qrDataUrl: '',
      expiresAt: 0,
      error: '',
    }
    provisionAttempt = attempt
    try {
      const handle = await startQqProvisioning({
        onQr(qr) {
          if (provisionAttempt !== attempt) return
          attempt.qrDataUrl = qr.dataUrl
          attempt.expiresAt = qr.expiresAt
          attempt.status = '等待扫码'
        },
        onStatus(status) {
          if (provisionAttempt === attempt) attempt.status = status
        },
        async onCredentials(credentials) {
          if (provisionAttempt !== attempt) return
          attempt.status = '保存凭据'
          const appId = String(credentials.appId || '')
          const appSecret = String(credentials.appSecret || '')
          const owner = String(credentials.ownerUserOpenid || '')
          const prev = loadQqCreds()
          persistQqCreds({
            appId,
            appSecret,
            ownerUserOpenid: owner || prev.ownerUserOpenid || '',
          })
          reloadPluginCfg()
          if (owner && !pluginCfg.notify.chatId) {
            pluginCfg.notify.chatId = owner
            persistPluginCfg()
            audit(`QQBIND  chatId=${owner} (扫码者)`)
          }
          audit('CONFIG  qqbot 扫码凭据已保存并重连')
          await startQq()
          if (provisionAttempt !== attempt) return
          attempt.status = '已连接'
          attempt.qrDataUrl = ''
          attempt.expiresAt = 0
        },
        onFailure(error) {
          if (provisionAttempt !== attempt) return
          const aborted = controller.signal.aborted
          const detail = error instanceof Error ? error.message : String(error)
          log(`扫码失败: ${detail}`)
          attempt.status = aborted ? '已取消' : '扫码失败'
          attempt.error = aborted ? '' : '平台扫码服务暂时不可用或二维码已过期，请重新扫码。'
        },
      }, controller.signal)
      if (provisionAttempt === attempt) attempt.handle = handle
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`扫码启动失败: ${detail}`)
      const missing = /未安装|ERR_MODULE_NOT_FOUND|Cannot find/i.test(detail)
      const message = missing
        ? '未安装扫码依赖。请在插件目录执行 npm install 后重试。'
        : '无法启动扫码流程，请检查网络后重试。'
      if (provisionAttempt === attempt) {
        attempt.status = '扫码启动失败'
        attempt.error = message
      }
      return { ok: false, error: message }
    }
  }

  async function startQq() {
    const gen = ++qqGen
    const prev = qq
    qq = null
    if (prev) {
      try { await prev.stop() } catch (error) {
        console.error(`[${NAME}] 停止旧 QQ 连接失败`, error)
      }
    }
    if (gen !== qqGen) return
    const creds = loadQqCreds()
    const bot = createQQBot(creds, log)
    bot.setMessageHandler((m) => { void handleInbound(m).catch((e) => console.error(`[${NAME}] inbound`, e)) })
    if (gen !== qqGen) {
      try { await bot.stop() } catch { /* superseded */ }
      return
    }
    qq = bot
    if (creds.appId && creds.appSecret) void bot.start()
  }

  void startQq()
  ctx.effect(() => () => {
    qqGen += 1
    tickets.dispose()
    void cancelProvisioning()
    void qq?.stop()
  })

  const llm = ctx.llm
  const permissionPresets = ctx.permissionPresets
  const agentDefaultModel = ctx.get('agentDefaultModel')

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
      return { ok: false, error: '未配置审核模型', ...route }
    }
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const efforts = (info && info.reasoning && Array.isArray(info.reasoning.efforts))
        ? info.reasoning.efforts.map((e) => e.id)
        : []
      if (route.reasoningEffort && efforts.length > 0 && !efforts.includes(route.reasoningEffort)) {
        return { ok: false, error: `reasoningEffort ${route.reasoningEffort} 不受支持`, ...route }
      }
      return { ok: true, ...route, info }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), ...route }
    }
  }

  /**
   * 调用审核模型。不要传 messages.system：newapi 会映射成 developer 角色导致 400。
   * 分类提示全部折进 user 文本。
   */
  async function callJudge(userText, signal, route, system) {
    const prompt = system || buildJudgePrompt(allowlist.criteria, pluginCfg.judgePromptLang)
    const opts = {
      provider: route.provider,
      model: route.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt + '\n\n' + userText }],
      }],
      temperature: 0,
      maxTokens: 256,
      signal,
    }
    if (route.reasoningEffort) opts.reasoningEffort = route.reasoningEffort
    let text = ''
    for await (const chunk of llm.stream(opts)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
        throw new Error('审核模型调用失败: ' + failure)
      }
    }
    return text
  }

  async function judgeOnce(toolName, mode, justification, args, signal, route, cwd) {
    const criteria = allowlist.criteria || DEFAULT_CRITERIA
    const lang = normalizeJudgePromptLang(pluginCfg.judgePromptLang)
    const user = formatJudgeCard(toolName, mode, justification, args, cwd, lang)
    const text = await callJudge(user, signal, route, buildJudgePrompt(criteria, lang))
    try {
      return { ...parseJudgeClassify(text, criteria), raw: String(text || '').slice(0, 800) }
    } catch (error) {
      error.raw = String(text || '').slice(0, 800)
      throw error
    }
  }

  async function withRetry(runFn, label, timeoutMs) {
    const runOnce = async () => {
      const controller = new AbortController()
      let cancelTimer
      const timed = new Promise((resolve) => {
        cancelTimer = ctx.timeout(() => resolve({ timedOut: true }), timeoutMs)
      })
      try {
        const call = runFn(controller.signal)
          .then((r) => ({ ...r, timedOut: false }))
          .catch((error) => ({ judgeError: error }))
        const result = await Promise.race([call, timed])
        if (result.judgeError) throw result.judgeError
        return result
      } finally {
        if (typeof cancelTimer === 'function') {
          try { cancelTimer() } catch { /* disposer */ }
        }
        controller.abort(`${NAME}: ${label} 结束`)
      }
    }
    let last = { failed: true }
    try {
      const first = await runOnce()
      if (!first.timedOut) return first
      last = { failed: true, timedOut: true, error: `超时(${timeoutMs}ms)` }
      console.warn(`[${NAME}] ${label} 超时(${timeoutMs}ms)，转人工`)
      return last
    } catch (error) {
      last = {
        failed: true,
        error: String((error && error.message) || error),
        raw: error && error.raw ? String(error.raw).slice(0, 800) : '',
      }
      console.error(`[${NAME}] ${label} 异常，重试 1 次`, error)
    }
    try {
      const second = await runOnce()
      if (!second.timedOut) return second
      last = { failed: true, timedOut: true, error: `重试超时(${timeoutMs}ms)` }
      console.warn(`[${NAME}] ${label} 重试超时(${timeoutMs}ms)`)
      return last
    } catch (error) {
      last = {
        failed: true,
        error: String((error && error.message) || error),
        raw: error && error.raw ? String(error.raw).slice(0, 800) : last.raw,
      }
      console.error(`[${NAME}] ${label} 重试仍异常`, error)
      return last
    }
  }

  async function judgeOperation(toolName, mode, justification, args, cwd) {
    const route = await resolveJudgeRoute()
    const meta = {
      provider: route.provider || '',
      model: route.model || '',
      effort: route.reasoningEffort || '',
    }
    if (!route.ok) {
      audit(`FAILED  judge route: ${route.error}`)
      return { action: 'human', criterion: 'other', reason: '', failed: true, error: route.error, ...meta }
    }
    const timeoutMs = effectiveJudgeTimeoutMs(allowlist, pluginCfg)
    const result = await withRetry(
      (signal) => judgeOnce(toolName, mode, justification, args, signal, route, cwd),
      '审核模型',
      timeoutMs,
    )
    if (result.failed) {
      return {
        action: 'human',
        criterion: 'other',
        reason: '',
        failed: true,
        timedOut: Boolean(result.timedOut),
        error: result.error || '审核失败',
        raw: result.raw || '',
        ...meta,
      }
    }
    const row = lookupCriteria(allowlist.criteria, result.criterion)
    return { ...result, action: row.action, label: row.label, ...meta }
  }

  async function applyHumanOutcome(ctxInfo, outcome, extra) {
    const { sessionId, toolName, mode, reason, justification, category, path, ticket, args, cwd, judgeReason, judge } = ctxInfo
    const source = (extra && extra.source) || 'web'
    audit(`OUTCOME ${toolName} outcome=${outcome} source=${source} ticket=${ticket || '-'} | ${reason.slice(0, 80)}`)
    const detail = { category, path, ticket, source, args, cwd, judgeReason, judge }

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
   * 网页 next() 与 QQ 票据竞速，谁先答谁赢。
   * 120s 只是 QQ 提醒，不是全局超时；网页框一直等到有人答或会话取消。
   */
  async function forwardToHuman(info, next, req) {
    reloadPluginCfg()
    const ticket = tickets.allocate(info)
    recordEvent(info.sessionId, info.toolName, info.mode, info.reason, info.justification, 'manual-pending', {
      kind: 'manual-pending',
      category: info.category || '',
      path: info.path,
      ticket: ticket.n,
      args: info.args,
      cwd: info.cwd,
      judgeReason: info.judgeReason,
      judge: info.judge,
    })

    const notify = pluginCfg.notify
    const timeoutSecs = Number(notify.timeoutSecs) > 0 ? Number(notify.timeoutSecs) : 120
    let pushed = false
    if (notify.enabled && qq && qq.connected() && notify.chatId) {
      const ok = await qqSend(notify.chatId, formatApprovalPush(ticket, timeoutSecs), {
        keyboard: formatApprovalKeyboard(
          ticket.n,
          String(notify.chatId).startsWith('g:') ? notify.userId : '',
        ),
      })
      if (ok) {
        pushed = true
        audit(`PUSH    #${ticket.n} chat=${notify.chatId} ${info.toolName}`)
      } else {
        audit(`PUSH_FAIL #${ticket.n} ${info.toolName}`)
      }
    } else {
      audit(`PUSH_SKIP #${ticket.n} enabled=${notify.enabled} connected=${Boolean(qq && qq.connected())} chat=${notify.chatId || ''} ${info.toolName}`)
    }

    const onAbort = () => {
      const live = tickets.get(ticket.n)
      if (!live || live.settled) return
      tickets.discard(ticket.n, 'abort')
      if (pushed) void qqSend(notify.chatId, `#${ticket.n} 已取消`)
    }
    const requestSignal = req.signal
    // 网页框听这个 fork：QQ 先答时 abort 它即可关框，不能 abort 原始 req.signal（整单会 cancelled）。
    const webSignal = forkAbortSignal(requestSignal)
    replaceRequestSignal(req, webSignal.signal)
    if (requestSignal) {
      if (requestSignal.aborted) {
        onAbort()
        webSignal.abort()
        await applyHumanOutcome({ ...info, ticket: ticket.n }, 'cancelled', { source: 'abort' })
        return 'cancelled'
      }
      requestSignal.addEventListener('abort', onAbort, { once: true })
    }

    let timeoutHandle
    if (pushed) {
      timeoutHandle = ctx.timeout(() => {
        if (ticket.settled) return
        void qqSend(notify.chatId, `#${ticket.n} 请在网页继续`)
      }, timeoutSecs * 1000)
    }

    try {
      const webP = Promise.resolve()
        .then(() => next())
        .then((outcome) => ({ source: 'web', outcome }))
        .catch((error) => {
          console.error(`[${NAME}] web next() 失败`, error)
          return { source: 'web', outcome: 'unavailable' }
        })
      const imP = ticket.wait.then((result) => result)

      const first = await Promise.race([webP, imP])
      if (first.source === 'qq' && first.outcome) {
        await applyHumanOutcome({ ...info, ticket: ticket.n }, first.outcome, {
          source: 'qq',
        })
        if (pushed) {
          void qqSend(notify.chatId, first.outcome === 'allowed-once'
            ? `#${ticket.n} 已批准`
            : `#${ticket.n} 已拒绝`)
        }
        return first.outcome
      }
      if (first.source === 'web') {
        tickets.discard(ticket.n, 'web')
        await applyHumanOutcome({ ...info, ticket: ticket.n }, first.outcome, { source: 'web' })
        if (pushed) void qqSend(notify.chatId, `#${ticket.n} 已在网页${formatOutcomeLabel(first.outcome)}`)
        return first.outcome
      }
      const outcome = first.outcome || 'cancelled'
      await applyHumanOutcome({ ...info, ticket: ticket.n }, outcome, { source: first.source || 'abort' })
      return outcome
    } finally {
      webSignal.abort()
      if (timeoutHandle && typeof timeoutHandle === 'function') {
        try { timeoutHandle() } catch { /* disposer */ }
      }
      if (requestSignal) requestSignal.removeEventListener('abort', onAbort)
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
      const sessionCwd = (typeof session.cwd === 'string' && session.cwd) ? session.cwd : ''
      const cached = takeCachedCall(pendingCalls, sessionId, req.callId)
      const toolArgs = pickToolArgs(cached.args || {})
      const baseInfo = {
        sessionId, toolName, mode, reason, justification, cwd: sessionCwd, callId: req.callId || '',
        args: toolArgs,
      }

      const toHuman = (path, category, extra) => forwardToHuman({
        ...baseInfo,
        path,
        category: category || '',
        key: extra && extra.key,
        confirmed: extra && extra.confirmed,
        threshold: extra && extra.threshold,
        judgeReason: extra && extra.judgeReason,
        judge: extra && extra.judge,
      }, next, req)
      humanFallback = toHuman
      // 没看见命令/路径就转人工，禁止关键词允许或模型标 safe。
      if (!cached.found || !hasToolPayload(toolArgs)) {
        const why = cached.found ? '工具参数不完整，转人工' : '未捕获工具参数，转人工'
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} missing-payload | ${why}`)
        return toHuman('missing-payload', 'other', { judgeReason: why })
      }
      const hay = formatKeywordHay(toolName, reason, toolArgs)
      const kw = matchKeywordBuckets(hay, allowlist, formatAllowKeywordHay(toolArgs))
      const eventDetail = { args: toolArgs, cwd: sessionCwd }
      if (kw && kw.action === 'reject') {
        audit(`REJECT  ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-reject', {
          kind: 'auto', path: 'keyword-reject', ...eventDetail,
        })
        return 'rejected'
      }
      if (toolArgsTruncated(toolArgs)) {
        const why = '工具参数过长已截断，转人工（禁止按前缀自动放行）'
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} truncated-payload | ${why}`)
        return toHuman('truncated-payload', 'other', { judgeReason: why })
      }
      if (kw) {
        if (kw.action === 'allow') {
          audit(`ALLOW   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
          recordEvent(sessionId, toolName, mode, reason, justification, 'keyword-allow', {
            kind: 'auto', path: 'keyword-allow', ...eventDetail,
          })
          return 'allowed-once'
        }
        audit(`HUMAN   ${toolName} mode=${mode || 'none'} keyword | ${reason.slice(0, 160)}`)
        return toHuman('keyword-human', '')
      }

      const judged = await judgeOperation(toolName, mode, justification, toolArgs, sessionCwd)
      const criterion = judged.criterion || 'other'
      const judgeReason = judged.reason || ''
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
        return 'rejected'
      }
      if (judged.action === 'allow') {
        audit(`ALLOW   ${toolName} mode=${mode || 'none'} criteria=${criterion} | ${judgeReason || reason.slice(0, 120)}`)
        recordEvent(sessionId, toolName, mode, reason, justification, 'criteria-allow', {
          kind: 'auto', category: criterion, path: 'criteria-allow', judgeReason, judge: judged, ...eventDetail,
        })
        return 'allowed-once'
      }
      audit(`HUMAN   ${toolName} mode=${mode || 'none'} criteria=${criterion} | ${judgeReason || reason.slice(0, 120)}`)
      return toHuman('criteria-human', criterion, { judgeReason, judge: judged })
    } catch (error) {
      console.error(`[${NAME}] 判断过程出错，回退人工`, error)
      if (humanFallback) {
        try {
          return await humanFallback('plugin-error', 'other', {
            judgeReason: String((error && error.message) || error),
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
      console.warn(`[${NAME}] connection.fetch 不可用，设置页/提示条 RPC 未注册（门控与 QQ 仍工作）`)
      return
    }

    async function dispatch(endpoint, payload) {
      try {
        reloadAllowlist()
        reloadPluginCfg()
        const body = payload && typeof payload === 'object' ? payload : {}
        if (endpoint === 'snapshot') {
          const creds = loadQqCreds()
          return {
            ok: true,
            value: {
              config: {
                version: allowlist.version || 17,
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
              },
              setup: getSetupState(paths.profilePatch),
              plugin: pluginCfg,
              pluginCorrupt: pluginCfgCorrupt,
              qq: {
                status: qq ? qq.status() : '未启动',
                connected: Boolean(qq && qq.connected()),
                hasSecret: Boolean(creds.appId && creds.appSecret),
                credsCorrupt: qqbotCorrupt,
                appIdMasked: maskSecret(creds.appId),
                recentChats,
                provisioning: provisionSnapshot(),
              },
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
            return { ok: false, error: { code: 'events', message: '需要 sessionId', details: {} } }
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
          return result.ok ? { ok: true, value: result } : { ok: false, error: { code: 'rule', message: result.error || '失败', details: {} } }
        }
        if (endpoint === 'setup') {
          return { ok: true, value: setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox) }
        }
        if (endpoint === 'save-plugin') {
          if (pluginCfgCorrupt && !body.overwriteCorrupt) {
            return { ok: false, error: { code: 'save', message: '插件配置损坏，拒绝覆盖。请修好磁盘文件，或点「覆盖损坏配置」', details: {} } }
          }
          const next = mergePluginConfig(pluginCfg, body)
          const prev = pluginCfg
          pluginCfg = next
          if (!persistPluginCfg({ overwriteCorrupt: Boolean(body.overwriteCorrupt) })) {
            pluginCfg = prev
            return { ok: false, error: { code: 'save', message: '写入配置失败', details: {} } }
          }
          let preset = null
          if (body && Object.prototype.hasOwnProperty.call(body, 'presetSandbox')) {
            preset = setAutoApproveSandbox(paths.profilePatch, pluginCfg.presetSandbox)
          }
          if (typeof body.judgeTimeoutMs === 'number') {
            const timeoutResult = applyRuleOp('set', 'judgeTimeoutMs', body.judgeTimeoutMs)
            if (!timeoutResult.ok) {
              return { ok: false, error: { code: 'rule', message: timeoutResult.error || '写入超时失败', details: {} } }
            }
            pluginCfg.judge.timeoutMs = allowlist.judgeTimeoutMs
            persistPluginCfg()
          }
          audit('CONFIG  plugin 已更新')
          return { ok: true, value: { ok: true, plugin: pluginCfg, preset, setup: getSetupState(paths.profilePatch) } }
        }
        if (endpoint === 'save-qq-creds') {
          await cancelProvisioning()
          const appId = String(body.appId || '').trim()
          const appSecret = String(body.appSecret || '').trim()
          const prev = loadQqCreds()
          const next = {
            appId: appId || prev.appId,
            appSecret: appSecret || prev.appSecret,
            ownerUserOpenid: prev.ownerUserOpenid || '',
          }
          persistQqCreds(next)
          await startQq()
          audit('CONFIG  qqbot 凭据已更新并重连')
          return { ok: true, value: { ok: true, status: qq ? qq.status() : '未启动' } }
        }
        if (endpoint === 'qq-provision') {
          const result = await startProvisioning()
          return result.ok
            ? { ok: true, value: { ok: true, status: provisionAttempt ? provisionAttempt.status : '' } }
            : { ok: false, error: { code: 'provision', message: result.error || '扫码启动失败', details: {} } }
        }
        if (endpoint === 'qq-cancel-provision') {
          await cancelProvisioning()
          return { ok: true, value: { ok: true } }
        }
        if (endpoint === 'set-chat') {
          pluginCfg.notify.chatId = String(body.chatId || '')
          pluginCfg.notify.userId = String(body.userId || '')
          if (!persistPluginCfg()) {
            return { ok: false, error: { code: 'save', message: '写入配置失败', details: {} } }
          }
          audit(`CONFIG  notify chatId=${pluginCfg.notify.chatId}`)
          return { ok: true, value: { ok: true, notify: pluginCfg.notify } }
        }
        if (endpoint === 'reconnect-qq') {
          await startQq()
          return { ok: true, value: { ok: true, status: qq ? qq.status() : '未启动' } }
        }
        if (endpoint === 'judge-catalog') {
          const provider = String(body.provider || configuredRoute().provider)
          let models = []
          try {
            models = (await llm.listModels(provider)).map((m) => ({ id: m.id, name: m.name || m.id }))
          } catch (error) {
            return { ok: false, error: { code: 'catalog', message: String((error && error.message) || error), details: {} } }
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
            return { ok: false, error: { code: 'info', message: String((error && error.message) || error), details: {} } }
          }
        }
        return { ok: false, error: { code: 'unknown', message: `unknown endpoint ${endpoint}`, details: {} } }
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: String((error && error.message) || error), details: {} } }
      }
    }

    /** 设置页 / 提示条 / 历史。仅 GUI；模型点不到这些按钮。 */
    async function serve(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const packed = body && body.payload && typeof body.payload === 'object' ? body.payload : {}
      const endpoint = String(packed.endpoint || '')
      const payload = packed.payload && typeof packed.payload === 'object' ? packed.payload : {}
      try {
        const result = await enqueueRpc(() => dispatch(endpoint, payload))
        return Response.json({ type: 'server-response', rpcId: rpcId, result: result })
      } catch (error) {
        return new Response('handler failure: ' + String(error), { status: 500 })
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

  log(`已挂载：关键词→审核表 sandbox=${pluginCfg.presetSandbox}；QQ=${qq ? qq.status() : '无'}`)
}
