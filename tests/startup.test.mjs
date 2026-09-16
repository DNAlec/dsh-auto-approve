import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.mjs'
import { shippedRejectKeywords, DEFAULT_CRITERIA_ZH } from '../src/rules.mjs'
import { readAutoApproveSandbox } from '../src/preset-patch.mjs'

function createCtx() {
  const listeners = new Map()
  const ctx = {
    llm: {
      async resolveModelInfo() { throw new Error('unused') },
      async *stream() { throw new Error('unused') },
      listProviders() { return [] },
      async listModels() { return [] },
    },
    permissionPresets: { current() { return 'auto-approve' } },
    timeout(fn, ms) {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
    emit() {},
    get() { return undefined },
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
    },
    inject(services, fn) {
      // 插件用 `ctx.inject(['connection'], …)` 挂 RPC：这里交出假 connection，
      // 让启动类用例也能像设置页那样打一次真实 RPC（`setup` 的守卫就靠它验）。
      if (Array.isArray(services) && services.includes('connection') && typeof fn === 'function') {
        fn({ connection: ctx._connection, effect: (f) => { f() }, on: () => {}, get: () => undefined })
      }
    },
    _connection: {
      fetch: {
        register(options) {
          ctx._rpcHandler = options.fetch
          return () => { ctx._rpcHandler = null }
        },
      },
    },
    _rpc: async (endpoint, payload) => {
      const body = { rpcId: 'test', payload: { endpoint, payload: payload || {} } }
      const response = await ctx._rpcHandler({ json: async () => body })
      const parsed = await response.json()
      return parsed.result
    },
  }
  return ctx
}

describe('启动时的 presetSandbox 判据（第 8 轮验证性复审的接线缺口）', { concurrency: false }, () => {
  const PATCH = ['- id: permission', '  config:', '    presets:', '      auto-approve:', '        sandbox: read-only', '        approval: ask', ''].join('\n')

  function boot(home, configValue) {
    const dir = mkdtempSync(join(tmpdir(), 'aa-start-sb-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    mkdirSync(join(dir, 'auto-approve'), { recursive: true })
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
    const patch = join(dir, 'profiles', 'web', 'cordis.patch.yml')
    writeFileSync(patch, PATCH, 'utf8')
    const cfg = { enabled: false, presetSandbox: configValue }
    if (configValue === undefined) delete cfg.presetSandbox
    writeFileSync(join(dir, 'auto-approve', 'config.json'), JSON.stringify(cfg) + '\n', 'utf8')
    try {
      apply(createCtx(), { onlyAutoApprovePreset: true })
      return readFileSync(patch, 'utf8')
    } finally {
      // `apply` 抛错也要恢复：否则 DSH_HOME 会泄漏到同一文件的后续用例（每个测试文件独立进程，
      // 所以只影响本文件，但足以让失败原因变得难以理解）。
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  }

  it('认得出的写法（含大小写/空白变体）不改写 patch；缺键与认不出的值也不改写', () => {
    // 变异「键存在即有意见」会让 readonly / nope 被当成默认值 workspace-write，
    // 把用户手写的 `sandbox: read-only` 改宽——这条接线此前没有任何用例守着。
    for (const value of ['READ-ONLY', ' read-only ', 'readonly', 'nope', undefined]) {
      assert.equal(boot(null, value), PATCH, `presetSandbox=${JSON.stringify(value)} 不许改写 patch`)
    }
  })

  it('明确要求 workspace-write 时才改写（认得出的值照旧生效）', () => {
    const after = boot(null, 'workspace-write')
    assert.match(after, /sandbox: workspace-write/)
    assert.doesNotMatch(after, /sandbox: read-only/)
  })
})

describe('启动时损坏配置', { concurrency: false }, () => {
  let origHome

  before(() => {
    origHome = process.env.DSH_HOME
  })

  after(() => {
    if (origHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origHome
  })

  it('损坏的 config.json 不改已有 read-only sandbox，也不覆盖磁盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-corrupt-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const config = join(home, 'auto-approve', 'config.json')
    writeFileSync(patch, [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(config, '{not-json', 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readAutoApproveSandbox(patch), 'read-only')
    assert.equal(readFileSync(config, 'utf8'), '{not-json')
  })

  it('config 损坏时 setup RPC 拒绝写沙箱，不许把 read-only 加宽成默认值', async () => {
    // 启动路径明令「损坏配置不写沙箱」，而 setup RPC 少了同一道守卫：一次点击就会按默认
    // workspace-write 改写用户的 patch——**放宽权限**这个方向最不能猜。
    const home = mkdtempSync(join(tmpdir(), 'aa-corrupt-setup-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    writeFileSync(patch, [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(home, 'auto-approve', 'config.json'), '{not-json', 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    const ctx = createCtx()
    apply(ctx, { onlyAutoApprovePreset: true })
    const res = await ctx._rpc('setup', {})
    assert.equal(res.ok, false, '损坏配置时不许报成功')
    assert.equal(res.error.code, 'err.pluginCorrupt')
    assert.equal(readAutoApproveSandbox(patch), 'read-only', '沙箱不许被默认值加宽')
    assert.equal(readFileSync(join(home, 'auto-approve', 'config.json'), 'utf8'), '{not-json')
  })

  it('缺失 config.json 且已有 auto-approve 时不把 sandbox 改成默认 workspace-write', () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-missing-cfg-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    writeFileSync(patch, [
      '- id: permission',
      '  config:',
      '    presets:',
      '      auto-approve:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readAutoApproveSandbox(patch), 'read-only')
  })

  it('config 存在但没有 presetSandbox 键时，也不拿默认值去加宽用户手写的 read-only', () => {
    // 判据必须是「配置里**明确**说了 sandbox」：文件存在但缺这个键时 `pluginCfg.presetSandbox`
    // 是默认值 workspace-write，拿它写盘就把用户手改成 read-only 的 patch 加宽了（第 4 轮实测的 P4）。
    const home = mkdtempSync(join(tmpdir(), 'aa-startup-nosb-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const text = ['- id: permission', '  config:', '    presets:', '      auto-approve:', '        sandbox: read-only', '        approval: ask', ''].join('\n')
    writeFileSync(patch, text, 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 22,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: [],
      allowKeywords: [],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    writeFileSync(join(home, 'auto-approve', 'config.json'), JSON.stringify({ judgePromptLang: 'zh' }) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readFileSync(patch, 'utf8'), text, '没有明确配置就不许改写用户的 sandbox')
    // 明确配了才跟随
    writeFileSync(join(home, 'auto-approve', 'config.json'), JSON.stringify({ judgePromptLang: 'zh', presetSandbox: 'workspace-write' }) + '\n', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.match(readFileSync(patch, 'utf8'), /sandbox: workspace-write/)
  })

  it('损坏的 allowlist.json 不覆盖磁盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-corrupt-al-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8')
    const allowlist = join(home, 'auto-approve', 'allowlist.json')
    writeFileSync(allowlist, '{not-json', 'utf8')
    apply(createCtx(), { onlyAutoApprovePreset: true })
    assert.equal(readFileSync(allowlist, 'utf8'), '{not-json')
  })
})
