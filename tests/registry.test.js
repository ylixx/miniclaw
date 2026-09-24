/**
 * registry.test.js — 工具注册表单测
 * 覆盖：模糊纠名、参数 coerce、必填校验、未知工具
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../server/tools/registry.js'

function makeRegistry() {
  const reg = new ToolRegistry()
  reg.register({
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'number' } },
      required: ['path'],
    },
    async execute(args) { return { ok: true, args } },
  })
  reg.register({
    name: 'write_file',
    description: 'write',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute(args) { return { ok: true, args } },
  })
  return reg
}

test('精确名称执行', async () => {
  const reg = makeRegistry()
  const r = await reg.execute('read_file', { path: 'a.txt' })
  assert.equal(r.ok, true)
})

test('模糊纠名：red_file → read_file', async () => {
  const reg = makeRegistry()
  const r = await reg.execute('red_file', { path: 'a.txt' })
  assert.equal(r.ok, true)
})

test('完全未知的工具抛 TOOL_NOT_FOUND', async () => {
  const reg = makeRegistry()
  await assert.rejects(
    () => reg.execute('zzzzzz', {}),
    (err) => err.code === 'TOOL_NOT_FOUND'
  )
})

test('字符串数字参数被 coerce 为 number', async () => {
  const reg = makeRegistry()
  const r = await reg.execute('read_file', { path: 'a.txt', limit: '5' })
  assert.equal(r.args.limit, 5)
  assert.equal(typeof r.args.limit, 'number')
})

test('非数字字符串 coerce 失败报 VALIDATION', async () => {
  const reg = makeRegistry()
  await assert.rejects(
    () => reg.execute('read_file', { path: 'a.txt', limit: 'abc' }),
    (err) => err.code === 'VALIDATION'
  )
})

test('缺失必填参数报 VALIDATION', async () => {
  const reg = makeRegistry()
  await assert.rejects(
    () => reg.execute('read_file', {}),
    (err) => err.code === 'VALIDATION'
  )
})

test('resolveName：精确 / 模糊 / 未中', () => {
  const reg = makeRegistry()
  assert.equal(reg.resolveName('read_file'), 'read_file')
  assert.equal(reg.resolveName('red_fil'), 'read_file')
  assert.equal(reg.resolveName('zzzzzzzz'), null)
  assert.equal(reg.resolveName(''), null)
})
