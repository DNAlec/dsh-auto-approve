import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAutoApprovePreset, getSetupState, migratePresetCopy, setAutoApproveSandbox, readAutoApproveSandbox } from '../src/preset-patch.mjs'

function tmpPatch(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-preset-'))
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, text, 'utf8')
  return path
}

describe('ensureAutoApprovePreset', () => {
  it('已有 auto-approve 则不动', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: workspace-write\n        approval: ask\n')
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'already')
    assert.equal(r.needRestart, false)
  })

  it('已有 permission 时插入 auto-approve', () => {
    const path = tmpPatch([
      '- id: webserver',
      '  config:',
      '    port: 3080',
      '- id: permission',
      '  name: \'@deepseek-ai/dsh-permission-presets\'',
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '      workspace-write:',
      '        sandbox: workspace-write',
      '        approval: ask',
      '',
    ].join('\n'))
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-preset')
    const text = readFileSync(path, 'utf8')
    assert.match(text, /auto-approve:/)
    assert.match(text, /name:\s*自动审批/)
    assert.equal(text.includes('Flash'), false)
  })

  it('没有 permission 条目时追加整块', () => {
    const path = tmpPatch('[]\n')
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    const text = readFileSync(path, 'utf8')
    assert.equal(text.trimStart().startsWith('[]'), false)
    assert.match(text, /^- id: permission/m)
    assert.match(text, /auto-approve:/)
  })
})

describe('getSetupState / migratePresetCopy', () => {
  it('检测到 auto-approve', () => {
    const path = tmpPatch('      auto-approve:\n        sandbox: workspace-write\n')
    assert.equal(getSetupState(path).configured, true)
  })

  it('把 Flash 显示名改成自动审批', () => {
    const path = tmpPatch('        name: 自动审批（Flash）\n        description: Flash 预判写入/命令是否不可回补：安全自动批准，有风险转人工审批。\n')
    migratePresetCopy(path)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /name: 自动审批/)
    assert.equal(text.includes('Flash'), false)
    assert.match(text, /审核模型预判/)
  })
})

describe('setAutoApproveSandbox', () => {
  it('把已有 auto-approve 的 sandbox 改成 read-only', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: workspace-write\n        approval: ask\n      workspace-write:\n        sandbox: workspace-write\n')
    const r = setAutoApproveSandbox(path, 'read-only')
    assert.equal(r.ok, true)
    assert.equal(r.needRestart, true)
    assert.equal(readAutoApproveSandbox(path), 'read-only')
    const text = readFileSync(path, 'utf8')
    assert.match(text, /auto-approve:\n\s+sandbox: read-only/)
    assert.match(text, /workspace-write:\n\s+sandbox: workspace-write/)
  })

  it('相同 sandbox 不写盘', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n        approval: ask\n')
    const r = setAutoApproveSandbox(path, 'read-only')
    assert.equal(r.status, 'unchanged')
    assert.equal(r.needRestart, false)
  })
})
