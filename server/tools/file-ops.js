/**
 * File Operations Tools - 文件操作工具集（带路径安全防护）
 *
 * 工作目录（沙箱根）随当前激活项目动态变化：每次工具执行时通过 getBaseDir()
 * 取当前项目 dir，并重新构造 PathGuard。这样"在新建项目时选择本地文件夹当工作区"
 * 能真正生效——agent 的文件读写被限制在所选工作区内。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'
import { checkFileOp } from './safety-gate.js'

const MAX_READ_BYTES = 2 * 1024 * 1024   // 单次读取上限 2MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024  // 单次写入上限 5MB

// ── 二进制容器格式防护 ─────────────────────────────────────────
// .docx/.pptx/.xlsx 等 OOXML 文件本质是 zip 包，而 write_file/append_file 只能写纯文本。
// 把文本写进这些扩展名会产出"伪 docx"，Word 打开即报"发现无法读取的内容"
// （实测 4B 模型在"排版文档"时经常偷懒这样写，而不是调用 create_docx）。
// 这里直接拒绝，并在报错里告诉模型正确工具——错误信息会回到模型，形成自我纠正。
const CONTAINER_HINTS = {
  '.docx': '生成 Word 请改用 create_docx。它可直接吃 Markdown：若已写好 .md，直接调用 create_docx({"path":"<目标.docx>","from_md":"<已有.md>"})；也可 create_docx({"path":"<目标.docx>","markdown":"# 标题\\n\\n正文..."})。不要用 blocks 数组（太复杂）',
  '.pptx': '生成 PPT 请改用 create_pptx 工具',
  '.xlsx': '生成 Excel 请改用表格专用工具，或先落 .csv 再转换',
  '.zip': '打包 zip 请使用命令行工具',
}
function assertNotTextToContainer(target, op) {
  const hint = CONTAINER_HINTS[path.extname(target).toLowerCase()]
  if (!hint) return
  throw new Error(
    `拒绝${op}：该扩展名是二进制容器格式（zip 包），不能用纯文本写入，否则 Office 将无法打开。${hint}。若只是要保存文本内容，请改用 .txt 或 .md 扩展名。`
  )
}

export function registerFileOps(registry, { getBaseDir, getPermissionMode } = {}) {
  // 实时读取权限模式（支持模型切换后动态生效）：unattended 跳过 delete_file 二次确认
  const getMode = () => (getPermissionMode && getPermissionMode()) || 'guarded'  // guarded | read-only | unattended

  // 每次执行重新构造守卫：工作目录可能随项目切换而变化
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 列出目录 ────────────────────────────────────────────────
  registry.register({
    name: 'list_files',
    description: '列出目录下的文件和文件夹',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '目录路径（相对工作目录），默认当前目录' },
      },
    },
    async execute({ dir }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(dir || '.', { mustExist: true, allowFile: false })
      const entries = await fs.readdir(target, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
      }))
    },
  })

  // ── 读取文件 ────────────────────────────────────────────────
  registry.register({
    name: 'read_file',
    description: '读取文件内容（UTF-8 文本，单次最多 2MB / 5000 字符）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作目录）' },
        offset: { type: 'number', description: '起始行号，从1开始' },
        limit: { type: 'number', description: '最多读取行数' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, offset, limit }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const stat = await fs.stat(target)
      if (stat.size > MAX_READ_BYTES) {
        return { error: `文件过大（${stat.size} 字节），超过单次读取上限 ${MAX_READ_BYTES} 字节，请分段读取` }
      }
      const content = await fs.readFile(target, 'utf-8')
      const allLines = content.split('\n')
      const start = Math.max(0, (offset || 1) - 1)
      const end = limit ? Math.min(allLines.length, start + limit) : allLines.length
      const sliced = allLines.slice(start, end).join('\n')
      return {
        content: sliced.slice(0, 5000),
        totalLines: allLines.length,
        truncated: sliced.length > 5000,
      }
    },
  })

  // ── 写入文件 ────────────────────────────────────────────────
  registry.register({
    name: 'write_file',
    description: '创建或覆盖文本文件（内容最多 5MB）。注意：不能写 .docx/.pptx/.xlsx 等二进制格式——生成 Word 用 create_docx，生成 PPT 用 create_pptx',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作目录）' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    async execute({ path: filePath, content }) {
      const deny = checkFileOp('write_file', { path: filePath })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      assertNotTextToContainer(target, '写入')
      if (typeof content !== 'string') throw new Error('content 必须是字符串')
      if (content.length > MAX_WRITE_BYTES) {
        throw new Error(`内容过大（${content.length} 字节），超过写入上限`)
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf-8')
      return { success: true, path: rel(target) }
    },
  })

  // ── 追加内容 ────────────────────────────────────────────────
  registry.register({
    name: 'append_file',
    description: '向文件末尾追加内容（文件不存在会自动创建）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作目录）' },
        content: { type: 'string', description: '追加内容' },
      },
      required: ['path', 'content'],
    },
    async execute({ path: filePath, content }) {
      const deny = checkFileOp('append_file', { path: filePath })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      assertNotTextToContainer(target, '追加')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.appendFile(target, content, 'utf-8')
      return { success: true, path: rel(target) }
    },
  })

  // ── 删除文件 ────────────────────────────────────────────────
  registry.register({
    name: 'delete_file',
    description: '删除文件（仅文件，不删目录）。危险操作，需二次确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作目录）' },
        confirm: { type: 'boolean', description: '危险操作二次确认：必须显式传 true 才会执行删除' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, confirm }) {
      const deny = checkFileOp('delete_file', { path: filePath })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const { guard, rel } = getCtx()
      // unattended 模式（无人值守）下跳过二次确认，但受保护路径拦截仍然生效
      if (getMode() !== 'unattended' && confirm !== true) {
        return { error: '删除是危险操作，已拦截。请在 arguments 中显式传入 "confirm": true 以确认执行。', needConfirm: true }
      }
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      await fs.unlink(target)
      return { success: true, deleted: rel(target) }
    },
  })

  // ── 创建目录 ────────────────────────────────────────────────
  registry.register({
    name: 'create_dir',
    description: '创建目录（支持多级）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute({ path: dirPath }) {
      const { guard, rel } = getCtx()
      const target = guard.resolve(dirPath)
      await fs.mkdir(target, { recursive: true })
      return { success: true, created: rel(target) }
    },
  })

  // ── 移动/重命名 ─────────────────────────────────────────────
  registry.register({
    name: 'move_file',
    description: '移动或重命名文件/目录',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径（相对工作目录）' },
        to: { type: 'string', description: '目标路径（相对工作目录）' },
      },
      required: ['from', 'to'],
    },
    async execute({ from, to }) {
      const deny = checkFileOp('move_file', { from, to })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const { guard, rel } = getCtx()
      const src = await guard.resolveChecked(from)
      const dst = guard.resolve(to)
      if (dst === src) return { success: true, from: rel(src), to: rel(dst), note: '源目标相同' }
      // 防止把目录移进自己内部
      const relPath = path.relative(src, dst)
      if (relPath !== '' && !relPath.startsWith('..') && !path.isAbsolute(relPath)) {
        throw new Error('不能把目录移动到它自身内部')
      }
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.rename(src, dst)
      return { success: true, from: rel(src), to: rel(dst) }
    },
  })

  // ── 复制文件 ────────────────────────────────────────────────
  registry.register({
    name: 'copy_file',
    description: '复制文件',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径（相对工作目录）' },
        to: { type: 'string', description: '目标路径（相对工作目录）' },
      },
      required: ['from', 'to'],
    },
    async execute({ from, to }) {
      const deny = checkFileOp('copy_file', { from, to })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const { guard, rel } = getCtx()
      const src = await guard.resolveChecked(from, { allowDir: false })
      const dst = guard.resolve(to)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
      return { success: true, from: rel(src), to: rel(dst) }
    },
  })

  // ── 文件信息 ────────────────────────────────────────────────
  registry.register({
    name: 'file_info',
    description: '获取文件/目录信息（大小、修改时间等）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作目录）' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }) {
      const { guard, rel, baseDir } = getCtx()
      const target = await guard.resolveChecked(filePath)
      const stat = await fs.stat(target)
      return {
        name: path.basename(target),
        path: rel(target),
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        modified: stat.mtime.toISOString(),
        workDir: baseDir,
      }
    },
  })

  // ── 搜索文件 ────────────────────────────────────────────────
  registry.register({
    name: 'search_files',
    description: '按文件名关键词递归搜索（最多返回 50 条，自动跳过 node_modules/.git 等）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索关键词' },
        dir: { type: 'string', description: '搜索目录，默认当前' },
      },
      required: ['pattern'],
    },
    async execute({ pattern, dir }) {
      const { guard, baseDir } = getCtx()
      const target = await guard.resolveChecked(dir || '.', { allowFile: false })
      const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv'])
      const results = []
      async function walk(current, depth) {
        if (results.length >= 50 || depth > 6) return
        let entries
        try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (results.length >= 50) return
          const fullPath = path.join(current, e.name)
          if (e.name.toLowerCase().includes(pattern.toLowerCase())) {
            results.push({ path: path.relative(baseDir, fullPath), name: e.name, type: e.isDirectory() ? 'dir' : 'file' })
          }
          if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) {
            await walk(fullPath, depth + 1)
          }
        }
      }
      await walk(target, 0)
      return results
    },
  })
}
