import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkAbortSignal, replaceRequestSignal, tryLoadJson, loadJson, appendEvent, trimEventsFile, readEventsSince } from '../src/util.mjs'

describe('forkAbortSignal', () => {
  it('父中止时子跟着中止，且带上 reason', () => {
    const parent = new AbortController()
    const forked = forkAbortSignal(parent.signal)
    assert.equal(forked.signal.aborted, false)
    parent.abort('turn-cancelled')
    assert.equal(forked.signal.aborted, true)
    assert.equal(forked.signal.reason, 'turn-cancelled')
  })

  it('abort() 只关子 signal，不碰父', () => {
    const parent = new AbortController()
    const forked = forkAbortSignal(parent.signal)
    forked.abort()
    assert.equal(forked.signal.aborted, true)
    assert.equal(parent.signal.aborted, false)
  })

  it('父已中止时立即中止子', () => {
    const parent = new AbortController()
    parent.abort('already')
    const forked = forkAbortSignal(parent.signal)
    assert.equal(forked.signal.aborted, true)
    assert.equal(forked.signal.reason, 'already')
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
    assert.equal(readFileSync(bad, 'utf8'), '{not-json')
  })
})

describe('trimEventsFile', () => {
  it('超过体积时只留最后若干条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-ev-'))
    const p = join(dir, 'events.jsonl')
    for (let i = 1; i <= 6; i++) appendEvent(p, { id: i, sessionId: 's', verdict: 'auto' })
    assert.equal(trimEventsFile(p, 10, 3), true)
    const evs = readEventsSince(p, 's', 0)
    assert.deepEqual(evs.map((e) => e.id), [4, 5, 6])
  })
})

describe('replaceRequestSignal', () => {
  it('替换可写 signal', () => {
    const req = { signal: new AbortController().signal }
    const next = new AbortController().signal
    assert.equal(replaceRequestSignal(req, next), true)
    assert.equal(req.signal, next)
  })
})
