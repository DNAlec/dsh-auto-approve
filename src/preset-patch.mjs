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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { autoApprovePresetYaml, FULL_PERMISSION_BLOCK, normalizePresetSandbox } from './rules.mjs'
import { writeAtomic } from './util.mjs'

/**
 * auto-approve 预设键：必须缩进（`presets:` 下的子键）。
 *
 * 键可以带引号（`'auto-approve':`）、冒号前可以有空格；值可以为空、行尾注释
 * （`auto-approve:   # ours`）或行内 flow 值（`auto-approve: {…}`）——**这些都算「键已存在」**：
 * 认不出来就会再插一份，同一 mapping 里两个同名键，DSH 的 `yaml.load` 直接抛
 * `duplicated mapping key` / `Map keys must be unique` → profile 起不来。
 */
const AUTO_APPROVE_KEY = /^([ \t]+)(['"]?)auto-approve\2[ \t]*:(.*)\r?$/
/** permission 行：顶层 `- id: permission`，或 `insert:` 下的缩进形式；允许引号 id 与行尾注释。 */
const PERMISSION_ROW = /^([ \t]*)- id:[ \t]*(['"]?)permission\2(?:[ \t]+#.*)?[ \t]*\r?$/
/** 块内 sandbox 行：保留前缀缩进与行尾，只换值。值不吃 `,`/`{}`（flow 形态的条目分隔符）。 */
const SANDBOX_LINE = /^([ \t]+sandbox:[ \t]*)([^\s,{}]+?)([ \t]*\r?)$/
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
/**
 * 普通（折叠）多行标量的头：`key: 一段没有引号/flow 标记的文本`。
 * 它的**续行**也必须是更深缩进，与块标量同一条缩进规则。
 * 引号 / flow / 锚点 / 标签开头的值不算（它们不会把下面的行吃进标量里）。
 */
const PLAIN_SCALAR_HEAD = /^([ \t]*)(?:(-[ \t]+))?([^\s#][^:]*):[ \t]+([^'"{}[\]*&!|>%@#\s][^\r\n]*)\r?$/

function indentOf(line) {
  return (String(line || '').match(/^[ \t]*/) || [''])[0].length
}

/**
 * 计算「哪些行是标量正文」。
 *
 * 只回看紧邻的上一非空行是**不够**的：块标量从第二行起、普通多行标量的续行，
 * 其上一行都是正文而不是 `|`/`>` 头，于是正文里一行 `auto-approve:` 会被当成真键——
 * 预设永远不装，而 UI 显示「已配置」。判据用 YAML 自己的缩进规则：
 * 正文行必须比标量**头所在行**更深，遇到「非空且缩进 <= 头缩进」的行就退出标量。
 * @param {string[]} lines
 * @returns {Set<number>} 标量正文行的下标
 */
function scalarBodyLines(lines) {
  const body = new Set()
  let headIndent = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (headIndent !== null) {
      if (line.trim() === '') { body.add(i); continue }
      if (indentOf(line) > headIndent) { body.add(i); continue }
      headIndent = null
    }
    if (BLOCK_SCALAR_HEADER.test(line)) {
      headIndent = indentOf(line)
      continue
    }
    const plain = PLAIN_SCALAR_HEAD.exec(line)
    if (plain) headIndent = plain[1].length + (plain[2] ? plain[2].length : 0)
  }
  return body
}

/** 去掉行首 BOM：`\uFEFF[]` 会让每个「这行是什么」的判定全体错位（Windows 编辑器常见）。 */
function stripBom(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '')
}

/** 去掉列 0 的文档标记，保证写出的是**单文档** patch（多文档会被 DSH 拒绝）。 */
export function stripDocumentMarkers(text) {
  return stripBom(text)
    .split('\n')
    .filter((line) => !DOC_END_LINE.test(line) && !DOC_START_LINE.test(line))
    .join('\n')
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
 * 键允许带引号；`inline` 表示这一行键后面还有值（flow / 标量）——调用方必须自己决定
 * 能不能安全插入（`presets: {…}` 就属于「插不进去，要报错」）。
 * @returns {{ line: number, indent: number, inline: boolean } | null}
 */
function findBlockChild(lines, parentLine, parentIndent, key) {
  const re = new RegExp('^[ \\t]*([\'"]?)' + key + '\\1[ \\t]*:(.*)\\r?$')
  // 标量正文里的同名行不是键（`description: |` 里写一句 `presets:` 会被当真目标，
  // 于是插件往标量里插键、自检失败 → 合法的 profile 永远装不上预设）。
  const body = scalarBodyLines(lines)
  for (let i = parentLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent <= parentIndent) return null
    if (body.has(i)) continue
    const m = re.exec(line)
    if (!m) continue
    // `presets: null` / `presets: ~` 是显式的「空值」：往里补子键是安全的，
    // 不算「行内值」（行内 flow 映射才没法做文本插入）。
    const inlineValue = stripTrailingComment(m[2]).trim()
    if (inlineValue !== '' && inlineValue !== 'null' && inlineValue !== '~') {
      return { line: i, indent, inline: true }
    }
    // 值从**下一行**开始、且以 `{`/`[` 开头：那是 flow 集合，同样没法安全做文本插入
    // （往里插键会写出 bad indentation / duplicated key 的 patch）。
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next.trim() === '' || next.trim().startsWith('#')) continue
      if (indentOf(next) <= indent) break
      return { line: i, indent, inline: /^[ \t]*[{[]/.test(next) }
    }
    return { line: i, indent, inline: false }
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
  const lines = stripBom(text).split('\n')
  // 标量正文里的同名行不是键（`description: |` 里写一句 `read-only:` 会造成假的漂移告警）。
  const body = scalarBodyLines(lines)
  for (const row of findPermissionRows(lines)) {
    const presets = findPermissionPresets(lines, [row]).presets
    if (!presets) continue
    const keys = []
    // 直接子键的缩进 = 这个块里第一个键行的缩进（用户可以用 4 空格，写死 +2 会漏）。
    let childIndent = null
    for (let i = presets.line + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = indentOf(line)
      if (indent <= presets.indent) break
      if (body.has(i)) continue
      const m = /^[ \t]*(['"]?)([A-Za-z0-9._-]+)\1[ \t]*:/.exec(line)
      if (!m) continue
      if (childIndent === null) childIndent = indent
      if (indent !== childIndent) continue
      keys.push(m[2])
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
 *
 * **只在 permission 行自己的 presets 块里、且必须是它的直接子键**：
 *  - 别的插件 presets 里的同名键不算数；
 *  - 更深一层（`my-preset.actions.auto-approve:`）也不算——那会让 `configured=true`、
 *    `sandbox=''`，预设永远不装而 UI 说「已配置」；
 *  - 标量正文（`description: |` 的续行）不算；
 *  - 键允许引号与冒号前空格，值允许空 / 注释 / 行内 flow（都算「已存在」）。
 * 「直接子键」的缩进由**这个块里第一个键行**决定（用户可以用 4 空格；写死 `+2` 会漏判，
 * 而漏判 = 再插一份同名键 = profile 起不来）。
 * @param {string} text - patch 文件全文。
 * @returns {{ line: number, indent: number, inline: boolean } | null}
 */
export function findAutoApproveKey(text) {
  const lines = stripBom(text).split('\n')
  const body = scalarBodyLines(lines)
  /**
   * **只找生效行**（`findPermissionPresets` 选中的最后一条带 config 的 permission 行）里的键。
   * 扫全部行会让「键只存在于被覆盖的那一行」被判成「已配置」——`ensureAutoApprovePreset`
   * 于是报 `already`、永不修复，而 DSH 生效的 `config.presets` 里根本没有它（静默失效）。
   * 写入侧与检测侧必须是同一套目标选择，否则两者会互相打架。
   */
  const { presets } = findPermissionPresets(lines, findPermissionRows(lines))
  if (!presets) return null
  let childIndent = null
  for (let i = presets.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= presets.indent) break
    // 标量正文里的同名行不是键：认了它 = 预设永远不装、UI 还说「已配置」。
    if (body.has(i)) continue
    const m = AUTO_APPROVE_KEY.exec(line)
    if (!m) {
      if (childIndent === null && /:/.test(line)) childIndent = indent
      continue
    }
    if (childIndent === null) childIndent = indent
    if (indent !== childIndent) continue
    return { line: i, indent, inline: String(m[3] || '').trim() !== '' }
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
 * 行首 BOM 必须先剥掉：`\uFEFF[]` 会整条判不出空，于是拼出「`[]` + 条目」的非法 YAML
 * （Windows 编辑器另存就长这样）。
 */
export function isPatchArrayEmpty(text) {
  for (const line of stripBom(text).split('\n')) {
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
    // **所有** `[]` 行都要删掉（`[]\n[]\n` 也等价于空 patch）：只删第一个会拼出
    // `[]` 后面还有条目的 YAML，DSH 的 parsePatchList 直接抛错（profile 起不来）。
    const head = src
      .split('\n')
      .filter((line) => !EMPTY_ARRAY_LINE.test(line))
      .join('\n')
      .replace(/\s*$/, '')
    return (head ? head + '\n' : '') + tail + '\n'
  }
  return src.replace(/\s*$/, '') + '\n' + tail + '\n'
}


/** `presets:` 下面有没有直接子键（没有 = 空 mapping，DSH 会落到插件的 schema 默认表）。 */
function presetsHasChildren(lines, presets) {
  const body = scalarBodyLines(lines)
  for (let i = presets.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= presets.indent) break
    if (body.has(i)) continue
    return true
  }
  return false
}

export function getSetupState(patchPath) {
  try {
    const text = stripBom(readFileSync(patchPath, 'utf8'))
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
    return readAutoApproveSandboxFromText(stripBom(readFileSync(patchPath, 'utf8')))
  } catch {
    return ''
  }
}

/**
 * 行内 flow mapping 形态（`auto-approve: { sandbox: read-only, approval: ask }`）。
 * 单行 flow 值也是「键已存在」（见 `AUTO_APPROVE_KEY`），所以 sandbox 的读写必须认它，
 * 否则设置页会显示「已配置」但每次点模式都报「没有 sandbox 行」——而 sandbox 明明在里面。
 *
 * 匹配前先切掉行尾注释：`auto-approve: { approval: ask } # sandbox: read-only` 里的
 * `sandbox:` 只是注释，认了它就会「只改注释还报成功」。
 * @returns {RegExpExecArray | null} 匹配 `sandbox: <值>` 的那一段（含缩进/逗号边界）
 */
function matchFlowSandbox(line) {
  const body = stripTrailingComment(String(line || ''))
  return /(^|[{,[ \t])sandbox[ \t]*:[ \t]*("[^"]*"|'[^']*'|[^\s,}]+)/.exec(body)
}

/** 切掉行尾注释（`… # 说明`）。引号里的 `#` 会被误切——README 里注明这个取舍。 */
function stripTrailingComment(line) {
  return String(line || '').replace(/[ \t]+#.*$/, '')
}

/** flow 值里的引号去掉：`"read-only"` → `read-only`（UI 要拿它跟预设值比对）。 */
function unquote(value) {
  const s = String(value == null ? '' : value)
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/** 键行上的 flow 值是否**在本行内闭合**（`{…}` / `[…]`）。没闭合就不能按块状路径改。 */
function flowClosed(line) {
  const text = stripTrailingComment(String(line || ''))
  const start = text.indexOf('auto-approve:')
  const rest = start === -1 ? text : text.slice(start + 'auto-approve:'.length)
  const value = rest.trim()
  if (!value.startsWith('{') && !value.startsWith('[')) return null
  const open = value[0]
  const close = open === '{' ? '}' : ']'
  return value.lastIndexOf(close) > 0
}

/** 读 auto-approve 块里的 sandbox 原值（不规范化，UI 要看到真实围栏）。 */
export function readAutoApproveSandboxFromText(text) {
  const src = String(text || '')
  const key = findAutoApproveKey(src)
  if (!key) return ''
  const lines = src.split('\n')
  const keyLine = lines[key.line]
  const closed = flowClosed(keyLine)
  if (closed === false) return '' // 多行 flow：本插件不解析（改写路径会明确报错）
  const flow = matchFlowSandbox(keyLine.slice(keyLine.indexOf('auto-approve:') + 'auto-approve:'.length))
  if (flow) return unquote(flow[2])
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
  // 行内 flow：只改这一行里的那个值，其余原样（不做 flow→块状的重写，那会动用户的排版）。
  // **跨行的 flow 不碰**：文本替换会吃掉条目分隔符，写出的 YAML 解析不了（profile 起不来），
  // 所以那种形态返回 `found: false`，由调用方报「请改成分块写法」。
  const closed = flowClosed(lines[key.line])
  if (closed === false) return { text: src, changed: false, found: false }
  const flow = matchFlowSandbox(lines[key.line])
  if (flow) {
    const raw = flow[2]
    if (unquote(raw) === mode) return { text: src, changed: false, found: true }
    const at = flow.index + flow[0].length - raw.length
    lines[key.line] = lines[key.line].slice(0, at) + mode + lines[key.line].slice(at + raw.length)
    return { text: lines.join('\n'), changed: true, found: true }
  }
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


/**
 * presets 块里直接子键的缩进：取第一个键行的缩进（用户可以用 4 空格），
 * 拿不到就按惯例 `presets.indent + 2`。
 */
function autoApproveChildIndent(lines, presets) {
  for (let i = presets.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= presets.indent) break
    if (/:/.test(line)) return indentOf(line)
  }
  return presets.indent + 2
}

/**
 * 数一数**看起来像 auto-approve 键**的行（引号/空格/行内值都算，排除标量正文）。
 * 只在写盘前做自检用：结果必须恰好是 1。
 */
/**
 * 目标 mapping 里有没有**认不出的键写法**：标签（`!!str k:`）、锚点（`&a k:`）、别名（`*a`）、
 * 转义（`"auto\u002Dapprove"`）、显式键（`? k`）……这些写法与普通键在 YAML 里等价，
 * 文本扫描认不全——认不出就不写盘，绝不去赌「大概不冲突」。
 * 引号包着的**简单**键（`'auto-approve':`）是我们认得的形态，不算风险。
 */
function hasUnrecognizedKeyForm(lines, presetsLine, presetsIndent, childIndent) {
  const body = scalarBodyLines(lines)
  for (let i = presetsLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= presetsIndent) break
    if (body.has(i) || indentOf(line) !== childIndent) continue
    const raw = line.trim()
    if (raw.startsWith('?') || raw.startsWith('-')) return true
    const colon = raw.indexOf(':')
    const keyPart = colon === -1 ? raw : raw.slice(0, colon)
    if (/[\\&!*%]/.test(keyPart)) return true
  }
  return false
}

function countMentionsInPresetsBlock(lines, presetsLine, presetsIndent, childIndent) {
  const body = scalarBodyLines(lines)
  let n = 0
  for (let i = presetsLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= presetsIndent) break
    if (body.has(i)) continue
    // 只数**将被写入的那个 mapping 的层级**：更深一层的嵌套键（`my-preset.actions.auto-approve`）
    // 与别的 presets 块里的同名键都不会与我们的键撞车，数进来只会误拦。
    if (indentOf(line) !== childIndent) continue
    // **只要这一行提到 `auto-approve` 就算**：同一个键有无数等价写法（引号、标签 `!!str`、
    // 锚点 `&a`、转义 `"auto\u002Dapprove"`、显式键 `? key`、序列项、flow `{auto-approve: …}`），
    // 穷举不过来。判据宽于识别正则的代价只是「奇怪文件被拒绝写盘」，
    // 窄的代价是「写坏用户的 profile」——两者不对等。
    if (autoApproveKeyName(line) === 'auto-approve') n += 1
  }
  return n
}

/**
 * 一行的**键名**（去掉行首的 `- `/`? `、YAML 标签 `!!str` / 锚点 `&a`、两侧引号与冒号后的值）。
 * `my-auto-approve:` 这种只是名字里含子串的键**不是** `auto-approve`——把它算进去会让
 * 一个完全合法的文件被永久拒绝写盘。
 */
function autoApproveKeyName(line) {
  let s = String(line || '').trim()
  s = s.replace(/^-[ \t]+/, '').replace(/^\?[ \t]*/, '')
  s = s.replace(/^![^\s]*[ \t]+/, '').replace(/^&[^\s]*[ \t]+/, '')
  const colon = s.indexOf(':')
  const keyPart = (colon === -1 ? s : s.slice(0, colon)).trim()
  const unquoted = keyPart.length >= 2
    && ((keyPart[0] === '"' && keyPart.endsWith('"')) || (keyPart[0] === "'" && keyPart.endsWith("'")))
    ? keyPart.slice(1, -1)
    : keyPart
  return unquoted.trim()
}

/**
 * 写盘前的最后一道闸门：插入后的文本里**有且只有一个** auto-approve 键。
 *
 * 文本扫描不可能穷举 YAML 的所有写法（引号、flow、奇怪缩进……），但「同名键出现两次」
 * 的后果是 `dsh web` 起不来。所以这里用一条宽判据兜底：认不出键形态 == 不去写这个文件，
 * 让设置页报错、由人来处理，比写坏用户的 profile 好。
 */
function finishPresetInsert(patchPath, after, status, presetsLine, presetsIndent, childIndent) {
  if (hasStrayRootEmptyArray(after)) {
    return {
      ok: false,
      status: 'broken-patch',
      needRestart: false,
      code: 'err.preset',
      details: { error: 'patch mixes a bare [] with entries; it cannot be parsed, fix it by hand' },
    }
  }
  const afterLines = stripBom(after).split('\n')
  if (hasUnrecognizedKeyForm(afterLines, presetsLine, presetsIndent, childIndent)) {
    return {
      ok: false,
      status: 'unrecognized-key-form',
      needRestart: false,
      code: 'err.preset',
      details: { error: 'unrecognized key spelling in this presets block; refusing to write' },
    }
  }
  const seen = countMentionsInPresetsBlock(afterLines, presetsLine, presetsIndent, childIndent)
  // 判据是**绝对值 1**（写进去的那一条），不是「比插入前多一条」：插入前若已有一个
  // 我们**没认出**的键（显式键 `? auto-approve`、标签/锚点/转义写法……），
  // 「多一条」会正好成立，而结果仍是同名键冲突、`dsh web` 起不来。
  if (seen !== 1) {
    return {
      ok: false,
      status: 'unrecognized-key-form',
      needRestart: false,
      code: 'err.preset',
      details: { error: `unrecognized auto-approve key layout (keys in this mapping=${seen})` },
    }
  }
  writeAtomic(patchPath, after)
  return { ok: true, status, needRestart: true }
}

/**
 * 空 patch / 追加整块：这条路上没有可用的 presets 块范围，改为检查
 * 「有没有认不出的 permission 行」——同 id 的两条 patch 里后写的 config 会**整块覆盖**
 * 前一条，静默丢掉用户自己的 presets。
 */
function writeComposed(patchPath, text, block, status) {
  const composed = composePatchText(text, block)
  if (hasStrayRootEmptyArray(composed)) {
    return {
      ok: false,
      status: 'broken-patch',
      needRestart: false,
      code: 'err.preset',
      details: { error: 'patch mixes a bare [] with entries; it cannot be parsed, fix it by hand' },
    }
  }
  const lines = stripBom(text).split('\n')
  const body = scalarBodyLines(lines)
  for (let i = 0; i < lines.length; i++) {
    if (body.has(i)) continue
    const line = lines[i]
    if (/^[ \t]*#/.test(line)) continue
    if (!/^[ \t]*-[ \t]+id[ \t]*:/.test(line)) continue
    if (!line.includes('permission')) continue
    if (PERMISSION_ROW.test(line)) continue
    return {
      ok: false,
      status: 'unrecognized-id-form',
      needRestart: false,
      code: 'err.preset',
      details: { error: 'unrecognized permission row spelling; refusing to add a second row' },
    }
  }
  writeAtomic(patchPath, composed)
  return { ok: true, status, needRestart: true }
}


/**
 * 找 permission 行的**块状 `config` 与它下面的 `presets`**。
 *
 * 只认 `config.presets`：DSH 的 permission 服务只读这一层，行级错位的 `presets:`
 * （写在 `- id: permission` 下、不在 `config` 里）是死配置——认了它就会「往死配置里插键，
 * UI 说已配置、预设其实不存在」，或者反过来「说没配置、每次启动再插一份」。
 *
 * 同一 id 可以出现多条 patch 时**后写的 config 整块覆盖前一条**（`vendor/include` 的
 * `target[key] = value`，不做深合并），所以目标必须是**最后一条**带 config 的 permission 行：
 * 认成第一条就会把键插进被覆盖的那一行——RPC 报成功、UI 说「已配置」，
 * 而 DSH 合成后 `config.presets` 里根本没有它。
 * @returns {{ config: object|null, presets: object|null, inlineConfig: boolean, inlinePresets: boolean }}
 */
function findPermissionPresets(lines, rows) {
  const out = { config: null, presets: null, inlineConfig: false, inlinePresets: false }
  // 只看**最后一条** permission 行：它的 config 在 DSH 里整块覆盖前面的。
  // 更早的行一律不参与——它们的 presets 可能仍然存在（不是我们该写的地方），
  // 从这里读出来会让「已配置」判定与 DSH 的真实结果脱节。
  const ordered = [...rows].reverse()
  for (const row of ordered) {
    const config = findBlockChild(lines, row.line, row.indent, 'config')
    if (!config) continue
    if (config.inline) {
      out.inlineConfig = true
      return out
    }
    out.config = config
    const inner = findBlockChild(lines, config.line, config.indent, 'presets')
    if (inner && inner.inline) out.inlinePresets = true
    else if (inner) out.presets = inner
    return out
  }
  return out
}


/**
 * 根部同时存在裸 `[]` 与条目 = 这份 patch 本来就解析不了（DSH 的 `parsePatchList` 直接抛）。
 * 插件不该在这种文件上「报成功」——写进去的键永远生效不了，用户还以为是插件没装。
 * 列 0 的 `[]` 只可能是根数组字面量（缩进的 `[]` 是某个键的空值，不算）。
 */
function hasStrayRootEmptyArray(text) {
  const lines = String(text || '').split('\n')
  let rootEmpty = false
  let rootEntry = false
  for (const line of lines) {
    if (/^\[\][ \t]*(?:#.*)?\r?$/.test(line)) rootEmpty = true
    else if (/^[ \t]*- /.test(line)) rootEntry = true
  }
  return rootEmpty && rootEntry
}

export function ensureAutoApprovePreset(patchPath, sandbox = 'workspace-write') {
  try {
    // **必须先剥 BOM**：`\uFEFF- id: permission` 会让 findPermissionRows 一条都认不出，
    // 于是走「追加整块」写出第二条 permission 行——patch 语义下后写的 config 整块覆盖，
    // 用户自己的 presets 静默消失。
    const text = stripBom(readFileSync(patchPath, 'utf8'))
    if (hasAutoApprovePreset(text)) return { ok: true, status: 'already', needRestart: false }

    const lines = text.split('\n')
    const rows = findPermissionRows(lines)

    if (rows.length === 0) {
      const block = FULL_PERMISSION_BLOCK + autoApprovePresetYaml(sandbox)
      return writeComposed(patchPath, text, block, 'added-entry')
    }

    const found = findPermissionPresets(lines, rows)
    const { config: blockConfig, inlineConfig, inlinePresets } = found
    /**
     * 空的 `presets:`（null / 没有子键）等同于「没有这张表」：只往里插一个 auto-approve 键
     * 会把 mapping 实体化，**吃掉 permission 插件的 schema 默认表**（workspace-write /
     * danger-full-access 会被 default 顶掉）。这时按「没有 presets」处理，写整张出厂表。
     */
    const presets = found.presets && presetsHasChildren(lines, found.presets) ? found.presets : null
    // `presets:` 存在但是空值：往里补**子键**（不能另起一个 `presets:` —— 同名键重复，
    // DSH 直接抛错；也不能只补一个 auto-approve —— 会把插件的 schema 默认表吃掉）。
    if (found.presets && !presets) {
      // 显式空值（`presets: null` / `presets: ~`）必须先把值去掉再补子键：留着 `null`
      // 会让后面的缩进行被 YAML 解析成多行**标量**（值是 "null read-only: …"），
      // 而不是我们要的 mapping。
      // CRLF 文件的行尾带 `\r`，而 `.` 不匹配 `\r`、`$` 在无 `m` 时只认串尾——
      // 直接套正则会静默 no-op，于是子键被插到 `null` 之下（自检会拦住，但功能就废了）。
      const keyLine = lines[found.presets.line]
      const crlf = keyLine.endsWith('\r')
      lines[found.presets.line] = keyLine.replace(/\r$/, '')
        .replace(/^([ \t]*)(['"]?)presets\2[ \t]*:.*$/, '$1$2presets$2:') + (crlf ? '\r' : '')
      const full = shippedPresetsBlock(sandbox, found.presets.indent - 4).replace(/\s*$/, '')
      const entriesRaw = full.split('\n').slice(1).join('\n')
      // 插入的行跟随原文件的换行风格，别把 CRLF 文件写成混合换行。
      // 末尾那个 `\r` 不能少：这一整块是作为**一个数组元素**插进去的，它与下一行之间
      // 由 `lines.join('\n')` 补分隔符——不补 `\r` 就会留下一行 LF 结尾（混合换行）。
      const entries = crlf ? entriesRaw.split('\n').join('\r\n') + '\r' : entriesRaw
      lines.splice(found.presets.line + 1, 0, entries)
      const next = lines.join('\n')
      const withNewline = next.endsWith('\n') ? next : next + '\n'
      // 状态沿用 `added-preset`：对调用方来说就是「往 presets 里补了一张表」，与旧行为一致。
      return finishPresetInsert(patchPath, withNewline, 'added-preset', found.presets.line, found.presets.indent, found.presets.indent + 2)
    }
    // `presets:` 自己是行内 flow 值（`presets: {other: {…}}`）：往它里面插键会造出重复的
    // `presets:`（同名键 → profile 起不来），所以与行内 config 同样处理：明确报错。
    if (inlinePresets) {
      return { ok: false, status: 'no-presets-key', needRestart: false, code: 'err.noPresetsKey' }
    }

    if (!presets) {
      // `config` 是块状、但没有 `presets`：把整个出厂表插进那个 config，保留它的其它键
      // （例如 defaultPreset）。
      if (blockConfig) {
        const insertAt = blockEndIndex(lines, blockConfig.line, blockConfig.indent)
        const block = shippedPresetsBlock(sandbox, blockConfig.indent + 2 - 4).replace(/\s*$/, '')
        if (block) {
          lines.splice(insertAt + 1, 0, block)
          const next = lines.join('\n')
          const withNewline = next.endsWith('\n') ? next : next + '\n'
          // 新插入的 presets 块：块内直接子键的缩进 = config.indent + 2。
          return finishPresetInsert(patchPath, withNewline, 'added-presets-key', insertAt + 1, blockConfig.indent + 2, blockConfig.indent + 4)
        }
      }
      // 没有可插入的块状 config：要么它只有 name/inject（追加整块没问题，因为它本来就没
      // 提供 config），要么是行内 flow config（文本插入不安全 → 明确报错）。
      if (inlineConfig || rows.some((row) => hasInlineConfigLine(lines, row))) {
        return { ok: false, status: 'no-presets-key', needRestart: false, code: 'err.noPresetsKey' }
      }
      const block = FULL_PERMISSION_BLOCK + autoApprovePresetYaml(sandbox)
      return writeComposed(patchPath, text, block, 'added-entry')
    }
    // 插到 presets 块最后一个子键之后：块结束于第一条缩进 <= presets 的非空行。
    const insertAt = blockEndIndex(lines, presets.line, presets.indent)
    // 直接子键的缩进与用户文件一致（用户可以用 4 空格），而不是写死 +2。
    const childIndent = autoApproveChildIndent(lines, presets)
    lines.splice(insertAt + 1, 0, autoApprovePresetYaml(sandbox, childIndent).replace(/\n$/, ''))
    const next = lines.join('\n')
    const withNewline = next.endsWith('\n') ? next : next + '\n'
    return finishPresetInsert(patchPath, withNewline, 'added-preset', presets.line, presets.indent, childIndent)
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
    const text = stripBom(readFileSync(patchPath, 'utf8'))
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
    writeAtomic(patchPath, replaced.text)
    return { ok: true, status: 'updated', needRestart: true, sandbox: mode }
  } catch (e) {
    return { ok: false, status: 'error', needRestart: false, sandbox: mode, code: 'err.preset', details: { error: String((e && e.message) || e) } }
  }
}

/** 把旧预设显示名「自动审批（Flash）」改成「自动审批」。 */
export function migratePresetCopy(patchPath) {
  try {
    const text = stripBom(readFileSync(patchPath, 'utf8'))
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
    if (next !== text) writeAtomic(patchPath, next)
  } catch { /* ignore */ }
}
