/**
 * tool-router.test.js — 工具子集动态注入单测
 * 覆盖：意图路由、技能路由、只读收敛（含 MCP 不注入）、注入上限
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_GROUPS, selectTools, scoreIntents } from '../server/agent/tool-router.js'

const schemas = [...new Set(Object.values(TOOL_GROUPS).flat())].map(name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
}))
const withMcp = [...schemas, {
  name: 'mcp__fs__write_file',
  description: 'MCP 写文件',
  parameters: { type: 'object', properties: {} },
  mcp: true,
}]

test('意图路由：pdf 关键词注入 pdf 分组工具', () => {
  const s = selectTools({ schemas, message: '把这两个 pdf 合并成一个 pdf 文件' })
  assert.ok(s.groups.includes('pdf'))
  const names = new Set(s.tools.map(t => t.name))
  assert.ok(names.has('merge_pdf'))
  assert.ok(names.has('split_pdf'))
  assert.equal(s.source, 'intent')
})

test('意图路由：数据关键词注入 data 分组工具', () => {
  const s = selectTools({ schemas, message: '读取 data.csv 并统计' })
  const names = new Set(s.tools.map(t => t.name))
  assert.ok(names.has('read_csv'))
  assert.ok(names.has('text_stats'))
})

test('技能路由：steps 工具全部注入且 source=skill', () => {
  const s = selectTools({
    schemas,
    activeSkills: [{ skillName: 'data_convert', steps: ['read_csv', 'read_json', 'write_csv', 'write_json'] }],
    message: '',
  })
  const names = new Set(s.tools.map(t => t.name))
  for (const n of ['read_csv', 'read_json', 'write_csv', 'write_json']) assert.ok(names.has(n))
  assert.equal(s.source, 'skill')
})

test('guarded 模式下 MCP 工具始终注入', () => {
  const s = selectTools({ schemas: withMcp, message: '' })
  assert.ok(s.names.has('mcp__fs__write_file'))
})

test('read-only 模式：写工具/执行工具/MCP 一律不注入，只读工具保留', () => {
  const s = selectTools({ schemas: withMcp, message: '帮我写文件并运行命令', permissionMode: 'read-only' })
  const names = s.names
  assert.ok(!names.has('write_file'))
  assert.ok(!names.has('run_command'))
  assert.ok(!names.has('run_script'))
  assert.ok(!names.has('mcp__fs__write_file'), 'read-only 下 MCP 工具必须从注入集中剔除')
  assert.ok(names.has('read_file'))
  assert.ok(names.has('list_files'))
})

test('注入上限：无技能 ≤14，有技能 ≤18', () => {
  const noSkill = selectTools({ schemas: withMcp, message: '整理 pdf 表格 数据 运行 文档 批量重命名' })
  assert.ok(noSkill.tools.length <= 14)
  const withSkill = selectTools({
    schemas: withMcp,
    activeSkills: [{ skillName: 'text_process', steps: ['list_files', 'search_files', 'read_file', 'text_replace', 'text_stats', 'write_file'] }],
    message: '整理 pdf 表格 数据 运行',
  })
  assert.ok(withSkill.tools.length <= 18)
})

test('scoreIntents：长短关键词命中去重计分', () => {
  const hits = scoreIntents('导出为 pptx 幻灯片')
  assert.equal(hits[0].group, 'pptx')
  // 'ppt' 是 'pptx' 的子串命中，去重后不应重复加权
  assert.ok(!hits[0].matched.includes('ppt'))
})

test('不存在的工具名不会被注入', () => {
  const s = selectTools({ schemas, activeSkills: [{ skillName: 'x', steps: ['no_such_tool'] }], message: '' })
  assert.ok(!s.names.has('no_such_tool'))
})
