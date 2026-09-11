import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/index.mjs'

describe('plugin exports', () => {
  it('命名导出 name/inject/apply，没有 default', () => {
    assert.equal(mod.name, 'dsh-auto-approve')
    assert.deepEqual(mod.inject, ['approval', 'permissionPresets', 'llm', 'timer', 'webServer'])
    assert.equal(typeof mod.apply, 'function')
    assert.equal('default' in mod, false)
  })
})
