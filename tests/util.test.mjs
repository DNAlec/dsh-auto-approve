import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, chmodSync } from 'node:fs'
import { pathsFor, tryLoadJson, loadJson, appendEvent, appendLine, writeAtomic, trimEventsFile, readEventsSince } from '../src/util.mjs'

describe('pathsFor', () => {
  it('插件配置在 auto-approve，旧路径仅作迁移源', () => {
    const p = pathsFor('dsh-home')
    assert.equal(p.pluginConfig, join('dsh-home', 'auto-approve', 'config.json'))
    assert.equal(p.legacyPluginConfig, join('dsh-home', 'approval-bridge', 'config.json'))
    assert.equal(p.allowlist, join('dsh-home', 'auto-approve', 'allowlist.json'))
    assert.equal('qqbot' in p, false)
  })
})

describe('tryLoadJson', () => {
  it('缺失 ok、损坏不抛且不改文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-json-'))
    const missing = join(dir, 'nope.json')
    const miss = tryLoadJson(missing)
    assert.equal(miss.ok, true)
    assert.equal(miss.missing, true)
    assert.equal(loadJson(missing, { fallback: 1 }).fallback, 1)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not-json', 'utf8')
    const loaded = tryLoadJson(bad)
    assert.equal(loaded.ok, false)
    assert.equal(readFileSync(bad, 'utf8'), '{not-json')
    assert.deepEqual(loadJson(bad, { x: 1 }), { x: 1 })
    // 合法 JSON 但**不是容器**（null / 字符串 / 数字）同样回落默认值：原样返回会让调用方
    // 把标量当成一份有效配置往下走（静默降级）。
    const scalar = join(dir, 'scalar.json')
    writeFileSync(scalar, 'null', 'utf8')
    assert.deepEqual(loadJson(scalar, { x: 2 }), { x: 2 })
    writeFileSync(scalar, '"text"', 'utf8')
    assert.deepEqual(loadJson(scalar, { x: 3 }), { x: 3 })
    // 数组同样是「合法 JSON 但不是配置」：`allowlist.json = []` / `config.json = []` 都按损坏处理
    writeFileSync(scalar, '[]', 'utf8')
    assert.deepEqual(loadJson(scalar, { x: 4 }), { x: 4 })
    assert.equal(tryLoadJson(scalar).ok, false, '[] 必须判损坏（调用方据此拒绝写盘）')
    assert.equal(readFileSync(bad, 'utf8'), '{not-json')
  })
})

describe('trimEventsFile', () => {
  it('超过体积时只留最后若干条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-'))
    const p = join(dir, 'events.jsonl')
    // 一条大记录把文件顶过 maxBytes；字节预算（500）装得下最近那几条小记录，
    // 于是真正生效的是**条数上限**（keep=3）。
    writeFileSync(p, JSON.stringify({ id: 0, sessionId: 's', blob: 'x'.repeat(2000) }) + '\n', 'utf8')
    for (let i = 1; i <= 6; i++) appendEvent(p, { id: i, sessionId: 's', verdict: 'auto' })
    assert.equal(trimEventsFile(p, 500, 3), true)
    const evs = readEventsSince(p, 's', 0)
    assert.deepEqual(evs.map((e) => e.id), [4, 5, 6])
  })
})

describe('trimEventsFile 的字节预算（第 6 轮生命周期复审）', () => {
  it('大记录只按条数裁时上限形同虚设：现在按字节保留，文件真的回到预算内', () => {
    // 单条记录由 `EVENT_ARGS_BUDGET`（6000 字符）决定，2000 条 ≈ 13MB：只按条数裁时
    // `maxBytes` 永远达不成，而 `appendEvent` 每次都调裁剪 → 每写一条事件就全量重写 ~13MB
    // （实测 ~68ms/条），自我维持。这里用 ~120KB 的记录把同一形状缩小验证。
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-bytes-'))
    const p = join(dir, 'events.jsonl')
    const big = 'x'.repeat(120 * 1024)
    const lines = []
    for (let i = 1; i <= 30; i++) lines.push(JSON.stringify({ id: i, sessionId: 's', args: { blob: big } }))
    writeFileSync(p, lines.join('\n') + '\n', 'utf8')
    const before = statSync(p).size
    assert.ok(before > 3 * 1024 * 1024, '前置：文件要真的超过预算：' + before)
    assert.equal(trimEventsFile(p, 1024 * 1024, 2000), true)
    const after = statSync(p).size
    assert.ok(after <= 1024 * 1024 + big.length + 64, '裁剪后必须回到预算量级：' + after)
    const ids = readEventsSince(p, 's', 0).map((e) => e.id)
    assert.equal(ids[ids.length - 1], 30, '最新一条必须留下（它是「刚才发生了什么」的现场）')
    assert.ok(ids.length >= 1 && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1), '保留的 id 连续：' + ids)
  })

  it('单条自己就超预算时仍保留它（至少留一条）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-one-'))
    const p = join(dir, 'events.jsonl')
    writeFileSync(p, JSON.stringify({ id: 1, sessionId: 's', args: { blob: 'y'.repeat(50 * 1024) } }) + '\n', 'utf8')
    assert.equal(trimEventsFile(p, 1024, 2000), true)
    assert.deepEqual(readEventsSince(p, 's', 0).map((e) => e.id), [1])
  })
})

describe('readEventsSince', () => {
  it('按会话过滤、按 since 边界增量，空 sessionId 返回全部', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev2-'))
    const p = join(dir, 'events.jsonl')
    appendEvent(p, { id: 1, sessionId: 'a', verdict: 'auto' })
    appendEvent(p, { id: 2, sessionId: 'b', verdict: 'auto' })
    appendEvent(p, { id: 3, sessionId: 'a', verdict: 'auto' })
    assert.deepEqual(readEventsSince(p, 'a', 0).map((e) => e.id), [1, 3])
    assert.deepEqual(readEventsSince(p, 'b', 0).map((e) => e.id), [2])
    // since 是「已见过的最大 id」，边界本身不重复返回
    assert.deepEqual(readEventsSince(p, 'a', 1).map((e) => e.id), [3])
    assert.deepEqual(readEventsSince(p, 'a', 3), [])
    assert.deepEqual(readEventsSince(p, '', 0).map((e) => e.id), [1, 2, 3])
  })

  it('损坏行与缺 id 记录被跳过，不影响其它事件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev3-'))
    const p = join(dir, 'events.jsonl')
    writeFileSync(p, [
      '{"id":1,"sessionId":"a"}',
      '{broken',
      '{"sessionId":"a"}',
      '{"id":2,"sessionId":"a"}',
      '',
    ].join('\n'), 'utf8')
    assert.deepEqual(readEventsSince(p, 'a', 0).map((e) => e.id), [1, 2])
  })
})

describe('legacy plugin config', () => {
  it('损坏的旧配置可读失败且不写盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-home-'))
    const bridge = join(home, 'approval-bridge')
    mkdirSync(bridge)
    const legacy = join(bridge, 'config.json')
    writeFileSync(legacy, '{broken', 'utf8')
    const loaded = tryLoadJson(legacy)
    assert.equal(loaded.ok, false)
    assert.equal(readFileSync(legacy, 'utf8'), '{broken')
  })
})

describe('trimEventsFile 不覆盖读不懂的内容（review 修复）', () => {
  it('一行都解析不出来时不写盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-bad-'))
    const p = join(dir, 'events.jsonl')
    const text = '{"noId":1}\n'.repeat(3000)
    writeFileSync(p, text, 'utf8')
    assert.equal(trimEventsFile(p, 1000, 2000), false)
    // 「没有可解析记录」不等于「文件里没东西」：这份审批历史是唯一副本，不能清空。
    assert.equal(readFileSync(p, 'utf8').length, text.length)
  })

  it('读不出来（路径是目录）时不写盘也不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-dir-'))
    const asDir = join(dir, 'events.jsonl')
    mkdirSync(asDir)
    assert.equal(trimEventsFile(asDir, 1, 10), false)
  })

  it('读不出来（stat 成功、read 失败）时不写盘也不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-perm-'))
    const p = join(dir, 'events.jsonl')
    const text = [1, 2, 3].map((i) => JSON.stringify({ id: i, sessionId: 's' })).join('\n') + '\n'
    writeFileSync(p, text, 'utf8')
    chmodSync(p, 0o000)
    const errors = []
    const orig = console.error
    console.error = (...args) => { errors.push(args.join(' ')) }
    try {
      assert.equal(trimEventsFile(p, 1, 1), false)
    } finally {
      console.error = orig
      chmodSync(p, 0o600)
    }
    // 「读不出来」要打日志：不然它与「0 条可解析记录」在外层看是同一个 `false`，
    // 少掉这条日志就分不清是权限问题还是文件坏了。
    assert.match(errors.join(' '), /读不出来/)
    assert.equal(readFileSync(p, 'utf8'), text, '文件必须逐字节不变')
  })

  it('可解析记录照旧被裁剪', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-ok-'))
    const p = join(dir, 'events.jsonl')
    for (let i = 1; i <= 6; i++) writeFileSync(p, '', { flag: 'a' })
    const big = JSON.stringify({ id: 0, sessionId: 's', blob: 'x'.repeat(2000) })
    const small = [1, 2, 3, 4, 5, 6].map((i) => JSON.stringify({ id: i, sessionId: 's' }))
    writeFileSync(p, [big, ...small].join('\n') + '\n', 'utf8')
    assert.equal(trimEventsFile(p, 500, 2), true)
    assert.deepEqual(readEventsSince(p, 's', 0).map((e) => e.id), [5, 6])
  })
})

describe('审计与原子写（review 修复）', () => {
  it('appendLine 失败要上报（返回 false + 打日志），但不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-append-'))
    const asDir = join(dir, 'audit.log')
    mkdirSync(asDir) // 目标是目录 → appendFileSync 必失败
    const errors = []
    const orig = console.error
    console.error = (...args) => { errors.push(args.join(' ')) }
    try {
      assert.equal(appendLine(asDir, 'x\n'), false)
    } finally {
      console.error = orig
    }
    assert.equal(errors.length > 0, true, '审计写失败必须留痕（它是三类兜底路径的唯一证据）')
    assert.match(errors.join(' '), /追加/)
  })

  it('writeAtomic 的 mode 参数生效：给了按它设权限，没给才收到 0600', () => {
    // 此前 rename 之后无条件 chmod 0600：`mode` 只在写临时文件时生效、随即被覆盖，
    // 传了等于没传（静默失效的 API）。现在显式 mode 说了算。
    const dir = mkdtempSync(join(tmpdir(), 'aa-util-mode-'))
    const def = join(dir, 'default.json')
    writeAtomic(def, '{}')
    assert.equal(statSync(def).mode & 0o777, 0o600, '默认仍是私有的（配置文件可能含密钥）')
    const open = join(dir, 'open.json')
    writeAtomic(open, '{}', 0o644)
    assert.equal(statSync(open).mode & 0o777, 0o644, '显式 mode 必须生效')
    const again = join(dir, 'again.json')
    writeAtomic(again, '{}')
    assert.equal(statSync(again).mode & 0o777, 0o600)
  })

  it('writeAtomic 失败时清理临时文件并抛出，目标文件保持原样', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-atomic-'))
    const target = join(dir, 'cordis.patch.yml')
    writeFileSync(target, 'original\n', 'utf8')
    // 让 rename 的目标变成目录 → 写失败
    const asDir = join(dir, 'blocked.yml')
    mkdirSync(asDir)
    assert.throws(() => writeAtomic(asDir, 'x'), /EISDIR|ENOTDIR|EPERM|EACCES|EEXIST|EISDIR/)
    assert.equal(readFileSync(target, 'utf8'), 'original\n')
    // 成功路径：不留 .tmp
    assert.equal(writeAtomic(target, 'next\n'), true)
    assert.equal(readFileSync(target, 'utf8'), 'next\n')
    assert.equal(existsSync(target + '.tmp'), false)
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
  })
})

describe('appendLine 的成功路径（漏改名会让它每次都假报失败）', () => {
  it('返回 true、行真的写进去、文件权限 0600', () => {
    // 这条用例对应一次真实缺陷：`chmodPrivate` 改名成 `chmodTo` 时漏改 appendLine 里那一处，
    // 于是每次审计写盘都抛 ReferenceError → 被 catch 吞掉、返回 false、日志里一堆「追加失败」，
    // 而内容其实已经写进去了（appendFileSync 在前）——**全量用例当时一条都不红**。
    const dir = mkdtempSync(join(tmpdir(), 'aa-util-audit-'))
    const path = join(dir, 'audit.log')
    assert.equal(appendLine(path, '[t] REJECT bash\n'), true, '成功路径必须返回 true')
    assert.match(readFileSync(path, 'utf8'), /REJECT bash/)
    assert.equal(statSync(path).mode & 0o777, 0o600, '审计里有命令片段，权限必须是 0600')
    assert.equal(appendLine(path, '[t] HUMAN bash\n'), true, '追加第二次同样成功')
    assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 2)
  })
})
