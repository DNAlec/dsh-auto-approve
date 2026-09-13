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

  it('path.* 都有对应 verdict.*，审核表允许不是英文 id', () => {
    for (const key of Object.keys(zh)) {
      if (!key.startsWith('path.')) continue
      const verdict = 'verdict.' + key.slice(5)
      assert.equal(zh[verdict], zh[key], verdict)
      assert.equal(en[verdict], en[key], verdict)
    }
    assert.equal(zh['verdict.criteria-allow'], '审核表允许')
    assert.notEqual(zh['verdict.criteria-allow'], 'criteria-allow')
    assert.equal(zh['criterion.safe'], undefined, '审核表 label 已取消，客户端不再有 criterion.* 文案')
    assert.ok(zh['err.criterionNeedDesc'] && en['err.criterionNeedDesc'])
    assert.equal(zh['sandbox.danger-full-access'], '全权限')
  })

  it('取消/不可用提示与缺参错误有双语键', () => {
    assert.match(zh['notice.cancelledTitle'], /{preview}/)
    assert.match(en['notice.cancelledTitle'], /{preview}/)
    assert.match(zh['notice.unavailableTitle'], /{preview}/)
    assert.equal(zh['err.missingPayload'].includes('err.'), false)
    assert.equal(en['err.truncatedPayload'].includes('err.'), false)
    assert.ok(!zh['set.modeWs'].includes('workspace-write'))
    assert.ok(!en['set.modeRo'].includes('read-only'))
  })
})
