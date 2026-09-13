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
    return { ok: true, missing: false, value: JSON.parse(readFileSync(path, 'utf8')) }
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

function chmodPrivate(path) {
  try { chmodSync(path, 0o600) } catch { /* ignore */ }
}

function writeAtomic(path, text, mode) {
  const tmp = path + '.tmp'
  try {
    ensureDir(dirname(path))
    if (mode != null) writeFileSync(tmp, text, { encoding: 'utf8', mode })
    else writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    chmodPrivate(path)
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
    chmodPrivate(path)
  } catch { /* ignore */ }
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
    const records = loadEventRecords(eventsPath) || []
    const kept = records.slice(-Math.max(1, keep))
    const text = kept.length ? kept.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''
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
  chmodPrivate(eventsPath)
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
