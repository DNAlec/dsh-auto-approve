import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanString, pickQqCredentials, startQqProvisioning } from '../src/provisioning.mjs'

describe('pickQqCredentials', () => {
  it('从数组里挑出完整凭据', () => {
    assert.equal(pickQqCredentials([]), null)
    assert.equal(pickQqCredentials(null), null)
    assert.deepEqual(pickQqCredentials([
      { appId: '', appSecret: 'x' },
      { appId: 'id1', appSecret: 'sec1', userOpenid: 'u1' },
    ]), { appId: 'id1', appSecret: 'sec1', userOpenid: 'u1' })
  })

  it('也接受单对象', () => {
    assert.deepEqual(
      pickQqCredentials({ appId: ' a ', appSecret: ' b ', userOpenid: '  ' }),
      { appId: 'a', appSecret: 'b', userOpenid: '' },
    )
  })
})

describe('cleanString', () => {
  it('只保留非空字符串', () => {
    assert.equal(cleanString('  x  '), 'x')
    assert.equal(cleanString(''), '')
    assert.equal(cleanString(1), '')
    assert.equal(cleanString(undefined), '')
  })
})

describe('startQqProvisioning', () => {
  it('二维码就绪后回调，成功后交出凭据', async () => {
    const events = []
    let captured
    const handle = await startQqProvisioning({
      onQr(qr) { events.push(['qr', qr.dataUrl, qr.expiresAt]) },
      onStatus(status) { events.push(['status', status]) },
      onCredentials(creds) { events.push(['creds', creds]) },
      onFailure(error) { events.push(['fail', error]) },
    }, undefined, {
      qrDataUrl: async (url) => 'data:image/png;base64,' + url,
      importConnector: async () => ({
        startQrConnect(cb) {
          captured = cb
          cb.onQrDisplayed('https://q.qq.com/qr')
          return () => { events.push(['dispose']) }
        },
      }),
    })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(events[0][0], 'qr')
    assert.equal(events[0][1], 'data:image/png;base64,https://q.qq.com/qr')
    assert.equal(typeof events[0][2], 'number')
    assert.deepEqual(events[1], ['status', '等待扫码'])

    captured.onSuccess([{ appId: 'app', appSecret: 'secret', userOpenid: 'openid' }])
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(events[2], ['creds', { appId: 'app', appSecret: 'secret', ownerUserOpenid: 'openid' }])

    handle.cancel()
    assert.deepEqual(events[3], ['dispose'])
  })

  it('缺少 startQrConnect 时失败', async () => {
    await assert.rejects(
      () => startQqProvisioning({
        onQr() {}, onStatus() {}, onCredentials() {}, onFailure() {},
      }, undefined, { importConnector: async () => ({}) }),
      /缺少 startQrConnect/,
    )
  })

  it('空凭据走 onFailure', async () => {
    const failures = []
    let captured
    await startQqProvisioning({
      onQr() {}, onStatus() {}, onCredentials() {},
      onFailure(error) { failures.push(String(error && error.message || error)) },
    }, undefined, {
      qrDataUrl: async () => 'x',
      importConnector: async () => ({
        startQrConnect(cb) { captured = cb; return () => {} },
      }),
    })
    captured.onSuccess([])
    assert.match(failures[0], /未返回完整机器人凭据/)
  })
})
