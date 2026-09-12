import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.mjs'
import { shippedRejectKeywords, DEFAULT_CRITERIA_ZH } from '../src/rules.mjs'
import { readAutoApproveSandbox } from '../src/preset-patch.mjs'

function createCtx() {
  const listeners = new Map()
  const ctx = {
    llm: {
      async resolveModelInfo() { throw new Error('unused') },
      async *stream() { throw new Error('unused') },
      listProviders() { return [] },
      async listModels() { return [] },
    },
    permissionPresets: { current() { return 'auto-approve' } },
    timeout(fn, ms) {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
    emit() {},
    get() { return undefined },
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
    },
    inject() {},
  }
  return ctx
}

describe('启动时损坏配置', () => {
  const homes = []
  let prevHome

  after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('损坏的 config.json 不改已有 read-only sandbox，也不覆盖磁盘', () => {
    prevHome = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'aa-corrupt-'))
    homes.push(home)
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const config = join(home, 'auto-approve', 'config.json')
    writeFileSync(patch, [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(config, '{not-json', 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readAutoApproveSandbox(patch), 'read-only')
    assert.equal(readFileSync(config, 'utf8'), '{not-json')
  })

  it('缺失 config.json 且已有 auto-approve 时不把 sandbox 改成默认 workspace-write', () => {
    prevHome = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'aa-missing-cfg-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    writeFileSync(patch, [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readAutoApproveSandbox(patch), 'read-only')
  })
})
