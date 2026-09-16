/**
 * 路径、JSON、审计、事件日志。无副作用：调用方传入目录。
 *
 * 规则、审计、插件配置在 ~/.dsh/auto-approve/。
 * 0.1.x 把插件配置放在 ~/.dsh/approval-bridge/config.json；缺失新文件时只迁移判定字段。
 * tryLoadJson 区分缺失与损坏：损坏时调用方不得用默认值覆写磁盘。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = '@dnalec/dsh-auto-approve'

/** DSH 的用户 patch 层文件名（profile 目录下）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 从 cordis 的 `baseUrl` 推导当前 profile 的 patch 文件路径。
 * app-boot 把 root include 的 baseUrl 锚在 profile 目录
 * （`packages/boot/app-boot/src/index.ts`：`ctx.baseUrl = pathToFileURL(dirname(configPath)).href + '/'`），
 * 所以这里能拿到真实 profile，而不是写死 `profiles/web`。
 * 拿不到（测试、非 file: URL）时返回 ''，由调用方回落到 `pathsFor()` 的默认位置。
 * @param {string} baseUrl - `ctx.baseUrl`
 * @returns {string} 绝对路径或 ''
 */
export function profilePatchFromBaseUrl(baseUrl) {
  const s = String(baseUrl || '')
  if (!s.startsWith('file:')) return ''
  try {
    const url = new URL(s)
    // 目录判定看 pathname：`file:///a/b/?x=1` 的字符串不以 / 结尾，但路径是目录。
    let dir = fileURLToPath(url)
    if (!url.pathname.endsWith('/')) dir = dirname(dir)
    if (!dir || dir === '/' || dir === '\\') return ''
    return join(dir, PROFILE_PATCH_FILENAME)
  } catch {
    return ''
  }
}

/**
 * patch 文件路径的优先级：显式配置 → 当前 profile 目录 → 默认 `profiles/web`。
 * @param {object} ctx - 插件 ctx（只用 baseUrl）。
 * @param {object} rawConfig - 插件行配置，可含 `profilePatch` 绝对路径。
 * @param {string} fallback - `pathsFor()` 给出的默认位置。
 * @returns {string}
 */
export function resolveProfilePatchPath(ctx, rawConfig, fallback) {
  const explicit = rawConfig && typeof rawConfig.profilePatch === 'string' ? rawConfig.profilePatch.trim() : ''
  if (explicit) return explicit
  return profilePatchFromBaseUrl(ctx && ctx.baseUrl) || String(fallback || '')
}

/** auto-approve = 规则/审计/插件配置；legacyPluginConfig 仅作 0.1.x 迁移源。 */
export function pathsFor(home = dshHome(), profileName = 'web') {
  const auto = join(home, 'auto-approve')
  const bridge = join(home, 'approval-bridge')
  return {
    home,
    auto,
    allowlist: join(auto, 'allowlist.json'),
    audit: join(auto, 'audit.log'),
    events: join(auto, 'events.jsonl'),
    pluginConfig: join(auto, 'config.json'),
    legacyPluginConfig: join(bridge, 'config.json'),
    profilePatch: join(home, 'profiles', profileName, PROFILE_PATCH_FILENAME),
  }
}
export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
}

export function tryLoadJson(path) {
  try {
    if (!existsSync(path)) return { ok: true, missing: true, value: null }
    const value = JSON.parse(readFileSync(path, 'utf8'))
    // 合法 JSON 但**不是对象**（`null` / `[]` / `"text"` / `42`）不算一份配置：读盘侧必须把它
    // 当「损坏」处理（调用方据此拒绝写盘）。否则 `null` 会被归一成默认值、再写回磁盘——
    // 用户手写坏的内容被静默覆盖，沙箱还可能被默认值**放宽**（启动路径实测过）。
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, missing: false, error: new Error('not a JSON object'), value: null }
    }
    return { ok: true, missing: false, value }
  } catch (error) {
    return { ok: false, missing: false, error, value: null }
  }
}

export function loadJson(path, fallback) {
  const loaded = tryLoadJson(path)
  if (!loaded.ok) {
    console.error(`[${NAME}] 读取 ${path} 失败，用默认值`, loaded.error)
    return fallback
  }
  if (loaded.missing) return fallback
  return loaded.value
}

function chmodTo(path, mode) {
  try { chmodSync(path, mode) } catch { /* ignore */ }
}

/**
 * 原子写：先写 `<path>.tmp` 再 rename，失败清掉临时文件并把异常抛给调用方。
 * 导出让 `preset-patch.mjs` 复用：profile patch 是 `dsh web` 启动的必需输入，
 * 写一半（进程被杀 / 磁盘满）会让 profile 解析失败、下次启动直接起不来。
 */
export function writeAtomic(path, text, mode) {
  // `mode` 是**显式**要求：给了就按它设权限，没给才收到 0600（配置文件可能含密钥/提示词）。
  // 此前 rename 之后无条件 chmod 0600，`mode` 只在写临时文件时生效、随即被覆盖——参数等于没有效果。
  const tmp = path + '.tmp'
  try {
    ensureDir(dirname(path))
    if (mode != null) writeFileSync(tmp, text, { encoding: 'utf8', mode })
    else writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    chmodTo(path, mode == null ? 0o600 : mode)
    return true
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

export function saveJson(path, data) {
  try {
    writeAtomic(path, JSON.stringify(data, null, 2) + '\n')
    return true
  } catch (error) {
    console.error(`[${NAME}] 写入 ${path} 失败`, error)
    return false
  }
}

export function appendLine(path, line) {
  try {
    ensureDir(dirname(path))
    appendFileSync(path, line, 'utf8')
    chmodTo(path, 0o600)
    return true
  } catch (error) {
    // 审计行是超预算 / 撞护栏 / 没采集到这三类路径的**唯一证据**：
    // 写不进去必须留痕（判定本身不受影响，所以只报错、不抛）。
    console.error(`[${NAME}] 追加 ${path} 失败`, error)
    return false
  }
}

export function audit(auditPath, line) {
  appendLine(auditPath, `[${new Date().toISOString()}] ${line}\n`)
}

/** @type {{ path: string, mtimeMs: number, size: number, records: object[] } | null} */
let eventsCache = null

function loadEventRecords(eventsPath) {
  try {
    const st = statSync(eventsPath)
    if (
      eventsCache
      && eventsCache.path === eventsPath
      && eventsCache.mtimeMs === st.mtimeMs
      && eventsCache.size === st.size
    ) {
      return eventsCache.records
    }
    const text = readFileSync(eventsPath, 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (Number.isInteger(ev.id)) records.push(ev)
      } catch { /* skip */ }
    }
    eventsCache = { path: eventsPath, mtimeMs: st.mtimeMs, size: st.size, records }
    return records
  } catch {
    return null
  }
}

export function readEventsSince(eventsPath, sessionId, since) {
  const records = loadEventRecords(eventsPath)
  if (!records) return []
  const events = []
  for (const ev of records) {
    if (ev.id <= since) continue
    if (sessionId && ev.sessionId !== sessionId) continue
    events.push(ev)
  }
  return events
}

export const EVENTS_MAX_BYTES = 2 * 1024 * 1024
export const EVENTS_KEEP = 2000

export function trimEventsFile(eventsPath, maxBytes = EVENTS_MAX_BYTES, keep = EVENTS_KEEP) {
  try {
    const st = statSync(eventsPath)
    if (st.size < maxBytes) return false
    const records = loadEventRecords(eventsPath)
    // **读失败不写盘**（与 allowlist / config 同一条原则）：`statSync` 成功但
    // `readFileSync` 失败（权限、被锁、IO 抖动）时返回 null；把 null 当空数组会让
    // 这份审批历史的唯一副本被清成 0 字节。
    if (!records) {
      console.error(`[${NAME}] ${eventsPath} 超过 ${maxBytes} 字节但读不出来，本次不裁剪`)
      return false
    }
    // 一行业都解析不出来：文件内容不是本插件的事件格式（可能已被别的工具改写/损坏），
    // 同样不覆盖——宁可让它继续变大，也不能把一个看不懂的文件删空。
    if (!records.length) {
      console.error(`[${NAME}] ${eventsPath} 超过 ${maxBytes} 字节但没有一条可解析记录，本次不裁剪`)
      return false
    }
    /**
     * 保留策略：**条数是上限，字节是目标**。
     *
     * 只按条数裁时 `maxBytes` 形同虚设：单条记录由 `EVENT_ARGS_BUDGET`（6000 字符）决定，
     * 2000 条 ≈ 13MB——文件永远回不到 2MB 以下，而 `appendEvent` 每次都调这里，
     * 于是每写一条事件就 readFileSync + 解析 2000 条 + 全量重写一次（实测 ~68ms/条），
     * 变成自我维持的重写循环。从最新一条往前累加字节，超预算就停（至少留一条），
     * 条数上限照旧生效。
     */
    const lines = records.map((r) => JSON.stringify(r))
    const kept = []
    let bytes = 0
    for (let i = lines.length - 1; i >= 0 && kept.length < Math.max(1, keep); i--) {
      const size = lines[i].length + 1
      // 至少留一条（最后一条事件是「刚才发生了什么」的唯一现场）：它自己超预算也要留。
      if (kept.length && bytes + size > maxBytes) break
      kept.push(lines[i])
      bytes += size
    }
    kept.reverse()
    const text = kept.length ? kept.join('\n') + '\n' : ''
    writeAtomic(eventsPath, text)
    eventsCache = null
    return true
  } catch {
    return false
  }
}

export function appendEvent(eventsPath, ev) {
  ensureDir(dirname(eventsPath))
  appendFileSync(eventsPath, JSON.stringify(ev) + '\n', 'utf8')
  // 事件里也可能有命令片段，同样收到 0600。
  chmodTo(eventsPath, 0o600)
  eventsCache = null
  trimEventsFile(eventsPath)
}

export function maxEventId(eventsPath) {
  let max = 0
  try {
    const text = readFileSync(eventsPath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (Number.isInteger(ev.id) && ev.id > max) max = ev.id
      } catch { /* skip */ }
    }
  } catch { /* missing */ }
  return max
}
