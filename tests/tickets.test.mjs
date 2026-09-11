import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTicketBroker,
  parseApprovalReply,
  isBindConfirmText,
  formatPendingList,
  formatApprovalPush,
  formatApprovalKeyboard,
  formatOutcomeLabel,
} from '../src/tickets.mjs'

describe('parseApprovalReply', () => {
  it('带号批准/拒绝', () => {
    assert.deepEqual(parseApprovalReply('批准 17', 2), { kind: 'allow', n: 17 })
    assert.deepEqual(parseApprovalReply('#17 批准', 2), { kind: 'allow', n: 17 })
    assert.deepEqual(parseApprovalReply('同意 17', 2), { kind: 'allow', n: 17 })
    assert.deepEqual(parseApprovalReply('yes 17', 2), { kind: 'allow', n: 17 })
    assert.deepEqual(parseApprovalReply('拒绝 17', 2), { kind: 'reject', n: 17 })
    assert.deepEqual(parseApprovalReply('#17 拒绝', 2), { kind: 'reject', n: 17 })
    assert.deepEqual(parseApprovalReply('no 17', 2), { kind: 'reject', n: 17 })
    assert.equal(parseApprovalReply('拒绝 17 永久', 2), null)
  })

  it('仅 1 条 pending 时允许裸词；≥2 条要求带号', () => {
    assert.deepEqual(parseApprovalReply('批准', 1), { kind: 'allow-bare' })
    assert.deepEqual(parseApprovalReply('拒绝', 1), { kind: 'reject-bare' })
    assert.equal(parseApprovalReply('拒绝永久', 1), null)
    assert.deepEqual(parseApprovalReply('批准', 2), { kind: 'need-number' })
    assert.deepEqual(parseApprovalReply('拒绝', 3), { kind: 'need-number' })
  })

  it('无关文本返回 null', () => {
    assert.equal(parseApprovalReply('你好', 1), null)
    assert.equal(parseApprovalReply('', 1), null)
  })
})

describe('isBindConfirmText', () => {
  it('私人 bot 绑定词', () => {
    assert.equal(isBindConfirmText('是'), true)
    assert.equal(isBindConfirmText('确认'), true)
    assert.equal(isBindConfirmText('用作审批'), true)
    assert.equal(isBindConfirmText('yes'), true)
    assert.equal(isBindConfirmText('OK'), true)
    assert.equal(isBindConfirmText('批准'), false)
    assert.equal(isBindConfirmText('是的'), false)
  })
})

describe('ticket broker', () => {
  it('分配 1–99 并跳过占用号', () => {
    const b = createTicketBroker()
    const a = b.allocate({ sessionId: 's1' })
    const c = b.allocate({ sessionId: 's2' })
    assert.equal(a.n, 1)
    assert.equal(c.n, 2)
    assert.equal(b.pendingCount(), 2)
    assert.equal(b.answer(1, { outcome: 'allowed-once' }), true)
    assert.equal(b.pendingCount(), 1)
    assert.ok(b.recentOutcome(1))
  })

  it('两条 pending 时 list 含两个短号', () => {
    const b = createTicketBroker()
    b.allocate({ sessionId: 'a' })
    b.allocate({ sessionId: 'b' })
    const list = b.listPending()
    assert.equal(list.length, 2)
    assert.equal(formatPendingList(list), '当前：#1、#2')
    assert.equal(b.solePending(), null)
  })

  it('结案后 discard/abort 不再改 outcome', async () => {
    const b = createTicketBroker()
    const t = b.allocate({ sessionId: 's' })
    const wait = t.wait
    assert.equal(b.answer(t.n, { outcome: 'allowed-once' }), true)
    const result = await wait
    assert.equal(result.outcome, 'allowed-once')
    assert.equal(result.source, 'qq')
    b.discard(t.n, 'abort')
    assert.equal(b.get(t.n), undefined)
    const again = await t.wait
    assert.equal(again.outcome, 'allowed-once')
  })

  it('abort discard 在未结案时解析为 source=abort', async () => {
    const b = createTicketBroker()
    const t = b.allocate({ sessionId: 's' })
    b.discard(t.n, 'abort')
    const result = await t.wait
    assert.equal(result.source, 'abort')
    assert.equal(result.outcome, null)
  })
})

describe('push copy', () => {
  it('含短号与批准/拒绝，且不超过 2000 字', () => {
    const text = formatApprovalPush({
      n: 17,
      sessionId: 'session-5cbb7dc3-0ec4-4b9c-b08e-6daef08b27a4',
      cwd: '/home/alec/workspace/dsh-approval-bridge',
      toolName: 'bash',
      reason: 'escalate sandbox to danger-full-access: systemctl restart foo',
      judgeReason: '仅列出目录',
      args: { command: 'ls /home/alec', description: 'List home directory' },
    }, 120)
    assert.match(text, /审批 #17/)
    assert.match(text, /本聊天 120s 内未答会提醒/)
    assert.match(text, /命令：ls \/home\/alec/)
    assert.match(text, /判定：仅列出目录/)
    assert.match(text, /批准 17/)
    assert.match(text, /拒绝 17/)
    assert.doesNotMatch(text, /escalate sandbox/)
    assert.ok(text.length <= 2000)
  })

  it('推送含截断后的写入和 diff', () => {
    const text = formatApprovalPush({
      n: 2,
      sessionId: 's',
      cwd: '/ws',
      toolName: 'edit',
      args: {
        file_path: '/tmp/a.env',
        old_string: 'TOKEN=old',
        new_string: 'TOKEN=new-secret',
      },
    }, 120)
    assert.match(text, /路径：\/tmp\/a.env/)
    assert.match(text, /原文：TOKEN=old/)
    assert.match(text, /改成：TOKEN=new-secret/)
  })

  it('代码字段进入推送；无卡片时提示看网页', () => {
    const withCode = formatApprovalPush({
      n: 4,
      sessionId: 's',
      cwd: '/ws',
      toolName: 'run_code',
      args: { code: 'print(1)' },
    }, 120)
    assert.match(withCode, /代码：print\(1\)/)
    const empty = formatApprovalPush({
      n: 5,
      sessionId: 's',
      cwd: '/ws',
      toolName: 'unknown',
      args: {},
    }, 120)
    assert.match(empty, /请在网页查看全文/)
  })

  it('过长命令提示到网页看全文', () => {
    const text = formatApprovalPush({
      n: 3,
      sessionId: 's',
      cwd: '/ws',
      toolName: 'bash',
      args: { command: 'x'.repeat(1800) },
    }, 120)
    assert.match(text, /正文已截断/)
  })

  it('审批推送带批准/拒绝按钮', () => {
    const kb = formatApprovalKeyboard(17)
    assert.equal(kb.rows.length, 1)
    assert.equal(kb.rows[0].buttons.length, 2)
    assert.equal(kb.rows[0].buttons[0].action.data, '批准 17')
    assert.equal(kb.rows[0].buttons[1].action.data, '拒绝 17')
    assert.equal(kb.rows[0].buttons[0].action.type, 1)
    assert.equal(kb.rows[0].buttons[0].action.permission.type, 2)
    const group = formatApprovalKeyboard(3, 'openid-x')
    assert.deepEqual(group.rows[0].buttons[0].action.permission, {
      type: 0,
      specify_user_ids: ['openid-x'],
    })
  })
})

describe('formatOutcomeLabel', () => {
  it('网页先答时用中文短标签', () => {
    assert.equal(formatOutcomeLabel('allowed-once'), '批准')
    assert.equal(formatOutcomeLabel('rejected'), '拒绝')
    assert.equal(formatOutcomeLabel('cancelled'), '取消')
  })
})
