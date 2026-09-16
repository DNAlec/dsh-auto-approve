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

/** permission 行：顶层 `- id: permission`，或 `insert:` 下的缩进形式；允许引号 id 与行尾注释。 */
const PERMISSION_ROW = /^([ \t]*)- id:[ \t]*(['"]?)permission\2(?:[ \t]+#.*)?[ \t]*\r?$/
/** 块内 sandbox 行：保留前缀缩进与行尾，只换值。值不吃 `,`/`{}`（flow 形态的条目分隔符）；允许引号键与行尾注释。 */
const SANDBOX_LINE = /^([ \t]+(?:['"])?sandbox(?:['"])?[ \t]*:[ \t]*)([^\s,{}]+?)((?:[ \t]*#.*)?[ \t]*\r?)$/
/** 空数组字面量行，允许行尾注释（`[] # empty`）。 */
const EMPTY_ARRAY_LINE = /^[ \t]*\[\][ \t]*(?:#.*)?\r?$/
/** 单行空数组的**全部**写法：`[]`、`[ ]`（YAML 里都是合法空序列）。 */
const EMPTY_ARRAY_LINE_LOOSE = /^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?\r?$/
/** 折行的空数组：`[` 单独一行、下一行只有 `]`。 */
const FLOW_SEQ_OPEN_LINE = /^[ \t]*\[[ \t]*(?:#.*)?\r?$/
const FLOW_SEQ_CLOSE_LINE = /^[ \t]*\][ \t]*(?:#.*)?\r?$/
/**
 * 空数组字面量占用的行号集合。
 *
 * **为什么不只认裸 `[]`**：`[ ]` 和「`[` 换行 `]`」在 YAML 里同样是空序列，用户手改一下就长这样。
 * 只识别裸 `[]` 时它们会被当成「有内容的 patch」，于是往后面追加条目 → 拼出
 * 「flow 序列 + 块序列」的非法 YAML → DSH `yaml.load` 抛 `Unexpected seq-item-ind`、
 * `dsh web` 起不来，而这条路的自检还会报成功。
 */
function emptyArrayLines(lines) {
  const out = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (EMPTY_ARRAY_LINE_LOOSE.test(lines[i])) { out.add(i); continue }
    if (FLOW_SEQ_OPEN_LINE.test(lines[i]) && i + 1 < lines.length && FLOW_SEQ_CLOSE_LINE.test(lines[i + 1])) {
      out.add(i)
      out.add(i + 1)
      i += 1
    }
  }
  return out
}
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
/**
 * **引号**标量的头：`key: "第一行` / `key: '第一行`（本行内没闭合）。
 *
 * 引号标量可以跨行，而它的续行**允许与键同缩进**（js-yaml 实测：续行只需比**
 * 所属 mapping**更深，不比键更深）：
 *
 * ```yaml
 * presets:
 *   mine: "第一行
 *   auto-approve:      ← 这是标量正文，不是键
 *   说明"
 * ```
 *
 * 只认块标量与无引号多行标量时，续行里的 `auto-approve:` 会被当成真键 →
 * `configured=true` / `ensure` 报 `already` → 预设永不安装，而设置页在
 * `configured=true` 时**不渲染**「写入权限预设」按钮，用户没有任何补救入口。
 * @returns {{ indent: number, quote: string } | null}
 */
function quotedScalarHead(line) {
  const m = /^([ \t]*)(-[ \t]+)?([^\s#][^:]*):[ \t]*(["'])/.exec(line)
  if (!m) return null
  const quote = m[4]
  if (quoteClosesIn(line.slice(m[0].length), quote)) return null
  return { indent: m[1].length + (m[2] ? m[2].length : 0), quote }
}

/** 这段文本里有没有**未转义**的闭合引号（双引号里 `\"`、单引号里 `''` 都不算闭合）。 */
function quoteClosesIn(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') { i += 1; continue }
    if (text[i] !== quote) continue
    if (quote === "'" && text[i + 1] === "'") { i += 1; continue }
    return true
  }
  return false
}

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
  // `head.quoted` 的续行判据是 `>=`（引号标量允许与键同缩进，只要求比所属 mapping 深），
  // 块标量与无引号标量是 `>`（必须比键更深）。引号标量在闭合引号那一行结束。
  let head = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (head !== null) {
      if (line.trim() === '') { body.add(i); continue }
      const indent = indentOf(line)
      const inScalar = head.quoted ? indent >= head.indent : indent > head.indent
      if (inScalar) {
        body.add(i)
        if (head.quoted && quoteClosesIn(line, head.quote)) head = null
        continue
      }
      head = null
    }
    if (BLOCK_SCALAR_HEADER.test(line)) {
      head = { indent: indentOf(line), quoted: false }
      continue
    }
    const quoted = quotedScalarHead(line)
    if (quoted) {
      head = { indent: quoted.indent, quoted: true, quote: quoted.quote }
      continue
    }
    const plain = PLAIN_SCALAR_HEAD.exec(line)
    if (plain) head = { indent: plain[1].length + (plain[2] ? plain[2].length : 0), quoted: false }
  }
  return body
}

/**
 * 一行作为**键行**的键名（`:` 之前那一段，去两侧引号）；不是键行返回 `''`。
 *
 * 检测（`findAutoApproveKey`）、抽取（`extractPresetKeysFromPatchText`）与写入侧
 * （`directChildIndent`）三处必须共用同一个判据：曾经检测侧用 `/:/`「猜键」、
 * 写入侧用另一套正则，于是 presets 块里一条更深缩进、带 ASCII 冒号的注释就能让
 * 检测算出错误的 childIndent（`configured=false` + `ensure` 因自检数到 2 条而永久拒写，
 * 而 DSH 里那个预设其实生效）。
 *
 * **故意不剥 `- `/`? `/标签 `!!str` /锚点 `&a`**：那些写法在 js-yaml 里根本解析不了
 * （实测 `!!str auto-approve:` 报 `bad indentation of a mapping entry`），把它们当成
 * 「已配置」等于对一份坏文件说 ok。它们的键名自然不等于 `auto-approve`，于是走插入路径、
 * 由 `hasUnrecognizedKeyForm` 拒绝写盘（报错、文件不动）——这是既定取舍。
 */
function childKeyName(line) {
  const s = String(line || '').trim()
  if (s === '' || s.startsWith('#')) return ''
  if (/^[{[\]}]/.test(s)) return ''
  const colon = s.indexOf(':')
  if (colon <= 0) return ''
  const keyPart = unquote(s.slice(0, colon).trim()).trim()
  return keyPart
}

/**
 * presets 块里**直接子键**的缩进：第一个真键行的缩进；拿不到就按惯例 `indent + 2`。
 * 检测、抽取、写入三处共用（见 `childKeyName`）。
 */
function directChildIndent(lines, parent) {
  const body = scalarBodyLines(lines)
  for (let i = parent.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (indentOf(line) <= parent.indent) break
    if (body.has(i)) continue
    if (childKeyName(line) !== '') return indentOf(line)
  }
  return parent.indent + 2
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

/**
 * 这一行是不是**patch 条目**（而不是别的插件 config 里的一个列表项）。
 *
 * DSH 的 `parsePatchList` 只把顶层序列项当条目，`applyEntryPatches` 也只对 `entry.group`
 * （即 `insert:`）的 config 递归。所以：列 0 的序列项是条目；缩进的序列项只有在最近的
 * 更浅一行是 `- insert:` 时才是条目。`- id: other-plugin / config: / items: / - id: permission`
 * 这种嵌套列表项**不是**条目——把它当成 permission 行会让插件报 `configured=true`/`already`，
 * 而 DSH 里根本没有这条 permission 条目（用户也就永远看不到补救按钮）。
 */
function isPatchEntryLine(lines, index, body) {
  const indent = indentOf(lines[index])
  if (indent === 0) return true
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (body.has(i)) continue
    if (indentOf(line) >= indent) continue
    // 父行是普通键（`items:` / `inject:` / `config:` …）→ 它只是别人 config 里的列表项，不是条目。
    if (!/^[ \t]*-([ \t]|$)/.test(line)) return false
    // 父行是序列项：必须是**根级**条目（列 0，含单独的 `-`）或 `- insert:` 里的条目；
    // 别人 config 里更深一层的列表项（`list:` 下面缩进的 `- thing: x`）不算。
    return indentOf(line) === 0 || /^[ \t]*-[ \t]*insert[ \t]*:/.test(line)
  }
  return false
}

/** 找所有 permission 行（列 0 的条目，或 `- insert:` 里缩进的条目）。 */
function findPermissionRows(lines) {
  const out = []
  const body = scalarBodyLines(lines)
  for (let i = 0; i < lines.length; i++) {
    const m = PERMISSION_ROW.exec(lines[i])
    if (!m) continue
    if (!isPatchEntryLine(lines, i, body)) continue
    out.push({ line: i, indent: m[1].length })
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
  /**
   * **必须与写入/检测同一套目标**：DSH 按顺序应用 patch，同 id 后写的 `config` 整块覆盖
   * 前一条，所以生效的是**最后一条带 config 的 permission 行**。取第一条时，
   * 「被覆盖的那一行有完整出厂表、生效行只剩一个自定义预设」这种文件会算出
   * `missing=[]` → 漂移告警与设置页卡片双双静默，而用户的生效表已经丢掉了全部出厂预设。
   */
  const { presets } = findPermissionPresets(lines, findPermissionRows(lines))
  if (!presets) return null
  const childIndent = directChildIndent(lines, presets)
  const keys = []
  for (let i = presets.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= presets.indent) break
    if (body.has(i)) continue
    if (indent !== childIndent) continue
    // 键名用「`:` 之前那一段」判定，**不设字符集**：中文/空格/点号都是合法的 YAML 键，
    // 固定字符集会把中文键漏掉，于是 `childIndent` 被更深一层的 `sandbox:` 占位，
    // 预设表与漂移提示同时错。
    const name = childKeyName(line)
    if (name === '') continue
    keys.push(name)
  }
  return keys
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
  /**
   * **只找生效行**（`findPermissionPresets` 选中的最后一条带 config 的 permission 行）里的键。
   * 扫全部行会让「键只存在于被覆盖的那一行」被判成「已配置」——`ensureAutoApprovePreset`
   * 于是报 `already`、永不修复，而 DSH 生效的 `config.presets` 里根本没有它（静默失效）。
   * 写入侧与检测侧必须是同一套目标选择，否则两者会互相打架。
   */
  const { presets } = findPermissionPresets(lines, findPermissionRows(lines))
  if (!presets) return null
  // 直接子键的缩进与键名判据必须与抽取/写入侧共用（见 `childKeyName` / `directChildIndent`）：
  // 检测侧自己「猜键」（任何含 ASCII 冒号的行）时，一条更深缩进的注释就能让它算错缩进，
  // 结果是「DSH 里预设生效、插件说未配置」，而且再也写不进去（自检会数到 2 条键）。
  const childIndent = directChildIndent(lines, presets)
  const body = scalarBodyLines(lines)
  for (let i = presets.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= presets.indent) break
    // 标量正文里的同名行不是键：认了它 = 预设永远不装、UI 还说「已配置」。
    if (body.has(i)) continue
    if (indent !== childIndent) continue
    if (childKeyName(line) !== 'auto-approve') continue
    const colon = line.indexOf(':')
    // 行内值（flow / 注释）也算「键已存在」：`auto-approve:   # ours` 与 `{…}` 都算。
    return { line: i, indent, inline: stripTrailingComment(line.slice(colon + 1)).trim() !== '' }
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
  const lines = stripBom(text).split('\n')
  const empty = emptyArrayLines(lines)
  for (let i = 0; i < lines.length; i++) {
    if (empty.has(i)) continue
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (DOC_MARKER_LINE.test(lines[i])) continue
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
    const lines = src.split('\n')
    const empty = emptyArrayLines(lines)
    const head = lines
      .filter((line, i) => !empty.has(i))
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
    /**
     * 有「认不出的 permission 行」时报 `configured: false`：那条行可能排在后面把这一整块盖掉
     * （DSH 同 id 后者胜、config 整块赋值），此时说「已配置」会让设置页隐藏唯一的补救按钮。
     * 宁可让用户点一次「写入」看到明确报错（`unrecognized-id-form` 会告诉他手工改哪一行）。
     */
    const badRow = unrecognizedPermissionRowError(text.split('\n'))
    return {
      configured: !badRow && hasAutoApprovePreset(text),
      unrecognizedRow: Boolean(badRow),
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
 * 单行 flow 值也是「键已存在」（见 `findAutoApproveKey`），所以 sandbox 的读写必须认它，
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

/**
 * auto-approve 块里的**直接子键** `sandbox:` 行。
 *
 * 判据必须与 `findAutoApproveKey` 同级：只看这个块的第一层子键、且跳过标量正文。
 * 只看「缩进 + `sandbox:`」时，更深一层的 `args.sandbox:`、或块标量正文里的一行
 * `sandbox:` 都会被当成目标——插件报 ok/updated，而 DSH 生效的 auto-approve 里根本没有
 * sandbox（schema 里它是必填），读取还会把用户正文里的字符串当成模式。找不到就返回 null，
 * 由调用方报 `err.presetSandboxMissing`（AGENTS 要求的落点）。
 * @returns {{ line: number, match: RegExpExecArray } | null}
 */
function findSandboxLine(lines, key) {
  const body = scalarBodyLines(lines)
  const childIndent = directChildIndent(lines, key)
  for (let i = key.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= key.indent) break
    if (body.has(i)) continue
    if (indent !== childIndent) continue
    if (childKeyName(line) !== 'sandbox') continue
    const m = SANDBOX_LINE.exec(line)
    if (m) return { line: i, match: m }
  }
  return null
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
  const hit = findSandboxLine(lines, key)
  // 块状值同样可能带引号：读回来必须是真值，否则「同一个值」会被判成需要改写（误报「已写入」）。
  return hit ? unquote(hit.match[2]) : ''
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
  const hit = findSandboxLine(lines, key)
  if (!hit) return { text: src, changed: false, found: false }
  // 值可能是引号形式（`sandbox: "workspace-write"`）：比较前必须去引号，否则同一个值
  // 会被判成「需要改写」，设置页于是显示「已写入，请重启」而内容其实没变。
  if (unquote(hit.match[2]) === mode) return { text: src, changed: false, found: true }
  lines[hit.line] = hit.match[1] + mode + hit.match[3]
  return { text: lines.join('\n'), changed: true, found: true }
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
 * 这一行是不是「认不出的 permission 行写法」：行里有一个 `id` 键，它的值去掉标签/锚点前缀、
 * 两侧引号、行尾注释与 `\uXXXX`／`\xXX` 转义之后等于 `permission`。
 *
 * 判据故意放宽（宁可误拒）：块状正则认不出的拼写（`- id: !!str permission`、
 * `- id: "\u0070ermission"`、折行的 `- {id: permission, …}`、多行序列项里的 `id: permission`）
 * 一律不写盘——追加第二条同 id 的 permission 行时，DSH 里后写的 `config` **整块覆盖**前一条，
 * 用户自带的 presets 静默消失，而 RPC 报成功。
 */
function mentionsPermissionId(line, anchored) {
  const m = (anchored
    // 键行：`id` 必须是**这一行的键**（`inject: [{id: permission}]` 里那个只是别的键的值，
    // 不是 patch 条目的 id）。
    ? /^[ \t]*(?:-[ \t]*)?['"]?id['"]?[ \t]*:[ \t]*(.*)$/
    // 序列项：整行（含 flow mapping）就是这位条目本身，`{config: …, id: permission}` 也算。
    : /(^|[\s{[,])['"]?id['"]?[ \t]*:[ \t]*(.*)$/
  ).exec(String(line || ''))
  if (!m) return false
  const valueIndex = m.length - 1
  let value = String(m[valueIndex] || '').trim()
  value = value.replace(/[ \t]+#.*$/, '').trim()   // 行尾注释
  value = value.replace(/[,}\]].*$/, '').trim()    // flow 里的值结束符
  value = value.replace(/^![^\s]*[ \t]*/, '')      // 标签 `!!str`
  value = value.replace(/^&[^\s]*[ \t]*/, '')      // 锚点
  return decodeYamlEscapes(unquote(value.trim())) === 'permission'
}

/** `\uXXXX` / `\xXX` / `\UXXXXXXXX` 解码：`"\u0070ermission"` 也是 permission 行。 */
function decodeYamlEscapes(text) {
  return String(text || '').replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|U([0-9a-fA-F]{8}))/g, (all, u, x, big) => {
    const cp = parseInt(u || x || big, 16)
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all
  })
}

/**
 * 这一行是不是**某个 patch 条目**里认不出的 permission 行。
 *
 * 只看 `mentionsPermissionId` 会把「别的插件 config 里恰好有个 `id: permission` 键」这种
 * 与 permission 行无关的合法文件判成拒写（错误文案还说「拒绝追加第二行」，是假话）。
 *
 * 判据：① 这一行**本身是序列项**（`- id: …` / `- {id: …}`，**任何缩进**都算——`insert:` /
 * `config:` 列表里缩进的条目同样是 patch 条目）；② 或者它是**某个条目的键**——沿最近的更浅
 * 缩进行往上找，那一行是序列项就说明它在条目里（`-` 单独一行、后面 `name: x` + `id: permission`
 * 也算条目，不能再要求「id 必须是第一个键」）。父行是普通 mapping 键（`thing:` / `config:`）
 * 时它只是别人 config 里的一个键，放行。
 */
function mentionsPermissionRow(lines, index, body) {
  if (body.has(index)) return false
  const line = lines[index]
  // 序列项：整行（含 flow mapping）就是这位条目本身；普通键行：只有 `id` **是这一行的键**才算
  // （`inject: [{id: permission, …}]` 里那个只是依赖注入列表里的一个值，不是 patch 条目）。
  if (!mentionsPermissionId(line, !/^[ \t]*-([ \t]|$)/.test(line))) return false
  // 「在不在 patch 条目里」与找行用**同一套**上下文判据。
  return isPatchEntryLine(lines, index, body)
}

/**
 * 全文扫「认不出的 permission 行」：返回 details 或 null。
 *
 * 同 id 的两条 patch 里**后写的 config 整块覆盖**前一条——所以只要存在一条插件认不出的
 * permission 行（标签/转义/`-` 单独一行的序列项…），**任何**路径都不能报 already/ok：
 * 它可能排在后面把我们的块整块盖掉（实测：前一条正常、后一条 `- id: !!str permission` 时，
 * `ensure` 报 already/ok 而 DSH 生效的 presets 里根本没有 auto-approve——UI 于是连补救按钮
 * 都不渲染）。判据收在写盘之前，逐条打印给用户看。
 */
function unrecognizedPermissionRowError(lines) {
  const body = scalarBodyLines(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    if (PERMISSION_ROW.test(line)) continue
    if (!mentionsPermissionRow(lines, i, body)) continue
    return { error: 'unrecognized permission row spelling; refusing to write because DSH would let it override this entry' }
  }
  return null
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
  // 认得出块状拼写才放行；**条目里其它写法**（flow mapping、标签/锚点/转义的 id 值、多行序列项…）
  // 只要点名了 permission 就拒绝写盘：`findPermissionRows` 认不出它 → 这里会追加**第二整块**，
  // 而 DSH 里同一 id 后写的 config 整块覆盖前一条 → 用户自带的 presets 被静默丢掉。
  // 宁可报错，也不动用户的文件；但**别的插件 config 里的同名键不算**（见 `mentionsPermissionRow`）。
  const badRow = unrecognizedPermissionRowError(lines)
  if (badRow) {
    return { ok: false, status: 'unrecognized-id-form', needRestart: false, code: 'err.preset', details: badRow }
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
 * @returns {{ config: object|null, presets: object|null, row: object|null, inlineConfig: boolean, inlinePresets: boolean }}
 */
function findPermissionPresets(lines, rows) {
  const out = { config: null, presets: null, row: null, inlineConfig: false, inlinePresets: false }
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
    // 回报选中的行：调用方要校验它的 `name:`（写错时 DSH 整条跳过）。
    out.row = row
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
  // 「列 0」是判据的一部分：`config:\n  inject:\n    []` 这种「某个键的空序列值写成独立一行」
  // 是合法 YAML，按 `emptyArrayLines` 宽松判定会把它当成根数组字面量 → 永久 broken-patch 拒写。
  // `[ ]` / 折行两种写法仍算（它们与条目混在一起同样是坏 YAML）。
  const rootEmpty = [...emptyArrayLines(lines)].some((i) => indentOf(lines[i]) === 0)
  const rootEntry = lines.some((line) => /^[ \t]*- /.test(line))
  return rootEmpty && rootEntry
}

/**
 * 文档标记出现在**内容之后**（`...` 或 `---`）：文件是多文档，`parsePatchList` 期望单文档 →
 * 直接抛 `expected a single document in the stream`。列 0 的标记在 compose 路径会被
 * `stripDocumentMarkers` 去掉，但**插入路径不动标记**，于是「中途 `...`」的文件会被插入后
 * 仍然解析不了，而插件报 ok。
 */
function hasInnerDocumentMarker(lines) {
  let started = false   // 当前文档已经有内容（或已经出现过 `---`）
  let ended = false     // 出现过 `...`：**文档已结束**，之后任何内容都是第二个文档
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (DOC_START_LINE.test(line)) {
      // 第二条 `---`、或内容之后又出现 `---` = 第二个文档。
      if (started) return true
      started = true
      continue
    }
    if (DOC_END_LINE.test(line)) {
      // `...` 结束**当前**文档：哪怕它出现在内容之前，后面的内容也已经是第二个文档
      // （js-yaml 实测「`...` 换行再接 `- id: permission`」报 expected a single document）。
      ended = true
      continue
    }
    if (ended) return true
    started = true
  }
  return false
}

/** patch 本身解析不了时的原因（写盘前一律先判，连 `already` 也不例外）。 */
/** 文件里除空行/注释/文档标记外，是否只剩一个空数组字面量（`[]` / `[ ]` / 折行的 `[` `]`）。 */
function isOnlyEmptyArrayLiteral(lines) {
  const content = lines
    .map((l) => l.trim().replace(/[ \t]+#.*$/, '').trim())   // 行尾注释（`[] # empty`）
    .filter((t) => t !== '' && !t.startsWith('#') && t !== '---' && t !== '...')
  if (content.length === 1) return /^\[[ \t]*\]$/.test(content[0])
  return content.length === 2 && content[0] === '[' && content[1] === ']'
}

function brokenPatchReason(lines) {
  if (hasStrayRootEmptyArray(lines.join('\n'))) {
    return 'patch mixes a bare [] with entries; it cannot be parsed, fix it by hand'
  }
  if (hasInnerDocumentMarker(lines)) {
    return 'patch contains a document marker (---/...) after content; DSH expects a single document'
  }
  /**
   * 根不是**块状序列**：DSH 的 `parsePatchList` 要求顶层数组。根 mapping（`auto-approve:` /
   * `config:`）、`{}`、`null`、以及**非空 flow 序列**（`[{id: …}]`）都解析不了——往这种文件里
   * 追加条目会写出「flow 序列 + 块序列」的混合体（比改前更坏），而 RPC 还报成功、UI 说
   * 「已写入，请重启」，profile 直接起不来。空数组字面量不算（那条路会整段替换它）。
   */
  const first = lines.find((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('#') && t !== '---' && t !== '...'
  })
  if (first === undefined) return ''
  const head = first.trim()
  if (head.startsWith('[')) {
    return isOnlyEmptyArrayLiteral(lines) ? '' : 'patch root is a flow sequence; DSH expects a block list of entries'
  }
  if (!/^-[ \t]*/.test(first) && head !== '-') return 'patch root is not a sequence; DSH expects a top-level list'
  /**
   * 条目必须是 mapping：`- just-a-string` / `- 42` / `- [a]` 都是合法 YAML 的序列，但 DSH 的
   * `parsePatchList` 会抛 `entry 1 is not a mapping`——照样是「报成功而 profile 起不来」。
   * 判据放宽到「有冒号 / 是 flow mapping / 是锚点别名标签」，认不出的写法宁可拒绝。
   */
  const item = /^-([ \t]+)(.*)$/.exec(first)
  if (item) {
    const rest = item[2].replace(/[ \t]+#.*$/, '').trim()
    if (rest !== '' && !rest.startsWith('{') && !rest.includes(':') && !/^[*&!]/.test(rest)) {
      return 'patch entries must be mappings; DSH expects every entry to be a mapping'
    }
  }
  return ''
}

/** permission 插件在 DSH 里的 entry name：patch 行的 `name:` 写错时 `applyEntryPatches` 整条跳过。 */
const PERMISSION_PLUGIN_NAME = '@deepseek-ai/dsh-permission-presets'

/**
 * 目标 permission 行自己的 `name:` 值（直接子键，去引号与行尾注释）；没有 name 返回 ''。
 * DSH 的 `applyEntryPatches`：`if (name && name !== target.name) { warn(...); continue }`
 * ——写错 name 的整条 patch 被丢弃，插件若照旧报 ok/updated，用户看到的是「已配置」，
 * 而他的预设从来没生效过。
 */
function permissionRowName(lines, row) {
  const body = scalarBodyLines(lines)
  const childIndent = directChildIndent(lines, row)
  for (let i = row.line + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= row.indent) break
    // **只认直接子键**：`findBlockChild` 会一路扫到更深层，于是预设自己的
    // `name: 自动审批`（在 config.presets.auto-approve 下面）会被当成这一行的 name，
    // 把一个完全正常的文件判成 name 不匹配。
    if (indent !== childIndent || body.has(i)) continue
    if (childKeyName(line) !== 'name') continue
    const colon = line.indexOf(':')
    return unquote(stripTrailingComment(line.slice(colon + 1)).trim())
  }
  return ''
}

export function ensureAutoApprovePreset(patchPath, sandbox = 'workspace-write') {
  try {
    // **必须先剥 BOM**：`\uFEFF- id: permission` 会让 findPermissionRows 一条都认不出，
    // 于是走「追加整块」写出第二条 permission 行——patch 语义下后写的 config 整块覆盖，
    // 用户自己的 presets 静默消失。
    const text = stripBom(readFileSync(patchPath, 'utf8'))
    const lines = text.split('\n')
    /**
     * 坏文件（根部混了裸 `[]` 与条目、内容之后还有文档标记）先判，**连 `already` 也不例外**：
     * 它们本来就解析不了，返回 `already/ok` 只会让 UI 说「已配置」而 DSH 根本读不到这份 patch
     * （AGENTS：这种情况直接拒绝写盘、不许报成功）。
     */
    const broken = brokenPatchReason(lines)
    if (broken) {
      return { ok: false, status: 'broken-patch', needRestart: false, code: 'err.preset', details: { error: broken } }
    }
    /**
     * **任何**路径都不能在「存在认不出的 permission 行」时报 already/ok：那条行可能排在后面
     * 把这一整块盖掉（DSH 同 id 后者胜、config 整块赋值）。放在 `already` 之前，UI 才会显示
     * 「需要手工处理」而不是「已配置」。
     */
    const badRow = unrecognizedPermissionRowError(lines)
    if (badRow) {
      return { ok: false, status: 'unrecognized-id-form', needRestart: false, code: 'err.preset', details: badRow }
    }
    const rows = findPermissionRows(lines)
    const found = findPermissionPresets(lines, rows)
    // `name:` 写错的 permission 行会被 DSH 整条跳过（`applyEntryPatches`）：这种文件里报
    // 「已配置 / 已写入」都是假话，明确报错、不动文件。
    if (found.row) {
      const rowName = permissionRowName(lines, found.row)
      if (rowName && rowName !== PERMISSION_PLUGIN_NAME) {
        return {
          ok: false,
          status: 'name-mismatch',
          needRestart: false,
          code: 'err.preset',
          details: { error: `permission row name is "${rowName}", DSH expects "${PERMISSION_PLUGIN_NAME}" and skips the whole entry` },
        }
      }
    }
    if (hasAutoApprovePreset(text)) return { ok: true, status: 'already', needRestart: false }

    if (rows.length === 0) {
      const block = FULL_PERMISSION_BLOCK + autoApprovePresetYaml(sandbox)
      return writeComposed(patchPath, text, block, 'added-entry')
    }

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
    const childIndent = directChildIndent(lines, presets)
    // 插入的行跟随原文件的换行风格（CRLF 文件里插 LF 会写出混合换行，与上面
    // 「空 presets 补齐」那条分支同一套处理）。
    const crlf = lines[presets.line].endsWith('\r')
    const inserted = autoApprovePresetYaml(sandbox, childIndent).replace(/\n$/, '')
    lines.splice(insertAt + 1, 0, crlf ? inserted.split('\n').join('\r\n') + '\r' : inserted)
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
