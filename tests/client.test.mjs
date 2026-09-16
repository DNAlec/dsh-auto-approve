/**
 * client.js 的纯函数单测。
 *
 * client.js 是给浏览器 bundle 的 `window.__ModuleLoader__.load({ id, factory })` 包装，
 * 浏览器半一直是测试空白区（review 里 P1-4/P1-5 两个缺陷就是从这里漏出去的）。
 * 这里造一个假 loader 取出 factory、用一个最小 `require` 跑起来，只测**不碰 DOM/ctx**
 * 的那几个判定与映射函数——它们正是「一次拒绝被渲染成自动放行」这类 bug 的所在。
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zh } from '../locales.mjs'

let api = null
/** `__ModuleLoader__.load` 收到的定义；factory 可以重复调用（第二个实例用 React 替身）。 */
let definition = null

before(async () => {
  globalThis.window = { __ModuleLoader__: { load(def) { definition = def } } }
  await import('../client.js')
  assert.ok(definition, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(definition.id, '@dnalec/dsh-auto-approve')
  api = definition.factory(() => ({}))
  assert.equal(api.name, '@dnalec/dsh-auto-approve')
  assert.ok(api.__test, '缺少 __test 出口')
})

/** 与 ctx.locale.bind 同形状：查不到就回落到键名（fillLocale 的最小替身）。 */
function t(key, params) {
  const tpl = zh[key]
  if (tpl === undefined) return key
  return String(tpl).replace(/\{(\w+)\}/g, (m, name) => (params && params[name] !== undefined ? String(params[name]) : m))
}

describe('审批事件 → 标签的映射（client 纯函数）', () => {
  it('拒绝的判据优先看 outcome，其次 denyReason，最后才回落到 verdict 后缀', () => {
    const { isAutoReject } = api.__test
    // 宿主显式落的结局最权威：`truncated-payload`（超预算 / 撞护栏）与 `plugin-error`
    // 既可能拒绝也可能放行，按后缀判会把一次真拒绝渲染成绿色的「自动放行」。
    assert.equal(isAutoReject({ outcome: 'rejected', verdict: 'truncated-payload' }), true)
    assert.equal(isAutoReject({ outcome: 'allowed-once', verdict: 'plugin-error' }), false)
    assert.equal(isAutoReject({ outcome: 'allowed-once', verdict: 'criteria-allow' }), false)
    // 没有 outcome（0.3.0 之前的记录）时用闭集拒绝原因
    assert.equal(isAutoReject({ verdict: 'truncated-payload', denyReason: 'payload-truncated' }), true)
    assert.equal(isAutoReject({ verdict: 'plugin-error' }), false)
    // 老记录两条都没有：后缀判据（保持旧行为）
    assert.equal(isAutoReject({ verdict: 'keyword-reject' }), true)
    assert.equal(isAutoReject({ verdict: 'criteria-reject' }), true)
    assert.equal(isAutoReject({ verdict: 'human' }), false)
    // 也接受裸字符串（历史调用点）
    assert.equal(isAutoReject('criteria-reject'), true)
    assert.equal(isAutoReject(undefined), false)
  })

  it('事件预览优先命令/路径，自定义工具的未知参数兜底', () => {
    const { eventPreview } = api.__test
    assert.equal(eventPreview({ args: { command: 'rm -rf /' } }), 'rm -rf /')
    assert.equal(eventPreview({ args: { file_path: 'a.ts' } }), 'a.ts')
    assert.equal(eventPreview({ args: { cmd: 'deploy' } }), 'deploy')
    // 宿主把自定义工具的嵌套叶子拍平成 `params.command` / `args.file_path`：
    // 这些键既不是专门行（专门行读顶层键），也必须能出现在预览里——否则条子上什么都没有。
    assert.equal(eventPreview({ args: { 'params.command': 'rm -rf /tmp/data' } }), 'rm -rf /tmp/data')
    assert.equal(eventPreview({ args: { 'args.file_path': '/a/b' } }), '/a/b')
    assert.equal(eventPreview({ args: {}, justification: '模型理由' }), '模型理由')
    assert.equal(eventPreview({}), '')
  })

  it('嵌套（带点号）参数单独成行，顶层已知键不重复列', () => {
    const { isExtraArgKey } = api.__test
    // 宿主把 MCP 的嵌套叶子拍平成 `params.command` / `args.file_path`：它们是**另一个参数**，
    // 必须走通用行。按尾段认成「已有专门行」会让它既进不了通用行、也没有专门行覆盖——
    // 审批历史里整个参数消失。
    for (const key of ['params.command', 'args.file_path', 'extra.query', 'a.b.c']) {
      assert.equal(isExtraArgKey(key), true, key)
    }
    // 顶层已知键有专门行，不再重复；workdir 由「命令工作目录」那一行负责。
    for (const key of ['command', 'file_path', 'path', 'content', 'code', 'url', 'query', 'body']) {
      assert.equal(isExtraArgKey(key), false, key)
    }
    assert.equal(isExtraArgKey('workdir'), false)
    // 未知顶层键（MCP 的自定义参数名）照样成行。
    assert.equal(isExtraArgKey('cmd'), true)
  })

  it('详情参数行：同组落选的键（path / 落选标签）必须进通用区', () => {
    const { detailExtraKeys } = api.__test
    // `file_path` 与 `path` 同时存在：两个都要显示（专门行给 file_path，path 走通用区）
    assert.deepEqual(detailExtraKeys({ file_path: '/y', path: '/x' }), ['path'])
    // 只有 path 时它占专门行，不重复
    assert.deepEqual(detailExtraKeys({ path: '/x' }), [])
    assert.deepEqual(detailExtraKeys({ file_path: '/y' }), [])
    // 嵌套叶子与未知键照常进通用区
    assert.deepEqual(detailExtraKeys({ command: 'ls', 'params.command': 'rm -rf /', extra: 'z' }), ['extra', 'params.command'])
    assert.deepEqual(detailExtraKeys({ workdir: '/w' }), [])
    assert.deepEqual(detailExtraKeys({}), [])
  })

  it('详情渲染必须走 detailExtraKeys（接线断言，防它被内联逻辑架空）', () => {
    // 第四轮加 helper 时渲染路径没接上，helper 成了死代码（测试全绿、行为没变）；
    // 第五轮接上之后，只有这条源码级断言能拦住「又被改回内联」。
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(src, /const extraKeys = detailExtraKeys\(args\)/)
    assert.equal(/args\.file_path != null && args\.path != null/.test(src), false,
      '通用参数行不许再有只认 file_path/path 的内联补行')
  })

  it('闭集标签查得到，未知 id 回落成 id 本身（不会渲染成 undefined）', () => {
    const { verdictLabel, pathLabel, denyReasonLabel, actionLabel, levelLabel, srcLabel } = api.__test
    assert.equal(verdictLabel(t, 'criteria-allow'), '审核表允许')
    assert.equal(verdictLabel(t, 'truncated-payload'), '内容超过送审上限')
    assert.equal(pathLabel(t, 'keyword-reject'), '关键词拒绝')
    assert.equal(denyReasonLabel(t, 'payload-truncated'), '内容超过送审上限')
    // 「参数没采集到」与「内容超过上限」必须分开显示（前者重发、后者别再发）。
    assert.equal(denyReasonLabel(t, 'payload-uncaptured'), zh['denyReason.payload-uncaptured'])
    assert.notEqual(denyReasonLabel(t, 'payload-uncaptured'), denyReasonLabel(t, 'payload-truncated'))
    assert.equal(actionLabel(t, 'human'), '人工')
    assert.equal(levelLabel(t, 'high'), '高')
    // 闸门那条路新增的 src 值也要有文案：否则审批历史的「判定来源」显示原始 id
    assert.equal(srcLabel(t, 'uncaptured'), '没采集到参数')
    assert.equal(srcLabel(t, 'oversize'), '撞收集护栏')
    assert.equal(srcLabel(t, 'truncated'), '超过送审上限')
    assert.equal(srcLabel(t, '认不出的来源'), '认不出的来源')
  })

  it('「参数没采集到」是整段告警，不能当成单元格占位符', () => {
    // 用同一个定义再起一个实例，这次给它一个最小的 React 替身：
    // Detail() / DetailSection() 只用到 createElement，不需要 DOM。
    const stub = definition.factory(() => ({
      createElement: (tag, props, ...kids) => ({ tag, props: props || {}, kids }),
    }))
    const { DetailSection } = stub.__test
    const row = ['命令', '']
    // 正常路径：空值显示占位符 `(空)`
    const plain = DetailSection('请求', [row], '(空)', null)
    const plainText = JSON.stringify(plain)
    assert.match(plainText, /\(空\)/)
    assert.equal(plainText.includes('未采集到'), false)
    // 告警路径：整段说明单独成行，**不能**贴到那一格的值上
    const warned = DetailSection('请求', [row], '(空)', '⚠ 未采集到这次调用的参数')
    const kids = warned.kids.map((k) => JSON.stringify(k)).join('|')
    assert.match(kids, /ab-detail-warn/)
    assert.match(kids, /未采集到/, '告警要在自己的元素里')
    assert.match(kids, /\(空\)/, '单元格占位符不受影响')
    // 一行值都没有时，只要有告警就要渲染出来
    assert.ok(DetailSection('请求', [], '(空)', '⚠ 未采集到这次调用的参数'))
    assert.equal(DetailSection('请求', [], '(空)', null), null)
  })

  it('RPC 错误码按 err.* 解析，认不出就用原始 message', () => {
    const { formatErr, codedText } = api.__test
    assert.equal(formatErr(t, 'err.judgeEmpty'), '审核模型输出为空')
    assert.equal(formatErr(t, 'rpc.unavailable'), 'connection.rpc 不可用')
    assert.equal(formatErr(t, 'judgeEmpty'), '审核模型输出为空')
    assert.equal(formatErr(t, 'something-else', { error: '上游说不行' }), '上游说不行')
    assert.equal(codedText(t, 'err.judgeTimeout', { ms: 30000 }), '审核超时（30000ms）')
    assert.equal(codedText(t, '不是错误码'), '不是错误码')
  })
})

describe('设置页结构（闸门不再单开卡片）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  it('闸门控件在审核模型卡片里', () => {
    // 用户要求：「超过送审上限不需要单独开个卡片」。触发条件（送审内容上限）与动作
    // 必须挨着放：拆到两处，改上限的人就看不到超限会发生什么。
    const judgeCard = src.indexOf("'data-ab-stage': 'judge'")
    const gateSelect = src.indexOf("kind: 'truncatedAction'")
    assert.ok(judgeCard > 0, '找不到审核模型卡片的锚点')
    assert.ok(gateSelect > judgeCard, 'truncatedAction 选择器必须在审核模型卡片内')
    assert.equal(src.includes("'unjudgeable'"), false, '闸门不该再有独立卡片或芯片')
    // 卡片没了，文案键也要跟着删：留着就是没有渲染点的死键
    for (const dead of ['set.unjudgeableTitle', 'set.unjudgeableSub', 'set.unjudgeableHint', 'set.judgeSubTail']) {
      assert.equal(zh[dead], undefined, dead + ' 已无渲染点，不该再留在字典里')
    }
  })

  it('总览只放步骤芯片，不放每行的「兜底等级 → 动作」投影', () => {
    // v22 把所有行统一成同一套刻度（low 允许 / medium 人工 / high 拒绝）之后，那排
    // `deletion · 高→拒绝` 芯片对每一行都是同一个值，还容易被读成「这些行都会被拒」——
    // 它只是「等级认不出」时那一格的投影，不是独立设置。真要表达的东西在审核表与风险等级
    // 两张卡片自己的控件里。删掉它就要连 CSS 一起删。
    assert.equal(src.includes('ab-set-inv'), false, 'ab-set-inv* 芯片与 CSS 应已删除')
    assert.equal(src.includes('set.rowFallback'), false, '行上的「等级认不出 → 动作」应已删除')
    assert.equal(zh['set.rowFallback'], undefined, 'set.rowFallback 不该再留在字典里')
  })
})
