import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zh, en, NS } from '../locales.mjs'
import { DENY_REASONS } from '../src/human-review.mjs'

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

  it('设置页文案键都有渲染点（删控件要同步删键）', () => {
    // 没有渲染点的键是死文案：留着会让后来的人以为某个开关还在。反过来也一样——
    // 每条 `set.*` 文案都必须在 client.js 里以字面量出现（`countsLabel(t, …, 'set.counts')`
    // 这种把键名当参数传的用法同样命中字面量）。删卡片 / 删控件时这条会先红。
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const dead = Object.keys(zh).filter((k) => k.startsWith('set.') && !src.includes(`'${k}'`))
    assert.deepEqual(dead, [], '这些 set.* 文案已无渲染点，请从 locales.mjs 删除：' + dead.join(', '))
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

  it('取消/不可用提示与失败档位有双语键，且文案不自指', () => {
    assert.match(zh['notice.cancelledTitle'], /{preview}/)
    assert.match(en['notice.cancelledTitle'], /{preview}/)
    assert.match(zh['notice.unavailableTitle'], /{preview}/)
    // 「参数没采集到」现在是唯一的采集类失败档位（`missing-payload` 那一档已随开关删除）
    assert.match(zh['err.missingPayloadUncaptured'], /未捕获/)
    assert.equal(en['err.missingPayloadUncaptured'].includes('err.'), false)
    assert.equal(en['err.truncatedPayload'].includes('err.'), false)
    // 已经不可达的档位不许留在字典里（0.4 起没有任何代码路径会产生它们）
    for (const gone of ['err.missingPayload', 'err.judgeParse', 'verdict.missing-payload', 'path.missing-payload']) {
      assert.equal(zh[gone], undefined, gone + ' 应当已删除')
      assert.equal(en[gone], undefined, gone + ' 应当已删除')
    }
    assert.ok(!zh['set.modeWs'].includes('workspace-write'))
    assert.ok(!en['set.modeRo'].includes('read-only'))
  })

  it('拒绝原因闭集的每一个值都有中英文案', () => {
    // 宿主会把这些值写进事件的 `denyReason`，客户端查不到键就静默丢字段——
    // 「参数没采集到」曾经因此与「内容超过送审上限」显示成同一句话。
    for (const reason of DENY_REASONS) {
      const key = 'denyReason.' + reason
      assert.ok(zh[key], `zh 缺 ${key}`)
      assert.ok(en[key], `en 缺 ${key}`)
    }
    assert.notEqual(zh['denyReason.payload-uncaptured'], zh['denyReason.payload-truncated'])
    assert.notEqual(en['denyReason.payload-uncaptured'], en['denyReason.payload-truncated'])
  })

  it('设置页文案是纯文本：不得含 markdown 强调或反引号', () => {
    for (const [lang, dict] of [['zh', zh], ['en', en]]) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(value.includes('**'), false, `${lang}.${key} 含 markdown 粗体`)
        assert.equal(value.includes('`'), false, `${lang}.${key} 含反引号`)
      }
    }
  })

  it('设置页只留一行提示，细节写在 README', () => {
    // 用户明确要求过「设置页面中不需要那么多说明，尽量精简，说明写到文档中」。
    // 规则细节（为什么这样设计、盲区在哪、触发时发生什么）一律进 README 的「设置」一节；
    // 页面上只留这个开关本身怎么用。**文案长回来了就把细节挪进 README，而不是放宽这几个数。**
    const keys = Object.keys(zh).filter((k) => /^set\.(intro|.*(Sub|Hint))$/.test(k))
    assert.ok(keys.length >= 10, '设置页说明键变少了？')
    for (const key of keys) {
      assert.ok(zh[key].length <= 80, `${key} 中文 ${zh[key].length} 字（上限 80）：长说明请写 README`)
      assert.ok(en[key].length <= 240, `${key} 英文 ${en[key].length} 字符（上限 240）：长说明请写 README`)
    }
    // 页面唯一的指路：其余说明都在 README 里
    assert.match(zh['set.intro'], /README/)
    assert.match(en['set.intro'], /README/)
  })
})
