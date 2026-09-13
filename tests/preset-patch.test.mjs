import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composePatchText,
  ensureAutoApprovePreset,
  extractPresetKeysFromPatchText,
  getSetupState,
  hasAutoApprovePreset,
  isPatchArrayEmpty,
  migratePresetCopy,
  presetDrift,
  readBasePresetKeys,
  setAutoApproveSandbox,
  readAutoApproveSandbox,
} from '../src/preset-patch.mjs'

function tmpPatch(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-preset-'))
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, text, 'utf8')
  return path
}

/** DSH 首次初始化 profile 时写的 patch 模板（`initProfile` → PROFILE_PATCH_TEMPLATE）。 */
const SHIPPED_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

/**
 * 结构校验：patch 是**一个**顶层 YAML 序列——注释/空行之外，
 * 不允许出现独立的 `[]`，且第一条有效行必须是条目。
 * `[]` 后面跟 `- id: …` 会让 DSH 的 parsePatchList 直接抛
 * 「failed to parse overlay」，profile 起不来。
 */
function assertSingleSequence(text) {
  const lines = text.split('\n')
  const meaningful = lines.filter((line) => {
    const t = line.trim()
    return t && !t.startsWith('#') && t !== '---' && t !== '...'
  })
  assert.ok(meaningful.length > 0, 'patch 不应为空')
  assert.ok(meaningful[0].startsWith('- '), '第一条有效行必须是顶层序列条目')
  for (const line of meaningful) {
    assert.ok(
      !/^\[\][ \t]*(#.*)?$/.test(line.trim()),
      '空数组字面量必须被替换掉，不能与条目并存',
    )
  }
  assert.match(text, /^- id: permission$/m, '必须含 permission 条目')
  assert.ok(text.endsWith('\n'), 'patch 应以换行结尾')
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

  it('没有 permission 条目时追加整块（裸 []）', () => {
    const path = tmpPatch('[]\n')
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    const text = readFileSync(path, 'utf8')
    assert.equal(text.trimStart().startsWith('[]'), false)
    assert.match(text, /^- id: permission/m)
    assert.match(text, /auto-approve:/)
    assertSingleSequence(text)
  })

  it('出厂模板（注释 + []）走替换而不是追加，产物是合法单序列', () => {
    const path = tmpPatch(SHIPPED_TEMPLATE)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    const text = readFileSync(path, 'utf8')
    assertSingleSequence(text)
    assert.match(text, /^# Your patch layer for this dsh profile/m, '注释应保留')
    assert.match(text, /auto-approve:\n\s+sandbox: workspace-write/)
  })

  it('只有注释、没有 [] 的空 patch 也能整段写入', () => {
    const path = tmpPatch('# 空的 patch\n\n')
    assert.equal(isPatchArrayEmpty(readFileSync(path, 'utf8')), true)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    assertSingleSequence(readFileSync(path, 'utf8'))
  })

  it('已有别的条目时只追加，不动原有内容', () => {
    const path = tmpPatch('- id: webserver\n  config:\n    port: 3080\n')
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    const text = readFileSync(path, 'utf8')
    assert.match(text, /^- id: webserver/m)
    assert.match(text, /^- id: permission/m)
    assertSingleSequence(text)
  })

  it('CRLF 的出厂模板同样可写', () => {
    const path = tmpPatch(SHIPPED_TEMPLATE.replace(/\n/g, '\r\n'))
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    assert.match(readFileSync(path, 'utf8'), /auto-approve:/)
  })

  it('注释里提过 auto-approve: 不算已配置', () => {
    const path = tmpPatch('# remember to enable auto-approve: preset later\n- id: webserver\n')
    assert.equal(hasAutoApprovePreset(readFileSync(path, 'utf8')), false)
    assert.equal(getSetupState(path).configured, false)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-entry')
    assert.equal(getSetupState(path).configured, true)
    assert.match(readFileSync(path, 'utf8'), /auto-approve:\n\s+sandbox: workspace-write/)
  })

  it('description 里提过 auto-approve: 也不算已配置', () => {
    const path = tmpPatch([
      '- id: other-plugin',
      '  config:',
      '    label: 见 auto-approve: 说明',
      '',
    ].join('\n'))
    assert.equal(getSetupState(path).configured, false)
  })

  it('块标量（description: |）里的同名行不算已配置', () => {
    const text = [
      '- id: other-plugin',
      '  config:',
      '    note: |',
      '      auto-approve:',
      '      enabled later',
      '',
    ].join('\n')
    assert.equal(hasAutoApprovePreset(text), false)
    const path = tmpPatch(text)
    assert.equal(getSetupState(path).configured, false)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    assertSingleSequence(readFileSync(path, 'utf8'))
  })

  it('真键仍在块标量头判断之外被识别', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    note: a >',
      '    presets:',
      '      auto-approve:',
      '        sandbox: workspace-write',
      '',
    ].join('\n')
    assert.equal(hasAutoApprovePreset(text), true)
  })

  it('带行尾注释的 [] 与文档标记也算空 patch', () => {
    for (const text of ['[] # empty\n', '---\n[]\n', '[]   \n']) {
      const path = tmpPatch(text)
      assert.equal(isPatchArrayEmpty(readFileSync(path, 'utf8')), true, JSON.stringify(text))
      assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
      assertSingleSequence(readFileSync(path, 'utf8'))
    }
  })

  it('insert 形式的 permission 行：插进它自己的 presets，不追加第二个 permission', () => {
    const path = tmpPatch([
      '- insert:',
      '    - id: permission',
      '      config:',
      '        presets:',
      '          read-only:',
      '            sandbox: read-only',
      '            approval: ask',
      '',
    ].join('\n'))
    const r = ensureAutoApprovePreset(path, 'workspace-write')
    assert.equal(r.status, 'added-preset')
    const text = readFileSync(path, 'utf8')
    assert.equal(text.match(/- id: permission/g).length, 1, '不能出现第二个 permission 行')
    assert.match(text, /^ {10}auto-approve:$/m, '缩进要落在 insert 形式下的 presets 子键层级')
    assert.match(text, /^ {12}sandbox: workspace-write$/m)
  })

  it('permission 行带行尾注释也能认出来', () => {
    const path = tmpPatch([
      '- id: permission  # ours',
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'))
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    assert.equal(readFileSync(path, 'utf8').match(/- id: permission/g).length, 1)
  })

  it('presets 下还没有子键时也能插入', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n')
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    assert.equal(readAutoApproveSandbox(path), 'workspace-write')
  })
})

describe('composePatchText', () => {
  it('空数组被替换、注释保留', () => {
    const out = composePatchText('# c\n[]\n', '- id: permission\n')
    assert.equal(out, '# c\n- id: permission\n')
  })

  it('非空 patch 追加且只留一个结尾换行', () => {
    const out = composePatchText('- id: webserver\n', '- id: permission\n')
    assert.equal(out, '- id: webserver\n- id: permission\n')
  })
})

describe('预设表漂移检测', () => {
  it('从 patch 文本抽 presets 直接子键（顶层与 insert 形式都行）', () => {
    const topLevel = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '      danger-full-access:',
      '        sandbox: danger-full-access',
      '',
    ].join('\n')
    assert.deepEqual(extractPresetKeysFromPatchText(topLevel), ['read-only', 'danger-full-access'])
    const inserted = [
      '- insert:',
      '    - id: permission',
      '      config:',
      '        presets:',
      '          read-only:',
      '            sandbox: read-only',
      '          auto-approve:',
      '            sandbox: workspace-write',
      '',
    ].join('\n')
    const keys = extractPresetKeysFromPatchText(inserted)
    assert.deepEqual(keys, ['read-only', 'auto-approve'])
    assert.equal(keys.includes('sandbox'), false, '子键的更深层键不能算预设')
    assert.equal(extractPresetKeysFromPatchText('- id: webserver\n'), null)
  })

  it('漂移只算「出厂有而本 profile 没有」的键', () => {
    assert.deepEqual(
      presetDrift(['read-only', 'sandbox-strict'], ['read-only', 'auto-approve']),
      { missing: ['sandbox-strict'], extra: ['auto-approve'] },
    )
    assert.deepEqual(presetDrift(null, null), { missing: [], extra: [] })
  })

  it('读不到出厂 base 时保持沉默（ok:false，不报警）', () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-base-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    assert.equal(readBasePresetKeys(join(home, 'profiles', 'web')).ok, false)
    assert.equal(readBasePresetKeys('').ok, false)
  })

  it('profile 与 profiles/node_modules 两处都能找到 base', () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-base2-'))
    const profile = join(home, 'profiles', 'web')
    const pkg = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(pkg, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-base', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
    writeFileSync(join(pkg, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: permission',
      '      config:',
      '        presets:',
      '          read-only:',
      '            sandbox: read-only',
      '          sandbox-strict:',
      '            sandbox: read-only',
      '',
    ].join('\n'))
    const base = readBasePresetKeys(profile)
    assert.equal(base.ok, true)
    assert.deepEqual(base.keys, ['read-only', 'sandbox-strict'])
  })

  it('getSetupState 带上本 profile 的 preset 键', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n        approval: ask\n')
    assert.deepEqual(getSetupState(path).presets, ['auto-approve'])
    assert.deepEqual(getSetupState(tmpPatch('[]\n')).presets, [])
  })
})

describe('getSetupState / migratePresetCopy', () => {
  it('检测到 auto-approve（必须挂在 permission 行的 presets 下）', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: workspace-write\n')
    assert.equal(getSetupState(path).configured, true)
  })

  it('别的插件 presets 下的同名键不算已配置', () => {
    const path = tmpPatch([
      '- id: other-plugin',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: workspace-write',
      '',
    ].join('\n'))
    assert.equal(getSetupState(path).configured, false)
    // 没有 permission 行时也应该装我们自己的预设
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    assert.match(readFileSync(path, 'utf8'), /^- id: permission$/m)
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

  it('词表外的 sandbox（danger-full-access）会被改写而不是静默放过', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: danger-full-access\n        approval: ask\n')
    assert.equal(readAutoApproveSandbox(path), 'danger-full-access')
    const r = setAutoApproveSandbox(path, 'read-only')
    assert.equal(r.ok, true)
    assert.equal(r.status, 'updated')
    assert.equal(r.needRestart, true)
    assert.equal(readAutoApproveSandbox(path), 'read-only')
  })

  it('块里没有 sandbox 行时返回错误，不假装成功', () => {
    const path = tmpPatch('- id: permission\n  config:\n    presets:\n      auto-approve:\n        approval: ask\n')
    const r = setAutoApproveSandbox(path, 'workspace-write')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.presetSandboxMissing')
    assert.equal(readAutoApproveSandbox(path), '')
  })

  it('只改 auto-approve 块里的 sandbox，不碰别的预设', () => {
    const path = tmpPatch([
      '- id: permission',
      '  config:',
      '    presets:',
      '      workspace-write:',
      '        sandbox: workspace-write',
      '        approval: ask',
      '      auto-approve:',
      '        sandbox: workspace-write',
      '        approval: ask',
      '',
    ].join('\n'))
    assert.equal(setAutoApproveSandbox(path, 'read-only').ok, true)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /workspace-write:\n\s+sandbox: workspace-write/)
    assert.match(text, /auto-approve:\n\s+sandbox: read-only/)
  })
})



describe('文档标记与无 presets 的 permission 行', () => {
  it('`...` 结束标记会被去掉，不会写出多文档 YAML', () => {
    const path = tmpPatch('- id: webserver\n  config:\n    port: 3080\n...\n')
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    const text = readFileSync(path, 'utf8')
    assert.equal(/^\.\.\.[ \t]*$/m.test(text), false, '列 0 的 ... 必须被去掉')
    assert.equal(/^---[ \t]*$/m.test(text), false, '列 0 的 --- 也要去掉')
    assert.match(text, /^- id: webserver$/m, '原有条目保留')
    assertSingleSequence(text)
  })

  it('只有 `...` 的 patch 也能被修复成合法单序列', () => {
    const path = tmpPatch('...\n')
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    assertSingleSequence(readFileSync(path, 'utf8'))
  })

  it('permission 行有块状 config 但没有 presets：把出厂表插进去，保留用户其它键', () => {
    const path = tmpPatch([
      '- id: permission',
      '  name: \'@deepseek-ai/dsh-permission-presets\'',
      '  config:',
      '    defaultPreset: read-only',
      '',
    ].join('\n'))
    const r = ensureAutoApprovePreset(path, 'workspace-write')
    assert.equal(r.status, 'added-presets-key')
    const text = readFileSync(path, 'utf8')
    assert.match(text, /defaultPreset: read-only/, '用户的键不能丢')
    assert.match(text, /^ {4}presets:$/m)
    assert.match(text, /^ {6}auto-approve:$/m)
    assert.equal(readAutoApproveSandbox(path), 'workspace-write')
    assertSingleSequence(text)
  })

  it('permission 行连 config 都没有：追加整块', () => {
    const path = tmpPatch('- id: permission\n  name: ignored\n')
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    assert.match(readFileSync(path, 'utf8'), /auto-approve:/)
    assert.equal(readAutoApproveSandbox(path), 'workspace-write')
  })

  it('行内 flow config 认不出来时明确报错，不猜', () => {
    const path = tmpPatch('- id: permission\n  config: {defaultPreset: read-only}\n')
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.noPresetsKey')
  })
})
