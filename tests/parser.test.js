/**
 * parser.test.js — 小模型响应解析器单测
 * 覆盖：双通道文本解析的各种格式、截断修复、误报防护
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseResponse, buildToolFormatHint } from '../server/agent/parser.js'

test('fenced ```json 代码块中的工具调用', () => {
  const r = parseResponse('```json\n{"tool":"read_file","arguments":{"path":"a.txt"}}\n```')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'read_file')
  assert.deepEqual(r.call.arguments, { path: 'a.txt' })
})

test('裸 JSON 对象 {name, arguments}（Hermes 简化格式）', () => {
  const r = parseResponse('{"name":"list_files","arguments":{}}')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'list_files')
})

test('OpenAI function_call 格式（arguments 为字符串）', () => {
  const r = parseResponse('{"function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}')
  assert.equal(r.type, 'tool_call')
  assert.deepEqual(r.call.arguments, { path: 'x' })
})

test('Hermes <|function_call|> 标签兜底', () => {
  const r = parseResponse('<|function_call|>\n{"name":"read_file","parameters":{"path":"x"}}')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'read_file')
  assert.deepEqual(r.call.arguments, { path: 'x' })
})

test('XML <function=name><parameter=k>v</parameter></function> 兜底', () => {
  const r = parseResponse('<function=read_file><parameter=path>a.txt</parameter></function>')
  assert.equal(r.type, 'tool_call')
  assert.deepEqual(r.call.arguments, { path: 'a.txt' })
})

test('max_tokens 截断的 JSON 能被修复解析', () => {
  const r = parseResponse('{"tool":"write_file","arguments":{"path":"a.txt","content":"abc')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'write_file')
  assert.equal(r.call.arguments.content, 'abc')
})

test('无引号键被安全修复', () => {
  const r = parseResponse('{tool: "read_file", arguments: {path: "a.txt"}}')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'read_file')
})

test('尾逗号被安全去除', () => {
  const r = parseResponse('{"tool":"list_files","arguments":{"dir":".",}}')
  assert.equal(r.type, 'tool_call')
  assert.equal(r.call.name, 'list_files')
})

test('正文中的普通花括号不会误判为工具调用', () => {
  const r = parseResponse('结果 {a:1} 如上所示。')
  assert.equal(r.type, 'text')
})

test('纯自然语言返回 text 且剥离 markdown 围栏', () => {
  const r = parseResponse('```python\nprint(1)\n```')
  assert.equal(r.type, 'text')
  assert.equal(r.text, 'print(1)')
})

test('空/非字符串输入安全返回 text', () => {
  assert.equal(parseResponse('').text, '')
  assert.equal(parseResponse(null).text, '')
})

test('buildToolFormatHint 包含工具名清单与示例', () => {
  const hint = buildToolFormatHint([{ name: 'read_file' }, { name: 'write_file' }])
  assert.ok(hint.includes('read_file, write_file'))
  assert.ok(hint.includes('"tool"'))
})
