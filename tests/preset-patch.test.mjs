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
  readAutoApproveSandboxFromText,
  replaceAutoApproveSandbox,
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
  assert.match(text, /^- id: ['"]?permission['"]?$/m, '必须含 permission 条目')
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

  it('空数组的其它写法（`[ ]` / 折行的 `[]`）同样按空 patch 处理', () => {
    // YAML 里 `[ ]` 与「`[` 换行 `]`」都是合法空序列。只认裸 `[]` 时它们会被当成
    // 「有内容的 patch」，于是往后面追加条目 → 拼出「flow 序列 + 块序列」的非法 YAML
    // （DSH `yaml.load` 抛 Unexpected seq-item-ind、`dsh web` 起不来），而自检还报成功。
    for (const text of ['[ ]\n', '[  ]\n', '[\n]\n', '[ ] # empty\n', '---\n[ ]\n']) {
      assert.equal(isPatchArrayEmpty(text), true, JSON.stringify(text))
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).status, 'added-entry', JSON.stringify(text))
      assertSingleSequence(readFileSync(path, 'utf8'), JSON.stringify(text))
    }
    // 有内容的 patch 不受影响
    assert.equal(isPatchArrayEmpty('[\n- id: permission\n]\n'), false)
  })

  it('flow 写法的 permission 行认不出来时拒绝写盘，不追加第二整块', () => {
    // `- {id: permission, config: {…}}` 既不被块状行正则认，也不进 writeComposed 的
    // 块范围查找 → 过去会再追加一整块 `- id: permission`；DSH 里同 id 后写的 config
    // 整块覆盖前一条，于是用户 flow 行自带的 presets 被静默丢掉而 RPC 报成功。
    for (const text of [
      '- {id: permission, config: {presets: {mine: {sandbox: workspace-write}}}}\n',
      "- {id: 'permission', config: {presets: {}}}\n",
    ]) {
      const path = tmpPatch(text)
      const before = readFileSync(path, 'utf8')
      const res = ensureAutoApprovePreset(path)
      assert.equal(res.status, 'unrecognized-id-form', JSON.stringify(text))
      assert.equal(readFileSync(path, 'utf8'), before, '拒绝时不得动用户文件')
    }
    // 无关的条目行（值不是 permission）照旧只追加
    const other = tmpPatch('- id: some-other-plugin\n  config:\n    x: 1\n')
    assert.equal(ensureAutoApprovePreset(other).status, 'added-entry')
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

/**
 * review 修复回归：
 *  - 块标量**续行**（不是紧跟 `|` 的第一行）里的同名行不算已配置；
 *  - 键带行尾注释 / 行内 flow 值也算已存在（否则再插一份 → 同名键 → DSH 解析失败）；
 *  - 空 patch 里的**每个** `[]` 都要被替换掉（`[]\n[]\n` 同样等价于空）。
 */
describe('findAutoApproveKey 的标量正文与键形态', () => {
  const inPermission = (body) => ['- id: permission', '  config:', '    presets:', '      my-preset:', ...body, ''].join('\n')

  it('块标量第二行起的同名行不算键（假键不在正文第一行）', () => {
    const text = inPermission([
      '        description: |',
      '          第一行说明',
      '          auto-approve:',
      '          （历史遗留）',
    ])
    assert.equal(hasAutoApprovePreset(text), false)
    const path = tmpPatch(text)
    assert.equal(getSetupState(path).configured, false)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    assertSingleSequence(readFileSync(path, 'utf8'))
    // 真的插进去了，而且只有一份
    assert.equal((readFileSync(path, 'utf8').match(/^ {6}auto-approve:/gm) || []).length, 1)
  })

  it('块标量里的空行不会提前结束标量', () => {
    const text = inPermission([
      '        description: |',
      '          说明第一行',
      '',
      '          auto-approve:',
    ])
    assert.equal(hasAutoApprovePreset(text), false)
  })

  it('普通多行（折叠）标量的续行同样不算键', () => {
    const text = inPermission([
      '        description: 说明文字',
      '          auto-approve:',
    ])
    assert.equal(hasAutoApprovePreset(text), false)
  })

  it('空块标量头之后的真键照旧被识别（不能反向漏判）', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      my-preset:',
      '        description: >',
      '      auto-approve:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    assert.equal(hasAutoApprovePreset(text), true)
    assert.equal(findKeyIndent(text), 6)
  })

  it('行内 flow 值也能读改 sandbox，不再误报「没有 sandbox 行」', () => {
    const flow = '- id: permission\n  config:\n    presets:\n      auto-approve: { sandbox: read-only, approval: ask }\n'
    assert.equal(hasAutoApprovePreset(flow), true)
    assert.equal(readAutoApproveSandboxFromText(flow), 'read-only')
    const changed = replaceAutoApproveSandbox(flow, 'workspace-write')
    assert.equal(changed.found, true)
    assert.equal(changed.changed, true)
    assert.match(changed.text, /auto-approve: \{ sandbox: workspace-write, approval: ask \}/)
    assert.equal(readAutoApproveSandboxFromText(changed.text), 'workspace-write')
    // 值已经一样时不动文件
    assert.equal(replaceAutoApproveSandbox(`${flow}`, 'read-only').changed, false)
    // 文件路径那条封装也要能读到（设置页走的是它）
    const path = tmpPatch(flow)
    assert.equal(readAutoApproveSandbox(path), 'read-only')
    assert.equal(setAutoApproveSandbox(path, 'read-only').ok, true)
  })

  it('键带行尾注释或行内值时算已存在，绝不追加第二份', () => {
    for (const line of ['      auto-approve:   # ours', '      auto-approve: { sandbox: read-only, approval: ask }']) {
      const text = ['- id: permission', '  config:', '    presets:', line, ''].join('\n')
      assert.equal(hasAutoApprovePreset(text), true, line)
      const path = tmpPatch(text)
      assert.equal(getSetupState(path).configured, true, line)
      assert.equal(ensureAutoApprovePreset(path).status, 'already', line)
      assert.equal((readFileSync(path, 'utf8').match(/auto-approve:/g) || []).length, 1, line)
    }
  })

  it('description 正文里的预设键名不算漂移', () => {
    // 正文行必须写成**冒号后无值**、且落在 presets 子键的缩进上——那正是会被严格键正则
    // 误认成子键的形态（带值的正文行永远不匹配，用它做用例等于空转）。
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '     list: |',
      '      read-only:',
      '      other-preset:',
    ].join('\n')
    const keys = extractPresetKeysFromPatchText(text)
    // 真实子键只有 `list`（`yaml.load` 的结论一致）；正文里的两行不能被算进去，
    // 否则会报出并不存在的预设漂移。
    assert.deepEqual(keys, ['list'])
    assert.equal(hasAutoApprovePreset(text), false)
  })

  it('CRLF 换行的标量正文同样不算键', () => {
    const crlfPlain = ['- id: permission', '  config:', '    presets:', '      my-preset:', '        description: 说明文字', '          auto-approve:', ''].join('\r\n')
    assert.equal(hasAutoApprovePreset(crlfPlain), false)
    const crlfBlock = ['- id: permission', '  config:', '    presets:', '      my-preset:', '        description: |', '          第一行', '          auto-approve:', ''].join('\r\n')
    assert.equal(hasAutoApprovePreset(crlfBlock), false)
    const path = tmpPatch(crlfBlock)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
  })

  it('引号键 / 冒号前空格 / 引号 presets / 引号 permission 都算「已有」', () => {
    const forms = [
      ["      'auto-approve':", '        sandbox: read-only'],
      ['      "auto-approve":', '        sandbox: read-only'],
      ['      auto-approve :', '        sandbox: read-only'],
    ]
    for (const presetLines of forms) {
      const text = ['- id: permission', '  config:', '    presets:', ...presetLines, ''].join('\n')
      assert.equal(hasAutoApprovePreset(text), true, presetLines[0])
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).status, 'already', presetLines[0])
      assert.equal((readFileSync(path, 'utf8').match(/auto-approve['"]?\s*:/g) || []).length, 1, presetLines[0])
    }
    // 引号的 permission 行同样要认出来（不然会追加第二条同 id 的 patch，把用户 config 整块盖掉）
    const quotedRow = [
      "- id: 'permission'",
      '  config:',
      '    presets:',
      '      other-preset:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path2 = tmpPatch(quotedRow)
    assert.equal(ensureAutoApprovePreset(path2).status, 'added-preset')
    assertSingleSequence(readFileSync(path2, 'utf8'))
  })

  it('flow 形态的 presets 明确报错而不是往里插键', () => {
    const text = '- id: permission\n  config: {presets: {other: {sandbox: read-only}}}\n'
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.noPresetsKey')
    assert.equal(readFileSync(path, 'utf8'), text, '报错就不能动文件')
    // 块状 config 但 presets 自己是 flow
    const text2 = '- id: permission\n  config:\n    presets: {other-preset: {sandbox: read-only}}\n'
    const path2 = tmpPatch(text2)
    assert.equal(ensureAutoApprovePreset(path2).code, 'err.noPresetsKey')
    assert.equal(readFileSync(path2, 'utf8'), text2)
  })

  it('键只存在于被覆盖的行时，检测侧也必须判「未配置」并可修复', () => {
    // 写入侧只写「最后一条带 config 的 permission 行」，检测侧必须用同一套目标——
    // 否则升级用户会落在「键在被覆盖的行里」这个状态：URL 说已配置、DSH 生效表里没有它，
    // 而且 ensure 报 already、永远不修复。
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '- id: permission',
      '  config:',
      '    defaultPreset: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(hasAutoApprovePreset(text), false, '被覆盖行里的键不算「已配置」')
    assert.equal(getSetupState(path).configured, false)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-presets-key')
    const out = readFileSync(path, 'utf8')
    const last = out.slice(out.lastIndexOf('- id: permission'))
    assert.match(last, /presets:/, '生效行必须拿到 presets')
    assert.match(last, /auto-approve:/)
    assert.equal(getSetupState(path).configured, true)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
  })

  it('空的 presets（无子键 / null / ~）要补齐整张出厂表，而不是只插一个键', () => {
    // 只插一个 auto-approve 会把 mapping 实体化，**吃掉 permission 插件的 schema 默认表**
    // （workspace-write / danger-full-access 会被 default 顶掉）。
    for (const keyLine of ['    presets:', '    presets: null', '    presets: ~ # 空']) {
      const text = ['- id: permission', '  config:', keyLine, '    defaultPreset: read-only', ''].join('\n')
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).status, 'added-preset', keyLine)
      const out = readFileSync(path, 'utf8')
      assert.match(out, /workspace-write:/, keyLine)
      assert.match(out, /danger-full-access:/, keyLine)
      assert.match(out, /auto-approve:/, keyLine)
      assert.equal(ensureAutoApprovePreset(path).status, 'already', keyLine)
    }
  })

  it('本来就解析不了的 patch（根部裸 [] + 条目）拒绝写盘，不报假成功', () => {
    const broken = [
      '[]',
      '- id: permission',
      '  config:',
      '    presets:',
      '      other:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(broken)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.status, 'broken-patch')
    assert.equal(readFileSync(path, 'utf8'), broken, '报错就不能动文件')
  })

  it('CRLF 文件里的空 presets 也要能补齐（且不留混合换行）', () => {
    // `split('\n')` 之后 CRLF 行尾还带 `\r`，而 `.` 不匹配 `\r`：去值正则会静默 no-op，
    // 子键被插到 `null` 之下（多行标量）→ 自检拦下、用户永远装不上预设。
    for (const keyLine of ['    presets:', '    presets: null', '    presets: ~ # 空']) {
      const text = ['- id: permission', '  config:', keyLine, '    defaultPreset: read-only', ''].join('\r\n')
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).status, 'added-preset', keyLine)
      const out = readFileSync(path, 'utf8')
      assert.match(out, /workspace-write:/, keyLine)
      assert.match(out, /danger-full-access:/, keyLine)
      assert.equal(ensureAutoApprovePreset(path).status, 'already', keyLine)
      // 不能留下 LF 结尾的行（混合换行）
      const lines = out.split('\n')
      const mixed = lines.filter((l, i) => i < lines.length - 1 && !l.endsWith('\r'))
      assert.deepEqual(mixed, [], keyLine)
    }
  })

  it('引号键算「已存在」，标签/锚点键拒绝写盘（两侧都要钉住）', () => {
    for (const keyLine of ["      'auto-approve':", '      "auto-approve":']) {
      const text = ['- id: permission', '  config:', '    presets:', keyLine, '        sandbox: read-only', ''].join('\n')
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).status, 'already', keyLine)
      assert.equal(readFileSync(path, 'utf8'), text)
    }
    for (const keyLine of ['      !!str auto-approve:', '      &a auto-approve:']) {
      const text = ['- id: permission', '  config:', '    presets:', keyLine, '        sandbox: read-only', ''].join('\n')
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path)
      assert.equal(r.ok, false, keyLine)
      assert.equal(readFileSync(path, 'utf8'), text, keyLine)
    }
  })

  it('认不出的键写法（显式键语法）宁可不写盘', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      other-preset:',
      '        sandbox: read-only',
      '      ? auto-approve',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false, '插入会造成同名键冲突时必须拒绝写盘')
    assert.equal(readFileSync(path, 'utf8'), text)
  })

  it('多行 flow 的 sandbox 不碰（改了会吃掉逗号 → 解析失败），行尾注释里的值也不算', () => {
    const multi = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve: {',
      '        sandbox: read-only,',
      '        approval: ask }',
      '',
    ].join('\n')
    const path = tmpPatch(multi)
    assert.equal(readAutoApproveSandboxFromText(multi), '')
    const r = setAutoApproveSandbox(path, 'workspace-write')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.presetSandboxMissing')
    assert.equal(readFileSync(path, 'utf8'), multi, '报错就不能动文件')
    // 注释里的 sandbox: 不是值（认了它就会「只改注释还报成功」）
    const commented = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve: { approval: ask } # sandbox: read-only',
      '',
    ].join('\n')
    const path2 = tmpPatch(commented)
    assert.equal(readAutoApproveSandboxFromText(commented), '')
    const r2 = setAutoApproveSandbox(path2, 'workspace-write')
    assert.equal(r2.ok, false)
    assert.equal(readFileSync(path2, 'utf8'), commented)
  })

  it('认不出的键写法一律拒绝写盘（标签 / 锚点 / 转义 / 显式键 / 序列项）', () => {
    const forms = [
      ['      !!str auto-approve:', '        sandbox: read-only'],
      ['      &a auto-approve:', '        sandbox: read-only'],
      ['      "auto\\u002Dapprove":', '        sandbox: read-only'],
      ['      ? auto-approve'],
      ['      - auto-approve'],
    ]
    for (const presetLines of forms) {
      const text = ['- id: permission', '  config:', '    presets:', ...presetLines, ''].join('\n')
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path)
      assert.equal(r.ok, false, presetLines.join(' '))
      assert.equal(readFileSync(path, 'utf8'), text, '拒绝时文件必须逐字节不变')
    }
    // 认得出来的形态照旧工作（不能被上面的守卫误拦）
    const ok = ['- id: permission', '  config:', '    presets:', "      'other-preset':", '        sandbox: read-only', ''].join('\n')
    const okPath = tmpPatch(ok)
    assert.equal(ensureAutoApprovePreset(okPath).status, 'added-preset')
  })

  it('4 空格缩进的直接子键也算「已有」（不写死 +2）', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '        auto-approve:',
      '          sandbox: read-only',
      '',
    ].join('\n')
    assert.equal(hasAutoApprovePreset(text), true)
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
    assert.equal(readFileSync(path, 'utf8'), text)
  })

  it('多行 flow（末条不带逗号）也不改写，报 err.presetSandboxMissing', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve: {',
      '        sandbox: read-only',
      '      }',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    const r = setAutoApproveSandbox(path, 'workspace-write')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.presetSandboxMissing')
    assert.equal(readFileSync(path, 'utf8'), text)
  })

  it('flow 里的引号值能读能改', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve: { sandbox: "read-only", approval: ask }',
      '',
    ].join('\n')
    assert.equal(readAutoApproveSandboxFromText(text), 'read-only')
    const changed = replaceAutoApproveSandbox(text, 'workspace-write')
    assert.equal(changed.found, true)
    assert.match(changed.text, /sandbox: workspace-write, approval: ask/)
  })

  it('下一行 flow 的 presets / config 一样报 err.noPresetsKey', () => {
    const nextLineFlow = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      { other: { sandbox: read-only } }',
      '',
    ].join('\n')
    const path = tmpPatch(nextLineFlow)
    assert.equal(ensureAutoApprovePreset(path).code, 'err.noPresetsKey')
    assert.equal(readFileSync(path, 'utf8'), nextLineFlow, '报错就不能动文件')
  })

  it('兄弟键名字里含 auto-approve 子串不算冲突（合法文件不能被永久拒写）', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      my-auto-approve:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    assertSingleSequence(readFileSync(path, 'utf8'))
  })

  it('同一 id 多条 patch：只写**最后一条**（DSH 里它整块覆盖前面的 config）', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      user-a:',
      '        sandbox: read-only',
      '- id: permission',
      '  config:',
      '    presets:',
      '      user-b:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    const out = readFileSync(path, 'utf8')
    // 生效的是最后一条 permission 行：auto-approve 必须在它的 presets 里
    const last = out.slice(out.lastIndexOf('- id: permission'))
    assert.match(last, /auto-approve:/)
    // 第一行保持原样（不往被覆盖的行里插）
    const first = out.slice(0, out.lastIndexOf('- id: permission'))
    assert.equal(first.includes('auto-approve'), false)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
  })

  it('最后一条 permission 行没有 presets 时，插进**它**的 config（不是前面那条的）', () => {
    const text = [
      '- id: permission',
      '  config:',
      '    presets:',
      '      user-a:',
      '        sandbox: read-only',
      '- id: permission',
      '  config:',
      '    defaultPreset: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-presets-key')
    const out = readFileSync(path, 'utf8')
    const last = out.slice(out.lastIndexOf('- id: permission'))
    assert.match(last, /auto-approve:/)
    // 前面那条用户的 presets 原样保留
    assert.match(out, /user-a:/)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
  })

  it('行级错位的 presets 不是目标：只认 config.presets', () => {
    const text = [
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  presets:',
      '    read-only:',
      '      sandbox: read-only',
      '  config:',
      '    defaultPreset: auto-approve',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, true)
    const out = readFileSync(path, 'utf8')
    // 插进去的位置必须是 config 下面那一份（DSH 只读它），而不是行级错位的那份
    const configBlock = out.slice(out.indexOf('  config:'))
    assert.match(configBlock, /^ {4}presets:$/m)
    assert.match(configBlock, /^ {6}auto-approve:$/m)
    // 幂等：第二次必须是 already（否则每次启动都会再插一份）
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
    assert.equal(readFileSync(path, 'utf8'), out)
  })

  it('块标量正文里的 config/presets 诱饵不会被当真目标', () => {
    // 诱饵在标量正文里，**缩进与真键同级**：不跳正文就会把 `config` 找到标量里去，
    // 于是 recognize 出「已配置」（其实 DSH 看不见），永远装不上预设。
    const text = [
      '- id: permission',
      '  description: |',
      '    config:',
      '      presets:',
      '        auto-approve: text',
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    const out = readFileSync(path, 'utf8')
    assert.match(out, /^ {6}auto-approve:$/m)
    assertSingleSequence(out)
  })

  it('BOM 开头的 permission 行仍被认出（否则会写出第二条 permission 行）', () => {
    const text = '\uFEFF- id: permission\n  config:\n    presets:\n      my-custom:\n        sandbox: read-only\n'
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.status, 'added-preset')
    const out = readFileSync(path, 'utf8')
    assert.equal((out.match(/- id: permission/g) || []).length, 1, '不能写出第二条 permission 行')
    assert.equal(out.includes('my-custom'), true, '用户自己的预设不能被整块覆盖')
  })

  it('BOM 开头的空 patch 也要整段替换', () => {
    const path = tmpPatch('\uFEFF[]\n')
    assert.equal(isPatchArrayEmpty('\uFEFF[]\n'), true)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-entry')
    const out = readFileSync(path, 'utf8')
    assert.equal(out.includes('[]'), false)
    assertSingleSequence(out)
  })

  it('双 [] 的空 patch 不会拼出「[] + 条目」', () => {
    assert.equal(isPatchArrayEmpty('[]\n[]\n'), true)
    const out = composePatchText('[]\n[]\n', '- id: permission\n')
    assert.equal(out.includes('[]'), false)
    assert.equal(out, '- id: permission\n')
    const doc = composePatchText('---\n[]\n---\n[]\n', '- id: permission\n')
    assert.equal(doc.includes('[]'), false)
  })
})

/** 直接读键行缩进（测试内部用，避免只看布尔值）。 */
function findKeyIndent(text) {
  const line = text.split('\n').find((l) => /^[ \t]+auto-approve:/.test(l))
  assert.ok(line, '应当能找到 auto-approve 键行')
  return (line.match(/^[ \t]*/) || [''])[0].length
}

/**
 * 第 1b 轮 review 修复：判据统一（检测/抽取/写入三处共用 `childKeyName` + `directChildIndent`）、
 * 引号多行标量、sandbox 行层级、坏文件与 name 校验。每条都对应一个实测过的静默失效。
 */
describe('review 修复：判据统一与坏文件', () => {
  const ROW = (body) => [
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    ...body,
    '',
  ].join('\n')

  it('多行**引号**标量里的 `auto-approve:` 不是键（否则预设永不安装且 UI 说已配置）', () => {
    // 引号标量的续行允许与键同缩进：整段是一个标量值，presets 下没有 auto-approve 键。
    const text = ROW(['      mine: "第一行', '      auto-approve:', '      说明"'])
    assert.equal(hasAutoApprovePreset(text), false)
    assert.equal(getSetupState(tmpPatch(text)).configured, false)
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    const out = readFileSync(path, 'utf8')
    assertSingleSequence(out)
    assert.match(out, /^ {6}auto-approve:$/m)
    // 幂等：第二次必须 already（否则每次启动都再插一份）
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
    // 单引号同样
    assert.equal(hasAutoApprovePreset(ROW(["      mine: '第一行", '      auto-approve:', "      说明'"])), false)
    // 反方向：引号在续行里闭合后，后面的真键照旧认得出（别把标量吞得太远）
    const closed = ROW(['      mine: "第一行', '        说明"', '      auto-approve:', '        sandbox: read-only'])
    assert.equal(hasAutoApprovePreset(closed), true)
    assert.equal(readAutoApproveSandboxFromText(closed), 'read-only')
  })

  it('抽取 / 漂移只看**生效的**那条 permission 行（后写的 config 整块覆盖前面的）', () => {
    const text = [
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '      workspace-write:',
      '        sandbox: workspace-write',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets:',
      '      mine:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    assert.deepEqual(extractPresetKeysFromPatchText(text), ['mine'])
    assert.deepEqual(getSetupState(tmpPatch(text)).presets, ['mine'])
    // 漂移告警据此才有意义：出厂表真的被覆盖掉了
    const base = ['read-only', 'workspace-write', 'danger-full-access']
    assert.deepEqual(presetDrift(base, extractPresetKeysFromPatchText(text)), {
      missing: base, extra: ['mine'],
    })
  })

  it('sandbox 只认 auto-approve 的**直接子键**：嵌套 / 块标量正文都不算', () => {
    // 只看缩进时会把 `args.sandbox:` 或正文里的一行当成目标：报 ok/updated，
    // 而 DSH 生效的 auto-approve 里根本没有 sandbox（schema 里它必填），还会改写用户正文。
    const nested = ROW(['      auto-approve:', '        approval: ask', '        args:', '          sandbox: workspace-write'])
    assert.equal(readAutoApproveSandboxFromText(nested), '')
    const path = tmpPatch(nested)
    const r = setAutoApproveSandbox(path, 'read-only')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'err.presetSandboxMissing')
    assert.equal(readFileSync(path, 'utf8'), nested, '拒绝时文件逐字节不变')

    const inBody = ROW(['      auto-approve:', '        approval: ask', '        description: |', '          sandbox: workspace-write'])
    assert.equal(readAutoApproveSandboxFromText(inBody), '')
    const bodyPath = tmpPatch(inBody)
    assert.equal(setAutoApproveSandbox(bodyPath, 'read-only').ok, false)
    assert.equal(readFileSync(bodyPath, 'utf8'), inBody, '块标量正文不许被改写')
  })

  it('sandbox 行带行尾注释：读得出、改得动、注释留着', () => {
    const text = ROW(['      auto-approve:', '        sandbox: workspace-write  # 模式', '        approval: ask'])
    assert.equal(readAutoApproveSandboxFromText(text), 'workspace-write')
    const path = tmpPatch(text)
    const r = setAutoApproveSandbox(path, 'read-only')
    assert.equal(r.ok, true)
    assert.equal(r.status, 'updated')
    assert.match(readFileSync(path, 'utf8'), /sandbox: read-only  # 模式/)
    assert.equal(readAutoApproveSandbox(path), 'read-only')
  })

  it('认不出的 permission 行拼写一律拒绝写盘（标签 / 转义 / flow / 多行序列项）', () => {
    for (const idLine of ['- id: !!str permission', '- id: "\\u0070ermission"', '- {id: permission, config: {}}']) {
      const text = [idLine, "  name: '@deepseek-ai/dsh-permission-presets'", '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''].join('\n')
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path)
      assert.equal(r.ok, false, idLine)
      assert.equal(r.status, 'unrecognized-id-form', idLine)
      assert.equal(readFileSync(path, 'utf8'), text, `${idLine}：拒绝时文件必须逐字节不变`)
    }
    // 折成多行的序列项（`-` 单独一行）同样拦得住
    const multiline = ['-', '  id: permission', '  config:', '    presets: {}', ''].join('\n')
    const path = tmpPatch(multiline)
    assert.equal(ensureAutoApprovePreset(path).status, 'unrecognized-id-form')
    assert.equal(readFileSync(path, 'utf8'), multiline)
  })

  it('presets 块里更深缩进、带 ASCII 冒号的注释不算键（检测与写入必须同一套判据）', () => {
    const text = ROW(['        # note: keep in sync with dsh-base', '      auto-approve:', '        sandbox: workspace-write'])
    assert.equal(hasAutoApprovePreset(text), true)
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
    assert.equal(readFileSync(path, 'utf8'), text)
  })

  it('预设键不设字符集：中文键照旧抽得出来（否则漂移与预设表双错）', () => {
    const text = ROW(['      "我的预设":', '        sandbox: read-only', '      read-only:', '        sandbox: read-only'])
    assert.deepEqual(extractPresetKeysFromPatchText(text), ['我的预设', 'read-only'])
  })

  it('缩进的 `[]` 是某个键的空序列值，不是根空数组（合法文件不许被判 broken-patch）', () => {
    const text = [
      '- id: some-plugin',
      '  config:',
      '    inject:',
      '      []',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '',
    ].join('\n')
    const path = tmpPatch(text)
    assert.equal(ensureAutoApprovePreset(path).status, 'added-preset')
    const out = readFileSync(path, 'utf8')
    // 缩进的 `[]` 是内容，必须原样留着；同时 auto-approve 键也真的插进去了
    assert.match(out, /^ {6}\[\]$/m)
    assert.match(out, /^ {6}auto-approve:$/m)
    assert.equal(ensureAutoApprovePreset(path).status, 'already')
  })

  it('坏文件不许报 ok/already：根部混了裸 []、或内容之后还有文档标记', () => {
    const stray = '[]\n- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n'
    const path = tmpPatch(stray)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.status, 'broken-patch')
    assert.equal(readFileSync(path, 'utf8'), stray)
    // 末尾的 `...` 不产生第二个文档：不算坏文件（别把合法文件拦掉）
    const trailing = "- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n...\n"
    assert.equal(ensureAutoApprovePreset(tmpPatch(trailing)).status, 'already')
    // 中途 `...` = 第二个文档：插入路径本来不会去掉标记，写进去也解析不了
    const mid = "- id: webserver\n- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n...\n- id: x\n"
    const midPath = tmpPatch(mid)
    assert.equal(ensureAutoApprovePreset(midPath).status, 'broken-patch')
    assert.equal(readFileSync(midPath, 'utf8'), mid)
  })

  it('根不是块状序列 / 条目不是 mapping：报 broken-patch 且不动文件', () => {
    // DSH 的 `parsePatchList` 要求顶层是数组、每个条目是 mapping。往别的形状里追加条目会写出
    // 「flow 序列 + 块序列」或「映射 + 序列项」的混合体（比改前更坏），而 RPC 却报成功、
    // UI 说「已写入，请重启」——profile 直接起不来（第 4 轮 preset 复审 P1）。
    const cases = {
      'root-mapping': 'auto-approve:\n  sandbox: workspace-write\n',
      'root-config-key': 'config:\n  presets: {}\n',
      'root-empty-mapping': '{}\n',
      'root-null': 'null\n',
      'root-scalar': 'permission\n',
      'root-flow-seq': '[{id: other-plugin, name: x}]\n',
      'entry-not-mapping': '- just-a-string\n',
      'entry-number': '- 42\n',
    }
    for (const [name, text] of Object.entries(cases)) {
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path)
      assert.equal(r.ok, false, name)
      assert.equal(r.status, 'broken-patch', name + '：' + JSON.stringify(r))
      assert.equal(readFileSync(path, 'utf8'), text, name + '：坏文件一个字节都不动')
    }
    // 对照：空数组（三种写法）与正常的块状条目照旧
    for (const text of ['[]\n', '[ ]\n', '[\n]\n', '- id: other-plugin\n  name: x\n']) {
      const path = tmpPatch(text)
      assert.equal(ensureAutoApprovePreset(path).ok, true, JSON.stringify(text))
    }
  })

  it('有认不出的 permission 行时 setup 报「未配置」（设置页要留下补救按钮）', () => {
    const text = ['- id: permission', '  name: "@deepseek-ai/dsh-permission-presets"', '  config:', '    presets:', '      auto-approve:', '        sandbox: workspace-write', '- id: !!str permission', '  config:', '    presets: {}', ''].join('\n')
    const path = tmpPatch(text)
    const state = getSetupState(path)
    assert.equal(state.configured, false, '后写的认不出行会整块覆盖，说「已配置」就是撒谎')
    assert.equal(state.unrecognizedRow, true)
    assert.equal(ensureAutoApprovePreset(path).status, 'unrecognized-id-form')
    assert.equal(readFileSync(path, 'utf8'), text)
  })

  it('内容之前的 `...` 也是第二个文档：坏文件不许报 already/ok', () => {
    // js-yaml 实测「`...` 换行再接 `- id: permission`」报 expected a single document——
    // 文档已结束，后面的内容属于第二个文档。只判「内容之后出现标记」时这种文件会被当正常。
    const leading = "...\n- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n"
    const path = tmpPatch(leading)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.status, 'broken-patch')
    assert.equal(readFileSync(path, 'utf8'), leading, '坏文件一个字节都不动')
    // 末尾的 `...` 仍不算坏文件（它不产生第二个文档）
    const trailing = "- id: permission\n  config:\n    presets:\n      auto-approve:\n        sandbox: read-only\n...\n"
    assert.equal(ensureAutoApprovePreset(tmpPatch(trailing)).status, 'already')
  })

  it('块状 sandbox 的**引号值**照旧读得出、同值写入判 unchanged', () => {
    const text = ROW(['      auto-approve:', '        sandbox: "workspace-write"', '        approval: ask'])
    assert.equal(readAutoApproveSandboxFromText(text), 'workspace-write', '读回来必须是真值（去引号）')
    const path = tmpPatch(text)
    const same = setAutoApproveSandbox(path, 'workspace-write')
    assert.equal(same.ok, true)
    assert.equal(same.status, 'unchanged', '同一个值不该被判成需要改写（否则 UI 误报「已写入，请重启」）')
    assert.equal(same.needRestart, false)
    assert.equal(readFileSync(path, 'utf8'), text)
    // 换一个值照旧能改
    assert.equal(setAutoApproveSandbox(path, 'read-only').status, 'updated')
    assert.match(readFileSync(path, 'utf8'), /sandbox: read-only/)
  })

  it('通用插入路径在 CRLF 文件里也写 CRLF（不许混进 LF 行）', () => {
    const text = ['- id: permission', "  name: '@deepseek-ai/dsh-permission-presets'", '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''].join('\r\n')
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path, 'workspace-write')
    assert.equal(r.status, 'added-preset')
    for (const line of readFileSync(path, 'utf8').split('\n').slice(0, -1)) {
      assert.equal(line.endsWith('\r'), true, '每一行都必须以 CRLF 结尾: ' + JSON.stringify(line))
    }
  })

  it('缩进的条目 / `-` 单独一行后 id 不是第一个键：同样算认不出的 permission 行', () => {
    // 第 2 轮的上下文判据要求「父行是**根级**条目」且「id 是第一个键」，于是漏掉这三类：
    // DSH 自己的 base patch 就是 `- insert:` + 缩进条目；`-` 单独一行时 id 可以在别的键之后。
    // 漏判的后果是追加第二整块 permission 行 → DSH 里后写的 config 整块覆盖 → 用户 presets 静默消失。
    const forms = {
      'insert-flow': ['- insert:', '    - {id: permission, name: "@deepseek-ai/dsh-permission-presets", config: {presets: {mine: {sandbox: read-only, approval: ask}}}}', ''],
      // `- insert:` 里的缩进条目（DSH 自己的 base patch 就是这形状）：这是**真的** patch 条目。
      // 注意 `inject:` / `items:` 这类**普通键**下面的列表项不是 patch 条目（DSH 只对顶层条目与
      // `insert:` 组递归），所以那些形状必须放行——见下面那条用例。
      'insert-indented-flow': ['- insert:', '    - {id: permission, config: {presets: {mine: {sandbox: read-only}}}}', ''],
      'solo-id-second': ['-', '  name: foo', '  id: permission', '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''],
    }
    for (const [name, lines] of Object.entries(forms)) {
      const text = lines.join('\n')
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path, 'workspace-write')
      assert.equal(r.ok, false, name)
      assert.equal(r.status, 'unrecognized-id-form', name)
      assert.equal(readFileSync(path, 'utf8'), text, name + '：拒绝时文件必须逐字节不变')
    }
  })

  it('普通键（`inject:` / `items:` / 列表）下面的 `id: permission` 不是 patch 条目 → 必须放行', () => {
    // DSH 的 `parsePatchList` 只把顶层条目与 `insert:` 组当 patch 条目；`inject:`（依赖注入）
    // 或别的插件 config 里的列表项/映射只是值。把它们当 permission 行会**永久拒写**合法文件
    // （第 4 轮实测：`inject: [{id: permission, …}]` 报 unrecognized-id-form、文件一动不动）。
    const allowed = {
      'flow-list-under-key': ['- id: some-plugin', '  inject: [{id: permission, config: {x: 1}}]', ''],
      'block-list-under-key': ['- id: webserver', '  name: x', '  config:', '    list:', '      - id: permission', ''],
      'list-item-with-id': ['- id: other-plugin', '  config:', '    list:', '      - thing: x', '        id: permission', ''],
      'mapping-under-config': ['- id: other-plugin', '  config:', '    thing:', '      id: permission', ''],
    }
    for (const [name, lines] of Object.entries(allowed)) {
      const text = lines.join('\n')
      const path = tmpPatch(text)
      const r = ensureAutoApprovePreset(path, 'workspace-write')
      assert.equal(r.ok, true, name + '：' + JSON.stringify(r))
      assert.equal(r.status, 'added-entry', name)
      assert.match(readFileSync(path, 'utf8'), /- id: permission\n/, name + '：要真的写进去一条')
    }
    // 对照：真正的条目形态（顶层 / `insert:` 里）仍要拒
    for (const [name, lines] of Object.entries({
      'top-level-tagged': ['- id: !!str permission', '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''],
      'solo-then-id': ['-', '  name: foo', '  id: permission', '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''],
    })) {
      const path = tmpPatch(lines.join('\n'))
      assert.equal(ensureAutoApprovePreset(path).status, 'unrecognized-id-form', name)
    }
  })

  it('别的插件 config 里的 `id: permission` 不算认不出的 permission 行（合法文件不许被拒写）', () => {
    // 只看「这一行有没有 id: permission」时，这种完全合法的文件会被永久拒写，
    // 而错误文案还说「拒绝追加第二行」——那是假话（文件里根本没有 permission 行）。
    const text = ['- id: other-plugin', '  config:', '    thing:', '      id: permission', ''].join('\n')
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path, 'workspace-write')
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.status, 'added-entry')
    assert.match(readFileSync(path, 'utf8'), /- id: permission\n/)
    // 但**条目行**上的各种认不出的拼写照旧拒写
    for (const entry of ['- id: !!str permission', '- id: "\\u0070ermission"', '- {id: permission, config: {}}']) {
      const bad = [entry, '  config:', '    presets:', '      mine:', '        sandbox: read-only', ''].join('\n')
      const badPath = tmpPatch(bad)
      assert.equal(ensureAutoApprovePreset(badPath).status, 'unrecognized-id-form', entry)
      assert.equal(readFileSync(badPath, 'utf8'), bad, entry)
    }
  })

  it('permission 行的 name 写错时拒绝（DSH 的 applyEntryPatches 会整条跳过）', () => {
    const text = ROW(['      auto-approve:', '        sandbox: read-only']).replace(
      "'@deepseek-ai/dsh-permission-presets'", "'@deepseek-ai/dsh-permission-presets-v2'",
    )
    const path = tmpPatch(text)
    const r = ensureAutoApprovePreset(path)
    assert.equal(r.ok, false)
    assert.equal(r.status, 'name-mismatch')
    assert.equal(readFileSync(path, 'utf8'), text)
    // 沙箱写入走同一条路：也要报错，不能返回 ok
    const sandbox = setAutoApproveSandbox(path, 'read-only')
    assert.equal(sandbox.ok, false)
    assert.equal(sandbox.status, 'name-mismatch')
    // 正确的 name / 没有 name 都照旧工作
    assert.equal(ensureAutoApprovePreset(tmpPatch(ROW(['      auto-approve:', '        sandbox: read-only']))).status, 'already')
    const noName = ['- id: permission', '  config:', '    presets:', '      auto-approve:', '        sandbox: read-only', ''].join('\n')
    assert.equal(ensureAutoApprovePreset(tmpPatch(noName)).status, 'already')
  })
})
