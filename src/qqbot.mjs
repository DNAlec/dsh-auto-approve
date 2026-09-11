/**
 * QQ 开放平台官方 Bot：token / WS / 收发。
 *
 * 意图：C2C + 群 @ + INTERACTION_CREATE（按钮回调）。
 * 发消息优先 markdown+keyboard；纯文本会成功但按钮没了。
 * op=7 必须关 socket 走重连，只改状态会卡死。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API = 'https://api.sgroup.qq.com'
const GATEWAY_PATH = '/gateway'
const GROUP_AND_C2C_INTENT = 1 << 25
const INTERACTION_INTENT = 1 << 26

export function isGatewayForceReconnect(op) {
  return op === 7 || op === 9
}

/**
 * @param {{ appId: string, appSecret: string }} creds
 * @param {(line: string) => void} log
 */
export function createQQBot(creds, log = () => {}) {
  const appId = String(creds.appId || '')
  const appSecret = String(creds.appSecret || '')
  if (!appId || !appSecret) {
    return {
      start() {},
      stop() {},
      async send() { throw new Error('qqbot: missing credentials') },
      setMessageHandler() {},
      status() { return '未配置凭据' },
      connected() { return false },
    }
  }

  let handler
  let ws
  let heartbeat
  let reconnectTimer
  let stableTimer
  let reconnectAttempts = 0
  let stopped = true
  let seq = null
  let accessToken = ''
  let tokenExpiresAt = 0
  let statusText = '未连接'

  function clearTimers() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = undefined }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    const delay = Math.min(3000 * (2 ** reconnectAttempts), 60_000)
    reconnectAttempts += 1
    log(`[qqbot] ${Math.ceil(delay / 1000)}s 后重连`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect().catch((err) => {
        statusText = '重连失败'
        log(`[qqbot] 重连失败: ${err instanceof Error ? err.message : String(err)}`)
        scheduleReconnect()
      })
    }, delay)
  }

  async function getToken() {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    })
    const body = await res.text()
    let data
    try { data = JSON.parse(body) } catch {
      throw new Error(`qq getAppAccessToken: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    if (!res.ok || !data.access_token) {
      throw new Error(`qq getAppAccessToken: HTTP ${res.status} ${data.message ?? 'no token'}`)
    }
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 7200
    tokenExpiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1000
    accessToken = data.access_token
    return accessToken
  }

  async function ensureToken() {
    if (!accessToken || Date.now() >= tokenExpiresAt) await getToken()
  }

  async function qqFetch(path, init, retried = false) {
    await ensureToken()
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'content-type': 'application/json',
        ...(init && init.headers ? init.headers : {}),
      },
    })
    if (res.status === 401 && !retried) {
      await res.text().catch(() => '')
      accessToken = ''
      tokenExpiresAt = 0
      return qqFetch(path, init, true)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`qq ${path}: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    if (res.status === 204) return null
    const text = await res.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  async function connect() {
    if (stopped) return
    if (typeof WebSocket === 'undefined') {
      statusText = '环境无 WebSocket'
      throw new Error('qqbot: WebSocket is not available')
    }
    await getToken()
    if (stopped) return
    const gw = await qqFetch(GATEWAY_PATH)
    const url = gw && gw.url
    if (!url) throw new Error('qq gateway: missing websocket url')
    if (stopped) return

    const socket = new WebSocket(url)
    ws = socket
    statusText = '连接中'
    socket.onopen = () => {
      if (ws === socket) statusText = '等待网关握手'
    }
    socket.onmessage = (ev) => {
      let payload
      try { payload = JSON.parse(String(ev.data)) } catch {
        log('[qqbot] 收到无法解析的网关消息')
        return
      }
      if (payload.s !== undefined) seq = payload.s
      switch (payload.op) {
        case 10: {
          const hello = payload.d || {}
          socket.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${accessToken}`,
              intents: GROUP_AND_C2C_INTENT | INTERACTION_INTENT,
              shard: [0, 1],
            },
          }))
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = setInterval(() => {
            if (ws === socket) socket.send(JSON.stringify({ op: 1, d: seq }))
          }, hello.heartbeat_interval || 41250)
          statusText = '鉴权中'
          log('[qqbot] 已收到 Hello，正在鉴权')
          break
        }
        case 0: {
          const t = payload.t
          if (t === 'READY') {
            if (stableTimer) clearTimeout(stableTimer)
            stableTimer = setTimeout(() => { reconnectAttempts = 0 }, 60_000)
            statusText = '已连接'
            log('[qqbot] 网关就绪')
            break
          }
          if (t === 'INTERACTION_CREATE') {
            const d = payload.d || {}
            if (d.id && (d.type === 11 || d.type === 12)) {
              void qqFetch(`/interactions/${encodeURIComponent(d.id)}`, {
                method: 'PUT',
                body: JSON.stringify({ code: 0 }),
              }).catch((err) => {
                log(`[qqbot] 互动回应失败: ${err instanceof Error ? err.message : String(err)}`)
              })
            }
            if (d.type !== 11) break
            const resolved = (d.data && d.data.resolved) || {}
            const text = String(resolved.button_data || '').trim()
            const isGroup = d.scene === 'group' || d.chat_type === 1
            const userId = isGroup
              ? (d.group_member_openid || '')
              : (d.user_openid || '')
            const chatId = isGroup
              ? (d.group_openid ? `g:${d.group_openid}` : '')
              : (d.user_openid || '')
            if (!chatId || !userId || !text) break
            void handler?.({ chatId, userId, text, isGroup, username: '' })
            break
          }
          if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE') {
            const msg = payload.d || {}
            if (!msg.content || !msg.author) return
            const isGroup = t === 'GROUP_AT_MESSAGE_CREATE'
            const userId = isGroup
              ? (msg.author.member_openid || msg.author.id)
              : (msg.author.user_openid || msg.author.id)
            const chatId = isGroup
              ? (msg.group_openid ? `g:${msg.group_openid}` : '')
              : (msg.author.user_openid || msg.author.id || '')
            if (!chatId || !userId) return
            void handler?.({
              chatId,
              userId,
              username: msg.author.username,
              text: String(msg.content || '').replace(/^<@!\d+>\s*/, '').trim(),
              isGroup,
            })
          }
          break
        }
        case 7:
        case 9:
          statusText = '重连中'
          log(`[qqbot] 网关要求重连 (op=${payload.op})`)
          if (payload.op === 9) seq = null
          try { socket.close() } catch { /* onclose 会 scheduleReconnect */ }
          break
      }
    }
    socket.onclose = (ev) => {
      if (ws !== socket) return
      if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = undefined }
      ws = undefined
      statusText = `已断开（code ${ev.code}）`
      if (!stopped) {
        const detail = ev.code === 4004 ? '：鉴权失败，将刷新 AccessToken' : ''
        log(`[qqbot] 连接断开（${ev.code}${detail}）`)
        scheduleReconnect()
      }
    }
    socket.onerror = () => {
      if (ws === socket) statusText = '连接错误'
    }
  }

  return {
    async start() {
      if (!stopped && (ws || reconnectTimer)) return
      stopped = false
      reconnectAttempts = 0
      try {
        await connect()
      } catch (err) {
        statusText = '连接失败'
        log(`[qqbot] 连接失败: ${err instanceof Error ? err.message : String(err)}`)
        scheduleReconnect()
      }
    },
    async stop() {
      stopped = true
      clearTimers()
      try { ws?.close(1000, 'shutdown') } catch { /* ignore */ }
      ws = undefined
      statusText = '已停止'
    },
    async send(chatId, text, extra = {}) {
      const content = String(text || '')
      const path = String(chatId).startsWith('g:')
        ? `/v2/groups/${String(chatId).slice(2)}/messages`
        : `/v2/users/${chatId}/messages`
      const keyboard = extra && extra.keyboard
      const kb = keyboard ? { content: keyboard } : null
      const payloads = []
      if (kb) {
        // 按钮挂在 markdown 上；纯文本会 200 但丢掉 keyboard。
        payloads.push({
          msg_type: 2,
          markdown: { content },
          keyboard: kb,
        })
        payloads.push({
          content,
          msg_type: 2,
          markdown: { content },
          keyboard: kb,
        })
        payloads.push({
          content,
          msg_type: 0,
          keyboard: kb,
        })
      }
      payloads.push({ content, msg_type: 0 })
      let lastErr
      for (const body of payloads) {
        try {
          await qqFetch(path, {
            method: 'POST',
            body: JSON.stringify(body),
          })
          log(`[qqbot] 已发送 msg_type=${body.msg_type}${body.keyboard ? ' keyboard' : ''}`)
          return
        } catch (err) {
          lastErr = err
          log(`[qqbot] 发送失败 msg_type=${body.msg_type}${body.keyboard ? ' keyboard' : ''}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      throw lastErr || new Error('qqbot: send failed')
    },
    setMessageHandler(h) { handler = h },
    status() { return statusText },
    connected() { return statusText === '已连接' },
  }
}
