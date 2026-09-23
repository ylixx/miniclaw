/**
 * Organize Tools - 文件整理工具集（4B 友好：聚合扫描 + 批量操作带预览）
 *
 * 设计红线（针对 4B 小模型）：
 * - scan_directory：一次调用返回「聚合统计 + 明细」，不倾倒全量文件列表；
 *   模型可见 size/ext/modified，才能做「按月份归档」「找最大的文件」等判断。
 * - batch_organize：默认 dryRun=true 只返回计划，必须显式 dryRun=false 才执行，
 *   把 N 次 move_file 压成 1 次批量操作，绕开引擎 24 步硬上限。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'
import { checkFileOp } from './safety-gate.js'

const MAX_SCAN_FILES = 5000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv', '.idea', '.vscode'])

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

export function registerOrganizeOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // 递归收集文件（跳过隐藏目录与依赖目录，防止扫 node_modules 爆量）
  async function walkFiles(root, { recursive = true, maxFiles = MAX_SCAN_FILES } = {}) {
    const out = []
    async function walk(current) {
      if (out.length >= maxFiles) return
      let entries
      try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.length >= maxFiles) return
        const full = path.join(current, e.name)
        if (e.isDirectory()) {
          if (recursive && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(full)
        } else if (e.isFile()) {
          let st
          try { st = await fs.stat(full) } catch { continue }
          out.push({
            name: e.name,
            relPath: path.relative(root, full),
            size: st.size,
            ext: (path.extname(e.name) || '').toLowerCase().replace(/^\./, '') || '(noext)',
            modified: st.mtime.toISOString(),
          })
        }
      }
    }
    await walk(root)
    return out
  }

  // ── scan_directory：聚合扫描 ──────────────────────────────────
  registry.register({
    name: 'scan_directory',
    description: '递归扫描目录，返回每个文件的名称/大小/扩展名/修改时间，并自动聚合统计（按扩展名分类、总大小、最大文件）。一次调用代替多次 file_info，让模型看见全貌。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '要扫描的目录（相对工作目录），默认当前目录' },
        recursive: { type: 'boolean', description: '是否递归子目录，默认 true' },
        extFilter: { type: 'string', description: '只看这些扩展名，逗号分隔，如 "jpg,png,docx"，留空看全部' },
        minSize: { type: 'number', description: '只统计大于等于该字节数的文件' },
        maxSize: { type: 'number', description: '只统计小于等于该字节数的文件' },
        since: { type: 'string', description: '只统计修改时间晚于该 ISO 日期的文件，如 2026-01-01' },
        until: { type: 'string', description: '只统计修改时间早于该 ISO 日期的文件' },
        sort: { type: 'string', description: '明细排序：name | size | modified，默认 name' },
        limit: { type: 'number', description: '返回的明细条数上限，默认 50（聚合统计始终返回）' },
      },
    },
    async execute({ dir, recursive, extFilter, minSize, maxSize, since, until, sort, limit }) {
      const { guard, rel } = getCtx()
      const root = await guard.resolveChecked(dir || '.', { allowFile: false })
      let files = await walkFiles(root, { recursive: recursive !== false })

      if (extFilter) {
        const want = new Set(extFilter.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))
        files = files.filter(f => want.has(f.ext))
      }
      if (typeof minSize === 'number') files = files.filter(f => f.size >= minSize)
      if (typeof maxSize === 'number') files = files.filter(f => f.size <= maxSize)
      if (since) { const t = new Date(since).getTime(); if (!isNaN(t)) files = files.filter(f => new Date(f.modified).getTime() >= t) }
      if (until) { const t = new Date(until).getTime(); if (!isNaN(t)) files = files.filter(f => new Date(f.modified).getTime() <= t) }

      const byExt = {}
      let totalSize = 0
      for (const f of files) {
        totalSize += f.size
        byExt[f.ext] = byExt[f.ext] || { count: 0, size: 0 }
        byExt[f.ext].count++
        byExt[f.ext].size += f.size
      }
      const byExtSorted = Object.entries(byExt)
        .map(([ext, v]) => ({ ext, count: v.count, size: v.size, sizeText: fmtSize(v.size) }))
        .sort((a, b) => b.size - a.size)

      const sf = [...files]
      const s = sort || 'name'
      if (s === 'size') sf.sort((a, b) => b.size - a.size)
      else if (s === 'modified') sf.sort((a, b) => new Date(b.modified) - new Date(a.modified))
      else sf.sort((a, b) => a.relPath.localeCompare(b.relPath))

      const lim = Math.min(limit || 50, sf.length)
      const detail = sf.slice(0, lim).map(f => ({
        name: f.name, path: f.relPath, size: f.size, sizeText: fmtSize(f.size), ext: f.ext, modified: f.modified,
      }))

      return {
        scanned: rel(root),
        totalFiles: files.length,
        totalSize,
        totalSizeText: fmtSize(totalSize),
        byExt: byExtSorted,
        files: detail,
        truncated: files.length > lim,
        note: files.length > MAX_SCAN_FILES ? `目录文件超过 ${MAX_SCAN_FILES}，已截断扫描` : undefined,
      }
    },
  })

  // ── batch_organize：批量整理（带 dryRun 预览）──────────────────
  registry.register({
    name: 'batch_organize',
    description: '按规则批量移动或复制文件（byExt 按扩展名 / byDate 按修改年月 / regex 按文件名正则）。默认 dryRun=true 只返回计划不执行，必须显式 dryRun=false 才真实操作，避免不可逆错误。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '源目录（相对工作目录），默认当前目录' },
        mode: { type: 'string', description: '分组规则：byExt（按扩展名）| byDate（按修改时间）| regex（按文件名正则）' },
        action: { type: 'string', description: 'move（移动，默认）| copy（复制）' },
        target: { type: 'string', description: '目标根目录（相对工作目录），默认 "." 即在工作区内按规则建子目录' },
        dateFormat: { type: 'string', description: 'mode=byDate 时：year（按年）| month（按年月，默认）' },
        pattern: { type: 'string', description: 'mode=regex 时的文件名正则表达式（字符串），命中的文件会被归类' },
        dryRun: { type: 'boolean', description: '安全预览：true（默认）只返回计划不执行；false 才真实移动/复制' },
      },
      required: ['mode'],
    },
    async execute({ dir, mode, action, target, dateFormat, pattern, dryRun }) {
      if (!['byExt', 'byDate', 'regex'].includes(mode)) return { error: 'mode 必须是 byExt / byDate / regex 之一' }
      const { guard, baseDir, rel } = getCtx()
      const root = await guard.resolveChecked(dir || '.', { allowFile: false })
      const files = await walkFiles(root, { recursive: true })
      if (!files.length) return { plan: [], count: 0, note: '目录为空或无匹配文件' }

      const act = action === 'copy' ? 'copy' : 'move'
      const doMove = act === 'move'
      const tgtRoot = guard.resolve(target && target !== '.' ? target : '.')
      const dateFmt = dateFormat === 'year' ? 'year' : 'month'

      const ops = []
      const plan = []
      const createdDirs = new Set()
      let regex = null
      if (mode === 'regex') {
        if (!pattern) return { error: 'mode=regex 时必须提供 pattern（文件名正则）' }
        try { regex = new RegExp(pattern) } catch (e) { return { error: 'pattern 不是合法正则：' + e.message } }
      }

      for (const f of files) {
        let sub
        if (mode === 'byExt') sub = f.ext
        else if (mode === 'byDate') {
          const d = new Date(f.modified)
          sub = dateFmt === 'year' ? String(d.getFullYear()) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        } else {
          const m = regex.exec(f.name)
          if (!m) continue
          sub = m[1] || m[0] || 'matched'
        }
        const destDir = path.join(tgtRoot, sub)
        const dest = path.join(destDir, f.name)
        const srcAbs = path.join(root, f.relPath)
        if (dest === srcAbs) continue
        createdDirs.add(rel(destDir))
        ops.push({ srcAbs, dstAbs: dest })
        plan.push({ from: rel(srcAbs), to: rel(dest) })
      }

      if (dryRun !== false) {
        const groups = {}
        for (const p of plan) {
          const g = path.dirname(p.to)
          groups[g] = (groups[g] || 0) + 1
        }
        return {
          dryRun: true,
          action: act,
          mode,
          count: plan.length,
          groups: Object.entries(groups).map(([g, c]) => ({ target: g, count: c })),
          plan: plan.slice(0, 100),
          truncated: plan.length > 100,
          note: '预览模式，未执行。确认无误后调用 dryRun=false 执行。',
        }
      }

      const deny = checkFileOp('batch_organize', { dir, target, action: act })
      if (deny) return { error: '安全拦截：' + deny, needConfirm: true, code: 'DENIED' }
      const executed = []
      for (const op of ops) {
        try {
          await fs.mkdir(path.dirname(op.dstAbs), { recursive: true })
          if (doMove) await fs.rename(op.srcAbs, op.dstAbs)
          else await fs.copyFile(op.srcAbs, op.dstAbs)
          executed.push({ from: rel(op.srcAbs), to: rel(op.dstAbs) })
        } catch (e) {
          executed.push({ from: rel(op.srcAbs), to: rel(op.dstAbs), error: e.message })
        }
      }
      return {
        dryRun: false,
        action: act,
        mode,
        count: executed.filter(e => !e.error).length,
        failed: executed.filter(e => e.error).length,
        createdDirs: [...createdDirs],
        executed: executed.slice(0, 100),
        truncated: executed.length > 100,
      }
    },
  })
}
