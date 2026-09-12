import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathsFor, tryLoadJson, loadJson, appendEvent, trimEventsFile, readEventsSince } from '../src/util.mjs'

describe('pathsFor', () => {
  it('插件配置在 auto-approve，旧路径仅作迁移源', () => {
    const p = pathsFor('/tmp/dsh-home')
    assert.equal(p.pluginConfig, join('/tmp/dsh-home', 'auto-approve', 'config.json'))
    assert.equal(p.legacyPluginConfig, join('/tmp/dsh-home', 'approval-bridge', 'config.json'))
    assert.equal(p.allowlist, join('/tmp/dsh-home', 'auto-approve', 'allowlist.json'))
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
