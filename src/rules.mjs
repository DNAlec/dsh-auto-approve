/**
 * 判定管道纯函数（无 I/O）。
 *
 * 关键词只匹配工具名 + command + 路径 + workdir（含会话 cwd；相对路径会拼到 cwd/workdir 上），不匹配 justification、description、文件正文。
 * 允许桶不匹配工具名，避免把 bash/write 整类放行。
 * 审核模型只归类；动作以本表为准。`other` 必须存在，解析失败视为 other。
 * allowlist.version 只增不改历史语义，用 prevVersion < N 做一次性迁移。
 * 解析失败抛错，由调用方转人工；不要把失败当成 other（用户可能把 other 改成 allow）。
 */

export const DEFAULT_DENY_KEYWORDS = [
  'rm -rf', 'rm -fr', 'rm -r -f', 'rm --recursive --force', 'sudo rm',
  'Remove-Item -Recurse -Force', 'Remove-Item -Force -Recurse',
  'git push --force', 'git push -f', 'push --force',
  'drop table', 'drop database', 'drop schema', 'delete from', 'truncate table',
  'mkfs', 'dd of=', 'Format-Volume', 'Clear-Disk',
  'chmod 777 /', 'chmod -R 777',
  'terraform destroy', 'docker system prune',
  'shutdown -h', 'shutdown now',
  'systemctl poweroff', 'systemctl reboot', 'systemctl halt',
  'Stop-Computer', 'Restart-Computer',
]

/** 旧预置：误伤太大，或只对理由/路径有意义。升级时从拒绝桶拿掉。 */
export const RETIRED_DEFAULT_KEYWORDS = [
  '格式化', 'docker rm', 'truncate ',
  '清空数据库', '删除数据库', 'force-push', 'force push',
  'git reset --hard', 'git clean -fd', 'rsync --delete', 'mkfs.ext',
  'shutdown', 'reboot',
]

/** 预置词默认进拒绝桶。 */
export const DEFAULT_REJECT_KEYWORDS = DEFAULT_DENY_KEYWORDS

/** 改自动审批配置的路径兜底，避免只靠模型选 approval-config。 */
export const DEFAULT_APPROVAL_CONFIG_KEYWORDS = [
  'auto-approve/allowlist',
  'approval-bridge/config.json',
  'approval-bridge/qqbot.json',
  '.dsh/auto-approve',
  '.dsh/approval-bridge',
]

/** 常见凭据路径。关键词层兜底，不把 .env / 私钥只交给模型。 */
export const DEFAULT_SECRET_PATH_KEYWORDS = [
  '.env',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.netrc',
]

/** 出厂拒绝词：灾难命令 + 审批配置路径 + 凭据路径。恢复默认必须用这个，不能只用 DEFAULT_DENY_KEYWORDS。 */
export function shippedRejectKeywords() {
  const out = DEFAULT_REJECT_KEYWORDS.slice()
  const seen = new Set(out)
  for (const w of [...DEFAULT_APPROVAL_CONFIG_KEYWORDS, ...DEFAULT_SECRET_PATH_KEYWORDS]) {
    if (seen.has(w)) continue
    out.push(w)
    seen.add(w)
  }
  return out
}

export function normalizeCriteriaAction(value) {
  if (value === 'reject' || value === 'allow' || value === 'human') return value
  if (value === '拒绝') return 'reject'
  if (value === '允许') return 'allow'
  if (value === '人工') return 'human'
  return 'human'
}

export const JUDGE_PROMPT_LANGS = ['zh', 'en']

/** 审核提示词语言。非法值回落到 zh，与现有出厂表一致。 */
export function normalizeJudgePromptLang(value) {
  return value === 'en' ? 'en' : 'zh'
}

/**
 * 默认审核表（中文）。风险类 reject；safe 才能 allow；other 是兜底 human。
 * description 会写进审核提示词，改文案等于改模型标准。
 */
export const DEFAULT_CRITERIA_ZH = [
  { id: 'deletion', label: '删除/覆盖不可再生数据', description: '以命令/路径/内容为准：删除、清空或不可逆覆盖用户数据、备份、历史或未提交内容；单文件常规源码/文档编辑不算', action: 'reject' },
  { id: 'credential', label: '凭据/密钥/授权修改', description: '以路径或写入内容为准：密钥、token、证书私钥、.env、authorized_keys、kubeconfig、~/.aws、带 token 的 .npmrc、docker config.json 及授权/登录配置', action: 'reject' },
  { id: 'remote', label: '远程系统/生产环境/数据库', description: '以实际命令为准：对远程主机/生产/数据库做写入，ssh/kubectl/云 CLI 的变更，以及 npm/pypi publish 或生产部署；只读查询和普通 git push 不算', action: 'reject' },
  { id: 'system', label: '系统级路径/配置', description: '以命令/路径为准：/etc、/usr、/boot、/root、/var、/opt、Windows 系统目录、服务与防火墙、关机/重启，以及 crontab、shell rc、用户启动项；包管理器往系统前缀安装也算', action: 'reject' },
  { id: 'bulk', label: '批量不可回补操作', description: '以实际命令为准：递归/通配/循环的批量删除或覆盖，以及格式化、dd、git reset --hard、git clean、rsync --delete', action: 'reject' },
  { id: 'approval-config', label: '自动审批配置', description: '以路径/命令为准：修改 ~/.dsh 下自动审批的 allowlist、插件配置，或其它会改审批规则/门控的配置', action: 'reject' },
  { id: 'safe', label: '安全/常规可回补', description: '以命令/路径/内容为准：能确认是常规可回补操作（源码、文档、测试、构建产物、安装项目依赖、可撤销单文件编辑）。发包、提权、外发数据不要选。拿不准不要选此项', action: 'allow' },
  { id: 'other', label: '其他（拿不准）', description: '风险类和 safe 都不符合，或拿不准。看起来无害但无法确认可回补的，也选这项', action: 'human' },
]

/** 默认审核表（英文）。id / action 与中文包相同。 */
export const DEFAULT_CRITERIA_EN = [
  { id: 'deletion', label: 'Delete/overwrite irreplaceable data', description: 'Based on command/path/content: delete, empty, or irreversibly overwrite user data, backups, history, or uncommitted work; ordinary single-file source or docs edits do not count', action: 'reject' },
  { id: 'credential', label: 'Credentials/keys/auth changes', description: 'Based on path or write content: secrets, tokens, private keys, .env, authorized_keys, kubeconfig, ~/.aws, .npmrc with tokens, docker config.json, and auth/login config', action: 'reject' },
  { id: 'remote', label: 'Remote/production/database', description: 'Based on the actual command: writes to remote hosts, production, or databases; ssh/kubectl/cloud CLI mutations; npm/pypi publish or production deploys. Read-only queries and ordinary git push do not count', action: 'reject' },
  { id: 'system', label: 'System paths/config', description: 'Based on command/path: /etc, /usr, /boot, /root, /var, /opt, Windows system directories, services and firewall, shutdown/reboot, plus crontab, shell rc, and user startup items; package-manager installs into a system prefix also count', action: 'reject' },
  { id: 'bulk', label: 'Bulk irreversible operations', description: 'Based on the actual command: recursive/glob/loop bulk delete or overwrite, plus format, dd, git reset --hard, git clean, rsync --delete', action: 'reject' },
  { id: 'approval-config', label: 'Auto-approve configuration', description: 'Based on path/command: changing the auto-approve allowlist or plugin config under ~/.dsh, or other files that change approval rules/gating', action: 'reject' },
  { id: 'safe', label: 'Safe/routine reversible', description: 'Based on command/path/content: confirmed routine reversible work (source, docs, tests, build artifacts, installing project dependencies, undoable single-file edits). Do not pick this for publishing, privilege escalation, or sending data out. Do not pick this if unsure', action: 'allow' },
  { id: 'other', label: 'Other (unsure)', description: 'Neither a risk row nor safe fits, or you are unsure. Also pick this when it looks harmless but reversibility cannot be confirmed', action: 'human' },
]

/** 兼容旧引用：空配置与迁移仍用中文出厂表。 */
export const DEFAULT_CRITERIA = DEFAULT_CRITERIA_ZH

export function shippedCriteria(lang) {
  return normalizeJudgePromptLang(lang) === 'en' ? DEFAULT_CRITERIA_EN : DEFAULT_CRITERIA_ZH
}

export function cloneShippedCriteria(lang) {
  return shippedCriteria(lang).map((c) => ({
    id: c.id, label: c.label, description: c.description, action: c.action,
  }))
}

export const CATEGORY_LABELS = {
  deletion: '删除/覆盖不可再生数据',
  credential: '凭据/密钥/授权修改',
  remote: '远程系统/生产环境/数据库',
  system: '系统级路径/配置',
  bulk: '批量不可回补操作',
  'approval-config': '自动审批配置',
  safe: '安全/常规可回补',
  other: '其他（拿不准）',
}

export function normalizePresetSandbox(value) {
  return value === 'read-only' ? 'read-only' : 'workspace-write'
}

export function slugCriterionId(value) {
  const t = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return t.slice(0, 32)
}

export function normalizeCriterion(raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const id = slugCriterionId(row.id || row.label)
  if (!id) return null
  const action = normalizeCriteriaAction(row.action)
  return {
    id,
    label: String(row.label || id).trim() || id,
    description: String(row.description || '').trim(),
    action,
  }
}

/** 保证 `other` 始终在表末可解析。硬类别数组是旧格式。 */
export function normalizeCriteria(raw, hardCategories) {
  const out = []
  const seen = new Set()
  const push = (row) => {
    const n = normalizeCriterion(row)
    if (!n || seen.has(n.id)) return
    seen.add(n.id)
    out.push(n)
  }
  if (Array.isArray(raw) && raw.length > 0) {
    for (const row of raw) {
      if (typeof row === 'string') {
        const def = DEFAULT_CRITERIA.find((c) => c.id === row)
        push(def || { id: row, label: row, action: 'human' })
      } else {
        push(row)
      }
    }
  } else if (Array.isArray(hardCategories) && hardCategories.length > 0) {
    for (const id of hardCategories) {
      const def = DEFAULT_CRITERIA.find((c) => c.id === id)
      push(def || { id, label: CATEGORY_LABELS[id] || id, action: 'human' })
    }
  } else {
    for (const row of DEFAULT_CRITERIA) push(row)
  }
  if (!seen.has('other')) push(DEFAULT_CRITERIA.find((c) => c.id === 'other'))
  return out
}

/**
 * 读盘后规范化。version 表示「已应用完哪一步迁移」。
 * 不要在迁移里无条件覆盖用户改过的 action，除非该步就是改默认动作。
 */
export function normalizeAllowlist(raw) {
  const cfg = raw && typeof raw === 'object' ? { ...raw } : {}
  const prevVersion = Number(cfg.version) || 0
  const legacyDeny = Array.isArray(cfg.denyKeywords) ? cfg.denyKeywords : null
  cfg.rejectKeywords = Array.isArray(cfg.rejectKeywords) ? cfg.rejectKeywords.slice() : []
  cfg.humanKeywords = Array.isArray(cfg.humanKeywords) ? cfg.humanKeywords.slice() : []
  cfg.allowKeywords = Array.isArray(cfg.allowKeywords) ? cfg.allowKeywords.slice() : []
  if (prevVersion < 5) {
    const pool = cfg.humanKeywords.length
      ? cfg.humanKeywords
      : (legacyDeny && legacyDeny.length ? legacyDeny : [])
    const allowSet = new Set(cfg.allowKeywords)
    const rejectSet = new Set(cfg.rejectKeywords)
    for (const w of pool) {
      if (!w || allowSet.has(w) || rejectSet.has(w)) continue
      cfg.rejectKeywords.push(w)
      rejectSet.add(w)
    }
    cfg.humanKeywords = cfg.humanKeywords.filter((w) => !rejectSet.has(w))
  }
  if (!cfg.rejectKeywords.length && !cfg.humanKeywords.length && !cfg.allowKeywords.length) {
    cfg.rejectKeywords = shippedRejectKeywords()
  }
  if (prevVersion < 9) {
    const owned = new Set([...cfg.rejectKeywords, ...cfg.humanKeywords, ...cfg.allowKeywords])
    for (const w of DEFAULT_REJECT_KEYWORDS) {
      if (owned.has(w)) continue
      cfg.rejectKeywords.push(w)
      owned.add(w)
    }
    const retired = new Set(RETIRED_DEFAULT_KEYWORDS)
    cfg.rejectKeywords = cfg.rejectKeywords.filter((w) => !retired.has(w))
  }
  cfg.denyKeywords = cfg.humanKeywords
  cfg.criteria = normalizeCriteria(cfg.criteria, cfg.hardCategories)
  if (prevVersion < 7) {
    const other = cfg.criteria.find((c) => c.id === 'other')
    if (other && other.action === 'human') other.action = 'allow'
  }
  if (prevVersion < 10) {
    for (const def of DEFAULT_CRITERIA) {
      const hit = cfg.criteria.find((c) => c.id === def.id)
      if (hit) {
        hit.label = def.label
        hit.description = def.description
      }
    }
  }
  if (prevVersion < 11) {
    if (!cfg.criteria.some((c) => c.id === 'safe')) {
      const def = DEFAULT_CRITERIA.find((c) => c.id === 'safe')
      const otherIdx = cfg.criteria.findIndex((c) => c.id === 'other')
      const row = { id: def.id, label: def.label, description: def.description, action: def.action }
      if (otherIdx >= 0) cfg.criteria.splice(otherIdx, 0, row)
      else cfg.criteria.push(row)
    }
    const other = cfg.criteria.find((c) => c.id === 'other')
    if (other && other.action === 'allow') other.action = 'human'
    for (const def of DEFAULT_CRITERIA) {
      const hit = cfg.criteria.find((c) => c.id === def.id)
      if (hit) {
        hit.label = def.label
        hit.description = def.description
      }
    }
  }
  if (prevVersion < 12) {
    const risk = new Set(['deletion', 'credential', 'remote', 'system', 'bulk'])
    for (const row of cfg.criteria) {
      if (risk.has(row.id) && row.action === 'human') row.action = 'reject'
    }
  }
  if (prevVersion < 13) {
    if (!cfg.criteria.some((c) => c.id === 'approval-config')) {
      const def = DEFAULT_CRITERIA.find((c) => c.id === 'approval-config')
      const row = { id: def.id, label: def.label, description: def.description, action: def.action }
      const safeIdx = cfg.criteria.findIndex((c) => c.id === 'safe')
      if (safeIdx >= 0) cfg.criteria.splice(safeIdx, 0, row)
      else {
        const otherIdx = cfg.criteria.findIndex((c) => c.id === 'other')
        if (otherIdx >= 0) cfg.criteria.splice(otherIdx, 0, row)
        else cfg.criteria.push(row)
      }
    }
  }
  if (prevVersion < 14) {
    const def = DEFAULT_CRITERIA.find((c) => c.id === 'approval-config')
    const hit = cfg.criteria.find((c) => c.id === 'approval-config')
    if (hit && def) {
      hit.label = def.label
      hit.description = def.description
    }
  }
  if (prevVersion < 16) {
    const owned = new Set([...cfg.rejectKeywords, ...cfg.humanKeywords, ...cfg.allowKeywords])
    for (const w of DEFAULT_APPROVAL_CONFIG_KEYWORDS) {
      if (owned.has(w)) continue
      cfg.rejectKeywords.push(w)
      owned.add(w)
    }
  }
  if (prevVersion < 17) {
    const owned = new Set([...cfg.rejectKeywords, ...cfg.humanKeywords, ...cfg.allowKeywords])
    for (const w of DEFAULT_SECRET_PATH_KEYWORDS) {
      if (owned.has(w)) continue
      cfg.rejectKeywords.push(w)
      owned.add(w)
    }
  }
  if (prevVersion < 18) {
    // 刷出厂文案：只替换仍是旧中/英原文的行，不改用户自定义描述，不碰 action。
    const prevCopy = {
      zh: {
        credential: { description: '以路径或写入内容为准：密钥、token、证书私钥、.env、authorized_keys、kubeconfig 及授权/登录配置' },
        remote: { description: '以实际命令为准：对远程主机/生产/数据库做写入，ssh/kubectl/云 CLI 的变更，或对外发布（publish/部署）；只读查询不算' },
        system: { description: '以命令/路径为准：/etc、/usr、/boot、/root、服务与防火墙、关机/重启，以及 crontab、shell rc、用户启动项' },
        safe: { description: '以命令/路径/内容为准：能确认是常规可回补操作（源码、文档、测试、构建产物、可撤销编辑）。拿不准不要选此项' },
        other: { label: '其他', description: '以上风险类都不符合，且不能确认是否安全' },
      },
      en: {
        credential: { description: 'Based on path or write content: secrets, tokens, private keys, .env, authorized_keys, kubeconfig, and auth/login config' },
        remote: { description: 'Based on the actual command: writes to remote hosts, production, or databases; ssh/kubectl/cloud CLI mutations; or publishing/deploying. Read-only queries do not count' },
        system: { description: 'Based on command/path: /etc, /usr, /boot, /root, services and firewall, shutdown/reboot, plus crontab, shell rc, and user startup items' },
        safe: { description: 'Based on command/path/content: confirmed routine reversible work (source, docs, tests, build artifacts, undoable edits). Do not pick this if unsure' },
        other: { label: 'Other', description: 'None of the risk rows apply, and safety cannot be confirmed' },
      },
    }
    const packs = { zh: DEFAULT_CRITERIA_ZH, en: DEFAULT_CRITERIA_EN }
    for (const lang of ['zh', 'en']) {
      const oldRows = prevCopy[lang]
      const neu = packs[lang]
      for (const id of Object.keys(oldRows)) {
        const hit = cfg.criteria.find((c) => c.id === id)
        const def = neu.find((c) => c.id === id)
        const old = oldRows[id]
        if (!hit || !def) continue
        const sameLabel = Boolean(old.label && hit.label === old.label)
        const sameDesc = Boolean(old.description && hit.description === old.description)
        if (!sameLabel && !sameDesc) continue
        hit.label = def.label
        hit.description = def.description
      }
    }
  }
  cfg.version = 18
  cfg.judgeTimeoutMs = Number(cfg.judgeTimeoutMs) > 0 ? Number(cfg.judgeTimeoutMs) : 20000
  delete cfg.allowRules
  delete cfg.denyRules
  delete cfg.learning
  delete cfg.riskyThreshold
  delete cfg.hardCategories
  return cfg
}

export function defaultPluginConfig() {
  return {
    onlyAutoApprovePreset: true,
    presetSandbox: 'workspace-write',
    judgePromptLang: 'zh',
    judge: { provider: '', model: '', reasoningEffort: '', timeoutMs: 20000 },
  }
}
export function cloneAllowlist(cfg) {
  const a = cfg && typeof cfg === 'object' ? cfg : {}
  return {
    version: a.version,
    rejectKeywords: Array.isArray(a.rejectKeywords) ? a.rejectKeywords.slice() : [],
    humanKeywords: Array.isArray(a.humanKeywords) ? a.humanKeywords.slice() : [],
    allowKeywords: Array.isArray(a.allowKeywords) ? a.allowKeywords.slice() : [],
    denyKeywords: Array.isArray(a.humanKeywords) ? a.humanKeywords.slice() : [],
    criteria: Array.isArray(a.criteria) ? a.criteria.map((c) => ({ ...c })) : [],
    judgeTimeoutMs: a.judgeTimeoutMs,
  }
}

export function copyAllowlistInto(target, src) {
  if (!target || !src) return
  target.version = src.version
  target.rejectKeywords = src.rejectKeywords
  target.humanKeywords = src.humanKeywords
  target.allowKeywords = src.allowKeywords
  target.denyKeywords = src.humanKeywords
  target.criteria = src.criteria
  target.judgeTimeoutMs = src.judgeTimeoutMs
}

/** 界面超时写 allowlist；yaml 的 judge.timeoutMs 只作缺省。 */
export function effectiveJudgeTimeoutMs(allowlist, pluginCfg) {
  const a = Number(allowlist && allowlist.judgeTimeoutMs)
  if (Number.isFinite(a) && a > 0) return a
  const p = Number(pluginCfg && pluginCfg.judge && pluginCfg.judge.timeoutMs)
  if (Number.isFinite(p) && p > 0) return p
  return 20000
}

const KEYWORD_KINDS = new Set(['rejectKeywords', 'humanKeywords', 'allowKeywords', 'denyKeywords'])

function keywordKind(kind) {
  return kind === 'denyKeywords' ? 'humanKeywords' : kind
}

function actionToKeywordBucket(action) {
  const a = normalizeCriteriaAction(action)
  if (a === 'reject') return 'rejectKeywords'
  if (a === 'allow') return 'allowKeywords'
  return 'humanKeywords'
}

function moveKeyword(allowlist, kind, str) {
  for (const k of ['rejectKeywords', 'humanKeywords', 'allowKeywords']) {
    const list = allowlist[k]
    if (!Array.isArray(list)) continue
    for (let i = list.length - 1; i >= 0; i--) if (String(list[i]) === str) list.splice(i, 1)
  }
  if (!Array.isArray(allowlist[kind])) allowlist[kind] = []
  allowlist[kind].push(str)
  allowlist.denyKeywords = allowlist.humanKeywords
}


export function fail(code, details) {
  const out = { ok: false, code }
  if (details && typeof details === 'object' && Object.keys(details).length) out.details = details
  return out
}

export function codedThrow(code, details) {
  const err = new Error(code)
  err.code = code
  if (details && typeof details === 'object') err.details = details
  throw err
}

/**
 * 只改 draft，不写盘。调用方保存成功后再 copyAllowlistInto 回活对象。
 */
export function mutateAllowlistOp(allowlist, op, kind, value) {
  if (kind === 'criteria') {
    if (op === 'set') {
      const row = value && typeof value === 'object' ? value : {}
      const id = String(row.id || '').trim()
      const hit = (allowlist.criteria || []).find((c) => c.id === id)
      if (!hit) return fail('err.criterionNotFound')
      if (row.action !== undefined) hit.action = normalizeCriteriaAction(row.action)
      if (row.label !== undefined) hit.label = String(row.label || hit.label).trim() || hit.label
      if (row.description !== undefined) hit.description = String(row.description || '').trim()
      return { ok: true, set: true, auditLine: `CONFIG  criteria ${id} → ${hit.action}` }
    }
    if (op === 'reset') {
      const lang = normalizeJudgePromptLang(
        value && typeof value === 'object' ? value.lang : value,
      )
      allowlist.criteria = cloneShippedCriteria(lang)
      return { ok: true, reset: true, auditLine: `CONFIG  criteria reset defaults lang=${lang}` }
    }
    if (op === 'add') {
      const n = normalizeCriterion(value)
      if (!n) return fail('err.criterionNeedId')
      if ((allowlist.criteria || []).some((c) => c.id === n.id)) return fail('err.criterionIdExists')
      allowlist.criteria.push(n)
      return { ok: true, added: true, auditLine: `CONFIG  criteria + ${n.id}` }
    }
    if (op === 'remove') {
      const id = String((value && value.id) || value || '').trim()
      if (id === 'other') return fail('err.criterionOtherLocked')
      const before = (allowlist.criteria || []).length
      allowlist.criteria = (allowlist.criteria || []).filter((c) => c.id !== id)
      if (allowlist.criteria.length === before) return fail('err.criterionNotFound')
      return { ok: true, removed: true, auditLine: `CONFIG  criteria - ${id}` }
    }
    return fail('err.criteriaOp')
  }

  if (kind === 'judgeTimeoutMs') {
    if (op !== 'set') return fail('err.opMustSet', { kind })
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return fail('err.invalidNumber')
    allowlist.judgeTimeoutMs = n
    return { ok: true, set: true, value: n, auditLine: `CONFIG  ${kind} → ${n}` }
  }

  if (kind === 'keywords') {
    if (op === 'reset') {
      allowlist.rejectKeywords = shippedRejectKeywords()
      allowlist.humanKeywords = []
      allowlist.allowKeywords = []
      allowlist.denyKeywords = allowlist.humanKeywords
      return { ok: true, reset: true, auditLine: 'CONFIG  keywords reset defaults' }
    }
    const row = value && typeof value === 'object' ? value : { text: value }
    const str = String(row.text || row.keyword || '').trim()
    if (!str) return fail('err.keywordEmpty')
    if (op === 'add' || op === 'set') {
      const from = String(row.from || '').trim()
      if (op === 'set' && from && from !== str) {
        let found = false
        for (const k of ['rejectKeywords', 'humanKeywords', 'allowKeywords']) {
          const list = allowlist[k]
          if (!Array.isArray(list)) continue
          for (let i = list.length - 1; i >= 0; i--) {
            if (String(list[i]) === from) { list.splice(i, 1); found = true }
          }
        }
        if (!found) return fail('err.keywordNotFound')
      }
      const bucket = actionToKeywordBucket(row.action)
      moveKeyword(allowlist, bucket, str)
      return {
        ok: true,
        added: op === 'add',
        set: op === 'set',
        auditLine: `CONFIG  keywords ${from && from !== str ? from + ' → ' : ''}${str} → ${bucket}`,
      }
    }
    if (op === 'remove') {
      let found = false
      for (const k of ['rejectKeywords', 'humanKeywords', 'allowKeywords']) {
        const list = allowlist[k]
        if (!Array.isArray(list)) continue
        for (let i = list.length - 1; i >= 0; i--) {
          if (String(list[i]) === str) { list.splice(i, 1); found = true }
        }
      }
      allowlist.denyKeywords = allowlist.humanKeywords
      if (!found) return fail('err.keywordNotFound')
      return { ok: true, removed: true, auditLine: `CONFIG  keywords - ${str}` }
    }
    return fail('err.keywordsOp')
  }

  if (KEYWORD_KINDS.has(kind)) {
    const bucket = keywordKind(kind)
    const str = String(value || '').trim()
    if (!str) return fail('err.valueEmpty')
    if (op === 'add') {
      moveKeyword(allowlist, bucket, str)
      return { ok: true, added: true, auditLine: `CONFIG  ${bucket} + ${str}` }
    }
    if (op === 'remove') {
      const list = allowlist[bucket]
      if (!Array.isArray(list)) return fail('err.unknownKind', { kind: bucket })
      const before = list.length
      for (let i = list.length - 1; i >= 0; i--) if (String(list[i]) === str) list.splice(i, 1)
      allowlist.denyKeywords = allowlist.humanKeywords
      if (list.length === before) return fail('err.ruleNotFound')
      return { ok: true, removed: true, auditLine: `CONFIG  ${bucket} - ${str}` }
    }
    return fail('err.unknownOp', { op: String(op || '') })
  }

  return fail('err.unknownKind', { kind: String(kind || '') })
}

export function mergePluginConfig(base, overlay) {
  const d = defaultPluginConfig()
  const b = base && typeof base === 'object' ? base : {}
  const o = overlay && typeof overlay === 'object' ? overlay : {}
  const judge = { ...d.judge, ...(b.judge || {}), ...(o.judge || {}) }
  return {
    onlyAutoApprovePreset: o.onlyAutoApprovePreset ?? b.onlyAutoApprovePreset ?? d.onlyAutoApprovePreset,
    presetSandbox: normalizePresetSandbox(o.presetSandbox ?? b.presetSandbox ?? d.presetSandbox),
    judgePromptLang: normalizeJudgePromptLang(o.judgePromptLang ?? b.judgePromptLang ?? d.judgePromptLang),
    judge,
  }
}

/** 从旧 approval-bridge/config.json 只抽出判定字段，丢掉 notify / channels。 */
export function pickMigratablePluginConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  if (Object.prototype.hasOwnProperty.call(raw, 'onlyAutoApprovePreset')) out.onlyAutoApprovePreset = raw.onlyAutoApprovePreset
  if (Object.prototype.hasOwnProperty.call(raw, 'presetSandbox')) out.presetSandbox = raw.presetSandbox
  if (Object.prototype.hasOwnProperty.call(raw, 'judgePromptLang')) out.judgePromptLang = raw.judgePromptLang
  if (raw.judge && typeof raw.judge === 'object') out.judge = raw.judge
  return Object.keys(out).length ? out : null
}

/** DSH 升级文案：`escalate sandbox to <mode>: <justification>`。mode 只作展示，不短路。 */
export function parseReason(reason) {
  const m = String(reason || '').match(/escalate\s+sandbox\s+to\s+([^\s:]+):?\s*([\s\S]*)/i)
  if (m) return { mode: m[1], justification: (m[2] || '').trim() }
  return { mode: '', justification: String(reason || '') }
}

/**
 * 词边界 / 命令形态匹配。中文关键词用包含；英文按非字母数字边界，空白可伸缩。
 * 不要整句裸 includes（避免 format/revoke 一类误伤）。
 */
export function looksDeny(text, keywords = DEFAULT_DENY_KEYWORDS) {
  const hay = String(text || '')
  if (!hay) return false
  for (const raw of keywords) {
    const keyword = String(raw || '')
    if (!keyword) continue
    if (/[\u4e00-\u9fff]/.test(keyword)) {
      if (hay.includes(keyword)) return true
      continue
    }
    const escaped = keyword
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
    const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i')
    if (re.test(hay)) return true
  }
  return false
}

/**
 * 拒绝 > 人工 > 允许。返回 { action, bucket } 或 null。
 */
export function matchKeywordBuckets(text, cfg, allowText) {
  const reject = (cfg && cfg.rejectKeywords) || []
  const human = (cfg && cfg.humanKeywords) || []
  const allow = (cfg && cfg.allowKeywords) || []
  if (looksDeny(text, reject)) return { action: 'reject', bucket: 'reject' }
  if (looksDeny(text, human)) return { action: 'human', bucket: 'human' }
  const allowHay = allowText != null ? allowText : text
  if (looksDeny(allowHay, allow)) return { action: 'allow', bucket: 'allow' }
  return null
}

export function lookupCriteria(criteria, id) {
  const list = criteria || []
  const hit = list.find((c) => c && c.id === id)
  if (hit) return hit
  return list.find((c) => c && c.id === 'other') || { id: 'other', label: '其他（拿不准）', action: 'human' }
}

const TOOL_ARG_KEYS = [
  'command', 'file_path', 'path', 'old_string', 'new_string', 'content', 'description', 'workdir',
  'code', 'url', 'query', 'script', 'sql', 'prompt', 'input', 'text', 'body', 'message', 'pattern', 'selector',
]
const TOOL_ARG_LIMITS = {
  command: 8000,
  file_path: 500,
  path: 500,
  old_string: 4000,
  new_string: 4000,
  content: 4000,
  description: 500,
  workdir: 500,
  code: 4000,
  url: 1000,
  query: 2000,
  script: 4000,
  sql: 2000,
  prompt: 2000,
  input: 2000,
  text: 2000,
  body: 2000,
  message: 1000,
  pattern: 500,
  selector: 500,
}

const EXTRA_CARD_KEYS_ZH = [
  ['code', '代码'],
  ['url', 'URL'],
  ['query', '查询'],
  ['script', '脚本'],
  ['sql', 'SQL'],
  ['prompt', '提示词'],
  ['input', '输入'],
  ['text', '文本'],
  ['body', '正文'],
  ['message', '消息'],
  ['pattern', '模式'],
  ['selector', '选择器'],
]

const EXTRA_CARD_KEYS_EN = [
  ['code', 'Code'],
  ['url', 'URL'],
  ['query', 'Query'],
  ['script', 'Script'],
  ['sql', 'SQL'],
  ['prompt', 'Prompt'],
  ['input', 'Input'],
  ['text', 'Text'],
  ['body', 'Body'],
  ['message', 'Message'],
  ['pattern', 'Pattern'],
  ['selector', 'Selector'],
]

/**
 * 只抽网页工具卡片同款叶子字段。禁止 JSON.stringify live exec。
 * justification 故意不抽：关键词和卡片都以命令/路径/内容为准。
 */
/** 缓存上限。超过仍算截断，禁止自动放行。 */
export const RAW_ARG_LIMIT = 256 * 1024

/**
 * 缓存用：尽量保留原文（含空字符串：write content='' 是截断文件）。展示/送审再 clip。
 */
export function pickToolArgs(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const key of TOOL_ARG_KEYS) {
    if (typeof raw[key] !== 'string') continue
    out[key] = raw[key].length > RAW_ARG_LIMIT ? raw[key].slice(0, RAW_ARG_LIMIT) : raw[key]
  }
  return out
}

/** 任一字段超过送审限额（或顶到 RAW 上限）则不能当完整卡片自动放行。 */
export function toolArgsTruncated(args) {
  const a = args || {}
  for (const key of TOOL_ARG_KEYS) {
    if (typeof a[key] !== 'string' || !a[key]) continue
    const lim = TOOL_ARG_LIMITS[key] || 1000
    if (a[key].length > lim) return true
  }
  return false
}

export function clipToolArgsForJudge(args) {
  const a = args || {}
  const out = {}
  for (const key of TOOL_ARG_KEYS) {
    if (typeof a[key] !== 'string') continue
    const lim = TOOL_ARG_LIMITS[key] || 1000
    out[key] = a[key].length > lim ? a[key].slice(0, lim) + '…' : a[key]
  }
  return out
}

const EVENT_ARG_LIMITS = {
  command: 2000,
  file_path: 500,
  path: 500,
  old_string: 1500,
  new_string: 1500,
  content: 1500,
  description: 400,
}

/** 写入审批事件的工具卡片叶子字段（再截短，避免 jsonl 膨胀）。 */
export function clipToolArgsForEvent(args) {
  const a = args || {}
  const out = {}
  for (const key of TOOL_ARG_KEYS) {
    if (typeof a[key] !== 'string') continue
    const lim = EVENT_ARG_LIMITS[key] || 800
    out[key] = a[key].length > lim ? a[key].slice(0, lim) + '…' : a[key]
  }
  return out
}

/** description 不算有效载荷：只有它等于没看见要审的操作。 */
export function hasToolPayload(args) {
  const a = args || {}
  return Boolean(
    a.command || a.file_path || a.path || a.old_string || a.new_string || a.content
    || a.code || a.url || a.script || a.sql || a.prompt
    || a.query || a.input || a.text || a.body || a.message || a.pattern || a.selector,
  )
}

export const CALL_CACHE_LIMIT = 256

/** 有 session 时带上，避免 assembler 的 call-0 在会话间撞车。 */
export function callCacheKey(sessionId, callId) {
  const id = String(callId || '')
  if (!id) return ''
  const sid = String(sessionId || '')
  return sid ? sid + ':' + id : id
}

export function rememberCachedCall(map, sessionId, callId, args) {
  if (!map || typeof map.set !== 'function') return
  const key = callCacheKey(sessionId, callId)
  if (!key) return
  map.set(key, args)
  while (map.size > CALL_CACHE_LIMIT) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

/**
 * 优先取 session:callId；没有再回落 callId。两条都删，避免密钥片段留在 Map 里。
 */
export function takeCachedCall(map, sessionId, callId) {
  if (!map || typeof map.get !== 'function') return { found: false, args: {} }
  const id = String(callId || '')
  const sid = String(sessionId || '')
  const scoped = sid && id ? sid + ':' + id : ''
  const bare = id
  let found = false
  let args
  if (scoped && map.has(scoped)) {
    args = map.get(scoped)
    map.delete(scoped)
    found = true
  }
  if (bare && map.has(bare)) {
    if (!found) {
      args = map.get(bare)
      found = true
    }
    map.delete(bare)
  }
  return { found, args: args && typeof args === 'object' ? args : {} }
}

/**
 * 关键词干草。`reason` 参数保留以免改签名，但故意不用：升级理由会误伤允许桶。
 * cwd 只进拒绝/人工干草，不进允许桶：目录名不能把该目录下所有工具放行。
 */
function isAbsoluteKeywordPath(p) {
  const s = String(p || '')
  if (!s) return true
  if (s.startsWith('/') || s.startsWith('\\') || s.startsWith('~')) return true
  return /^[a-zA-Z]:[\\/]/.test(s)
}

function joinKeywordPath(base, p) {
  const root = String(base || '').replace(/[/\\]+$/, '')
  const rel = String(p || '')
  if (!root || !rel || isAbsoluteKeywordPath(rel)) return ''
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return root + sep + rel
}

export function formatKeywordHay(toolName, reason, args, cwd) {
  const a = args || {}
  const extras = []
  const bases = []
  if (cwd) {
    extras.push(cwd)
    bases.push(cwd)
  }
  if (a.workdir && a.workdir !== cwd) bases.push(a.workdir)
  for (const base of bases) {
    for (const p of [a.file_path, a.path]) {
      const joined = joinKeywordPath(base, p)
      if (joined) extras.push(joined)
    }
  }
  return [
    toolName,
    a.command,
    a.file_path,
    a.path,
    a.workdir,
    ...extras,
  ].filter(Boolean).join('\n')
}

/** 允许桶不看工具名，避免 `bash`/`write` 整类放行。 */
export function formatAllowKeywordHay(args) {
  const a = args || {}
  return [
    a.command,
    a.file_path,
    a.path,
    a.workdir,
  ].filter(Boolean).join('\n')
}

/** 给审核模型看的卡片。含内容/cwd；模型理由只作补充。语言与提示词框架一致。空字符串也要展示（截断写入）。 */
function cardArg(val, en) {
  return val === '' ? (en ? '(empty)' : '(空)') : val
}

function hasCardArg(a, key) {
  return typeof a[key] === 'string'
}

export function formatJudgeCard(toolName, mode, justification, args, cwd, lang) {
  const a = clipToolArgsForJudge(args)
  const en = normalizeJudgePromptLang(lang) === 'en'
  const none = en ? '(none)' : '(无说明)'
  const sandbox = mode || (en ? '(not a sandbox escalation)' : '(非越界审批)')
  const lines = en
    ? [`Tool: ${toolName}`, `Target sandbox: ${sandbox}`]
    : [`工具: ${toolName}`, `目标沙箱模式: ${sandbox}`]
  if (cwd) lines.push((en ? 'Working directory: ' : '工作目录: ') + cwd)
  if (hasCardArg(a, 'workdir') && a.workdir !== cwd) {
    lines.push((en ? 'Command working directory: ' : '命令工作目录: ') + cardArg(a.workdir, en))
  }
  if (hasCardArg(a, 'command')) lines.push(en ? 'Command:' : '命令:', cardArg(a.command, en))
  if (hasCardArg(a, 'file_path') || hasCardArg(a, 'path')) {
    lines.push((en ? 'Path: ' : '路径: ') + cardArg(a.file_path || a.path, en))
  }
  if (hasCardArg(a, 'description')) lines.push((en ? 'Description: ' : '描述: ') + cardArg(a.description, en))
  if (hasCardArg(a, 'old_string')) lines.push(en ? 'Original:' : '原文:', cardArg(a.old_string, en))
  if (hasCardArg(a, 'new_string')) lines.push(en ? 'Replacement:' : '改成:', cardArg(a.new_string, en))
  if (hasCardArg(a, 'content')) lines.push(en ? 'Write contents:' : '写入内容:', cardArg(a.content, en))
  const extra = en ? EXTRA_CARD_KEYS_EN : EXTRA_CARD_KEYS_ZH
  for (const pair of extra) {
    if (hasCardArg(a, pair[0])) lines.push(pair[1] + ':', cardArg(a[pair[0]], en))
  }
  lines.push((en ? 'Model justification: ' : '模型理由: ') + (justification || none))
  if (en) lines.push('', 'Classify. Output exactly two lines:', 'Category: <id>', 'Reason: <one sentence>')
  else lines.push('', '请归类。只输出两行：', '类别: <id>', '理由: <一句话>')
  return lines.join('\n')
}

/** 分类提示。强调选 approval-config 而不是 safe 去改 ~/.dsh 门控。语言只换框架，表行用传入 criteria 原文。 */
export function buildJudgePrompt(criteria, lang) {
  const rows = Array.isArray(criteria) && criteria.length ? criteria : shippedCriteria(lang)
  const en = normalizeJudgePromptLang(lang) === 'en'
  const lines = rows.map((c) => {
    const desc = c.description ? (en ? '. ' : '。') + c.description : ''
    return `- ${c.id}${en ? ': ' : '：'}${c.label}${desc}`
  })
  if (en) {
    return [
      'You are an approval classifier. You see the same tool card a human would. You are not the allow/reject/human decision maker.',
      'Assign the operation to exactly one row in the criteria table. Do not output allow, reject, or human.',
      '',
      'Trust command / path / original / replacement / write contents. The model justification may be incomplete or wrong; it does not override the command.',
      'Sandbox mode only describes the fence: workspace-write may write inside the workspace; danger-full-access may write outside it. Do not change the class because of the mode name.',
      'Ordinary source/docs/test/build edits outside the workspace are not deletion, credential, remote, system, or bulk by themselves.',
      'If it looks like deletion, credentials, remote, system, or bulk, pick that class.',
      'Changing the auto-approve allowlist, plugin config, or other approval-gating config under ~/.dsh is approval-config, not safe.',
      'Ordinary git push is not remote.',
      'Pick safe only when you can confirm a routine reversible operation.',
      'If neither a risk row nor safe fits, or you are unsure, pick other. Do not pick safe when unsure.',
      '',
      'Criteria:',
      ...lines,
      '',
      'Output exactly two lines and nothing else:',
      'Category: <id from the table>',
      'Reason: <one sentence>',
    ].join('\n')
  }
  return [
    '你是审批分类器，代替人看同一张工具卡片。不是放行/拒绝的决策者。',
    '根据审核表把操作归到恰好一行。不要输出允许、拒绝或人工。',
    '',
    '以「命令 / 路径 / 原文 / 改成 / 写入内容」为准。模型理由可能不完整或与实际不符，不能代替命令。',
    '沙箱模式只说明围栏范围：workspace-write 写工作区；danger-full-access 可写工作区外。不要因为模式名就改分类。',
    '工作区外常规源码/文档/测试/构建编辑本身不算删除/凭据/远程/系统/批量。',
    '像删除/凭据/远程/系统/批量就选该类。',
    '修改 ~/.dsh 下自动审批 allowlist、插件配置或其它审批门控配置选 approval-config，不要当成 safe。',
    '普通 git push 不要选 remote。',
    '只有能确认是常规可回补操作才选 safe。',
    '风险类和 safe 都不符合，或拿不准时选 other。不要因为拿不准就选 safe。',
    '',
    '审核表：',
    ...lines,
    '',
    '只输出两行，不要其它内容：',
    '类别: <上面的 id>',
    '理由: <一句话>',
  ].join('\n')
}

/**
 * 只认「类别: id」。模糊匹配跳过 other 和 action===allow 的 id，避免把 safe 当兜底。
 * 解析失败抛错，由调用方转人工。
 */
export function parseJudgeClassify(text, criteria) {
  const rows = Array.isArray(criteria) && criteria.length ? criteria : DEFAULT_CRITERIA
  const ids = new Set(rows.map((c) => c.id))
  const raw = String(text || '').trim()
  if (!raw) codedThrow('err.judgeEmpty')
  const idMatch = raw.match(/(?:^|\n)\s*(?:类别|分类|category)\s*[:：]\s*([a-z0-9_-]+)/i)
  let id = idMatch ? String(idMatch[1]).toLowerCase() : ''
  if (!id || !ids.has(id)) {
    for (const row of rows) {
      if (row.id === 'other' || row.action === 'allow') continue
      const re = new RegExp('(?:^|[^a-z0-9_])' + row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z0-9_])', 'i')
      if (re.test(raw)) { id = row.id; break }
    }
  }
  if (!id || !ids.has(id)) {
    codedThrow('err.judgeParse')
  }
  const reasonMatch = raw.match(/(?:^|\n)\s*(?:理由|reason)\s*[:：]\s*(.+)/i)
  const reason = reasonMatch ? String(reasonMatch[1]).trim().slice(0, 200) : ''
  const row = lookupCriteria(rows, id)
  return { criterion: row.id, label: row.label, action: row.action, reason }
}

export function parseJudgeOutput(text) {
  return parseJudgeClassify(text, DEFAULT_CRITERIA)
}

/** 插入 permission.presets 下的一块。sandbox 只能是 workspace-write | read-only。 */
export function autoApprovePresetYaml(sandbox = 'workspace-write') {
  const mode = normalizePresetSandbox(sandbox)
  return `      auto-approve:
        sandbox: ${mode}
        approval: ask
        name: 自动审批
        description: 审核模型预判写入/命令是否不可回补：安全自动批准，有风险转人工审批。
`
}

export const AUTO_APPROVE_PRESET_YAML = autoApprovePresetYaml('workspace-write')

export const FULL_PERMISSION_BLOCK = `
# ── 自动审批模式（dsh-auto-approve）─────────────────────────
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
`

