import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  looksDeny,
  DEFAULT_DENY_KEYWORDS,
  parseReason,
  parseJudgeOutput,
  parseJudgeClassify,
  matchKeywordBuckets,
  formatAllowKeywordHay,
  mergePluginConfig,
  pickMigratablePluginConfig,
  AUTO_APPROVE_PRESET_YAML,
  autoApprovePresetYaml,
  normalizeAllowlist,
  DEFAULT_CRITERIA,
  DEFAULT_CRITERIA_EN,
  DEFAULT_CRITERIA_ZH,
  shippedCriteria,
  cloneShippedCriteria,
  normalizeJudgePromptLang,
  buildJudgePrompt,
  shippedRejectKeywords,
  DEFAULT_APPROVAL_CONFIG_KEYWORDS,
  cloneAllowlist,
  copyAllowlistInto,
  mutateAllowlistOp,
  fail,
  effectiveJudgeTimeoutMs,
  pickToolArgs,
  toolArgsTruncated,
  formatKeywordHay,
  formatJudgeCard,
  hasToolPayload,
  callCacheKey,
  rememberCachedCall,
  takeCachedCall,
  CALL_CACHE_LIMIT,
} from '../src/rules.mjs'

describe('looksDeny 词边界', () => {
  it('命中危险命令形态', () => {
    assert.equal(looksDeny('bash escalate sandbox to danger-full-access: rm -rf /tmp/x', DEFAULT_DENY_KEYWORDS), true)
    assert.equal(looksDeny('git push --force origin main', DEFAULT_DENY_KEYWORDS), true)
    assert.equal(looksDeny('sudo rm /etc/passwd', DEFAULT_DENY_KEYWORDS), true)
    assert.equal(looksDeny('drop database testdb', DEFAULT_DENY_KEYWORDS), true)
  })

  it('不误伤 format / revoke / formatted', () => {
    assert.equal(looksDeny('format the report as markdown', DEFAULT_DENY_KEYWORDS), false)
    assert.equal(looksDeny('revoke the previous sentence', DEFAULT_DENY_KEYWORDS), false)
    assert.equal(looksDeny('formatted output for the user', DEFAULT_DENY_KEYWORDS), false)
  })

  it('不把 docker rmi 当成 docker rm', () => {
    assert.equal(looksDeny('docker rmi old-image', DEFAULT_DENY_KEYWORDS), false)
    assert.equal(looksDeny('git push -f origin main', DEFAULT_DENY_KEYWORDS), true)
  })
})

describe('parseReason', () => {
  it('解析 escalate reason', () => {
    const r = parseReason('escalate sandbox to workspace-write: edit README.md')
    assert.equal(r.mode, 'workspace-write')
    assert.equal(r.justification, 'edit README.md')
  })
})

describe('judge parse', () => {
  it('解析 类别 + 理由，动作用表', () => {
    const got = parseJudgeClassify('类别: deletion\n理由: 会删掉数据', DEFAULT_CRITERIA)
    assert.equal(got.criterion, 'deletion')
    assert.equal(got.action, 'reject')
    assert.match(got.reason, /删掉/)
    const safe = parseJudgeClassify('类别: safe\n理由: 改 README', DEFAULT_CRITERIA)
    assert.equal(safe.criterion, 'safe')
    assert.equal(safe.action, 'allow')
  })

  it('无法解析则抛错', () => {
    assert.throws(() => parseJudgeOutput('I am not sure but maybe okay'))
    assert.throws(() => parseJudgeOutput('SAFE'))
    assert.throws(() => parseJudgeOutput('无法确定'))
    assert.throws(() => parseJudgeOutput('this looks safe to me'))
  })

  it('认全角冒号；模糊匹配不把 safe 当兜底', () => {
    const got = parseJudgeClassify('类别：credential\n理由：改 .env', DEFAULT_CRITERIA)
    assert.equal(got.criterion, 'credential')
    assert.throws(() => parseJudgeClassify('unknown id only', DEFAULT_CRITERIA))
    const en = parseJudgeClassify('Category: deletion\nReason: would delete data', DEFAULT_CRITERIA)
    assert.equal(en.criterion, 'deletion')
    assert.equal(en.action, 'reject')
  })
})

describe('缺参 fail-closed', () => {
  it('有命令或路径才算捕获到工具卡片', () => {
    assert.equal(hasToolPayload({ command: 'ls' }), true)
    assert.equal(hasToolPayload({ file_path: 'a.ts' }), true)
    assert.equal(hasToolPayload({ path: '/tmp/x' }), true)
    assert.equal(hasToolPayload({ content: 'hi' }), true)
    assert.equal(hasToolPayload({ description: 'just a note' }), false)
    assert.equal(hasToolPayload({ code: 'print(1)' }), true)
    assert.equal(hasToolPayload({ url: 'https://example.com' }), true)
    assert.equal(hasToolPayload({ query: 'foo' }), true)
    assert.equal(hasToolPayload({ selector: '.x' }), true)
    assert.equal(hasToolPayload({}), false)
  })

  it('缓存按 session+callId 隔离，用完删除', () => {
    const map = new Map()
    rememberCachedCall(map, 's1', 'call-0', { command: 'rm -rf /' })
    rememberCachedCall(map, 's2', 'call-0', { command: 'echo ok' })
    assert.equal(callCacheKey('s1', 'call-0'), 's1:call-0')
    const a = takeCachedCall(map, 's1', 'call-0')
    assert.equal(a.found, true)
    assert.equal(a.args.command, 'rm -rf /')
    assert.equal(map.has('s1:call-0'), false)
    const b = takeCachedCall(map, 's2', 'call-0')
    assert.equal(b.args.command, 'echo ok')
    const miss = takeCachedCall(map, 's1', 'call-0')
    assert.equal(miss.found, false)
  })

  it('无 session 时回落到 callId，超出上限淘汰最早的', () => {
    const map = new Map()
    rememberCachedCall(map, '', 'call-9', { command: 'bare' })
    const got = takeCachedCall(map, 'later-session', 'call-9')
    assert.equal(got.found, true)
    assert.equal(got.args.command, 'bare')
    for (let i = 0; i < CALL_CACHE_LIMIT + 5; i++) {
      rememberCachedCall(map, 's', 'c' + i, { command: String(i) })
    }
    assert.equal(map.size, CALL_CACHE_LIMIT)
    assert.equal(map.has(callCacheKey('s', 'c0')), false)
    assert.equal(map.has(callCacheKey('s', 'c' + (CALL_CACHE_LIMIT + 4))), true)
  })
})

describe('tool card', () => {
  it('只抽叶子字段，命令进关键词干草', () => {
    const args = pickToolArgs({
      command: 'rm -rf /tmp/x',
      justification: '清理缓存',
      nested: { nope: true },
    })
    assert.equal(args.command, 'rm -rf /tmp/x')
    assert.equal(args.justification, undefined)
    const hay = formatKeywordHay('bash', 'escalate sandbox to danger-full-access: 清理缓存', args)
    assert.match(hay, /rm -rf \/tmp\/x/)
    assert.equal(hay.includes('清理缓存'), false)
    const docHay = formatKeywordHay('write', '写文档', pickToolArgs({
      file_path: 'README.md',
      content: 'never run rm -rf / on production',
    }))
    assert.equal(docHay.includes('rm -rf'), false)
    const descHay = formatKeywordHay('bash', '', pickToolArgs({
      command: 'ls src',
      description: 'npm test in docs',
    }))
    assert.equal(descHay.includes('npm test'), false)
    const card = formatJudgeCard('bash', 'danger-full-access', '清理缓存', args, '/home/alec/ws')
    assert.match(card, /命令/)
    assert.match(card, /rm -rf/)
    assert.match(card, /工作目录: \/home\/alec\/ws/)
    const enCard = formatJudgeCard('bash', 'danger-full-access', '清理缓存', args, '/home/alec/ws', 'en')
    assert.match(enCard, /Command:/)
    assert.match(enCard, /Working directory: \/home\/alec\/ws/)
    assert.match(enCard, /Category: <id>/)
  })

  it('超长命令算截断；workdir 进关键词干草', () => {
    const long = 'echo ' + 'a'.repeat(9000)
    assert.equal(toolArgsTruncated({ command: long }), true)
    assert.equal(toolArgsTruncated({ command: 'ls' }), false)
    const hay = formatKeywordHay('bash', '', { command: 'echo x', workdir: '/home/alec/.dsh/auto-approve' })
    assert.match(hay, /\.dsh\/auto-approve/)
  })

  it('会话 cwd 进拒绝干草；相对路径拼上 cwd；允许干草不含 cwd', () => {
    const cfg = normalizeAllowlist({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
    })
    const hay = formatKeywordHay('write', '', { file_path: 'allowlist.json' }, '/home/alec/.dsh/auto-approve')
    assert.match(hay, /\.dsh\/auto-approve\/allowlist\.json/)
    assert.equal(matchKeywordBuckets(hay, cfg).action, 'reject')
    const allowHay = formatAllowKeywordHay({ file_path: 'allowlist.json' })
    assert.equal(allowHay.includes('.dsh/auto-approve'), false)
    const envHay = formatKeywordHay('write', '', { file_path: '.env' }, '/home/alec/proj')
    assert.equal(matchKeywordBuckets(envHay, cfg).action, 'reject')
  })

  it('空写入内容仍进卡片，不从 pickToolArgs 丢掉', () => {
    const args = pickToolArgs({ file_path: 'notes.md', content: '' })
    assert.equal(args.content, '')
    assert.equal(hasToolPayload(args), true)
    const zh = formatJudgeCard('write', 'danger-full-access', '', args, '/tmp/ws')
    assert.match(zh, /写入内容/)
    assert.match(zh, /\(空\)/)
    const en = formatJudgeCard('write', 'danger-full-access', '', args, '/tmp/ws', 'en')
    assert.match(en, /Write contents:/)
    assert.match(en, /\(empty\)/)
    const edit = pickToolArgs({ file_path: 'a.ts', old_string: 'x', new_string: '' })
    assert.equal(edit.new_string, '')
    const editCard = formatJudgeCard('edit', '', '', edit, '/tmp')
    assert.match(editCard, /改成:/)
    assert.match(editCard, /\(空\)/)
  })
})

describe('matchKeywordBuckets', () => {
  it('拒绝优先于人工优先于允许', () => {
    const cfg = {
      rejectKeywords: ['rm -rf'],
      humanKeywords: ['rm -rf', 'docker rm'],
      allowKeywords: ['npm test'],
    }
    assert.equal(matchKeywordBuckets('bash rm -rf /tmp', cfg).action, 'reject')
    assert.equal(matchKeywordBuckets('docker rm c1', cfg).action, 'human')
    assert.equal(matchKeywordBuckets('run npm test', cfg).action, 'allow')
    assert.equal(matchKeywordBuckets('edit README', cfg), null)
  })

  it('允许桶不匹配纯工具名', () => {
    const cfg = { rejectKeywords: [], humanKeywords: [], allowKeywords: ['bash'] }
    const hay = formatKeywordHay('bash', '', { command: 'ls src' })
    const allowHay = formatAllowKeywordHay({ command: 'ls src' })
    assert.equal(matchKeywordBuckets(hay, cfg, allowHay), null)
    assert.equal(matchKeywordBuckets(hay, { allowKeywords: ['ls src'] }, allowHay).action, 'allow')
  })
})

describe('mergePluginConfig', () => {
  it('空值回落到默认，overlay 覆盖 yaml', () => {
    const m = mergePluginConfig({ judge: { model: 'from-yaml' } }, { judge: { provider: 'p' } })
    assert.equal(m.judge.model, 'from-yaml')
    assert.equal(m.judge.provider, 'p')
    assert.equal(m.onlyAutoApprovePreset, true)
    assert.equal(m.presetSandbox, 'workspace-write')
    assert.equal(m.judgePromptLang, 'zh')
    assert.equal('notify' in m, false)
    assert.equal('channels' in m, false)
  })

  it('judgePromptLang 只接受 zh/en', () => {
    assert.equal(mergePluginConfig({}, { judgePromptLang: 'en' }).judgePromptLang, 'en')
    assert.equal(mergePluginConfig({}, { judgePromptLang: 'fr' }).judgePromptLang, 'zh')
    assert.equal(normalizeJudgePromptLang('en'), 'en')
    assert.equal(normalizeJudgePromptLang(''), 'zh')
  })

  it('presetSandbox 只接受 workspace-write / read-only', () => {
    assert.equal(mergePluginConfig({}, { presetSandbox: 'read-only' }).presetSandbox, 'read-only')
    assert.equal(mergePluginConfig({}, { presetSandbox: 'danger-full-access' }).presetSandbox, 'workspace-write')
  })
})

describe('normalizeAllowlist', () => {
  it('丢掉已废弃的白名单字段', () => {
    const cfg = normalizeAllowlist({
      allowRules: [
        { mode: 'workspace-write', description: '工作区写入（可回补）' },
        { tool: 'bash', contains: 'src/index.mjs' },
      ],
    })
    assert.equal(cfg.allowRules, undefined)
    assert.equal(cfg.denyRules, undefined)
    assert.equal(cfg.learning, undefined)
  })

  it('空配置预置词进拒绝桶', () => {
    const cfg = normalizeAllowlist({})
    assert.ok(cfg.rejectKeywords.includes('rm -rf'))
    assert.ok(cfg.rejectKeywords.includes('auto-approve/allowlist'))
    assert.ok(cfg.rejectKeywords.includes('.dsh/auto-approve'))
    assert.ok(cfg.rejectKeywords.includes('.env'))
    assert.ok(cfg.rejectKeywords.includes('id_rsa'))
    assert.equal(cfg.humanKeywords.length, 0)
    assert.equal(cfg.version, 18)
    const other = cfg.criteria.find((c) => c.id === 'other')
    const safe = cfg.criteria.find((c) => c.id === 'safe')
    assert.equal(other.action, 'human')
    assert.equal(other.label, '其他（拿不准）')
    assert.equal(safe.action, 'allow')
  })

  it('v4 人工桶预置词迁到拒绝', () => {
    const cfg = normalizeAllowlist({
      version: 4,
      rejectKeywords: [],
      humanKeywords: ['rm -rf', 'my-custom'],
      allowKeywords: [],
    })
    assert.ok(cfg.rejectKeywords.includes('rm -rf'))
    assert.ok(cfg.rejectKeywords.includes('my-custom'))
    assert.equal(cfg.humanKeywords.length, 0)
  })

  it('v6 其他允许会被后续迁移改回人工', () => {
    const cfg = normalizeAllowlist({
      version: 6,
      rejectKeywords: ['rm -rf'],
      humanKeywords: [],
      allowKeywords: [],
      criteria: [
        { id: 'deletion', label: '删除', action: 'human' },
        { id: 'other', label: '其他', action: 'human' },
      ],
    })
    assert.equal(cfg.criteria.find((c) => c.id === 'other').action, 'human')
    assert.equal(cfg.criteria.find((c) => c.id === 'safe').action, 'allow')
    assert.equal(cfg.criteria.find((c) => c.id === 'deletion').action, 'reject')
    assert.equal(cfg.version, 18)
  })

  it('v7 拿掉只对理由有意义的中文词', () => {
    const cfg = normalizeAllowlist({
      version: 7,
      rejectKeywords: ['rm -rf', '删除数据库', '清空数据库'],
      humanKeywords: [],
      allowKeywords: [],
    })
    assert.equal(cfg.rejectKeywords.includes('删除数据库'), false)
    assert.equal(cfg.rejectKeywords.includes('清空数据库'), false)
    assert.ok(cfg.rejectKeywords.includes('rm -rf'))
    assert.ok(cfg.rejectKeywords.includes('drop database'))
  })

  it('v8 拿掉 reset/clean/裸 shutdown，补 pwsh 与 systemd', () => {
    const cfg = normalizeAllowlist({
      version: 8,
      rejectKeywords: ['rm -rf', 'git reset --hard', 'shutdown', 'reboot', 'rsync --delete'],
      humanKeywords: [],
      allowKeywords: [],
    })
    assert.equal(cfg.rejectKeywords.includes('git reset --hard'), false)
    assert.equal(cfg.rejectKeywords.includes('shutdown'), false)
    assert.equal(cfg.rejectKeywords.includes('reboot'), false)
    assert.ok(cfg.rejectKeywords.includes('systemctl reboot'))
    assert.ok(cfg.rejectKeywords.includes('Remove-Item -Recurse -Force'))
    assert.ok(cfg.rejectKeywords.includes('shutdown -h'))
  })

  it('v10 其他允许改为人工，并插入 safe', () => {
    const cfg = normalizeAllowlist({
      version: 10,
      rejectKeywords: ['rm -rf'],
      criteria: [
        { id: 'deletion', label: '删除', action: 'human' },
        { id: 'other', label: '其他', action: 'allow' },
      ],
    })
    const ids = cfg.criteria.map((c) => c.id)
    assert.ok(ids.includes('safe'))
    assert.ok(ids.indexOf('safe') < ids.indexOf('other'))
    assert.equal(cfg.criteria.find((c) => c.id === 'other').action, 'human')
    assert.equal(cfg.criteria.find((c) => c.id === 'safe').action, 'allow')
    assert.equal(cfg.criteria.find((c) => c.id === 'deletion').action, 'reject')
    assert.equal(cfg.version, 18)
  })

  it('v12 插入 approval-config 默认拒绝', () => {
    const cfg = normalizeAllowlist({
      version: 12,
      rejectKeywords: ['rm -rf'],
      criteria: [
        { id: 'deletion', label: '删除', action: 'reject' },
        { id: 'safe', label: '安全', action: 'allow' },
        { id: 'other', label: '其他', action: 'human' },
      ],
    })
    const ids = cfg.criteria.map((c) => c.id)
    assert.ok(ids.includes('approval-config'))
    assert.ok(ids.indexOf('approval-config') < ids.indexOf('safe'))
    assert.equal(cfg.criteria.find((c) => c.id === 'approval-config').action, 'reject')
    assert.equal(cfg.version, 18)
  })

  it('v15 插入审批配置路径拒绝词', () => {
    const cfg = normalizeAllowlist({
      version: 14,
      rejectKeywords: ['rm -rf'],
    })
    assert.ok(cfg.rejectKeywords.includes('auto-approve/allowlist'))
    assert.ok(cfg.rejectKeywords.includes('approval-bridge/config.json'))
    assert.ok(cfg.rejectKeywords.includes('approval-bridge/qqbot.json'))
    assert.ok(cfg.rejectKeywords.includes('.dsh/auto-approve'))
    const hay = formatKeywordHay('write', '', { file_path: '/home/alec/.dsh/auto-approve/allowlist.json' })
    assert.equal(matchKeywordBuckets(hay, cfg).action, 'reject')
    const cfgHay = formatKeywordHay('write', '', { file_path: '/home/alec/.dsh/approval-bridge/config.json' })
    assert.equal(matchKeywordBuckets(cfgHay, cfg).action, 'reject')
    const qqHay = formatKeywordHay('write', '', { file_path: '/home/alec/.dsh/approval-bridge/qqbot.json' })
    assert.equal(matchKeywordBuckets(qqHay, cfg).action, 'reject')
    const wdHay = formatKeywordHay('bash', '', { command: 'echo x', workdir: '/home/alec/.dsh/auto-approve' })
    assert.equal(matchKeywordBuckets(wdHay, cfg).action, 'reject')
  })

  it('v17 插入凭据路径拒绝词', () => {
    const cfg = normalizeAllowlist({
      version: 16,
      rejectKeywords: ['rm -rf'],
    })
    assert.ok(cfg.rejectKeywords.includes('.env'))
    assert.ok(cfg.rejectKeywords.includes('id_rsa'))
    const hay = formatKeywordHay('write', '', { file_path: '/home/alec/proj/.env' })
    assert.equal(matchKeywordBuckets(hay, cfg).action, 'reject')
  })

  it('v18 刷出厂审核表文案，不改自定义描述和 action', () => {
    const zh = normalizeAllowlist({
      version: 17,
      rejectKeywords: ['rm -rf'],
      criteria: [
        { id: 'remote', label: '远程系统/生产环境/数据库', description: '以实际命令为准：对远程主机/生产/数据库做写入，ssh/kubectl/云 CLI 的变更，或对外发布（publish/部署）；只读查询不算', action: 'human' },
        { id: 'safe', label: '安全/常规可回补', description: '以命令/路径/内容为准：能确认是常规可回补操作（源码、文档、测试、构建产物、可撤销编辑）。拿不准不要选此项', action: 'allow' },
        { id: 'other', label: '其他', description: '以上风险类都不符合，且不能确认是否安全', action: 'human' },
      ],
    })
    assert.equal(zh.version, 18)
    assert.equal(zh.criteria.find((c) => c.id === 'remote').action, 'human')
    assert.match(zh.criteria.find((c) => c.id === 'remote').description, /普通 git push 不算/)
    assert.equal(zh.criteria.find((c) => c.id === 'other').label, '其他（拿不准）')
    assert.match(zh.criteria.find((c) => c.id === 'safe').description, /发包、提权、外发数据不要选/)

    const en = normalizeAllowlist({
      version: 17,
      rejectKeywords: ['rm -rf'],
      criteria: [
        { id: 'remote', label: 'Remote/production/database', description: 'Based on the actual command: writes to remote hosts, production, or databases; ssh/kubectl/cloud CLI mutations; or publishing/deploying. Read-only queries do not count', action: 'reject' },
        { id: 'other', label: 'Other', description: 'None of the risk rows apply, and safety cannot be confirmed', action: 'human' },
      ],
    })
    assert.match(en.criteria.find((c) => c.id === 'remote').description, /ordinary git push do not count/)
    assert.equal(en.criteria.find((c) => c.id === 'other').label, 'Other (unsure)')

    const custom = normalizeAllowlist({
      version: 17,
      rejectKeywords: ['rm -rf'],
      criteria: [
        { id: 'safe', label: '我的安全', description: '自定义描述', action: 'allow' },
        { id: 'other', label: '其他', description: '以上风险类都不符合，且不能确认是否安全', action: 'human' },
      ],
    })
    assert.equal(custom.criteria.find((c) => c.id === 'safe').label, '我的安全')
    assert.equal(custom.criteria.find((c) => c.id === 'safe').description, '自定义描述')
    assert.equal(custom.criteria.find((c) => c.id === 'other').label, '其他（拿不准）')
  })

  it('version 已是 15 且三桶全空时仍回填含路径的出厂拒绝词', () => {
    const cfg = normalizeAllowlist({
      version: 15,
      rejectKeywords: [],
      humanKeywords: [],
      allowKeywords: [],
    })
    assert.ok(cfg.rejectKeywords.includes('rm -rf'))
    assert.ok(cfg.rejectKeywords.includes('auto-approve/allowlist'))
    assert.ok(cfg.rejectKeywords.includes('.dsh/auto-approve'))
  })

  it('缺 other 会补回；恢复默认拒绝词含路径兜底', () => {
    const cfg = normalizeAllowlist({
      version: 15,
      rejectKeywords: ['rm -rf'],
      criteria: [{ id: 'safe', label: '安全', action: 'allow' }],
    })
    assert.ok(cfg.criteria.some((c) => c.id === 'other'))
    const shipped = shippedRejectKeywords()
    for (const w of DEFAULT_APPROVAL_CONFIG_KEYWORDS) {
      assert.ok(shipped.includes(w))
    }
    assert.ok(shipped.includes('rm -rf'))
  })
})

describe('auto-approve 预设文案', () => {
  it('显示名是自动审批，不再带 Flash', () => {
    assert.match(AUTO_APPROVE_PRESET_YAML, /name:\s*自动审批\s*$/m)
    assert.equal(AUTO_APPROVE_PRESET_YAML.includes('Flash'), false)
    assert.match(AUTO_APPROVE_PRESET_YAML, /审核模型预判/)
  })

  it('autoApprovePresetYaml 可写成 read-only', () => {
    const yaml = autoApprovePresetYaml('read-only')
    assert.match(yaml, /sandbox:\s*read-only/)
    assert.match(AUTO_APPROVE_PRESET_YAML, /sandbox:\s*workspace-write/)
  })
})

describe('effectiveJudgeTimeoutMs', () => {
  it('优先 allowlist，yaml 只作缺省', () => {
    assert.equal(effectiveJudgeTimeoutMs({ judgeTimeoutMs: 8000 }, { judge: { timeoutMs: 20000 } }), 8000)
    assert.equal(effectiveJudgeTimeoutMs({ judgeTimeoutMs: 0 }, { judge: { timeoutMs: 5000 } }), 5000)
    assert.equal(effectiveJudgeTimeoutMs({}, {}), 20000)
  })
})

describe('shipped criteria / judge prompt lang', () => {
  it('中英出厂表 id 与 action 相同', () => {
    assert.deepEqual(
      DEFAULT_CRITERIA_ZH.map((c) => c.id + ':' + c.action),
      DEFAULT_CRITERIA_EN.map((c) => c.id + ':' + c.action),
    )
    assert.equal(DEFAULT_CRITERIA, DEFAULT_CRITERIA_ZH)
    assert.equal(shippedCriteria('en')[0].label, DEFAULT_CRITERIA_EN[0].label)
    assert.equal(shippedCriteria('zh')[0].label, DEFAULT_CRITERIA_ZH[0].label)
  })

  it('英文框架不含中文指令；表行用传入原文', () => {
    const en = buildJudgePrompt(cloneShippedCriteria('en'), 'en')
    assert.match(en, /Category: <id from the table>/)
    assert.match(en, /Reason: <one sentence>/)
    assert.equal(en.includes('你是审批分类器'), false)
    assert.match(en, /Delete\/overwrite irreplaceable data/)
    assert.match(en, /Ordinary git push is not remote/)
    const zh = buildJudgePrompt(cloneShippedCriteria('zh'), 'zh')
    assert.match(zh, /类别: <上面的 id>/)
    assert.match(zh, /删除\/覆盖不可再生数据/)
    assert.match(zh, /普通 git push 不要选 remote/)
    const mixed = buildJudgePrompt(cloneShippedCriteria('zh'), 'en')
    assert.match(mixed, /Category:/)
    assert.match(mixed, /删除\/覆盖不可再生数据/)
  })
})

describe('mutateAllowlistOp', () => {
  it('other 不可删；写盘前活对象不变', () => {
    const live = normalizeAllowlist({ version: 16, rejectKeywords: ['rm -rf'] })
    const draft = cloneAllowlist(live)
    const blocked = mutateAllowlistOp(draft, 'remove', 'criteria', 'other')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'err.criterionOtherLocked')
    const added = mutateAllowlistOp(draft, 'add', 'keywords', { text: 'only-in-draft', action: 'reject' })
    assert.equal(added.ok, true)
    assert.ok(draft.rejectKeywords.includes('only-in-draft'))
    assert.equal(live.rejectKeywords.includes('only-in-draft'), false)
    copyAllowlistInto(live, draft)
    assert.ok(live.rejectKeywords.includes('only-in-draft'))
  })

  it('恢复默认审核表按 lang 选包', () => {
    const draft = cloneAllowlist(normalizeAllowlist({ version: 17, rejectKeywords: ['rm -rf'] }))
    const en = mutateAllowlistOp(draft, 'reset', 'criteria', { lang: 'en' })
    assert.equal(en.ok, true)
    assert.equal(draft.criteria.find((c) => c.id === 'safe').label, DEFAULT_CRITERIA_EN.find((c) => c.id === 'safe').label)
    const zh = mutateAllowlistOp(draft, 'reset', 'criteria', { lang: 'zh' })
    assert.equal(zh.ok, true)
    assert.equal(draft.criteria.find((c) => c.id === 'safe').label, DEFAULT_CRITERIA_ZH.find((c) => c.id === 'safe').label)
    mutateAllowlistOp(draft, 'reset', 'criteria', {})
    assert.equal(draft.criteria.find((c) => c.id === 'other').label, '其他（拿不准）')
  })

  it('恢复默认拒绝词走 shippedRejectKeywords，不是 DEFAULT_DENY_KEYWORDS', () => {
    const draft = cloneAllowlist(normalizeAllowlist({ version: 18, rejectKeywords: ['only-custom'] }))
    draft.rejectKeywords = ['only-custom']
    const r = mutateAllowlistOp(draft, 'reset', 'keywords', null)
    assert.equal(r.ok, true)
    const shipped = shippedRejectKeywords()
    for (const w of shipped) assert.ok(draft.rejectKeywords.includes(w), w)
    assert.equal(draft.rejectKeywords.includes('only-custom'), false)
    assert.ok(draft.rejectKeywords.includes('.env'))
    assert.ok(draft.rejectKeywords.includes('auto-approve/allowlist'))
  })
})


describe('error codes', () => {
  it('规则操作失败返回 code 而不是中文', () => {
    const draft = cloneAllowlist(normalizeAllowlist({ version: 16, rejectKeywords: ['rm -rf'] }))
    assert.equal(mutateAllowlistOp(draft, 'remove', 'criteria', 'missing').code, 'err.criterionNotFound')
    assert.equal(mutateAllowlistOp(draft, 'add', 'keywords', { text: '' }).code, 'err.keywordEmpty')
    assert.equal(fail('err.invalidNumber').code, 'err.invalidNumber')
  })

  it('审核解析失败抛带 code 的错误', () => {
    try {
      parseJudgeClassify('', DEFAULT_CRITERIA)
      assert.fail('should throw')
    } catch (e) {
      assert.equal(e.code, 'err.judgeEmpty')
    }
    try {
      parseJudgeClassify('no category here', DEFAULT_CRITERIA)
      assert.fail('should throw')
    } catch (e) {
      assert.equal(e.code, 'err.judgeParse')
    }
  })
})
describe('pickMigratablePluginConfig', () => {
  it('只抽出判定字段，丢掉 notify / channels', () => {
    const picked = pickMigratablePluginConfig({
      onlyAutoApprovePreset: false,
      presetSandbox: 'read-only',
      judgePromptLang: 'en',
      judge: { provider: 'p', model: 'm', reasoningEffort: 'off', timeoutMs: 9000 },
      notify: { enabled: true, chatId: 'u1' },
      channels: { qqbot: { enabled: true, chatId: 'u1' } },
    })
    assert.equal(picked.onlyAutoApprovePreset, false)
    assert.equal(picked.presetSandbox, 'read-only')
    assert.equal(picked.judgePromptLang, 'en')
    assert.equal(picked.judge.model, 'm')
    assert.equal('notify' in picked, false)
    assert.equal('channels' in picked, false)
    const merged = mergePluginConfig({}, picked)
    assert.equal(merged.judge.timeoutMs, 9000)
    assert.equal('notify' in merged, false)
  })

  it('空对象或非对象返回 null', () => {
    assert.equal(pickMigratablePluginConfig(null), null)
    assert.equal(pickMigratablePluginConfig({ notify: { chatId: 'u1' } }), null)
  })
})
