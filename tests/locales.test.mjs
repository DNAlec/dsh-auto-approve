import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zh, en, NS } from '../locales.mjs'

describe('locales', () => {
  it('namespace is dsh-auto-approve', () => {
    assert.equal(NS, 'dsh-auto-approve')
  })

  it('zh/en 键集合相同且非空', () => {
    const zk = Object.keys(zh)
    const ek = Object.keys(en)
    assert.ok(zk.length > 80)
    assert.deepEqual(zk.slice().sort(), ek.slice().sort())
    for (const key of zk) {
      assert.equal(typeof zh[key], 'string')
      assert.equal(typeof en[key], 'string')
      assert.ok(zh[key].length > 0, key)
      assert.ok(en[key].length > 0, key)
    }
  })

  it('client.js 内嵌字典与 locales.mjs 一致', () => {
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const zhM = src.match(/const ZH = JSON\.parse\(String\.raw`([\s\S]*?)`\)/)
    const enM = src.match(/const EN = JSON\.parse\(String\.raw`([\s\S]*?)`\)/)
    assert.ok(zhM, 'client.js 缺少 ZH JSON.parse')
    assert.ok(enM, 'client.js 缺少 EN JSON.parse')
    assert.deepEqual(JSON.parse(zhM[1]), zh)
    assert.deepEqual(JSON.parse(enM[1]), en)
  })
})
