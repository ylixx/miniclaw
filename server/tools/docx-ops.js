/**
 * DOCX Document Tools - Word 文档处理工具
 *
 * 依赖（运行时动态加载，未安装不影响服务启动）：
 *   - docx：生成 .docx（最全的 JS Word 生成库，支持段落/标题/列表/表格/样式）
 *   - mammoth：读取 .docx（转换为文本或 HTML，纯文本提取最稳）
 *   - jszip：替换文本（docx 本质是 OOXML zip 包，word/document.xml 存文本）
 *
 * 工作目录随当前任务动态变化（每次执行通过 getBaseDir 取沙箱根），
 * 所有文件路径必须经 PathGuard 校验，防止越界。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'

// 延迟加载，避免依赖缺失时整模块崩溃
let _docx = null
let _mammoth = null
let _JSZip = null
async function ensureLibs() {
  if (!_docx) {
    _docx = await import('docx')
  }
  if (!_mammoth) {
    _mammoth = (await import('mammoth')).default || (await import('mammoth'))
  }
  if (!_JSZip) {
    const z = await import('jszip')
    _JSZip = z.default || z
  }
  return { docx: _docx, mammoth: _mammoth, JSZip: _JSZip }
}

// ── XML 实体解码/编码（替换文本用）──────────────────────────────
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}
function encodeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── 轻量 Markdown → blocks ───────────────────────────────────
// 4B 模型填不对嵌套的 blocks 对象数组（实测：它会退化成反复用 write_file 写纯文本，
// 产出打不开的伪 docx），但它很擅长写 Markdown。所以允许直接喂 Markdown 文本
// 或已写好的 .md 文件路径，把结构化成本从模型侧挪到服务端。
function markdownToBlocks(md) {
  const lines = String(md || '').split(/\r?\n/)
  const blocks = []
  let list = null
  let table = null
  const flush = () => {
    if (list) { blocks.push({ type: 'bullets', items: list }); list = null }
    if (table) { blocks.push({ type: 'table', rows: table }); table = null }
  }
  for (const raw of lines) {
    const line = raw.trim()
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    const isRow = /^\|.*\|$/.test(line)
    const li = /^[-*+]\s+(.*)$/.exec(line)
    const num = /^\d+[.)]\s+(.*)$/.exec(line)

    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); continue }
    if (isRow) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue   // |---|---| 分隔行
      if (!table) { flush(); table = [] }
      table.push(cells)
      continue
    }
    if (li || num) { flush(); if (!list) list = []; list.push((li ? li[1] : num[1]).trim()); continue }
    flush()
    if (!line) continue
    blocks.push({ type: 'paragraph', text: line })
  }
  flush()
  return blocks
}

export function registerDocxOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 生成 DOCX ────────────────────────────────────────────────
  registry.register({
    name: 'create_docx',
    description: '生成 Word(.docx)。内容三选一：markdown(推荐，直接把 Markdown 文本粘进来)、from_md(已写好的 .md 文件路径)、blocks(结构化数组)。示例：create_docx({"path":"output/排版结果.docx","from_md":"output/排版结果.md"})',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 .docx 文件路径（工作区内，须以 .docx 结尾）' },
        title: { type: 'string', description: '文档标题（生成文档最前的大标题，可选）' },
        author: { type: 'string', description: '作者署名，写入文档属性，可选' },
        markdown: { type: 'string', description: '推荐：Markdown 文本，自动转标题/列表/表格/段落' },
        from_md: { type: 'string', description: '推荐：已存在的 .md 文件路径，自动转 docx（与 markdown 二选一）' },
        blocks: {
          type: 'array',
          description: '结构化内容块数组（markdown/from_md 更简单，优先用它们）。每块: {type, ...}。type 可选 heading(需 text,level 1-6)/paragraph(需 text)/bullets(需 items 字符串数组)/table(需 rows 二维字符串数组，首行作表头)。',
          items: { type: 'object' },
        },
      },
      required: ['path'],
    },
    async execute({ path: filePath, title, author, blocks, markdown, from_md }) {
      const { docx } = await ensureLibs()
      const {
        Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle,
      } = docx
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      if (!target.toLowerCase().endsWith('.docx')) throw new Error('文件路径必须以 .docx 结尾')

      // 内容来源优先级：markdown > from_md > blocks
      let contentBlocks = Array.isArray(blocks) ? blocks : []
      if (from_md && String(from_md).trim()) {
        const mdPath = await guard.resolveChecked(String(from_md), { allowDir: false })
        contentBlocks = markdownToBlocks(await fs.readFile(mdPath, 'utf-8'))
      } else if (markdown && String(markdown).trim()) {
        contentBlocks = markdownToBlocks(markdown)
      }
      if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
        throw new Error('缺少内容：请提供 markdown、from_md 或 blocks（三者其一，推荐 markdown/from_md）')
      }

      const headingLevels = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

      const children = []
      if (title) {
        children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }))
      }
      for (const b of contentBlocks) {
        const t = b.type || 'paragraph'
        if (t === 'heading') {
          const lvl = Math.min(6, Math.max(1, Number(b.level) || 1))
          children.push(new Paragraph({ text: String(b.text || ''), heading: headingLevels[lvl] }))
        } else if (t === 'bullets') {
          const items = Array.isArray(b.items) ? b.items : (b.items ? [b.items] : [])
          for (const it of items) {
            children.push(new Paragraph({ text: String(it), bullet: { level: 0 } }))
          }
        } else if (t === 'table') {
          const rows = Array.isArray(b.rows) ? b.rows : []
          if (rows.length) {
            const tableRows = rows.map((row, ri) =>
              new TableRow({
                tableHeader: ri === 0,
                children: (Array.isArray(row) ? row : [row]).map((cell) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ''), bold: ri === 0 })] })],
                  })
                ),
              })
            )
            children.push(new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: { single: { color: '999999', size: 4, style: BorderStyle.SINGLE } },
              rows: tableRows,
            }))
          }
        } else {
          // paragraph（默认）
          children.push(new Paragraph({ children: [new TextRun(String(b.text || ''))] }))
        }
      }

      const doc = new Document({
        creator: author || 'MiniAgent',
        title: title || '',
        sections: [{ children }],
      })
      const buffer = await Packer.toBuffer(doc)
      await fs.writeFile(target, buffer)
      return { success: true, path: rel(target), blockCount: contentBlocks.length }
    },
  })

  // ── 读取 DOCX 文本 ────────────────────────────────────────────
  registry.register({
    name: 'read_docx',
    description: '读取已有 .docx，提取纯文本（保留段落/表格换行）。返回文本与段落数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .docx 文件路径' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }) {
      const { mammoth } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const { value } = await mammoth.extractRawText({ path: target })
      const paraCount = String(value).split(/\n+/).filter((l) => l.trim()).length
      return { success: true, paragraphCount: paraCount, text: value }
    },
  })

  // ── DOCX 转 Markdown ──────────────────────────────────────────
  registry.register({
    name: 'docx_to_markdown',
    description: '把 .docx 转换为 Markdown：标题→#、列表→-、表格→管道表。基于 mammoth 的 HTML 输出做轻量转换。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的 .docx 文件路径' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }) {
      const { mammoth } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const { value: html } = await mammoth.convertToHtml({ path: target })
      const md = htmlToMarkdown(html)
      return { success: true, markdown: md }
    },
  })

  // ── 替换 DOCX 文本（保留版式）────────────────────────────────
  registry.register({
    name: 'replace_docx_text',
    description: '在已有 .docx 中查找并替换文本（保留版式/图片/表格）。可选择性包含页眉页脚。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要修改的 .docx 文件路径' },
        find: { type: 'string', description: '查找文本' },
        replace: { type: 'string', description: '替换文本' },
        includeHeadersFooters: { type: 'boolean', description: '是否一并替换页眉/页脚文本，默认 false' },
      },
      required: ['path', 'find', 'replace'],
    },
    async execute({ path: filePath, find, replace, includeHeadersFooters }) {
      const { JSZip } = await ensureLibs()
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      const zip = await JSZip.loadAsync(buf)

      const fileFilter = (n) => {
        if (/^word\/document\.xml$/.test(n)) return true
        if (includeHeadersFooters && /^word\/(header|footer)\d+\.xml$/.test(n)) return true
        return false
      }

      let total = 0
      await Promise.all(
        Object.keys(zip.files)
          .filter(fileFilter)
          .map(async (name) => {
            let xml = await zip.files[name].async('string')
            xml = xml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (full, inner) => {
              const decoded = decodeXml(inner)
              if (decoded.includes(find)) {
                const replaced = decoded.split(find).join(replace)
                total += decoded.split(find).length - 1
                // 用函数形式做 replacement：字符串形式会特殊解释 $&/$' 等 $ 序列，
                // 替换文本含 $ 时会产出损坏的 XML
                return full.replace(inner, () => encodeXml(replaced))
              }
              return full
            })
            zip.file(name, xml)
          })
      )

      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      await fs.writeFile(target, out)
      return { success: true, replacements: total, path: rel(target) }
    },
  })
}

// ── 轻量 HTML → Markdown（供 docx_to_markdown 用）──────────────
function htmlToMarkdown(html) {
  let s = String(html || '')
  // 表格：把 <table> 转成管道表
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (tbl) => {
    const rows = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((rm) => {
      const cells = [...rm[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cm) => stripTags(cm[1]).replace(/\|/g, '\\|').trim())
      return cells
    })
    if (!rows.length) return ''
    const header = `| ${rows[0].join(' | ')} |`
    const sep = `| ${rows[0].map(() => '---').join(' | ')} |`
    const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n')
    return `\n${header}\n${sep}\n${body}\n`
  })
  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n`)
  // 列表
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `- ${stripTags(inner).trim()}\n`)
  s = s.replace(/<ul[\s\S]*?<\/ul>/gi, (m) => m + '\n')
  s = s.replace(/<ol[\s\S]*?<\/ol>/gi, (m) => m + '\n')
  // 行内
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  // 段落
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `${stripTags(inner).trim()}\n\n`)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = stripTags(s)
  // 清理多余空行
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s + '\n'
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '')
}
