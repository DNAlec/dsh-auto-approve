/**
 * 把 auto-approve 预设写入 profile 的 cordis.patch.yml。
 * 权限表冻结，不能运行时扩展 presets。改 sandbox 后必须重启并重新选预设。
 * patch 若是 `[]`，整段替换，不要拼成 `[]\n- id: permission`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { autoApprovePresetYaml, FULL_PERMISSION_BLOCK, normalizePresetSandbox } from './rules.mjs'

export function getSetupState(patchPath) {
  try {
    const text = readFileSync(patchPath, 'utf8')
    return {
      configured: text.includes('auto-approve:'),
      patchPath,
      sandbox: readAutoApproveSandboxFromText(text),
    }
  } catch (e) {
    return { configured: false, patchPath, sandbox: '', error: String((e && e.message) || e) }
  }
}

export function readAutoApproveSandbox(patchPath) {
  try {
    return readAutoApproveSandboxFromText(readFileSync(patchPath, 'utf8'))
  } catch {
    return ''
  }
}

export function readAutoApproveSandboxFromText(text) {
  const lines = String(text || '').split('\n')
  let inAuto = false
  let autoIndent = 0
  for (const line of lines) {
    const start = line.match(/^([ \t]*)auto-approve:\s*$/)
    if (start) {
      inAuto = true
      autoIndent = start[1].length
      continue
    }
    if (!inAuto) continue
    const indent = (line.match(/^[ \t]*/) || [''])[0].length
    if (line.trim() !== '' && indent <= autoIndent) {
      inAuto = false
      continue
    }
    const sandbox = line.match(/^[ \t]+sandbox:\s*(workspace-write|read-only)\s*$/)
    if (sandbox) return sandbox[1]
  }
  return ''
}

export function replaceAutoApproveSandbox(text, sandbox) {
  const mode = normalizePresetSandbox(sandbox)
  const lines = String(text || '').split('\n')
  let inAuto = false
  let autoIndent = 0
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = line.match(/^([ \t]*)auto-approve:\s*$/)
    if (start) {
      inAuto = true
      autoIndent = start[1].length
      continue
    }
    if (!inAuto) continue
    const indent = (line.match(/^[ \t]*/) || [''])[0].length
    if (line.trim() !== '' && indent <= autoIndent) {
      inAuto = false
      continue
    }
    if (/^[ \t]+sandbox:\s*(workspace-write|read-only)\s*$/.test(line)) {
      const next = line.replace(/workspace-write|read-only/, mode)
      if (next !== line) {
        lines[i] = next
        changed = true
      }
      inAuto = false
    }
  }
  return { text: lines.join('\n'), changed }
}

export function ensureAutoApprovePreset(patchPath, sandbox = 'workspace-write') {
  const yaml = autoApprovePresetYaml(sandbox)
  try {
    const text = readFileSync(patchPath, 'utf8')
    if (text.includes('auto-approve:')) return { ok: true, status: 'already', needRestart: false }

    const lines = text.split('\n')
    let permIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^- id:\s*permission\s*$/.test(lines[i])) { permIdx = i; break }
    }

    if (permIdx === -1) {
      const trimmed = String(text || '').replace(/^\s+|\s+$/g, '')
      const block = (FULL_PERMISSION_BLOCK + yaml).replace(/^\n/, '')
      const next = (trimmed === '' || trimmed === '[]')
        ? block
        : (text.replace(/\s*$/, '') + '\n' + block)
      writeFileSync(patchPath, next.endsWith('\n') ? next : next + '\n', 'utf8')
      return { ok: true, status: 'added-entry', needRestart: true }
    }

    let presetsIdx = -1
    for (let i = permIdx; i < lines.length; i++) {
      if (/^ {4}presets:\s*$/.test(lines[i])) { presetsIdx = i; break }
      if (i > permIdx && /^- /.test(lines[i]) && !/^ {2,}- /.test(lines[i])) break
    }
    if (presetsIdx === -1) {
      return { ok: false, status: 'no-presets-key', needRestart: false, error: 'permission 条目缺少 presets 键，请手动添加' }
    }
    let insertAt = presetsIdx
    for (let i = presetsIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^ {6}\S/.test(line) || /^ {8}\S/.test(line)) { insertAt = i; continue }
      if (/^ {0,4}\S/.test(line) && !/^ {6,}\S/.test(line)) break
      if (/^\s*$/.test(line)) continue
    }
    lines.splice(insertAt + 1, 0, yaml.replace(/\n$/, ''))
    writeFileSync(patchPath, lines.join('\n'), 'utf8')
    return { ok: true, status: 'added-preset', needRestart: true }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, error: String((e && e.message) || e) }
  }
}

/** 把配置里的 presetSandbox 写进 auto-approve.sandbox。已有预设则只改这一行。 */
export function setAutoApproveSandbox(patchPath, sandbox) {
  const mode = normalizePresetSandbox(sandbox)
  const ensured = ensureAutoApprovePreset(patchPath, mode)
  if (!ensured.ok) return { ...ensured, sandbox: mode }
  try {
    const text = readFileSync(patchPath, 'utf8')
    const replaced = replaceAutoApproveSandbox(text, mode)
    if (!replaced.changed) {
      return { ok: true, status: ensured.status === 'already' ? 'unchanged' : ensured.status, needRestart: Boolean(ensured.needRestart), sandbox: mode }
    }
    writeFileSync(patchPath, replaced.text, 'utf8')
    return { ok: true, status: 'updated', needRestart: true, sandbox: mode }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, sandbox: mode, error: String((e && e.message) || e) }
  }
}

/** 把旧预设显示名「自动审批（Flash）」改成「自动审批」。 */
export function migratePresetCopy(patchPath) {
  try {
    const text = readFileSync(patchPath, 'utf8')
    const next = text
      .replace(/name:\s*自动审批（Flash）/g, 'name: 自动审批')
      .replace(
        /description:\s*Flash 预判写入\/命令是否不可回补：安全自动批准，有风险转人工审批。/g,
        'description: 审核模型预判写入/命令是否不可回补：安全自动批准，有风险转人工审批。',
      )
      .replace(
        /description:\s*判定模型预判写入\/命令是否不可回补：安全自动批准，有风险转人工审批。/g,
        'description: 审核模型预判写入/命令是否不可回补：安全自动批准，有风险转人工审批。',
      )
    if (next !== text) writeFileSync(patchPath, next, 'utf8')
  } catch { /* ignore */ }
}
