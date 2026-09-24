/**
 * context.test.js — 上下文裁剪单测
 * 覆盖：预算内不动、超预算裁剪保序、tool 配对原子性（不产生孤儿 tool 消息）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextManager } from '../server/agent/context.js'

const userMsg = (c) => ({ role: 'user', content: 'x'.repeat(c) })
const callMsg = (id, c) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'y'.repeat(c) }) } }],
})
const toolMsg = (id, c) => ({ role: 'tool', tool_call_id: id, content: 'z'.repeat(c) })

/** 校验消息序列无孤儿：每个 tool 消息前一条必须是含对应 tool_call 的 assistant */
function assertNoOrphans(history) {
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role !== 'tool') continue
    const prev = history[i - 1]
    assert.ok(
      prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) &&
        prev.tool_calls.some(tc => tc.id === m.tool_call_id),
      `位置 ${i} 的 tool 消息(${m.tool_call_id})是孤儿：前一条不是配对的 assistant(tool_calls)`
    )
  }
}

test('预算内不裁剪', () => {
  const cm = new ContextManager(8192)
  const history = [userMsg(10), { role: 'assistant', content: 'hi' }]
  assert.equal(cm.trim(history), history)
})

test('超预算裁剪：保序、保 tool 配对原子性', () => {
  // maxTokens=100 → tokenBudget=70 → 约 140 字符预算
  const cm = new ContextManager(100)
  const history = [
    userMsg(60),                       // 单元1
    callMsg('c1', 40), toolMsg('c1', 60),  // 单元2（原子）
    userMsg(60),                       // 单元3
    callMsg('c2', 40), toolMsg('c2', 60),  // 单元4（原子）
    userMsg(60),                       // 单元5
  ]
  const trimmed = cm.trim(history)
  assert.ok(trimmed.length < history.length, '应发生裁剪')
  assertNoOrphans(trimmed)
  // 保序：裁剪结果必须是原序列的子序列
  let pos = 0
  for (const m of trimmed) {
    pos = history.indexOf(m, pos)
    assert.ok(pos !== -1, '裁剪破坏了消息顺序')
    pos++
  }
  // 配对单元要么整体保留要么整体丢弃
  assert.ok(trimmed.some(m => m.role === 'tool') === trimmed.some(m => m.role === 'assistant' && m.tool_calls))
})

test('保底：至少保留最后 2 个单元 / 4 条消息', () => {
  const cm = new ContextManager(50) // 极小预算
  const history = [
    userMsg(60),
    callMsg('c1', 40), toolMsg('c1', 60),
    userMsg(60),
    callMsg('c2', 40), toolMsg('c2', 60),
    userMsg(60),
  ]
  const trimmed = cm.trim(history)
  assert.ok(trimmed.length >= 4, `保底失效，仅剩 ${trimmed.length} 条`)
  assertNoOrphans(trimmed)
})

test('最末单元自身超预算时不再裁（避免裁出孤儿）', () => {
  const cm = new ContextManager(30) // budget 21 字符≈42
  const history = [
    userMsg(10),
    callMsg('c1', 200), toolMsg('c1', 400), // 巨型单元
  ]
  const trimmed = cm.trim(history)
  assertNoOrphans(trimmed)
  assert.ok(trimmed.length >= 2)
})

test('system 消息（引擎注入的纠错/进度反馈）可随老化被裁掉', () => {
  const cm = new ContextManager(100)
  const history = [
    { role: 'system', content: '[格式错误] ' + 'x'.repeat(80) },
    userMsg(60),
    { role: 'assistant', content: 'y'.repeat(60) },
    userMsg(60),
    { role: 'assistant', content: 'y'.repeat(60) },
    userMsg(60),
    { role: 'assistant', content: 'y'.repeat(60) },
  ]
  const trimmed = cm.trim(history)
  assert.ok(!trimmed.some(m => m.role === 'system'), '老化 system 消息应被裁掉')
  assert.ok(trimmed.length >= 4)
})
