/**
 * 短号票据：#1–#99 循环；解析 QQ 批复；结案 30s 记忆。
 *
 * 网页与 QQ 竞速：先答的 outcome 生效。结案后 30s 内同一短号再答会提示「已处理」，
 * 避免用户点两次按钮以为没生效。没有「永久拒绝」。
 */

const MAX = 99

/** 进程内经纪。不落盘：重启后未结票据作废，网页框也会随会话消失。 */
export function createTicketBroker() {
  /** @type {Map<number, object>} */
  const pending = new Map()
  /** @type {Map<number, { ts: number, outcome: string }>} */
  const recent = new Map()
  let nextNum = 1

  function pruneRecent(now = Date.now()) {
    for (const [n, rec] of recent) {
      if (now - rec.ts > 30_000) recent.delete(n)
    }
  }

  function allocate(meta) {
    pruneRecent()
    for (let i = 0; i < MAX; i++) {
      const n = ((nextNum - 1 + i) % MAX) + 1
      if (pending.has(n)) continue
      nextNum = (n % MAX) + 1
      const ticket = {
        n,
        sessionId: meta.sessionId || '',
        callId: meta.callId || '',
        toolName: meta.toolName || '',
        mode: meta.mode || '',
        reason: meta.reason || '',
        justification: meta.justification || '',
        category: meta.category || '',
        judgeReason: meta.judgeReason || '',
        path: meta.path || '',
        cwd: meta.cwd || '',
        args: meta.args && typeof meta.args === 'object' ? meta.args : {},
        resolve: null,
        settled: false,
      }
      const wait = new Promise((resolve) => {
        ticket.resolve = (result) => {
          if (ticket.settled) return
          ticket.settled = true
          pending.delete(n)
          recent.set(n, { ts: Date.now(), outcome: result && result.outcome })
          resolve(result)
        }
      })
      ticket.wait = wait
      pending.set(n, ticket)
      return ticket
    }
    throw new Error('no free ticket numbers')
  }

  function get(n) {
    return pending.get(Number(n))
  }

  function listPending() {
    return [...pending.values()].map((t) => ({
      n: t.n,
      sessionId: t.sessionId,
      toolName: t.toolName,
    }))
  }

  function answer(n, result) {
    const ticket = pending.get(Number(n))
    if (!ticket) return false
    ticket.resolve({
      source: 'qq',
      outcome: result.outcome,
    })
    return true
  }

  function discard(n, reason) {
    const ticket = pending.get(Number(n))
    if (!ticket) return
    ticket.resolve({ source: reason || 'discard', outcome: null })
  }

  function recentOutcome(n) {
    pruneRecent()
    return recent.get(Number(n)) || null
  }

  function pendingCount() {
    return pending.size
  }

  function solePending() {
    if (pending.size !== 1) return null
    return pending.values().next().value
  }

  function dispose() {
    for (const ticket of [...pending.values()]) {
      ticket.resolve({ source: 'dispose', outcome: 'cancelled' })
    }
  }

  return {
    allocate,
    get,
    listPending,
    answer,
    discard,
    recentOutcome,
    pendingCount,
    solePending,
    dispose,
  }
}

/** 未绑定 chatId 时，私人 bot 把这些回复当成「把本聊天设为审批目标」。 */
export function isBindConfirmText(text) {
  return /^(是|确认|用作审批|yes|ok)$/i.test(String(text || '').trim())
}

/**
 * 只认批准/拒绝。没有永久拒绝。多条 pending 必须带短号。
 * @returns {{ kind: string, n?: number, text?: string } | null}
 */
export function parseApprovalReply(text, pendingCount) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const s = raw.replace(/^[@＠]\S+\s+/, '').trim()

  const allowRe = /^(?:批准|同意|允许|yes|ok|allow)\s*#?\s*(\d{1,2})$/i
  const allowRe2 = /^#?\s*(\d{1,2})\s*(?:批准|同意|允许|yes|ok|allow)$/i
  const rejectRe = /^(?:拒绝|否决|no|reject|deny)\s*#?\s*(\d{1,2})$/i
  const rejectRe2 = /^#?\s*(\d{1,2})\s*(?:拒绝|否决|no|reject|deny)$/i

  let m = s.match(allowRe) || s.match(allowRe2)
  if (m) return { kind: 'allow', n: Number(m[1]) }

  m = s.match(rejectRe) || s.match(rejectRe2)
  if (m) return { kind: 'reject', n: Number(m[1]) }

  const bareAllow = /^(?:批准|同意|允许|yes|ok|allow)$/i
  const bareReject = /^(?:拒绝|否决|no|reject|deny)$/i
  if (bareAllow.test(s)) {
    if (pendingCount === 1) return { kind: 'allow-bare' }
    return { kind: 'need-number' }
  }
  if (bareReject.test(s)) {
    if (pendingCount === 1) return { kind: 'reject-bare' }
    return { kind: 'need-number' }
  }

  return null
}

export function formatPendingList(list) {
  if (!list || list.length === 0) return '当前没有待处理审批'
  return '当前：' + list.map((t) => '#' + t.n).join('、')
}

export function truncateText(text, max = 1600) {
  const s = String(text || '')
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export function formatOutcomeLabel(outcome) {
  if (outcome === 'allowed-once') return '批准'
  if (outcome === 'rejected') return '拒绝'
  if (outcome === 'cancelled') return '取消'
  if (outcome === 'unavailable') return '未应答'
  return String(outcome || '已处理')
}

/**
 * QQ 推送正文。timeoutSecs 只是「本聊天未答会提醒」，不是审批截止。
 * 有 command 时不重复 escalate 理由，避免把沙箱升级套话当成命令。
 */
export function formatApprovalPush(ticket, timeoutSecs) {
  const sid = String(ticket.sessionId || '')
  const tail = sid.length > 8 ? sid.slice(-8) : sid
  const cwd = String(ticket.cwd || '').replace(/[\\/]+$/, '')
  const base = cwd.split(/[\\/]/).pop() || cwd || '(cwd)'
  const args = ticket.args || {}
  const command = args.command ? truncateText(args.command, 1200) : ''
  const filePath = args.file_path || args.path || ''
  const content = args.content ? truncateText(args.content, 400) : ''
  const oldS = args.old_string ? truncateText(args.old_string, 300) : ''
  const newS = args.new_string ? truncateText(args.new_string, 300) : ''
  const extras = [
    args.code ? `代码：${truncateText(args.code, 400)}` : null,
    args.url ? `URL：${truncateText(args.url, 300)}` : null,
    args.query ? `查询：${truncateText(args.query, 300)}` : null,
    args.script ? `脚本：${truncateText(args.script, 400)}` : null,
    args.sql ? `SQL：${truncateText(args.sql, 300)}` : null,
    args.prompt ? `提示词：${truncateText(args.prompt, 300)}` : null,
    args.input ? `输入：${truncateText(args.input, 300)}` : null,
    args.text ? `文本：${truncateText(args.text, 300)}` : null,
    args.body ? `正文：${truncateText(args.body, 300)}` : null,
    args.message ? `消息：${truncateText(args.message, 200)}` : null,
  ].filter(Boolean)
  const clipped = Boolean(
    (args.command && command !== args.command)
    || (args.content && content !== args.content)
    || (args.old_string && oldS !== args.old_string)
    || (args.new_string && newS !== args.new_string)
    || (args.code && extras.some((l) => l.startsWith('代码：') && l.endsWith('…'))),
  )
  const hasCard = Boolean(command || filePath || content || oldS || newS || extras.length)
  const secs = Number(timeoutSecs) > 0 ? Number(timeoutSecs) : 120
  const body = [
    `⚠️ 审批 #${ticket.n}（本聊天 ${secs}s 内未答会提醒）`,
    `会话：${base} · ${tail}`,
    `工具：${ticket.toolName || 'unknown'}`,
    command ? `命令：${command}` : null,
    filePath ? `路径：${truncateText(filePath, 400)}` : null,
    args.description ? `描述：${truncateText(args.description, 200)}` : null,
    content ? `写入：${content}` : null,
    oldS ? `原文：${oldS}` : null,
    newS ? `改成：${newS}` : null,
    ...extras,
    ticket.judgeReason ? `判定：${truncateText(ticket.judgeReason, 200)}` : null,
    !command && ticket.reason ? `原因：${truncateText(ticket.justification || ticket.reason, 800)}` : null,
    !hasCard ? '未捕获命令/路径/内容，请在网页查看全文再批准' : null,
    clipped ? '正文已截断，请在网页查看全文再批准' : null,
    `点下方按钮，或回复：批准 ${ticket.n}  /  拒绝 ${ticket.n}`,
  ].filter(Boolean).join('\n')
  const out = truncateText(body, 2000)
  if (out !== body && !clipped) {
    return truncateText(body.replace(
      `点下方按钮，或回复：批准 ${ticket.n}  /  拒绝 ${ticket.n}`,
      `正文已截断，请在网页查看全文再批准\n点下方按钮，或回复：批准 ${ticket.n}  /  拒绝 ${ticket.n}`,
    ), 2000)
  }
  return out
}

/**
 * QQ 自定义按钮（单聊/群聊，2026-04-23 起无需模板）。
 * 必须挂在 markdown 消息上发出，纯文本 200 也会丢掉 keyboard。
 * @param {number} n
 * @param {string} [userId] 群聊时限制可点的人
 */
export function formatApprovalKeyboard(n, userId) {
  const num = String(n)
  const permission = userId
    ? { type: 0, specify_user_ids: [String(userId)] }
    : { type: 2 }
  const button = function (id, label, data, style) {
    return {
      id,
      render_data: { label, visited_label: label, style },
      action: {
        type: 1,
        permission,
        data,
        unsupport_tips: '请回复：' + data,
      },
    }
  }
  return {
    rows: [
      {
        buttons: [
          button('allow-' + num, '批准', '批准 ' + num, 1),
          button('reject-' + num, '拒绝', '拒绝 ' + num, 0),
        ],
      },
    ],
  }
}
