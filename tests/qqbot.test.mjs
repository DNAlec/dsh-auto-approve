import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isGatewayForceReconnect } from '../src/qqbot.mjs'

describe('isGatewayForceReconnect', () => {
  it('op=7 与 op=9 都要关连接重连', () => {
    assert.equal(isGatewayForceReconnect(7), true)
    assert.equal(isGatewayForceReconnect(9), true)
    assert.equal(isGatewayForceReconnect(0), false)
    assert.equal(isGatewayForceReconnect(10), false)
  })
})
