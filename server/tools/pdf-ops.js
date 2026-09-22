/**
 * PDF Document Tools - PDF 处理工具
 *
 * 依赖（运行时动态加载，未安装不影响服务启动）：
 *   - pdf-lib：生成/合并/拆分 PDF（纯 JS，无原生依赖）
 *   - pdf-parse：提取 PDF 文本（基于 PDF.js，注意用 lib 子路径规避其 import 副作用）
 *   - fontkit：生成 PDF 时嵌入中文字体（自动探测系统 CJK 字体，使中文正常渲染）
 *
 * 工作目录随当前任务动态变化（每次执行通过 getBaseDir 取沙箱根），
 * 所有文件路径必须经 PathGuard 校验，防止越界。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'

let _pdfLib = null
let _fontkit = null
async function ensurePdfLib() {
  if (!_pdfLib) _pdfLib = await import('pdf-lib')
  return _pdfLib
}
async function ensureFontkit() {
  if (!_fontkit) {
    // 优先 @pdf-lib/fontkit（pdf-lib 官方适配包，内含 fontkit 1.x，API 与 embedFont 匹配）。
    // 裸 fontkit v2 的字体对象缺少 layout()，会导致绘制时报 "this.font.layout is not a function"。
    for (const mod of ['@pdf-lib/fontkit', 'fontkit']) {
      try {
        const imported = await import(mod)
        const fk = imported.default || imported
        if (fk && typeof fk.create === 'function') { _fontkit = fk; break }
      } catch { /* 该包不可用，试下一个 */ }
    }
  }
  return _fontkit
}

// 常见系统 CJK 字体候选（Windows / Linux / macOS）
const CJK_FONT_CANDIDATES = [
  // 独立 TTF 优先：.ttc 是字体集合，pdf-lib 无法直接嵌入（绘制时才报 layout 缺失）
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttf',
  'C:\\Windows\\Fonts\\msyh.ttf',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\simfang.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simsun.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
]

async function findCjkFont() {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      await fs.access(p)
      return p
    } catch { /* 继续 */ }
  }
  return null
}


function wrapLines(text, font, fontSize, maxWidth) {
  const lines = []
  const paragraphs = String(text).split('\n')
  for (const para of paragraphs) {
    if (para === '') { lines.push(''); continue }
    let cur = ''
    for (const ch of para) {
      const trial = cur + ch
      if (font.widthOfTextAtSize(trial, fontSize) > maxWidth && cur !== '') {
        lines.push(cur)
        cur = ch
      } else {
        cur = trial
      }
    }
    if (cur !== '') lines.push(cur)
  }
  return lines
}

export function registerPdfOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 生成 PDF ─────────────────────────────────────────────────
  registry.register({
    name: 'create_pdf',
    description: '根据文本生成 PDF(.pdf)。支持标题与多段正文，自动分页；若系统存在中文字体则自动嵌入，中文可正常显示。文件落在当前任务工作区。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 .pdf 文件路径（工作区内，须以 .pdf 结尾）' },
        title: { type: 'string', description: '文档标题（首页大标题，可选）' },
        content: { type: 'string', description: '正文内容，使用 \\n 换行分段' },
        fontSize: { type: 'number', description: '正文字号，默认 12' },
      },
      required: ['path', 'content'],
    },
    async execute({ path: filePath, title, content, fontSize }) {
      const { PDFDocument, StandardFonts, rgb } = await ensurePdfLib()
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      if (!target.toLowerCase().endsWith('.pdf')) throw new Error('文件路径必须以 .pdf 结尾')

      const size = Number(fontSize) > 0 ? Number(fontSize) : 12
      const doc = await PDFDocument.create()
      doc.setTitle(title || 'MiniAgent Document')

      // 选择字体：优先嵌入中文，否则用标准字体（仅 Latin-1）。
      // 遍历候选字体逐个尝试嵌入，第一个成功即用（.ttc 字体集合可能嵌入失败，自动跳过）。
      let font = null
      let cjk = false
      const fontkit = await ensureFontkit()
      if (fontkit && typeof doc.registerFontkit === 'function') {
        doc.registerFontkit(fontkit)
        for (const c of CJK_FONT_CANDIDATES) {
          try {
            await fs.access(c)
            const bytes = await fs.readFile(c)
            // 探针：.ttc 经 fontkit.create 得到字体集合（无 layout），embedFont 当时不报错、
            // 却在绘制阶段抛 "this.font.layout is not a function"，故提前筛掉。
            const probe = fontkit.create(bytes)
            if (!probe || typeof probe.layout !== 'function') continue
            font = await doc.embedFont(bytes)
            cjk = true
            break
          } catch {
            // 该字体不可用或嵌入失败，尝试下一个候选
          }
        }
      }
      if (!font) font = await doc.embedFont(StandardFonts.Helvetica)

      const pageW = 595.28
      const pageH = 841.89
      const margin = 56
      const maxWidth = pageW - margin * 2

      let page = doc.addPage([pageW, pageH])
      let y = pageH - margin

      const drawLine = (text, fs, opts = {}) => {
        if (y < margin) {
          page = doc.addPage([pageW, pageH])
          y = pageH - margin
        }
        page.drawText(text, { x: margin, y, size: fs, font, color: rgb(0, 0, 0), ...opts })
        y -= fs + 6
      }

      if (title) {
        for (const ln of wrapLines(title, font, size + 6, maxWidth)) drawLine(ln, size + 6, { font })
        y -= 8
      }
      const lines = wrapLines(content, font, size, maxWidth)
      for (const ln of lines) {
        if (ln === '') { y -= size * 0.5; continue }
        drawLine(ln, size, { font })
      }

      const bytes = await doc.save()
      await fs.writeFile(target, bytes)
      return { success: true, path: rel(target), chineseFont: cjk, note: cjk ? '已嵌入中文字体' : '未找到中文字体，仅支持英文/数字（中文会显示为空白）' }
    },
  })

  // ── 读取 PDF 文本 ────────────────────────────────────────────
  registry.register({
    name: 'read_pdf',
    description: '读取 .pdf，提取全部文本与元数据（页数、标题、作者等）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .pdf 文件路径' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }) {
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      // 用 lib 子路径规避 pdf-parse 在某些版本 import 时执行测试代码的副作用
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default || (await import('pdf-parse/lib/pdf-parse.js'))
      const data = await pdfParse(buf)
      const info = {}
      if (data.info) {
        for (const [k, v] of Object.entries(data.info)) {
          info[k] = typeof v === 'object' ? String(v) : v
        }
      }
      return {
        success: true,
        pageCount: data.numpages,
        text: data.text,
        info,
      }
    },
  })

  // ── 合并 PDF ─────────────────────────────────────────────────
  registry.register({
    name: 'merge_pdf',
    description: '将多个 .pdf 按顺序合并为一个 .pdf。',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: '待合并的 .pdf 文件路径数组（按数组顺序）' },
        outPath: { type: 'string', description: '合并后输出 .pdf 路径' },
      },
      required: ['inputs', 'outPath'],
    },
    async execute({ inputs, outPath }) {
      const { PDFDocument } = await ensurePdfLib()
      const { guard, rel } = getCtx()
      if (!Array.isArray(inputs) || inputs.length < 2) throw new Error('inputs 至少需要 2 个 PDF 路径')
      const out = guard.resolve(outPath)
      if (!out.toLowerCase().endsWith('.pdf')) throw new Error('outPath 必须以 .pdf 结尾')

      const merged = await PDFDocument.create()
      let count = 0
      for (const p of inputs) {
        const src = await guard.resolveChecked(p, { allowDir: false })
        const bytes = await fs.readFile(src)
        const srcDoc = await PDFDocument.load(bytes)
        const copied = await merged.copyPages(srcDoc, srcDoc.getPageIndices())
        copied.forEach((pg) => merged.addPage(pg))
        count += copied.length
      }
      const bytes = await merged.save()
      await fs.writeFile(out, bytes)
      return { success: true, path: rel(out), pageCount: count }
    },
  })

  // ── 拆分 PDF ─────────────────────────────────────────────────
  registry.register({
    name: 'split_pdf',
    description: '拆分 .pdf。两种方式二选一：① 指定页码(pages)提取为单个输出文件(outPath)；② splitAll=true 时把每页分别存为独立文件（写入 outDir 或源目录）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要拆分的 .pdf 文件路径' },
        pages: { type: 'string', description: '要提取的页码，支持 "1,3,5" 或区间 "2-4"（从1开始），与 splitAll 互斥' },
        outPath: { type: 'string', description: '提取指定页时的输出 .pdf 路径（与 pages 配合使用）' },
        splitAll: { type: 'boolean', description: 'true 时把每一页拆成独立文件，默认 false' },
        outDir: { type: 'string', description: 'splitAll 时存放单页文件的目录，省略则用源文件所在目录' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, pages, outPath, splitAll, outDir }) {
      const { PDFDocument } = await ensurePdfLib()
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const bytes = await fs.readFile(target)
      const srcDoc = await PDFDocument.load(bytes)
      const total = srcDoc.getPageCount()

      if (splitAll) {
        const dir = outDir ? guard.resolve(outDir) : path.dirname(target)
        const stem = path.basename(target, path.extname(target))
        const written = []
        for (let i = 0; i < total; i++) {
          const one = await PDFDocument.create()
          const [pg] = await one.copyPages(srcDoc, [i])
          one.addPage(pg)
          const fn = path.join(dir, `${stem}_p${String(i + 1).padStart(3, '0')}.pdf`)
          await fs.writeFile(fn, await one.save())
          written.push(rel(fn))
        }
        return { success: true, paths: written, pageCount: total }
      }

      if (!pages) throw new Error('请提供 pages（页码）或 splitAll=true')
      // 解析页码
      const idxSet = new Set()
      for (const part of String(pages).split(',')) {
        const seg = part.trim()
        if (!seg) continue
        if (seg.includes('-')) {
          const [a, b] = seg.split('-').map((x) => parseInt(x, 10))
          if (!a || !b) throw new Error(`无效页码区间: ${seg}`)
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (i >= 1 && i <= total) idxSet.add(i - 1)
          }
        } else {
          const n = parseInt(seg, 10)
          if (n >= 1 && n <= total) idxSet.add(n - 1)
        }
      }
      if (idxSet.size === 0) throw new Error('没有匹配的页码')
      const out = guard.resolve(outPath)
      if (!out.toLowerCase().endsWith('.pdf')) throw new Error('outPath 必须以 .pdf 结尾')
      const one = await PDFDocument.create()
      const copied = await one.copyPages(srcDoc, [...idxSet].sort((a, b) => a - b))
      copied.forEach((pg) => one.addPage(pg))
      await fs.writeFile(out, await one.save())
      return { success: true, path: rel(out), pageCount: idxSet.size }
    },
  })
}
