/**
 * 把 auto-approve 预设写入 profile 的 cordis.patch.yml。
 * 权限表冻结，不能运行时扩展 presets。改 sandbox 后必须重启并重新选预设。
 *
 * 这个文件里所有「是否已存在 auto-approve」的判断都必须用**缩进键锚定**，
 * 不能用 `text.includes('auto-approve:')`：后者会被注释、description、块标量
 * 里的同名子串骗到，结果是预设永远不装且 UI 不报警。
 * 空 patch（`[]`、`[] # 注释`、`---` + `[]`、注释 + `[]`、只有注释）必须整段替换成块，
 * 绝不能拼成 `[]\n- id: permission`（YAML 两个根节点，profile 直接起不来）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { autoApprovePresetYaml, FULL_PERMISSION_BLOCK, normalizePresetSandbox } from './rules.mjs'

/** auto-approve 预设键：必须缩进（`presets:` 下的子键），排除注释和行内文本。 */
const AUTO_APPROVE_KEY = /^([ \t]+)auto-approve:[ \t]*\r?$/
/** permission 行：顶层 `- id: permission`，或 `insert:` 下的缩进形式；允许行尾注释。 */
const PERMISSION_ROW = /^([ \t]*)- id:[ \t]*permission(?:[ \t]+#.*)?[ \t]*\r?$/
/** 块内 sandbox 行：保留前缀缩进与行尾，只换值。 */
const SANDBOX_LINE = /^([ \t]+sandbox:[ \t]*)(\S+?)([ \t]*\r?)$/
/** 空数组字面量行，允许行尾注释（`[] # empty`）。 */
const EMPTY_ARRAY_LINE = /^[ \t]*\[\][ \t]*(?:#.*)?\r?$/
/** YAML 文档标记行：结构行，不算「有内容」。 */
const DOC_MARKER_LINE = /^[ \t]*(?:---|\.\.\.)[ \t]*(?:#.*)?\r?$/
/**
 * 文档标记（**只认列 0**：块标量里的同名行是缩进的，属于内容，不能动）。
 * `...` 结束文档：在它后面追加条目会变成两个文档，DSH 的 parsePatchList 直接抛错。
 * 写盘前一律去掉——列 0 的 `---` / `...` 只可能是文档标记。
 */
const DOC_END_LINE = /^\.\.\.[ \t]*(?:#.*)?\r?$/
const DOC_START_LINE = /^---[ \t]*(?:#.*)?\r?$/
/** 块标量头（`key: |`、`key: >-`、`- |2`）：它后面缩进行是字面文本，不是 YAML 键。 */
const BLOCK_SCALAR_HEADER = /(?:^|:)[ \t]*(?:-[ \t]+)?[|>](?:[+-]?\d*|\d*[+-]?)?[ \t]*(?:#.*)?\r?$/

function indentOf(line) {
  return (String(line || '').match(/^[ \t]*/) || [''])[0].length
}

/** 去掉列 0 的文档标记，保证写出的是**单文档** patch（多文档会被 DSH 拒绝）。 */
export function stripDocumentMarkers(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !DOC_END_LINE.test(line) && !DOC_START_LINE.test(line))
    .join('\n')
}

/** 上一个非空行（用于识别块标量头）。 */
function previousContentLine(lines, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (String(lines[i]).trim() !== '') return lines[i]
  }
  return ''
}

/** 找所有 permission 行（顶层或 insert 里的缩进形式）。 */
function findPermissionRows(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = PERMISSION_ROW.exec(lines[i])
    if (m) out.push({ line: i, indent: m[1].length })
  }
  return out
}

/** 父行缩进块的最后一个子行下标（没有子行时返回父行本身）。 */
function blockEndIndex(lines, parentLine, parentIndent) {
  let last = parentLine
  for (let i = parentLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (indentOf(line) <= parentIndent) break
    last = i
  }
  return last
}

/**
 * 行内（flow 风格）`config:` 行：`  config: {…}` / `  config: !!js …`。
 * 这种形态没法安全做文本插入，只能明确报错，不能猜。
 */
function hasInlineConfigLine(lines, row) {
  for (let i = row.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent <= row.indent) return false
    if (indent === row.indent + 2 && /^[ \t]*config:[ \t]*\S/.test(line)) return true
  }
  return false
}

/**
 * 在一行的缩进块里找直接子键（缩进必须大于父行）。
 * 比写死 `^ {4}presets:` 稳：`insert:` 形式与别的缩进都不会错位。
 */
function findBlockChild(lines, parentLine, parentIndent, key) {
  const re = new RegExp('^[ \\t]*' + key + ':[ \\t]*\\r?$')
  for (let i = parentLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= parentIndent) return null
    if (re.test(line)) return { line: i, indent }
  }
  return null
}

/**
 * 从 patch 文本里抽出 `permission` 行 `config.presets` 的直接子键。
 * 纯文本扫描（插件不引 YAML 依赖）；找不到 permission/presets 时返回 null。
 * 出厂 base 的 patch 与 profile 的 patch 都可以用。
 * @param {string} text - patch 文件全文。
 * @returns {string[] | null}
 */
export function extractPresetKeysFromPatchText(text) {
  const lines = String(text || '').split('\n')
  for (const row of findPermissionRows(lines)) {
    const presets = findBlockChild(lines, row.line, row.indent, 'presets')
    if (!presets) continue
    const keys = []
    for (let i = presets.line + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = indentOf(line)
      if (indent <= presets.indent) break
      if (indent !== presets.indent + 2) continue
      const m = /^[ \t]*([A-Za-z0-9._-]+):[ \t]*\r?$/.exec(line)
      if (m) keys.push(m[1])
    }
    return keys
  }
  return null
}

/**
 * 读 DSH 出厂 `@deepseek-ai/dsh-base` 的 permission 预设键。
 * 找不到（打包版、profile 布局不同）时 ok:false —— 调用方必须保持沉默，不要据此报警。
 * @param {string} profileDir - profile 目录（`dirname(profilePatch)`）。
 * @returns {{ ok: boolean, keys: string[], path?: string }}
 */
export function readBasePresetKeys(profileDir) {
  const dir = String(profileDir || '')
  if (!dir) return { ok: false, keys: [] }
  for (const root of [join(dir, 'node_modules'), join(dirname(dir), 'node_modules')]) {
    const pkgDir = join(root, '@deepseek-ai', 'dsh-base')
    try {
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
      const rel = manifest && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
      if (typeof rel !== 'string' || !rel) continue
      const patchPath = join(pkgDir, rel)
      const keys = extractPresetKeysFromPatchText(readFileSync(patchPath, 'utf8'))
      if (keys && keys.length) return { ok: true, keys, path: patchPath }
    } catch { /* 试下一个候选 */ }
  }
  return { ok: false, keys: [] }
}

/**
 * 出厂预设表与 profile 里那份的差异。
 * 插件写入的 `permission` 行会**整块替换** base 的 config（patch 语义：按 id 覆盖时
 * config 是整体赋值，不做深合并），所以 DSH 新增的预设不会自动出现。
 * 这里只做检测，供日志与设置页提示；不自动改写用户文件。
 * @param {string[]} baseKeys - 出厂键。
 * @param {string[]} ourKeys - profile 里的键。
 * @returns {{ missing: string[], extra: string[] }}
 */
export function presetDrift(baseKeys, ourKeys) {
  const base = Array.isArray(baseKeys) ? baseKeys : []
  const ours = Array.isArray(ourKeys) ? ourKeys : []
  return {
    missing: base.filter((key) => !ours.includes(key)),
    extra: ours.filter((key) => !base.includes(key)),
  }
}

/**
 * 找 auto-approve 预设键的行号与缩进。
 * **只在 permission 行自己的 presets 块里找**：别的插件 presets 里的同名键不算数
 * （误判的代价是「以为已配置」，预设永远不装且 UI 不报警）。
 * 同时排除注释、行内文本，以及块标量（`description: |`）里的同名文本行。
 * @param {string} text - patch 文件全文。
 * @returns {{ line: number, indent: number } | null}
 */
export function findAutoApproveKey(text) {
  const lines = String(text || '').split('\n')
  for (const row of findPermissionRows(lines)) {
    const presets = findBlockChild(lines, row.line, row.indent, 'presets')
    if (!presets) continue
    for (let i = presets.line + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') continue
      const indent = indentOf(line)
      if (indent <= presets.indent) break
      const m = AUTO_APPROVE_KEY.exec(line)
      if (!m) continue
      if (BLOCK_SCALAR_HEADER.test(previousContentLine(lines, i))) continue
      return { line: i, indent: m[1].length }
    }
  }
  return null
}

/** patch 里是否真的有 auto-approve 预设（不是注释里提过一句）。 */
export function hasAutoApprovePreset(text) {
  return findAutoApproveKey(text) !== null
}

/**
 * patch 是否等价于空数组：没有顶层条目。
 * 只认注释、空行、`---`/`...` 与 `[]`（可带行尾注释）——
 * DSH 生成 profile 时写的模板就是「注释 + `[]`」。
 */
export function isPatchArrayEmpty(text) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (DOC_MARKER_LINE.test(line) || EMPTY_ARRAY_LINE.test(line)) continue
    return false
  }
  return true
}

/**
 * 把块并入 patch 文本。空数组时**替换**那个 `[]`（保留注释），否则追加。
 * 两种分支都会先去掉列 0 的文档标记：`...` 结束文档，在它后面追加会产出
 * 多文档 YAML，DSH 的 parsePatchList 直接抛错（profile 起不来）。
 * 任何情况下都不会产出「`[]` 后面还有条目」或「两个文档」的非法 YAML。
 */
export function composePatchText(text, block) {
  const src = stripDocumentMarkers(text)
  const tail = String(block || '').replace(/^\n/, '').replace(/\s*$/, '')
  if (isPatchArrayEmpty(src)) {
    const head = src.replace(/^[ \t]*\[\][ \t]*(?:#.*)?\r?\n?/m, '').replace(/\s*$/, '')
    return (head ? head + '\n' : '') + tail + '\n'
  }
  return src.replace(/\s*$/, '') + '\n' + tail + '\n'
}

export function getSetupState(patchPath) {
  try {
    const text = readFileSync(patchPath, 'utf8')
    return {
      configured: hasAutoApprovePreset(text),
      patchPath,
      sandbox: readAutoApproveSandboxFromText(text),
      presets: extractPresetKeysFromPatchText(text) || [],
    }
  } catch (e) {
    return { configured: false, patchPath, sandbox: '', presets: [], error: String((e && e.message) || e) }
  }
}

export function readAutoApproveSandbox(patchPath) {
  try {
    return readAutoApproveSandboxFromText(readFileSync(patchPath, 'utf8'))
  } catch {
    return ''
  }
}

/** 读 auto-approve 块里的 sandbox 原值（不规范化，UI 要看到真实围栏）。 */
export function readAutoApproveSandboxFromText(text) {
  const src = String(text || '')
  const key = findAutoApproveKey(src)
  if (!key) return ''
  const lines = src.split('\n')
  for (let i = key.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== '' && indentOf(line) <= key.indent) break
    const m = SANDBOX_LINE.exec(line)
    if (m) return m[2]
  }
  return ''
}

/**
 * 只改 auto-approve 块里的 sandbox 值。找不到块或块里没有 sandbox 行时
 * `found: false`，由调用方报错，绝不假装成功（否则 UI 说 read-only、围栏还是全权限）。
 * @returns {{ text: string, changed: boolean, found: boolean }}
 */
export function replaceAutoApproveSandbox(text, sandbox) {
  const src = String(text || '')
  const mode = normalizePresetSandbox(sandbox)
  const key = findAutoApproveKey(src)
  if (!key) return { text: src, changed: false, found: false }
  const lines = src.split('\n')
  for (let i = key.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== '' && indentOf(line) <= key.indent) break
    const m = SANDBOX_LINE.exec(line)
    if (!m) continue
    if (m[2] === mode) return { text: src, changed: false, found: true }
    lines[i] = m[1] + mode + m[3]
    return { text: lines.join('\n'), changed: true, found: true }
  }
  return { text: src, changed: false, found: false }
}

/**
 * 出厂预设表按 delta 重新缩进（从 FULL_PERMISSION_BLOCK 里原样取出，避免维护两份表）。
 * @param {string} sandbox - auto-approve 的沙箱模式。
 * @param {number} delta - 目标 presets 缩进相对出厂 4 空格的偏移。
 */
function shippedPresetsBlock(sandbox, delta) {
  const lines = FULL_PERMISSION_BLOCK.split('\n')
  const start = lines.findIndex((line) => /^ {4}presets:[ \t]*$/.test(line))
  /* v8 ignore next -- FULL_PERMISSION_BLOCK 是常量，必然含 presets 键 */
  if (start === -1) return ''
  const pad = ' '.repeat(Math.max(0, delta))
  const body = lines.slice(start).map((line) => (line.trim() === '' ? line : pad + line)).join('\n')
  return body.replace(/\s*$/, '') + '\n' + autoApprovePresetYaml(sandbox, 6 + delta)
}

export function ensureAutoApprovePreset(patchPath, sandbox = 'workspace-write') {
  try {
    const text = readFileSync(patchPath, 'utf8')
    if (hasAutoApprovePreset(text)) return { ok: true, status: 'already', needRestart: false }

    const lines = text.split('\n')
    const rows = findPermissionRows(lines)

    if (rows.length === 0) {
      const block = FULL_PERMISSION_BLOCK + autoApprovePresetYaml(sandbox)
      writeFileSync(patchPath, composePatchText(text, block), 'utf8')
      return { ok: true, status: 'added-entry', needRestart: true }
    }

    // 同一个 id 可以出现多条 patch（后写的 config 生效），取第一条带 presets 的。
    let presets = null
    for (const row of rows) {
      presets = findBlockChild(lines, row.line, row.indent, 'presets')
      if (presets) break
    }

    if (!presets) {
      // 行里没有 presets：如果它有块状 `config:`（单独一行、无行内内容），
      // 把整个出厂表插进那个 config，保留用户已有的其它键（例如 defaultPreset）。
      for (const row of rows) {
        const config = findBlockChild(lines, row.line, row.indent, 'config')
        if (!config) continue
        const insertAt = blockEndIndex(lines, config.line, config.indent)
        const block = shippedPresetsBlock(sandbox, config.indent + 2 - 4).replace(/\s*$/, '')
        if (!block) break
        lines.splice(insertAt + 1, 0, block)
        const next = lines.join('\n')
        writeFileSync(patchPath, next.endsWith('\n') ? next : next + '\n', 'utf8')
        return { ok: true, status: 'added-presets-key', needRestart: true }
      }
      // 一条 permission 行都没有可插入的块状 config：要么它只有 name/inject（追加整块没问题，
      // 因为它本来就没提供 config），要么是行内 flow config（文本插入不安全 → 明确报错）。
      if (rows.some((row) => hasInlineConfigLine(lines, row))) {
        return { ok: false, status: 'no-presets-key', needRestart: false, code: 'err.noPresetsKey' }
      }
      const block = FULL_PERMISSION_BLOCK + autoApprovePresetYaml(sandbox)
      writeFileSync(patchPath, composePatchText(text, block), 'utf8')
      return { ok: true, status: 'added-entry', needRestart: true }
    }
    // 插到 presets 块最后一个子键之后：块结束于第一条缩进 <= presets 的非空行。
    const insertAt = blockEndIndex(lines, presets.line, presets.indent)
    lines.splice(insertAt + 1, 0, autoApprovePresetYaml(sandbox, presets.indent + 2).replace(/\n$/, ''))
    const next = lines.join('\n')
    writeFileSync(patchPath, next.endsWith('\n') ? next : next + '\n', 'utf8')
    return { ok: true, status: 'added-preset', needRestart: true }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, code: 'err.preset', details: { error: String((e && e.message) || e) } }
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
    if (!replaced.found) {
      // 预设存在但块里没有 sandbox 行：必须报错，不能返回 ok 让 UI 以为写成功。
      return {
        ok: false,
        status: 'no-sandbox-line',
        needRestart: false,
        sandbox: mode,
        code: 'err.presetSandboxMissing',
        details: { path: String(patchPath || '') },
      }
    }
    if (!replaced.changed) {
      return {
        ok: true,
        status: ensured.status === 'already' ? 'unchanged' : ensured.status,
        needRestart: Boolean(ensured.needRestart),
        sandbox: mode,
      }
    }
    writeFileSync(patchPath, replaced.text, 'utf8')
    return { ok: true, status: 'updated', needRestart: true, sandbox: mode }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, sandbox: mode, code: 'err.preset', details: { error: String((e && e.message) || e) } }
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
