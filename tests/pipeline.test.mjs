import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.mjs'
import { pathsFor } from '../src/util.mjs'
import { shippedRejectKeywords, DEFAULT_CRITERIA_ZH } from '../src/rules.mjs'

function createCtx() {
  const listeners = new Map()
  const ctx = {
    llm: {
      async resolveModelInfo() { throw new Error('llm unused in keyword cases') },
      async *stream() { throw new Error('llm unused in keyword cases') },
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
    inject() {},
  }
  ctx._listeners = listeners
  return ctx
}

function sessionOf(cwd) {
  return { id: 'sess-pipeline', header: { cwd } }

}


function eventRows() {
  const path = pathsFor().events
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  if (!text) return []
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function runCase(ctx, { command, reason, toolName = 'bash', nextFn, skipPre, cwd, args } = {}) {
  const session = sessionOf(cwd || '/tmp/ws-pipeline')
  const callId = 'call-' + Math.random().toString(36).slice(2)
  const before = eventRows().length
  if (!skipPre) {
    const pre = ctx._listeners.get('tools/pre-execute') || []
    for (const h of pre) {
      await h({
        callId,
        agent: { session },
        arguments: args || { command },

      }, () => undefined)
    }
  }
  const req = {
    agent: { session },
    toolName,
    callId,
    reason,
  }
  const handlers = ctx._listeners.get('approval/request') || []
  assert.ok(handlers.length > 0, 'approval/request 未挂上')
  const outcome = await handlers[0](req, nextFn || (async () => 'web-human'))
  return { outcome, events: eventRows().slice(before), callId }
}

describe('approval/request 三条路径', () => {
  let prevHome
  let ctx

  before(() => {
    prevHome = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'aa-pipe-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'auto-approve'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8')
    writeFileSync(join(home, 'auto-approve', 'allowlist.json'), JSON.stringify({
      version: 18,
      rejectKeywords: shippedRejectKeywords(),
      humanKeywords: ['NEEDS-HUMAN-TOKEN'],
      allowKeywords: ['SAFE-ALLOW-TOKEN'],
      criteria: DEFAULT_CRITERIA_ZH,
      judgeTimeoutMs: 20000,
    }, null, 2) + '\n', 'utf8')
    ctx = createCtx()
    apply(ctx, { onlyAutoApprovePreset: true })
  })

  after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('拒绝：rm -rf 命中关键词，直接 rejected', async () => {
    const { outcome } = await runCase(ctx, {
      command: 'rm -rf /tmp/aa-reject-probe',
      reason: 'escalate sandbox to danger-full-access: 删临时目录',
    })
    assert.equal(outcome, 'rejected')
  })

  it('通过：允许词命中，直接 allowed-once', async () => {
    const { outcome } = await runCase(ctx, {
      command: 'echo SAFE-ALLOW-TOKEN',
      reason: 'escalate sandbox to danger-full-access: 写安全探测',
    })
    assert.equal(outcome, 'allowed-once')
  })

  it('转人工：人工词命中，next() 交给网页框', async () => {
    const { outcome, events } = await runCase(ctx, {
      command: 'echo NEEDS-HUMAN-TOKEN',
      reason: 'escalate sandbox to danger-full-access: 拿不准的探测',
    })
    assert.equal(outcome, 'web-human')
    assert.ok(events.some((e) => e.path === 'keyword-human'))
  })

  it('缺参转人工，禁止自动放行', async () => {
    const { outcome, events } = await runCase(ctx, {
      command: '',
      reason: 'escalate sandbox to danger-full-access: 空命令',
    })
    assert.equal(outcome, 'web-human')
    assert.ok(events.some((e) => e.path === 'missing-payload' && e.judgeReason === 'err.missingPayload'))
  })

  it('未捕获工具参数也走 missing-payload', async () => {
    const { outcome, events } = await runCase(ctx, {
      command: 'echo never-seen',
      reason: 'escalate sandbox to danger-full-access: 无缓存',
      skipPre: true,
    })
    assert.equal(outcome, 'web-human')
    assert.ok(events.some((e) => e.path === 'missing-payload' && e.judgeReason === 'err.missingPayloadUncaptured'))
  })

  it('next() 抛错只交接一次，返回 unavailable', async () => {
    let n = 0
    const { outcome, events } = await runCase(ctx, {
      command: '',
      reason: 'escalate sandbox to danger-full-access: 框失败',
      nextFn: async () => {
        n += 1
        throw new Error('boom')
      },
    })
    assert.equal(n, 1)
    assert.equal(outcome, 'unavailable')
    assert.ok(events.some((e) => e.kind === 'manual-unavailable' || e.path === 'missing-payload'))
  })

  it('未命中关键词时审核失败转人工，禁止自动放行', async () => {
    const { outcome, events } = await runCase(ctx, {
      command: 'echo PIPELINE-JUDGE-MISS',
      reason: 'escalate sandbox to danger-full-access: 走审核表',
    })
    assert.equal(outcome, 'web-human')
    assert.equal(outcome === 'allowed-once', false)
    assert.ok(events.some((e) => e.path === 'judge-failed'))
  })

  it('允许词但参数过长：截断后转人工，禁止按前缀放行', async () => {
    const { outcome, events } = await runCase(ctx, {
      command: 'echo SAFE-ALLOW-TOKEN ' + 'x'.repeat(9000),
      reason: 'escalate sandbox to danger-full-access: 超长允许词',
    })
    assert.notEqual(outcome, 'allowed-once')
    assert.equal(outcome, 'web-human')
    assert.ok(events.some((e) => e.path === 'truncated-payload'))
  })

  it('非 auto-approve 预设不拦截，交回 next()', async () => {
    const orig = ctx.permissionPresets.current
    ctx.permissionPresets.current = () => 'workspace-write'
    try {
      let n = 0
      const { outcome } = await runCase(ctx, {
        command: 'rm -rf /tmp/aa-skip-preset',
        reason: 'escalate sandbox to danger-full-access: 不该拦',
        nextFn: async () => {
          n += 1
          return 'from-default'
        },
      })
      assert.equal(n, 1)
      assert.equal(outcome, 'from-default')
    } finally {
      ctx.permissionPresets.current = orig
    }
  })

  it('会话 cwd 下相对路径命中审批配置拒绝词', async () => {
    const { outcome, events } = await runCase(ctx, {
      cwd: '/home/alec/.dsh/auto-approve',
      args: { file_path: 'allowlist.json', content: '{}' },
      toolName: 'write',
      reason: 'escalate sandbox to danger-full-access: 改规则',
    })
    assert.equal(outcome, 'rejected')
    assert.ok(events.some((e) => e.path === 'keyword-reject'))
  })
})
