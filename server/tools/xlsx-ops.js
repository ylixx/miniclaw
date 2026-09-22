/**
 * XLSX Document Tools - Excel 表格处理工具
 *
 * 依赖（运行时动态加载，未安装不影响服务启动）：
 *   - exceljs：读写 .xlsx，支持多 sheet、样式、流式处理，办公报表首选
 *
 * 工作目录随当前任务动态变化（每次执行通过 getBaseDir 取沙箱根），
 * 所有文件路径必须经 PathGuard 校验，防止越界。
 */

import fs from 'fs/promises'
import path from 'path'
import { PathGuard } from './path-guard.js'

let _exceljs = null
async function ensureLibs() {
  if (!_exceljs) {
    _exceljs = (await import('exceljs')).default || (await import('exceljs'))
  }
  return { ExcelJS: _exceljs }
}

export function registerXlsxOps(registry, { getBaseDir } = {}) {
  const getCtx = () => {
    const bd = getBaseDir()
    return { guard: new PathGuard(bd), baseDir: bd, rel: (abs) => path.relative(bd, abs) || '.' }
  }

  // ── 生成 XLSX ────────────────────────────────────────────────
  registry.register({
    name: 'create_xlsx',
    description: '根据二维数据生成 Excel(.xlsx)，支持多工作表(sheet)与表头加粗。数据可为二维数组(数组的数组)或对象数组。文件落在当前任务工作区。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 .xlsx 文件路径（工作区内，须以 .xlsx 结尾）' },
        sheets: {
          type: 'array',
          description: '工作表数组。每项: { name?, data }。data 为二维数组（首行作表头加粗）或对象数组（键作表头）。可只传一个 sheet。',
          items: { type: 'object' },
        },
        creator: { type: 'string', description: '作者署名，写入文档属性，可选' },
      },
      required: ['path', 'sheets'],
    },
    async execute({ path: filePath, sheets, creator }) {
      const { ExcelJS } = await ensureLibs()
      if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('sheets 必须是非空数组')
      const { guard, rel } = getCtx()
      const target = guard.resolve(filePath)
      if (!target.toLowerCase().endsWith('.xlsx')) throw new Error('文件路径必须以 .xlsx 结尾')

      const wb = new ExcelJS.Workbook()
      wb.creator = creator || 'MiniAgent'
      wb.created = new Date()

      for (const sh of sheets) {
        const name = sh.name || `Sheet${sheets.indexOf(sh) + 1}`
        const ws = wb.addWorksheet(name.slice(0, 31))
        const data = sh.data
        if (Array.isArray(data) && data.length) {
          if (Array.isArray(data[0])) {
            // 二维数组：首行加粗表头
            data.forEach((row, ri) => {
              const excelRow = ws.addRow(row.map((c) => (c == null ? '' : c)))
              if (ri === 0) {
                excelRow.font = { bold: true }
                excelRow.alignment = { vertical: 'middle' }
              }
            })
          } else if (typeof data[0] === 'object') {
            // 对象数组：自动列
            ws.columns = Object.keys(data[0]).map((k) => ({ header: k, key: k, width: 16 }))
            data.forEach((obj) => ws.addRow(obj))
          } else {
            ws.addRow(data)
          }
        }
        // 自动列宽（简单估算）
        ws.columns.forEach((col) => {
          if (col.width == null) col.width = 16
        })
      }

      await wb.xlsx.writeFile(target)
      return { success: true, path: rel(target), sheetCount: sheets.length }
    },
  })

  // ── 读取 XLSX ────────────────────────────────────────────────
  registry.register({
    name: 'read_xlsx',
    description: '读取 .xlsx 全部工作表，逐 sheet 返回二维数组（含表头行）。返回每个 sheet 的名称与行数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .xlsx 文件路径' },
        sheet: { type: 'string', description: '仅读取指定 sheet 名或索引(从1开始)，默认读取全部', },
      },
      required: ['path'],
    },
    async execute({ path: filePath, sheet }) {
      const { ExcelJS } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(target)

      const sheetList = []
      const wantIdx = typeof sheet === 'number' ? sheet : (Number(sheet) ? Number(sheet) : null)
      const wantName = typeof sheet === 'string' ? sheet : null

      let si = 0
      wb.eachSheet((ws) => {
        si++
        if (wantIdx && si !== wantIdx) return
        if (wantName && ws.name !== wantName) return
        const rows = []
        ws.eachRow((row) => {
          const arr = []
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            arr[colNumber - 1] = cell.value == null ? '' : (typeof cell.value === 'object' ? (cell.value.text || cell.value.result || cell.text || '') : cell.value)
          })
          // 去掉尾部空
          while (arr.length && arr[arr.length - 1] === '') arr.pop()
          rows.push(arr)
        })
        sheetList.push({ index: si, name: ws.name, rowCount: rows.length, rows })
      })

      return { success: true, sheetCount: sheetList.length, sheets: sheetList }
    },
  })

  // ── XLSX 转 CSV ──────────────────────────────────────────────
  registry.register({
    name: 'xlsx_to_csv',
    description: '把 .xlsx 的指定工作表转为 CSV 文本；若提供 outPath 则写入文件，多 sheet 时自动按 sheet 名分文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的 .xlsx 文件路径' },
        sheet: { type: 'string', description: '指定 sheet 名或索引(从1开始)，默认第一个' },
        outPath: { type: 'string', description: '输出 .csv 路径（可选）。省略则返回 CSV 文本字符串。' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, sheet, outPath }) {
      const { ExcelJS } = await ensureLibs()
      const { guard, rel } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(target)

      const wantIdx = typeof sheet === 'number' ? sheet : (Number(sheet) ? Number(sheet) : null)
      const wantName = typeof sheet === 'string' ? sheet : null

      const toCsv = (rows) =>
        rows
          .map((r) => r.map((c) => {
            const v = c == null ? '' : String(c)
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
          }).join(','))
          .join('\n')

      const results = []
      let si = 0
      wb.eachSheet((ws) => {
        si++
        if (wantIdx && si !== wantIdx) return
        if (wantName && ws.name !== wantName) return
        const rows = []
        ws.eachRow((row) => {
          const arr = []
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            arr[colNumber - 1] = cell.value == null ? '' : (typeof cell.value === 'object' ? (cell.value.text || cell.value.result || cell.text || '') : cell.value)
          })
          while (arr.length && arr[arr.length - 1] === '') arr.pop()
          rows.push(arr)
        })
        results.push({ name: ws.name, csv: toCsv(rows) })
      })

      if (outPath) {
        if (results.length === 1) {
          const out = guard.resolve(outPath)
          if (!out.toLowerCase().endsWith('.csv')) throw new Error('outPath 必须以 .csv 结尾')
          await fs.writeFile(out, results[0].csv, 'utf8')
          return { success: true, path: rel(out), sheet: results[0].name }
        } else {
          // 多 sheet：按名生成多个文件
          const base = guard.resolve(outPath)
          const dir = path.dirname(base)
          const ext = path.extname(base)
          const stem = path.basename(base, ext) || 'sheet'
          const written = []
          for (const r of results) {
            const fn = path.join(dir, `${stem}_${r.name}${ext || '.csv'}`)
            await fs.writeFile(fn, r.csv, 'utf8')
            written.push(rel(fn))
          }
          return { success: true, paths: written, sheetCount: results.length }
        }
      }

      return {
        success: true,
        csv: results.length === 1 ? results[0].csv : results.map((r) => `=== ${r.name} ===\n${r.csv}`).join('\n\n'),
      }
    },
  })

  // ── XLSX 转 Markdown ──────────────────────────────────────────
  registry.register({
    name: 'xlsx_to_markdown',
    description: '把 .xlsx 的指定工作表转为 Markdown 管道表格。多 sheet 时依次拼接。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要转换的 .xlsx 文件路径' },
        sheet: { type: 'string', description: '指定 sheet 名或索引(从1开始)，默认第一个' },
      },
      required: ['path'],
    },
    async execute({ path: filePath, sheet }) {
      const { ExcelJS } = await ensureLibs()
      const { guard } = getCtx()
      const target = await guard.resolveChecked(filePath, { allowDir: false })
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(target)

      const wantIdx = typeof sheet === 'number' ? sheet : (Number(sheet) ? Number(sheet) : null)
      const wantName = typeof sheet === 'string' ? sheet : null

      const parts = []
      let si = 0
      wb.eachSheet((ws) => {
        si++
        if (wantIdx && si !== wantIdx) return
        if (wantName && ws.name !== wantName) return
        const rows = []
        ws.eachRow((row) => {
          const arr = []
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            arr[colNumber - 1] = cell.value == null ? '' : (typeof cell.value === 'object' ? (cell.value.text || cell.value.result || cell.text || '') : cell.value)
          })
          while (arr.length && arr[arr.length - 1] === '') arr.pop()
          rows.push(arr)
        })
        if (rows.length) {
          const header = `| ${rows[0].map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`
          const sep = `| ${rows[0].map(() => '---').join(' | ')} |`
          const body = rows.slice(1).map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`).join('\n')
          parts.push(`### ${ws.name}\n\n${header}\n${sep}\n${body}`)
        }
      })
      return { success: true, markdown: parts.join('\n\n') + '\n' }
    },
  })
}
