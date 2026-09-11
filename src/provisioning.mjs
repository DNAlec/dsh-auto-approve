/**
 * QQ 官方扫码创建机器人：生成本机二维码，等待平台返回 AppID / AppSecret。
 * 长连接仍由 qqbot.mjs 负责。扫码成功可预填扫码者 openid 为 chatId。
 */

export function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * @param {unknown} credentials
 * @returns {{ appId: string, appSecret: string, userOpenid: string } | null}
 */
export function pickQqCredentials(credentials) {
  const list = Array.isArray(credentials) ? credentials : (credentials ? [credentials] : [])
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const appId = cleanString(item.appId)
    const appSecret = cleanString(item.appSecret)
    if (appId && appSecret) {
      return { appId, appSecret, userOpenid: cleanString(item.userOpenid) }
    }
  }
  return null
}

export async function qrDataUrl(value) {
  const url = String(value || '')
  if (!url) throw new Error('扫码服务未返回二维码 URL')
  let mod
  try {
    mod = await import('qrcode')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/Cannot find|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(msg)) {
      throw new Error('未安装 qrcode，请在插件目录执行 npm install')
    }
    throw error
  }
  const toDataURL = typeof mod.toDataURL === 'function'
    ? mod.toDataURL
    : (mod.default && typeof mod.default.toDataURL === 'function' ? mod.default.toDataURL : null)
  if (!toDataURL) throw new Error('qrcode.toDataURL 不可用')
  return toDataURL.call(mod.default || mod, url, {
    type: 'image/png',
    margin: 2,
    width: 320,
    errorCorrectionLevel: 'M',
  })
}

async function defaultImportConnector() {
  try {
    return await import('@tencent-connect/qqbot-connector')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/Cannot find|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(msg)) {
      throw new Error('未安装 @tencent-connect/qqbot-connector，请在插件目录执行 npm install')
    }
    throw error
  }
}

/**
 * @param {{
 *   onQr: (qr: { dataUrl: string, expiresAt: number }) => void,
 *   onStatus: (status: string) => void,
 *   onCredentials: (creds: { appId: string, appSecret: string, ownerUserOpenid: string }) => void | Promise<void>,
 *   onFailure: (error: unknown) => void,
 * }} callbacks
 * @param {AbortSignal} [signal]
 * @param {{ importConnector?: () => Promise<any>, qrDataUrl?: (url: string) => Promise<string> }} [deps]
 * @returns {Promise<{ cancel: () => void }>}
 */
export async function startQqProvisioning(callbacks, signal, deps) {
  const loadConnector = (deps && deps.importConnector) || defaultImportConnector
  const toQr = (deps && deps.qrDataUrl) || qrDataUrl
  const mod = await loadConnector()
  const startQrConnect = typeof mod.startQrConnect === 'function'
    ? mod.startQrConnect
    : (mod.default && typeof mod.default.startQrConnect === 'function' ? mod.default.startQrConnect : null)
  if (typeof startQrConnect !== 'function') {
    throw new Error('@tencent-connect/qqbot-connector 缺少 startQrConnect')
  }

  let disposed = false
  const started = startQrConnect({
    onQrDisplayed(url) {
      if (disposed) return
      void Promise.resolve(toQr(String(url || ''))).then((dataUrl) => {
        if (disposed) return
        callbacks.onQr({ dataUrl, expiresAt: Date.now() + 5 * 60_000 })
        callbacks.onStatus('等待扫码')
      }).catch((error) => {
        if (!disposed) callbacks.onFailure(error)
      })
    },
    onQrExpired() {
      if (!disposed) callbacks.onStatus('二维码已过期')
    },
    onSuccess(credentials) {
      if (disposed) return
      const first = pickQqCredentials(credentials)
      if (!first) {
        callbacks.onFailure(new Error('QQ 扫码未返回完整机器人凭据'))
        return
      }
      void Promise.resolve(callbacks.onCredentials({
        appId: first.appId,
        appSecret: first.appSecret,
        ownerUserOpenid: first.userOpenid,
      })).catch((error) => {
        if (!disposed) callbacks.onFailure(error)
      })
    },
    onFailure(error) {
      if (!disposed) callbacks.onFailure(error)
    },
  }, {
    displayQrCodeToConsole: false,
    source: 'deepseek-harness',
    signal,
  })
  const dispose = (started && typeof started.then === 'function') ? await started : started
  return {
    cancel() {
      disposed = true
      if (typeof dispose === 'function') dispose()
    },
  }
}
