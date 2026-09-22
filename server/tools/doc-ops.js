/**
 * Office Document Tools - 办公文档处理工具
 *
 * 基于纯 JS 实现，不依赖 native 库，适合小模型轻量部署。
 * 工作目录随当前项目动态变化（每次执行通过 getBaseDir 取沙箱根）。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'

export function registerDocOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 读取 CSV ────────────────────────────────────────────────
  registry.register({
    name: 'read_csv',
    description: '读取 CSV 文件，返回表格数据',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'CSV 文件路径' },
        limit: { type: 'number', description: '最大行数，默认100' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, limit }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const content = await fs.readFile(target, 'utf-8')
      const lines = content.split(/\r?\n/).filter(l => l.trim())
      const maxLines = Math.min(lines.length, (limit || 100) + 1)
      const headers = parseCSVLine(lines[0])
      const rows = []
      for (let i = 1; i < maxLines; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => { row[h] = values[idx] || '' })
        rows.push(row)
      }
      return { headers, rows, totalRows: lines.length - 1 }
    },
  })

  // ── 写入 CSV ────────────────────────────────────────────────
  registry.register({
    name: 'write_csv',
    description: '写入 CSV 文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        headers: { type: 'array', items: { type: 'string' }, description: '列名' },
        rows: { type: 'array', description: '数据行' },
      },
      required: ['path', 'headers', 'rows'],
    },
    async execute({ path: filePath, headers, rows }) {
      const { guard, rel, baseDir } = getCtx()
      const target = guard.resolve(filePath)
      const lines = [headers.join(',')]
      for (const row of rows) {
        if (Array.isArray(row)) {
          lines.push(row.map(v => csvEscape(v)).join(','))
        } else {
          lines.push(headers.map(h => csvEscape(row[h])).join(','))
        }
      }
      await fs.writeFile(target, lines.join('\n'), 'utf-8')
      return { success: true, rows: rows.length, path: rel(target) }
    },
  })

  // ── 读取 JSON ───────────────────────────────────────────────
  registry.register({
    name: 'read_json',
    description: '读取 JSON 文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'JSON 文件路径' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const content = await fs.readFile(target, 'utf-8')
      return JSON.parse(content)
    },
  })

  // ── 写入 JSON ───────────────────────────────────────────────
  registry.register({
    name: 'write_json',
    description: '写入 JSON 文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        data: { type: 'object', description: 'JSON 数据' },
        pretty: { type: 'boolean', description: '是否美化，默认true' },
      },
      required: ['path', 'data'],
    },
    async execute({ path: filePath, data, pretty }) {
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      const content = pretty !== false ? JSON.stringify(data, null, 2) : JSON.stringify(data)
      await fs.writeFile(target, content, 'utf-8')
      return { success: true, path: rel(target) }
    },
  })

  // ── 生成 Markdown 表格 ──────────────────────────────────────
  registry.register({
    name: 'md_table',
    description: '生成 Markdown 格式表格',
    parameters: {
      type: 'object',
      properties: {
        headers: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array' },
      },
      required: ['headers', 'rows'],
    },
    execute({ headers, rows }) {
      const lines = []
      lines.push('| ' + headers.join(' | ') + ' |')
      lines.push('| ' + headers.map(() => '---').join(' | ') + ' |')
      for (const row of rows) {
        const values = Array.isArray(row) ? row : headers.map(h => row[h] || '')
        lines.push('| ' + values.join(' | ') + ' |')
      }
      return { markdown: lines.join('\n') }
    },
  })

  // ── 简单文本统计 ────────────────────────────────────────────
  registry.register({
    name: 'text_stats',
    description: '统计文本的字数、行数、字符数',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要统计的文本' },
      },
      required: ['text'],
    },
    execute({ text }) {
      return {
        characters: text.length,
        words: text.split(/\s+/).filter(w => w).length,
        lines: text.split('\n').length,
        chinese: (text.match(/[一-鿿]/g) || []).length,
      }
    },
  })

  // ── 文本替换 ────────────────────────────────────────────────
  registry.register({
    name: 'text_replace',
    description: '在文件中查找并替换文本',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        find: { type: 'string', description: '查找文本' },
        replace: { type: 'string', description: '替换文本' },
      },
      required: ['path', 'find', 'replace'],
    },
    async execute({ path: filePath, find, replace }) {
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const content = await fs.readFile(target, 'utf-8')
      const count = content.split(find).length - 1
      const newContent = content.replaceAll(find, replace)
      await fs.writeFile(target, newContent, 'utf-8')
      return { success: true, replacements: count, path: rel(target) }
    },
  })

  // ── 摘要提取（纯文本）────────────────────────────────────────
  registry.register({
    name: 'text_summary',
    description: '提取文本的前N行作为摘要',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        lines: { type: 'number', description: '提取行数，默认10' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, lines: n }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const content = await fs.readFile(target, 'utf-8')
      const allLines = content.split('\n')
      const head = allLines.slice(0, n || 10).join('\n')
      return {
        summary: head,
        totalLines: allLines.length,
        totalChars: content.length,
      }
    },
  })
}

// ── CSV 辅助函数 ─────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

function csvEscape(val) {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}
