/**
 * prompt.test.js — Prompt 构建器单测
 * 覆盖：system prompt 顶部收口、引擎注入的 system 消息透传（纠错回灌通电）、工具结果截断
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, buildToolResult } from '../server/agent/prompt.js'

test('顶层 system prompt 在消息首位', () => {
  const messages = buildPrompt({ history: [{ role: 'user', content: 'hi' }], config: {} })
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].content, 'hi')
})

test('回归：历史中引擎注入的 system 消息必须透传给模型（纠错回灌）', () => {
  const messages = buildPrompt({
    history: [
      { role: 'user', content: '帮我建个文件' },
      { role: 'system', content: '[格式错误] 你的回复无法解析为工具调用。错误详情：xxx' },
      { role: 'system', content: '[进度提示] 你已使用 8 步...' },
      { role: 'assistant', content: '好的' },
    ],
    config: {},
  })
  const sys = messages.filter(m => m.role === 'system')
  assert.equal(sys.length, 3, '顶层 1 条 + 引擎注入 2 条')
  assert.ok(sys.some(m => m.content.includes('[格式错误]')))
  assert.ok(sys.some(m => m.content.includes('[进度提示]')))
})

test('工作目录注入 system prompt', () => {
  const messages = buildPrompt({ history: [], config: {}, workDir: 'E:\\demo' })
  assert.ok(messages[0].content.includes('E:\\demo'))
})

test('selfVerifyHint 注入且只出现一次', () => {
  const messages = buildPrompt({
    history: [],
    config: {},
    selfVerifyHint: '【禁止重试】请立即改用别的工具',
  })
  const hits = messages[0].content.match(/【禁止重试】/g)
  assert.equal(hits.length, 1)
})

test('buildToolResult：非读类对象序列化并截断（中段带省略标记）', () => {
  const big = { content: 'x'.repeat(5000) }
  const out = buildToolResult(big)
  assert.ok(out.startsWith('{"content"'))
  assert.ok(out.includes('结果过长已截断'))
  const small = buildToolResult({ success: true, path: 'a.txt' })
  assert.ok(small.includes('a.txt'))
})

test('buildToolResult：读类工具直接吐正文（放宽到 5000，不中段截断 JSON）', () => {
  const res = { content: 'A'.repeat(4000), totalLines: 100, truncated: false }
  const out = buildToolResult(res, 'read_file')
  assert.equal(out, 'A'.repeat(4000), '读类工具直接返回 content 原文')
  // 超过 5000 仍整体返回（read_file 自身已限 5000），不出现未闭合 JSON
  const huge = { content: 'B'.repeat(6000) }
  const out2 = buildToolResult(huge, 'read_xlsx')
  assert.ok(out2.startsWith('B'.repeat(6000).slice(0, 20)))
  assert.ok(out2.includes('已截断'))
  // 非读类工具仍走紧凑上限（1500）
  const obj = buildToolResult({ a: 1, b: 'c' })
  assert.ok(obj.includes('"a":1'))
})

test('buildToolResult：纯字符串按 5000 上限截断；null 返回占位', () => {
  assert.equal(buildToolResult('y'.repeat(3000)).length, 3000, '3000 < 5000 不截断')
  assert.equal(buildToolResult('z'.repeat(9000)).length, 5000, '超长纯字符串截断到 5000')
  assert.ok(buildToolResult(null).includes('成功'))
})
