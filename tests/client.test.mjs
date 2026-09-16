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
import { zh, en } from '../locales.mjs'

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
    assert.equal(levelLabel(t, 'high'), 'high', '等级原样显示 id（提示词/审计里都是它）')
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

describe('原生审批框的详情行（本插件接管）', () => {
  it('命令优先；没有命令就列参数（路径在最前，值裁剪但说明总量）', () => {
    const { approvalDetailText } = api.__test
    // 有命令时**也要交代其余参数**（凭证按完整投影签发，只印命令等于让人替看不见的字段签字）
    assert.equal(
      approvalDetailText(JSON.stringify({ command: 'rm -rf /x', description: 'd' })),
      'rm -rf /x（另有 1 个参数：description: d）',
    )
    assert.equal(approvalDetailText(JSON.stringify({ command: 'rm -rf /x' })), 'rm -rf /x')
    const write = approvalDetailText(JSON.stringify({ content: 'y'.repeat(150), file_path: '/etc/hosts' }))
    assert.ok(write.startsWith('file_path: /etc/hosts' + String.fromCharCode(10)), '路径要排在正文前面')
    assert.match(write, /content: y+…/)
  })

  it('嵌套命令要提升（MCP 的 params.command 就是命令），标量照样列', () => {
    const { approvalDetailText } = api.__test
    // 宿主侧 `formatReviewOperation` 同样做这个提升（两处口径必须一致）：不提升的话，
    // 正文一长，命令就会被挤出「只列前 4 个」那一截——人看不到自己要批准的命令。
    assert.equal(approvalDetailText(JSON.stringify({ params: { command: 'deploy --prod' } })), 'deploy --prod')
    // 命令位只放得下命令时**没有**披露段（其余参数为空才不写）；有一个别的参数就要交代
    assert.equal(
      approvalDetailText(JSON.stringify({ params: { command: 'deploy --prod' }, extra: 'e' })),
      'deploy --prod（另有 1 个参数：extra: e）',
    )
    const noisy = approvalDetailText(JSON.stringify({
      params: { command: 'deploy --prod' }, contents: 'x'.repeat(200), aaa: 1, bbb: 2, ccc: 3,
    }))
    assert.match(noisy, /^deploy --prod（另有 4 个参数：/, '命令不会被别的参数挤掉，其余参数照旧交代')
    const mcp = approvalDetailText(JSON.stringify({ params: { query: 'q' }, force: true }))
    assert.match(mcp, /params\.query: q/)
    assert.match(mcp, /force: true/)
  })

  it('嵌套过深要写出来，不能静默没有详情行', () => {
    const { approvalDetailText } = api.__test
    // 叶子最多到 5 段（`a.b.c.d.e`）；再深的整棵丢掉时必须交代一句
    // （宿主侧 `pickToolArgsDetailed` 没有这个上限，这里只是护栏）
    assert.equal(approvalDetailText(JSON.stringify({ a: { b: { c: { d: { e: 'x' } } } } })), 'a.b.c.d.e: x')
    const deep = approvalDetailText(JSON.stringify({ a: { b: { c: { d: { e: { f: 'x' } } } } } }))
    assert.match(deep, /嵌套过深，未展开/, '全是深嵌套时不能返回 null（那等于整行消失）')
    const mixed = approvalDetailText(JSON.stringify({
      path: '/tmp/x', a: { b: { c: { d: { e: { f: 'deep' } } } } },
    }))
    assert.match(mixed, /path: \/tmp\/x/)
    assert.match(mixed, /更深层参数未展开/)
  })

  it('截断与「只列前几个」都要说出来，且多行结果不被折成一行', () => {
    const { approvalDetailText } = api.__test
    const many = approvalDetailText(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }))
    assert.match(many, /（共 5 个参数，仅列前 4 个）$/)
    assert.equal(many.split(String.fromCharCode(10)).length, 4, '每个参数一行')
    const long = approvalDetailText(JSON.stringify({ command: 'a'.repeat(3000) + ' | sh' }))
    assert.match(long, /…（共 3005 字；尾部：…a+ \| sh）$/)
  })

  it('复核请求的包装层要拆掉：详情行显示被复核的操作，不是 {tool, arguments}', () => {
    // 模型求复核时，那次「调用」是转人工工具自己，参数形如 {tool, arguments, justification}。
    // 不拆就会渲染成 `arguments.command: …` / `tool: bash`，而 headline 已经写了「操作：…」。
    const inner = api.__test.approvalDetailText(JSON.stringify({
      tool: 'bash', arguments: { command: 'rm -rf /x' }, justification: '必须执行',
    }))
    assert.equal(inner, 'rm -rf /x')
    const write = api.__test.approvalDetailText(JSON.stringify({
      tool: 'write', arguments: { file_path: '/etc/hosts', content: 'y'.repeat(100) }, justification: 'x',
    }))
    assert.ok(write.startsWith('file_path: /etc/hosts' + String.fromCharCode(10)))
    // 判据收紧到「恰好这三个键」：多一个键的普通工具不拆（宁可多列几行，也不猜错对象）
    const other = api.__test.approvalDetailText(JSON.stringify({ tool: 'x', arguments: { a: 1 }, extra: 'keep' }))
    assert.match(other, /arguments\.a: 1/)
    assert.match(other, /tool: x/)
    // 三个包装键**都在**、但还多第四个键时同样不拆：长度判据不是摆设（只查 indexOf 时
    // `{tool, arguments, justification, extra}` 会被误当包装层，`extra` 这一条参数就看不见了）
    const four = api.__test.approvalDetailText(JSON.stringify({
      tool: 'write', arguments: { file_path: '/etc/hosts' }, justification: '模型理由', extra: 'keep-me',
    }))
    assert.match(four, /arguments\.file_path: \/etc\/hosts/, '不许拆包装层')
    assert.match(four, /tool: write/)
    assert.match(four, /extra: keep-me/)
  })

  it('「自动判定」那一行按事件行拼：关键词带命中词、审核表带等级、复核框不写', () => {
    const { verdictLineFromEvent } = api.__test
    assert.equal(
      verdictLineFromEvent(t, { path: 'keyword-human', keyword: 'NEEDS-HUMAN-TOKEN' }),
      '自动判定：关键词转人工（NEEDS-HUMAN-TOKEN）',
    )
    assert.equal(verdictLineFromEvent(t, { path: 'criteria-human', level: 'medium' }), '自动判定：审核表转人工 · medium')
    // 等级也可能只在 `judge.level` 里（自动判定那几条行就是这么存的）——两种形状都要认
    assert.equal(
      verdictLineFromEvent(t, { path: 'criteria-human', judge: { level: 'medium' } }),
      '自动判定：审核表转人工 · medium',
      '宿主把等级存在 judge 里时也要读得到',
    )
    // **判定压根没跑成**时宿主走的仍是 criteria-human：只按 path 出标签会显示成
    // 「审核表转人工」，人就不知道模型其实一个字都没答（与宿主 JUDGE_FAILURE_SRCS 同口径）。
    for (const src of ['empty', 'timeout', 'call', 'route', 'plugin']) {
      assert.equal(
        verdictLineFromEvent(t, { path: 'criteria-human', src, level: 'high' }),
        '自动判定：判定失败转人工',
        `src=${src} 要显示成判定失败`,
      )
    }
    assert.equal(verdictLineFromEvent(t, { path: 'judge-failed' }), '自动判定：判定失败转人工')
    assert.equal(verdictLineFromEvent(t, { path: 'truncated-payload' }), '自动判定：内容超过送审上限')
    // 复核框：标题已说明是模型求的复核，再写一行就是自指噪声
    assert.equal(verdictLineFromEvent(t, { path: 'human-review' }), '')
    assert.equal(verdictLineFromEvent(t, null), '')
    assert.equal(verdictLineFromEvent(t, {}), '')
    // 英文语言包同样有键
    const tEn = (key, params) => {
      const tpl = en[key]
      if (tpl === undefined) return key
      return String(tpl).replace(/\{(\w+)\}/g, (m, name) => (params && params[name] !== undefined ? String(params[name]) : m))
    }
    assert.equal(verdictLineFromEvent(tEn, { path: 'criteria-human', level: 'medium' }), 'Machine verdict: Criteria → human · medium')
  })

  it('组件渲染不炸：详情行取会话里那次调用的参数，查不到就整块不渲染', () => {
    // 只做「能渲染出来」的冒烟：React 替身 + 假 useChat。真正的取数（按 callId 查事件）
    // 在浏览器里跑，这里盯的是结构——组件一炸，审批框就没了（比少一行严重得多）。
    const stub = definition.factory(() => ({
      createElement: (tag, props, ...kids) => ({ tag, props: props || {}, kids }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
    }))
    const { ApprovalDetail } = stub.__test
    const shown = ApprovalDetail({
      slotsProps: { callId: 'call-x', useChat: () => 'file_path: /etc/hosts' },
      t,
      rpc: null,
    })
    assert.ok(shown, '有内容时要渲染')
    assert.match(JSON.stringify(shown), /file_path: \/etc\/hosts/)
    // 那次调用找不到（useChat 返回 null）且没有判决 → 整块不渲染，审批框照常
    assert.equal(ApprovalDetail({ slotsProps: { callId: 'call-x', useChat: () => null }, t, rpc: null }), null)
  })

  it('「自动判定」的取数接线真的会跑：带会话作用域查一次、并写进缓存', async () => {
    // 只测「结构不炸」是不够的：上一版冒烟用 `useEffect: () => {}` + `rpc: null`，
    // 于是 `rpc('events', {sessionId, callId})` → 缓存 → setVerdict 整段从不执行，
    // 参数写错、promise 分支写错、缓存键写错都不会被发现（而那正是这行字静默消失的方式）。
    const stub = definition.factory(() => ({
      createElement: (tag, props, ...kids) => ({ tag, props: props || {}, kids }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: (fn) => { fn() },            // 同步跑，等价于首帧后立即执行
      useRef: () => ({ current: null }),
    }))
    const { ApprovalDetail } = stub.__test
    const calls = []
    const rpc = (endpoint, payload) => {
      calls.push([endpoint, payload])
      return Promise.resolve({ events: [{ path: 'criteria-human', level: 'medium', callId: 'call-wire-1' }] })
    }
    const props = (sessionId, callId) => ({
      slotsProps: { callId, sessionId, useChat: () => 'rm -rf /tmp/x' },
      t,
      rpc,
    })
    ApprovalDetail(props('sess-wire-a', 'call-wire-1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, [['events', { sessionId: 'sess-wire-a', callId: 'call-wire-1' }]], '按会话 + callId 查一次')
    // 第二次渲染应当从缓存里拿到那一行（不再发查询）
    const rendered = JSON.stringify(ApprovalDetail(props('sess-wire-a', 'call-wire-1')))
    assert.match(rendered, /自动判定：审核表转人工 · medium/)
    assert.equal(calls.length, 1, '同一会话同一调用只查一次（缓存生效）')
    // 缓存键必须带会话：同一个 callId 在另一个会话里是**另一个**调用，要重新查
    ApprovalDetail(props('sess-wire-b', 'call-wire-1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.length, 2, '不同会话的同名 callId 不能共用缓存（否则会显示别人的判决）')
    assert.deepEqual(calls[1], ['events', { sessionId: 'sess-wire-b', callId: 'call-wire-1' }])
  })

  it('解析不出对象就返回 null（渲染不出来就不渲染，别抛进别人的 UI）', () => {
    const { approvalDetailText } = api.__test
    assert.equal(approvalDetailText('{oops'), null)
    assert.equal(approvalDetailText('[1,2]'), null)
    assert.equal(approvalDetailText('{}'), null)
    assert.equal(approvalDetailText(undefined), null)
    // 模型自己的说辞不是操作本体：与宿主侧卡片同一口径排除
    assert.equal(approvalDetailText(JSON.stringify({ justification: 'very important' })), null)
  })
})

describe('详情行与宿主对拍（第 2 轮 review）', () => {
  it('前 4 个参数与宿主 formatReviewOperation 选中同一批（键序两桶规则）', async () => {
    // 客户端按自己的优先表排序时，`{content:{x:1}, description, code, url, sql}` 这种调用
    // 会选出 `content.x` 而宿主选 `description`——人看到的「操作」与卡片不是同一批参数。
    const { formatReviewOperation } = await import('../src/rules.mjs')
    const { approvalDetailText } = api.__test
    const cases = [
      { content: { x: 1 }, description: 'D', code: 'C', url: 'U', sql: 'S', file_path: '/p' },
      { query: { filter: { term: 't' } }, file_path: '/x', content: 'body' },
      { a: 1, b: 2, c: 3, d: 4, e: 5 },
    ]
    for (const args of cases) {
      const host = formatReviewOperation(args, 'zh').split(' · ')
      const client = approvalDetailText(JSON.stringify(args)).split('\n')
      const take = (rows) => rows.slice(0, 4).map((r) => r.split(':')[0])
      assert.deepEqual(take(client), take(host), JSON.stringify(args))
    }
  })

  it('与宿主逐字对拍（300 组随机嵌套参数，含命令位与披露段）', async () => {
    // 手动挑的例子总会漏：第 4 轮我用 2 万组随机输入对拍才发现三处漂移（数字/布尔 command、
    // 披露只列顶层标量、值裁剪与行尾空白）。这条用例把对拍固化下来（确定性 PRNG，跑得快）。
    const { formatReviewOperation, TOOL_ARG_KEYS } = await import('../src/rules.mjs')
    const vals = ['', 'x', 'a'.repeat(120), '/p', 'cmd | sh', '😀', 'zh中文']
    let seed = 20240916
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const pick = (a) => a[Math.floor(next() * a.length)]
    const randObj = (depth) => {
      const o = {}
      for (let i = 0, n = 1 + Math.floor(next() * 5); i < n; i++) {
        const key = next() < 0.55 ? pick(TOOL_ARG_KEYS) : pick(['zz', 'aa', 'params', 'query'])
        if (next() < 0.25 && depth < 2) o[key] = randObj(depth + 1)
        else if (next() < 0.15) o[key] = next() < 0.5 ? 42 : true
        else o[key] = pick(vals)
      }
      return o
    }
    // 显式补几组「命令本身就很长 + 非默认预算」的输入：随机值域里最长 120 字、且默认 limit=600 时
    // `0.6*600`/`0.2*600` 都是整数，`Math.round` 与 `Math.floor` 恰好一致——抓不到那处取整差异
    //（第 6 轮验证性复审：1017/20000 组分歧全是它，只在预算不是 5 的倍数时显形）。
    for (const max of [601, 503, 301]) {
      for (const args of [
        // 只有一条长命令（没有其它参数）→ 走的是 `clipped()` 那条路（有其它参数时走披露分支，
        // 那条分支本来就是 Math.floor，抓不到这里的取整差异）。
        { command: 'a'.repeat(700) },
        { command: 'a'.repeat(700), p1: 'x', p2: 'y' },
        { command: 'a'.repeat(200), x: '1', y: '2', z: '3', w: '4', v: '5', u: '6', t: '7' },
      ]) {
        assert.equal(
          api.__test.approvalDetailText(JSON.stringify(args), max),
          formatReviewOperation(args, 'zh', max).replace(/ · /g, '\n'),
          JSON.stringify(args).slice(0, 40) + ' @max=' + max,
        )
      }
    }
    let checked = 0
    for (let i = 0; i < 300; i++) {
      const args = randObj(0)
      if (!Object.keys(args).length) continue
      checked++
      const host = formatReviewOperation(args, 'zh').replace(/ · /g, '\n')
      const client = api.__test.approvalDetailText(JSON.stringify(args)) || ''
      assert.equal(client, host, JSON.stringify(args))
    }
    assert.ok(checked > 250, '要真的比过 250 组以上：' + checked)
  })

  it('扁平宽对象也要撞 500 叶上限并写出 detail.leafCut（不许静默报个假总数）', () => {
    const wide = {}
    for (let i = 0; i < 50000; i++) wide['k' + i] = 'v' + i
    const out = api.__test.approvalDetailText(JSON.stringify(wide))
    assert.match(out, /（参数过多，未全部展开）$/, '撞上限必须写出来')
    assert.match(out, /（共 500 个参数，仅列前 4 个）/, '总数按实际上限报，不许报 50000')
  })

  it('字面键与嵌套键撞车时带 #2 后缀（与宿主投影同一个约定）', () => {
    const out = api.__test.approvalDetailText(JSON.stringify({ 'a.b': 'LITERAL', a: { b: 'NESTED' } }))
    assert.match(out, /a\.b: LITERAL/)
    assert.match(out, /a\.b#2: NESTED/)
  })

  it('键序表与宿主 TOOL_ARG_KEYS 逐项同序（单侧调序要红）', async () => {
    const { TOOL_ARG_KEYS } = await import('../src/rules.mjs')
    assert.deepEqual(api.__test.DETAIL_KEY_ORDER, TOOL_ARG_KEYS, '两处不能 import，只能靠这条守卫钉住同序')
  })

  it('失败 src 集合与宿主 JUDGE_FAILURE_SRCS 一致（新增一个 src 也要有标签）', async () => {
    const { JUDGE_FAILURE_SRCS } = await import('../src/rules.mjs')
    for (const src of JUDGE_FAILURE_SRCS) {
      assert.equal(
        api.__test.verdictLineFromEvent(t, { path: 'criteria-human', src, level: 'high' }),
        '自动判定：判定失败转人工',
        src,
      )
    }
    // 非失败 src 仍按审核表出标签（别把正常判定也吞成「判定失败」）
    assert.equal(
      api.__test.verdictLineFromEvent(t, { path: 'criteria-human', src: 'strict', level: 'high' }),
      '自动判定：审核表转人工 · high',
    )
  })

  it('无命令 + 参数表超预算时两侧仍逐字一致（裁的必须是同一份字符串）', async () => {
    // 宿主用 ` · `（3 字符）连接、客户端用换行（1 字符）：各自先连接再裁会让同一份参数在
    // 原生详情行与复核框里显示**不同的尾巴**，`共 N 字` 也差 `2×(行数-1)`（第 7 轮验证复审报的 B1）。
    // 现有随机对拍的输入从没在无命令分支超预算，所以这条约定此前零覆盖。
    const { formatReviewOperation } = await import('../src/rules.mjs')
    const args = {}
    for (let i = 0; i < 4; i++) args['k'.repeat(70) + i] = 'v'.repeat(80)
    const host = formatReviewOperation(args, 'zh')
    const client = api.__test.approvalDetailText(JSON.stringify(args))
    assert.ok(host.length <= 600, `宿主 ${host.length}`)
    assert.ok(client.length <= 600, `客户端 ${client.length}`)
    assert.match(host, /共 \d+ 字/)
    assert.equal(host, client.split('\n').join(' · '), '除分隔符外逐字一致')
    // 没超预算时不带截断标记
    const small = formatReviewOperation({ file_path: '/etc/hosts', content: 'x' }, 'zh')
    assert.doesNotMatch(small, /共 \d+ 字/)
  })

  it('空/纯空白 command 不许把详情行整行抹掉（原生框里人什么都看不到）', () => {
    // 槽位 priority -10 遮蔽了 DSH 自带那一行：详情行返回空串时人什么都看不到。
    // 空 command 此前被「嵌套命令提升」当成命令 → `clipped('')` → 空串。
    assert.match(api.__test.approvalDetailText(JSON.stringify({ command: '' })), /^command:$/m)
    const two = api.__test.approvalDetailText(JSON.stringify({ command: '', description: 'd' }))
    assert.match(two, /^command:$/m)
    assert.match(two, /description: d/)
    const blank = api.__test.approvalDetailText(JSON.stringify({ command: '   ', file_path: '/x' }))
    assert.match(blank, /^command:$/m)
    assert.match(blank, /file_path: \/x/)
    // 真命令照旧优先
    assert.equal(
      api.__test.approvalDetailText(JSON.stringify({ command: 'rm -rf /x', description: 'd' })),
      'rm -rf /x（另有 1 个参数：description: d）',
      '只印命令时人看不见其余字段，而凭证按完整投影签发',
    )
    // 多个嵌套命令时取**键名最小**的那个（与宿主 `...endsWith('.command')).sort()[0]` 同序）
    const multi = api.__test.approvalDetailText(JSON.stringify({ b: { command: 'B' }, a: { command: 'A' } }))
    // 取键名最小的（`a.command`），其余叶子照旧披露——与宿主同一份文本
    assert.equal(multi, 'A（另有 1 个参数：b.command: B）')
  })

  it('顶层有命令位（含空串/纯空白）时不提升嵌套 command —— 与宿主逐字一致', async () => {
    // 变异：`mayPromoteNested` 恒 true 时全套用例原本全绿（第 5 轮验证性复审抓到）。
    const { formatReviewOperation } = await import('../src/rules.mjs')
    for (const args of [{ command: '', script: { command: '325' } }, { command: '   ', script: { command: '325' } }]) {
      const host = formatReviewOperation(args, 'zh').replace(/ · /g, '\n')
      const client = api.__test.approvalDetailText(JSON.stringify(args))
      assert.match(host, /script\.command: 325/, JSON.stringify(args))
      assert.match(client, /script\.command: 325/, JSON.stringify(args))
      assert.equal(client, host, JSON.stringify(args))
    }
    // 顶层没有命令位时照旧提升（MCP 的 params.command）
    assert.match(api.__test.approvalDetailText(JSON.stringify({ params: { command: 'ls -la' } })), /^ls -la/)
  })

  it('数字/布尔 command 与宿主同口径（宿主投影标量转文本后进命令位）', async () => {
    // 宿主 `pickToolArgsDetailed` 把 `{command:true}` 收成 `"true"` → 走命令位；客户端拿的是
    // **原始**参数，此前只认字符串 → 一边显示命令、另一边显示参数表（实测 2 万组里 470 组不一致）。
    const { formatReviewOperation } = await import('../src/rules.mjs')
    for (const args of [{ command: true }, { command: 42 }, { command: false }, { command: 0 }]) {
      const host = formatReviewOperation(args, 'zh')
      const client = api.__test.approvalDetailText(JSON.stringify(args))
      assert.equal(client, host, JSON.stringify(args))
    }
    // 非有限数字与对象不进命令位（宿主 `scalarToText` 对它们返回空）
    assert.match(api.__test.approvalDetailText(JSON.stringify({ command: { a: 1 } })), /command\.a: 1/)
  })

  it('长命令也不许把「另有 N 个参数」披露挤出上限（详情行是唯一展示位）', async () => {
    const { formatReviewOperation } = await import('../src/rules.mjs')
    for (const n of [30, 560, 595, 700, 1200]) {
      const args = { command: 'c'.repeat(n), file_path: '/etc/shadow', content: 'SECRET' }
      const cli = api.__test.approvalDetailText(JSON.stringify(args))
      assert.ok(cli.length <= 600, `${n} 字命令 → ${cli.length} 字`)
      assert.match(cli, /另有 2 个参数/, `${n} 字命令`)
      assert.equal(cli, formatReviewOperation(args, 'zh'), `${n} 字命令：两侧逐字一致`)
    }
  })

  it('嵌套命令为纯空白时同样不许把详情行抹成空串；中文键 JSON 仍按结构化走', () => {
    const blankNested = api.__test.approvalDetailText(JSON.stringify({ params: { command: '   ' } }))
    assert.match(blankNested, /^params\.command:$/m, '嵌套空命令要落回参数表')
    // `__proto__` 与宿主投影同名（宿主 keep() 改名成 __proto__#raw）
    // 用 JSON.parse 造**自有** `__proto__`（对象字面量的 `__proto__:` 是设原型，不是键）
    const proto = api.__test.approvalDetailText('{"__proto__":"P","file_path":"/p"}')
    assert.match(proto, /__proto__#raw: P/)
    assert.match(proto, /file_path: \/p/)
  })

  it('中文键的行内 JSON 也算结构化输出（自定义表 + fallback=low 下不许被理由里的词放行）', async () => {
    const { parseJudgeClassify, lookupCriteria, resolveCriterionAction } = await import('../src/rules.mjs')
    const rows = [
      { id: 'safe', description: 'safe', actions: { low: 'allow', medium: 'allow', high: 'allow' } },
      { id: 'other', description: 'other', actions: { low: 'reject', medium: 'reject', high: 'reject' } },
    ]
    const levels = { fallback: 'low', descriptions: { low: '', medium: '', high: '' } }
    const got = parseJudgeClassify('分析如下：{"类别":"safe","理由":"常规改动"}', rows, levels)
    const act = resolveCriterionAction(lookupCriteria(rows, got.criterion), got.level, levels)
    assert.notEqual(act.action, 'allow', '结构化输出 + 会放行的行必须被模糊扫描跳过')
  })

  it('顶层有命令位（哪怕为空）时不许提升嵌套命令——与宿主逐字一致', async () => {
    // 宿主只按投影里那个 `command` 键取值（`{command:''}` 是空串 → 落参数表），客户端继续
    // 全树搜 `*.command` 会把详情行压成「325」并挤掉其它参数。变异（`mayPromoteNested = true`）
    // 此前全绿 —— 这条用例把它钉住。
    const { formatReviewOperation } = await import('../src/rules.mjs')
    const args = { command: '', script: { command: '325' }, workdir: 'a' }
    const host = formatReviewOperation(args, 'zh')
    const client = api.__test.approvalDetailText(JSON.stringify(args))
    // 两侧都落**参数表**：嵌套的 `script.command` 是表里的一行，不许被提升成「唯一的操作」
    assert.match(host, /^command: /, '宿主落参数表')
    // 客户端每行会去掉行尾空白（空值就印成 `command:`，不带到换行分隔里）
    assert.match(client, /^command:/, '客户端也必须是参数表的第一行')
    assert.match(client, /workdir: a/)
    assert.match(client, /script\.command: 325/)
    assert.notEqual(client, '325')
    // 顶层**没有**命令位时照旧提升嵌套命令（MCP 习惯）
    assert.equal(api.__test.approvalDetailText(JSON.stringify({ params: { command: 'ls -la' } })), 'ls -la')
  })

  it('说明框必须随快照换 key 重挂（否则恢复默认后 blur 会把旧文案写回）', () => {
    // 非受控 `defaultValue` 的 textarea 在 React 复用同一实例时不会跟随新 props：恢复默认后
    // 一失焦就把**旧文案**写回（用户以为恢复了默认，磁盘上还是老说明）。AGENTS 明写这条规则，
    // 但第 10 轮测试套件审计发现 443 条用例里**零命中**，删掉 key 三处变异全部 SURVIVED。
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.ok(src.includes("key: c.id + ':desc:' + (c.description || '')"), '审核表说明框缺少 :desc: 重挂 key')
    assert.ok(src.includes("key: level + ':desc:' + text"), '等级说明框缺少 :desc: 重挂 key')
    assert.equal((src.match(/:desc:/g) || []).length >= 2, true, '两处非受控说明框都要有')
  })

  it('空 verdict 的标签为空串（拒绝分支的「已拒绝」兜底才不是死代码）', () => {
    // 第 9 轮真实 DOM 走查：`verdictLabel` 对空 verdict 返回「自动放行」，于是两个**拒绝分支**里
    // 的 `|| t('notice.rejectedDefault')` 永远走不到——一条没有 verdict 的自动拒绝行会按「已拒绝」
    // 渲染（红底 ✕、标题「已拒绝：…」）却挂着「自动放行」的标签。
    assert.equal(api.__test.verdictLabel(t, ''), '', '空 verdict 交给调用点兜底')
    assert.equal(api.__test.verdictLabel(t, undefined), '')
    assert.equal(api.__test.verdictLabel(t, 'criteria-reject'), '审核表拒绝')
    assert.equal(api.__test.verdictLabel(t, 'criteria-human'), '审核表转人工')
    // 四个调用点都必须保留自己的默认词（源码级守卫：删掉任何一个 `||` 就会退回「自动放行」）
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    for (const fallback of ["|| t('notice.rejectedDefault')", "|| t('notice.autoDefault')", "|| t('history.tagAuto')"]) {
      assert.ok(src.includes(fallback), '缺少兜底：' + fallback)
    }
    assert.equal((src.match(/\|\| t\('notice\.rejectedDefault'\)/g) || []).length >= 2, true, '通知条与历史行各要有一处')
  })

  it('关键词编辑的「跳过 blur」标记在进入下一次编辑时清零', () => {
    // Escape 取消后浏览器不保证发 blur，残留的 true 会把下一次编辑的 blur 静默吞掉。
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    // 取**最后一次**出现：第一次在 onBlur 里（那才是「跳过这一次」的正常用法），
    // 进入编辑那一步的清零在按钮的 onClick 里。
    const at = src.lastIndexOf('kwSkipBlurRef.current = false')
    assert.ok(at > 0, '找不到清零那一行')
    const nextEdit = src.indexOf('setKwEdit(editKey)', at)
    assert.ok(nextEdit > at && nextEdit - at < 120, '清零必须紧挨着「进入编辑」那一步')
  })

  it('characterData 分支要沿祖先找菜单项/触发器（文案在 span 里）', () => {
    // DSH 的菜单项是 `<button role=menuitem><span>文案</span></button>`：React 原地改文案时
    // 只有 characterData，只扫 `parentNode`（span）会漏掉真正的 menuitem → 徽标摘不掉。
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const at = src.indexOf("rec.type === 'characterData'")
    assert.ok(at > 0)
    // 断言必须落在**这一段分支体内**：窗口开大时会匹配到紧邻的 childList 分支里那句同名
    // closest（实测 600 字符窗口就够到下一段），等于把「两条分支一起删」才变红。
    const nextBranch = src.indexOf('rec.type ===', at + 10)
    const seg = src.slice(at, nextBranch > at ? nextBranch : at + 800)
    assert.match(seg, /closest\('button\[aria-label\], \[role="menuitem"\]'\)/)
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

  it('接管原生审批框详情行：注册在 conversation.approval.detail 且 priority 为负', () => {
    // 槽位是 single：同 priority 会抛「already has a registration」，换 priority 才遮蔽，
    // 渲染的是 priority 最低的那个。ui-chat 用默认 0，所以我们必须用负值——写成 0 或正数
    // 会让注册直接抛错（或被它遮住，等于白做）。
    assert.match(src, /slots\.inject\('conversation\.approval\.detail'/)
    assert.match(src, /name: 'conversation\.approval\.detail', priority: -\d+/)
    // 多行参数表要在网页上真的换行：补的这条 CSS 不能丢
    assert.match(src, /\.ab-approval-detail\{white-space:pre-line\}/)
  })

  it('思考强度下拉不留重复的「不表态」选项：只留「模型默认」，目录里的 off 也要过滤', () => {
    // `off` 与「模型默认」在适配层是同一个请求（都不发档位），列两个等价项只会让人以为有区别；
    // 而且 `off` 会走「档位必须在路由档位表里」那条校验——路由没列它时每次判定都以路由失败告终
    // （宿主侧 `mergePluginConfig` 现在把历史拼写 off 归一成空，这里盯住 UI 不再提供它）。
    // 只看**档位下拉那一段**（`模型默认` 选项 → 目录档位映射之间）：别处还有「模型转人工」的
    // 开/关下拉，它用 `value: 'off'` 是另一回事，不能一起误判。
    // 起点往前挪一点：`{ value: '', key: '' }` 在 `t('set.modelDefaultEffort')` 之前
    const at = Math.max(0, src.indexOf("t('set.modelDefaultEffort')") - 200)
    const end = src.indexOf('efforts.filter', at)
    assert.ok(at > 0 && end > at, '档位下拉还在')
    assert.doesNotMatch(src.slice(at, end), /value: 'off'/, '档位下拉里不许再有 off 选项')
    assert.match(src.slice(at, end), /value: '', key: ''/, '只留一个「模型默认」（空值 = 不表态）')
    assert.match(src, /e\.id !== 'off'/, '路由把 off 列进档位表时也不能冒出来')
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

describe('设置页的结构性硬约束（源码级，逐条对应一次实测缺陷）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  it('动作下拉顺序固定 拒绝 > 人工 > 允许（与管道优先级一致）', () => {
    const fn = src.slice(src.indexOf('function actionOptions'), src.indexOf('function actionOptions') + 400)
    assert.ok(fn.length > 100, '找不到 actionOptions')
    const order = ["'reject'", "'human'", "'allow'"].map((v) => fn.indexOf(v))
    assert.ok(order[0] > 0 && order[1] > order[0] && order[2] > order[1], '顺序必须是 拒绝 > 人工 > 允许')
  })

  it('折叠卡片的 summary 里只放 phrasing content（span，不是 div/p）', () => {
    // `<summary><div>` 是无效 HTML：浏览器会把 div 甩到 summary 外面，折叠标题结构就乱了。
    const summaries = src.split("createElement('summary'")
    assert.ok(summaries.length >= 4, '找不到 summary 构造点')
    for (let i = 1; i < summaries.length; i++) {
      const seg = summaries[i].slice(0, 700)
      // summary 的子树里不许出现 div/p：span / 文本 / 图标都行
      const until = seg.indexOf("createElement('div', { className: 'ab-set-fold-body'")
      const head = until > 0 ? seg.slice(0, until) : seg
      assert.equal(/createElement\('(?:div|p)'/.test(head), false, `第 ${i} 个 summary 里出现了 div/p`)
      assert.match(head, /createElement\('span', \{ className: 'ab-set-card-head'/)
    }
  })

  it('关键词文本是 button（键盘可达），不是 span onClick', () => {
    assert.match(src, /createElement\('button', \{\s*type: 'button',\s*className: 'ab-set-kw-text'/)
    assert.equal(/createElement\('span', \{[^}]*onClick/.test(src), false, 'span + onClick 键盘完全不可达')
  })

  it('接管 conversation.approval.detail 的注册包在 try/catch 里，失败只 warn', () => {
    // 这是越权动作：DSH 将来也用 -10 时抛错，会顺着 slot reconcile 把设置页/提示条/盾牌
    // 一起带走。失败必须降级成「退回 DSH 自带渲染」。
    const at = src.indexOf("slots.inject('conversation.approval.detail'")
    assert.ok(at > 0)
    const around = src.slice(Math.max(0, at - 100), at + 900)
    assert.match(around, /try \{/)
    assert.match(around, /catch/)
    assert.match(around, /console\.warn/)
  })

  it('每个动作下拉/数字输入都有可访问名（aria-label 或 label for）', () => {
    // 下拉、等级三格、送审上限这类没有可见 label 的控件必须自带 aria-label。
    for (const needle of [
      "className: 'ab-set-select', value: row.action",
      "className: 'ab-set-select', value: newKeywordAction",
      "value: cfg.truncatedAction || 'human',",
    ]) {
      const at = src.indexOf(needle)
      assert.ok(at > 0, needle)
      const seg = src.slice(at, at + 400)
      assert.match(seg, /'aria-label'/, needle + ' 缺可访问名')
    }
  })

  it('快照播种按 reseed 分流：judge 只播审核设置、human 只播转人工、all 才全播', () => {
    // 这条分流就是「点一下模型转人工下拉，未保存的提示词草稿被冲掉」那个实测缺陷的修复：
    // 任何写入都不得顺手重播另一张卡片的本地编辑态。
    const at = src.indexOf("const reseed = (opts && opts.reseed) || 'none'")
    assert.ok(at > 0)
    const seg = src.slice(at, at + 400)
    assert.match(seg, /reseed === 'all' \|\| reseed === 'judge'/)
    assert.match(seg, /reseed === 'all' \|\| reseed === 'human'/)
    assert.match(seg, /if \(reseed === 'all'\) seedSandbox\(data\)/)
    // judge 分支不得顺手播 human/sandbox，human 分支不得播 judge
    assert.equal(/reseed === 'judge'\) seedHumanReview/.test(seg), false)
    assert.equal(/reseed === 'human'\) seedJudge/.test(seg), false)
  })
})
