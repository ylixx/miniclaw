/**
 * PPTX Document Tools - PowerPoint 演示文稿处理工具
 *
 * 依赖（运行时动态加载，未安装不影响服务启动）：
 *   - pptxgenjs：生成 .pptx
 *   - jszip：读取/编辑（PPTX 本质是 OOXML zip 包，ppt/slides/slideN.xml 存文本）
 *
 * 工作目录随当前任务动态变化（每次执行通过 getBaseDir 取沙箱根），
 * 所有文件路径必须经 PathGuard 校验，防止越界。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'

// 延迟加载，避免依赖缺失时整模块崩溃
let _PptxGenJS = null
let _JSZip = null
async function ensureLibs() {
  if (!_PptxGenJS) {
    const m = await import('pptxgenjs')
    _PptxGenJS = m.default || m
  }
  if (!_JSZip) {
    const z = await import('jszip')
    _JSZip = z.default || z
  }
  return { PptxGenJS: _PptxGenJS, JSZip: _JSZip }
}

// ── XML 实体解码（读取文本用）──────────────────────────────
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

// ── XML 实体编码（写入文本用）──────────────────────────────
function encodeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── 从 slide XML 抽取全部 <a:t> 文本（保持顺序）──────────────
function extractTextRuns(xml) {
  const runs = []
  const re = /<a:t>([\s\S]*?)<\/a:t>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    runs.push(decodeXml(m[1]))
  }
  return runs
}

// ── 规范化表格数据（4B 可能用 table/rows/data 任一命名，或传对象数组，或字符串化）──
function normalizeTable(data) {
  if (!data) return null
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return null }
  }
  if (!Array.isArray(data) || data.length === 0) return null
  // 对象数组 → 矩阵（键作表头行）
  if (data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
    const keys = Object.keys(data[0])
    return [keys, ...data.map((obj) => keys.map((k) => (obj == null ? '' : obj[k])))]
  }
  // 已是二维数组 → 直接返回（每行确保为数组）
  return data.map((row) => (Array.isArray(row) ? row : [row]))
}

// ── 渲染表格到幻灯片（首行作表头：主题色填充 + 白字加粗）────────────────
function renderTable(slide, matrix, theme) {
  const headerFill = theme || '1F4E79'
  const rows = matrix.map((row, ri) =>
    (Array.isArray(row) ? row : [row]).map((cell) => {
      const text = cell == null ? '' : String(cell)
      if (ri === 0) {
        return { text, options: { bold: true, color: 'FFFFFF', fill: { color: headerFill }, align: 'center' } }
      }
      return { text, options: { align: 'left' } }
    })
  )
  slide.addTable(rows, {
    x: 0.5, y: 1.5, w: 9.0,
    fontSize: 14, color: '222222',
    border: { type: 'solid', color: 'BBBBBB', pt: 1 },
    valign: 'middle', autoPage: false,
  })
}

export function registerPptxOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 生成 PPTX ────────────────────────────────────────────────
  registry.register({
    name: 'create_pptx',
    description: '根据结构化大纲生成 PowerPoint(.pptx) 演示文稿。支持封面页、要点列表、正文段落、章节页、表格页与备注，可选主题色。文件落在当前任务工作区。示例：create_pptx({"path":"a.pptx","title":"汇报","slides":[{"title":"数据","layout":"table","table":[["姓名","分数"],["张三","90"],["李四","85"]]},{"title":"结论","bullets":["达标","可推广"]}]})',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 .pptx 文件路径（工作区内，须以 .pptx 结尾）' },
        title: { type: 'string', description: '演示文稿标题（生成封面页，可选）' },
        author: { type: 'string', description: '作者署名，显示在封面副标题，可选' },
        themeColor: { type: 'string', description: '主题色十六进制，如 "2563EB"，默认 1F4E79 深蓝' },
        slides: {
          type: 'array',
          description: '幻灯片数组。每页: { title, layout?, bullets?, content?, table?, notes? }。layout 可选 titleAndBullets(默认)/titleOnly/titleAndContent/section/blank/table。bullets 为要点(字符串或数组)；content 为正文段落(字符串或数组)；table 为表格数据——二维数组(首行作表头加粗)或对象数组(键作列)，也可用 rows/data 命名；notes 为演讲者备注。',
          items: { type: 'object' },
        },
      },
      required: ['path', 'slides'],
    },
    async execute({ path: filePath, title, author, themeColor, slides }) {
      const { PptxGenJS } = await ensureLibs()
      // 容错归一化：4B 模型有时会把 slides 包成 JSON 字符串（双重转义）而非数组，
      // 在此尝试还原，避免直接抛出"必须是非空数组"误导模型。
      if (typeof slides === 'string') {
        try { slides = JSON.parse(slides) } catch { /* 还原失败则交由下方校验抛错 */ }
      }
      if (!Array.isArray(slides) || slides.length === 0) throw new Error('slides 必须是非空数组')
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      if (!target.toLowerCase().endsWith('.pptx')) throw new Error('文件路径必须以 .pptx 结尾')

      const theme = (themeColor || '1F4E79').replace(/^#/, '').toUpperCase()
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_16x9'
      if (title) pptx.title = title
      if (author) pptx.author = author
      pptx.company = 'MiniAgent'

      const slideList = []
      // 封面页
      if (title) {
        const cover = pptx.addSlide()
        cover.background = { color: 'FFFFFF' }
        cover.addText(title, {
          x: 0.6, y: 2.0, w: 8.8, h: 1.6, fontSize: 40, bold: true,
          color: theme, align: 'center', valign: 'middle',
        })
        const sub = [author, new Date().toLocaleDateString('zh-CN')].filter(Boolean).join('  ·  ')
        if (sub) {
          cover.addText(sub, {
            x: 0.6, y: 3.7, w: 8.8, h: 0.6, fontSize: 16,
            color: '666666', align: 'center', valign: 'middle',
          })
        }
        slideList.push(cover)
      }

      const warnings = []
      const KNOWN_LAYOUTS = ['titleAndBullets', 'titleOnly', 'titleAndContent', 'section', 'blank', 'table']
      for (const s of slides) {
        const slide = pptx.addSlide()
        const layout = s.layout || 'titleAndBullets'
        if (!KNOWN_LAYOUTS.includes(layout)) {
          warnings.push(`未知 layout:「${layout}」，已按默认 titleAndBullets 处理`)
        }
        if (s.title) {
          slide.addText(s.title, {
            x: 0.5, y: 0.3, w: 9.0, h: 1.0,
            fontSize: layout === 'section' ? 36 : 28,
            bold: true, color: theme,
            align: layout === 'section' ? 'center' : 'left',
            valign: 'middle',
          })
        }
        if (layout === 'titleOnly' || layout === 'blank') {
          // 仅标题/空白，不自动加正文
        } else if (layout === 'section') {
          // 章节页：标题已居中放大，可附加要点作为说明
          if (Array.isArray(s.bullets) && s.bullets.length) {
            slide.addText(s.bullets.map((b) => ({ text: String(b) })), {
              x: 1.0, y: 3.0, w: 8.0, h: 2.0, fontSize: 16,
              color: '444444', align: 'center', bullet: false,
            })
          }
        } else if (layout === 'titleAndContent') {
          const body = Array.isArray(s.content) ? s.content : (s.content ? [s.content] : [])
          if (body.length) {
            slide.addText(body.map((b) => ({ text: String(b) })), {
              x: 0.6, y: 1.5, w: 8.8, h: 3.6,
              fontSize: 16, color: '222222', valign: 'top',
              paraSpaceAfter: 8, lineSpacingMultiple: 1.1,
            })
          }
        } else if (layout === 'table') {
          const matrix = normalizeTable(s.table ?? s.rows ?? s.data)
          if (matrix && matrix.length) {
            renderTable(slide, matrix, theme)
          } else if (Array.isArray(s.bullets) ? s.bullets.length : (s.bullets || s.content)) {
            warnings.push(`slide「${s.title || '(无标题)'}」layout=table 但未提供表格数据，已退化为要点/正文`)
            const bullets = Array.isArray(s.bullets) ? s.bullets : (s.bullets ? [s.bullets] : [])
            if (bullets.length) {
              slide.addText(bullets.map((b) => ({ text: String(b) })), {
                x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 16, color: '222222',
                valign: 'top', bullet: { code: '2022', indent: 18 }, paraSpaceAfter: 6,
              })
            } else if (s.content) {
              const body = Array.isArray(s.content) ? s.content : [s.content]
              slide.addText(body.map((b) => ({ text: String(b) })), {
                x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 16, color: '222222', valign: 'top', paraSpaceAfter: 8,
              })
            }
          } else {
            warnings.push(`slide「${s.title || '(无标题)'}」layout=table 但未提供任何内容`)
          }
        } else {
          // titleAndBullets（默认，也兜底未知 layout）
          const bullets = Array.isArray(s.bullets) ? s.bullets : (s.bullets ? [s.bullets] : [])
          if (bullets.length) {
            slide.addText(bullets.map((b) => ({ text: String(b) })), {
              x: 0.6, y: 1.5, w: 8.8, h: 3.6,
              fontSize: 16, color: '222222', valign: 'top',
              bullet: { code: '2022', indent: 18 }, paraSpaceAfter: 6,
            })
          } else if (s.content) {
            const body = Array.isArray(s.content) ? s.content : [s.content]
            slide.addText(body.map((b) => ({ text: String(b) })), {
              x: 0.6, y: 1.5, w: 8.8, h: 3.6,
              fontSize: 16, color: '222222', valign: 'top', paraSpaceAfter: 8,
            })
          }
        }
        if (s.notes) slide.addNotes(Array.isArray(s.notes) ? s.notes.join('\n') : String(s.notes))
        slideList.push(slide)
      }

      await pptx.writeFile({ fileName: target })
      return {
        success: true,
        path: rel(target),
        slideCount: slideList.length,
        note: title ? '已生成封面页 + ' + slides.length + ' 内容页' : '已生成 ' + slides.length + ' 页',
        ...(warnings.length ? { warnings } : {}),
      }
    },
  })

  // ── 读取 PPTX 文本 ────────────────────────────────────────────
  registry.register({
    name: 'read_pptx',
    description: '读取已有 .pptx，逐页抽取全部文本。返回每页标题与正文，以及总页数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .pptx 文件路径' },
        includeNotes: { type: 'boolean', description: '是否一并抽取演讲者备注，默认 false' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, includeNotes }) {
      const { JSZip } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      const zip = await JSZip.loadAsync(buf)

      // 收集幻灯片文件，按编号排序
      const slideFiles = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const na = Number(a.match(/slide(\d+)\.xml$/)[1])
          const nb = Number(b.match(/slide(\d+)\.xml$/)[1])
          return na - nb
        })

      const slides = []
      let totalRuns = 0
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async('string')
        const runs = extractTextRuns(xml)
        totalRuns += runs.length
        const title = runs[0] || ''
        const body = runs.slice(1)
        let notes = ''
        if (includeNotes) {
          // 备注页命名与幻灯片对应：notesSlides/notesSlideN.xml，且内部 r:cSld 引用 slideN
          const idx = i + 1
          const noteFile = Object.keys(zip.files).find(
            (n) => new RegExp(`^ppt/notesSlides/notesSlide${idx}\\.xml$`).test(n)
          )
          if (noteFile) {
            const nxml = await zip.files[noteFile].async('string')
            notes = extractTextRuns(nxml).join('\n').trim()
          }
        }
        slides.push({ index: i + 1, title, body, notes })
      }

      return {
        success: true,
        slideCount: slides.length,
        textRunCount: totalRuns,
        slides,
      }
    },
  })

  // ── PPTX 转 Markdown ──────────────────────────────────────────
  registry.register({
    name: 'pptx_to_markdown',
    description: '把 .pptx 转换为 Markdown：每页一个二级标题，要点转为列表，备注可选附在引用块。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的 .pptx 文件路径' },
        includeNotes: { type: 'boolean', description: '是否把备注写入 > 引用块，默认 false' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, includeNotes }) {
      const { JSZip } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      const zip = await JSZip.loadAsync(buf)
      const slideFiles = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]))

      const parts = []
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async('string')
        const runs = extractTextRuns(xml)
        const heading = (runs[0] || `第 ${i + 1} 页`).trim()
        parts.push(`## ${heading}`)
        const bullets = runs.slice(1).filter((t) => t.trim())
        if (bullets.length) {
          for (const b of bullets) parts.push(`- ${b.trim()}`)
        } else {
          parts.push('_(无正文)_')
        }
        if (includeNotes) {
          const idx = i + 1
          const noteFile = Object.keys(zip.files).find(
            (n) => new RegExp(`^ppt/notesSlides/notesSlide${idx}\\.xml$`).test(n)
          )
          if (noteFile) {
            const nxml = await zip.files[noteFile].async('string')
            const nt = extractTextRuns(nxml).join('\n').trim()
            if (nt) parts.push('', `> 备注: ${nt.replace(/\n/g, ' ')}`)
          }
        }
        parts.push('')
      }
      return { success: true, markdown: parts.join('\n').trimEnd() + '\n' }
    },
  })

  // ── 替换 PPTX 文本（保留版式）────────────────────────────────
  registry.register({
    name: 'replace_pptx_text',
    description: '在已有 .pptx 中查找并替换文本（保留原有版式/图片/动画）。可作用于幻灯片与备注页。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要修改的 .pptx 文件路径' },
        find: { type: 'string', description: '查找文本' },
        replace: { type: 'string', description: '替换文本' },
        includeNotes: { type: 'boolean', description: '是否一并替换备注页文本，默认 false' },
      },
      required: ['path', 'find', 'replace'],
    },
    async execute({ path: filePath, find, replace, includeNotes }) {
      const { JSZip } = await ensureLibs()
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      const zip = await JSZip.loadAsync(buf)

      let total = 0
      const fileFilter = (n) => {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(n)) return true
        if (includeNotes && /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)) return true
        return false
      }

      await Promise.all(
        Object.keys(zip.files)
          .filter(fileFilter)
          .map(async (name) => {
            let xml = await zip.files[name].async('string')
            xml = xml.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (full, inner) => {
              const decoded = decodeXml(inner)
              if (decoded.includes(find)) {
                const replaced = decoded.split(find).join(replace)
                total += decoded.split(find).length - 1
                return `<a:t>${encodeXml(replaced)}</a:t>`
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

  // ── 追加幻灯片（克隆末页版式，保留设计）──────────────────────
  registry.register({
    name: 'append_pptx_slide',
    description: '向已有 .pptx 追加一张幻灯片。通过克隆现有幻灯片结构（保留版式/配色）并替换其文本实现；新页标题取首个文本占位符，其余要点填充正文。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要追加的 .pptx 文件路径' },
        title: { type: 'string', description: '新页标题' },
        bullets: { type: 'array', items: { type: 'string' }, description: '新页要点列表，可选' },
        content: { type: 'string', description: '新页正文段落（与 bullets 二选一），可选' },
      },
      required: ['path', 'title'],
    },
    async execute({ path: filePath, title, bullets, content }) {
      const { JSZip } = await ensureLibs()
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const buf = await fs.readFile(target)
      const zip = await JSZip.loadAsync(buf)

      // 现有幻灯片按号排序，取最大编号作为克隆源
      const slideFiles = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]))
      if (slideFiles.length === 0) throw new Error('该 pptx 不含任何幻灯片，无法追加')
      const maxNum = Number(slideFiles[slideFiles.length - 1].match(/slide(\d+)\.xml$/)[1])
      const newNum = maxNum + 1
      const srcSlide = slideFiles[slideFiles.length - 1]

      // 克隆源幻灯片 XML，替换 <a:t> 文本：第一个=标题，后续=要点/正文
      let srcXml = await zip.files[srcSlide].async('string')
      const bodyText = Array.isArray(bullets) && bullets.length
        ? bullets
        : (content ? [content] : [])
      const replacement = [title, ...bodyText]
      let ri = 0
      srcXml = srcXml.replace(/<a:t>[\s\S]*?<\/a:t>/g, (full) => {
        const txt = ri < replacement.length ? replacement[ri++] : ''
        return `<a:t>${encodeXml(txt)}</a:t>`
      })
      // 若源页文本占位符多于提供内容，剩余清空；若提供内容多于占位符，超出部分忽略（版式限制）
      zip.file(`ppt/slides/slide${newNum}.xml`, srcXml)

      // 克隆源幻灯片的关系文件
      const srcRelsName = `ppt/slides/_rels/${path.basename(srcSlide)}.rels`
      if (zip.files[srcRelsName]) {
        zip.file(`ppt/slides/_rels/slide${newNum}.xml.rels`, await zip.files[srcRelsName].async('string'))
      }

      // 更新 presentation.xml 的 sldIdLst
      const presName = 'ppt/presentation.xml'
      let pres = await zip.files[presName].async('string')
      const sldIdMatch = pres.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)
      if (sldIdMatch) {
        const newSldId = `<p:sldId id="256" r:id="rIdSlide${newNum}"/>`
        pres = pres.replace(sldIdMatch[0], `<p:sldIdLst>${sldIdMatch[1]}${newSldId}</p:sldIdLst>`)
        zip.file(presName, pres)
      }

      // 更新 presentation.xml.rels：新增 slide 关系
      const presRelsName = 'ppt/_rels/presentation.xml.rels'
      let presRels = await zip.files[presRelsName].async('string')
      const relIds = [...presRels.matchAll(/Id="(rId\d+)"/g)].map((m) => Number(m[1].slice(3)))
      const newRelId = `rId${Math.max(0, ...relIds) + 1}`
      // 复用上面写的 rIdSlide{newNum} 必须在 rels 中存在，统一改为 newRelId
      pres = pres.replace(`rIdSlide${newNum}`, newRelId)
      zip.file(presName, pres)
      const newRel = `<Relationship Id="${newRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNum}.xml"/>`
      presRels = presRels.replace(/<\/Relationships>/, `${newRel}</Relationships>`)
      zip.file(presRelsName, presRels)

      // 更新 [Content_Types].xml
      const ctName = '[Content_Types].xml'
      let ct = await zip.files[ctName].async('string')
      const override = `<Override PartName="/ppt/slides/slide${newNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
      if (!ct.includes(`/ppt/slides/slide${newNum}.xml`)) {
        ct = ct.replace(/<\/Types>/, `${override}</Types>`)
        zip.file(ctName, ct)
      }

      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      await fs.writeFile(target, out)
      return { success: true, path: rel(target), slideCount: newNum }
    },
  })
}
