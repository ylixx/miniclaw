/**
 * 技能包（zip）安装器
 *
 * 流程：接收 zip 原始字节 → PowerShell Expand-Archive 解包（Windows 内置，免 npm 依赖）
 * → 递归查找技能入口（优先 SKILL.md 标准格式，其次含 name+instruction 的 *.json）
 * → 转换/校验 → 写入 skills 目录（覆盖同名）→ 触发 SkillsManager.reload() 热重载。
 */

import fs from 'fs/promises'
import fssync from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

// 递归列出目录下所有文件
function walk(dir, out = []) {
  const entries = fssync.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// 解析 SKILL.md：首个 --- ... --- 为 frontmatter（取 name/description），其后正文为 instruction
function parseSkillMd(content) {
  const text = content.trim()
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/)
  if (!m) return { name: '', description: '', instruction: text }
  const fm = m[1]
  const instruction = m[2].trim()
  let name = ''
  let description = ''
  for (const line of fm.split('\n')) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!mm) continue
    const k = mm[1].toLowerCase()
    const v = mm[2].trim().replace(/^["']|["']$/g, '')
    if (k === 'name') name = v
    else if (k === 'description') description = v
  }
  return { name, description, instruction }
}

// 在解压目录中定位技能入口
function findEntry(dir) {
  const files = walk(dir)
  // 1) 优先 SKILL.md（标准技能格式）
  const skillMd = files.find((f) => f.toLowerCase().endsWith('skill.md'))
  if (skillMd) {
    const parsed = parseSkillMd(fssync.readFileSync(skillMd, 'utf-8'))
    if (!parsed.name || !parsed.instruction) {
      throw new Error('SKILL.md 缺少 name 或正文指令（instruction）')
    }
    return {
      name: parsed.name,
      description: parsed.description || parsed.name,
      instruction: parsed.instruction,
      steps: [],
      params: [],
    }
  }
  // 2) 其次：含 name + instruction 的技能 JSON
  for (const f of files.filter((f) => f.toLowerCase().endsWith('.json'))) {
    try {
      const data = JSON.parse(fssync.readFileSync(f, 'utf-8'))
      if (data.name && data.instruction) {
        return {
          name: data.name,
          description: data.description || data.name,
          instruction: data.instruction,
          steps: Array.isArray(data.steps) ? data.steps : [],
          params: Array.isArray(data.params) ? data.params : [],
        }
      }
    } catch { /* 跳过非技能 JSON */ }
  }
  throw new Error('zip 中未找到 SKILL.md 或含 name/instruction 的技能 JSON')
}

/**
 * 从 zip 字节安装技能。
 * @param {Buffer} zipBuffer 上传的 zip 原始字节
 * @param {import('./loader.js').SkillsManager} skillsManager 用于写目录与热重载
 * @returns {Promise<{name:string, description:string, file:string}>}
 */
export async function installSkillFromZip(zipBuffer, skillsManager) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    throw new Error('缺少 zip 数据')
  }
  const base = path.join(os.tmpdir(), `miniagent-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const zipPath = base + '.zip'
  const outDir = base
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(zipPath, zipBuffer)
  try {
    // Windows 内置解压，免依赖；路径用单引号包裹并转义内部单引号
    const ps = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })

    const skill = findEntry(outDir)

    // 写入 skills 目录（覆盖同名）
    await fs.mkdir(skillsManager.skillsDir, { recursive: true })
    const file = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
    const target = path.join(skillsManager.skillsDir, file)
    try { await fs.unlink(target) } catch { /* 文件可能不存在 */ }
    await fs.writeFile(target, JSON.stringify(skill, null, 2), 'utf-8')

    // 热重载，装完即用，无需重启
    await skillsManager.reload()

    return { name: skill.name, description: skill.description, file }
  } finally {
    // 清理临时文件
    try {
      await fs.rm(zipPath, { force: true })
      await fs.rm(outDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}
