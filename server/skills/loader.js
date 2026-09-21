/**
 * Skills System v2 - 技能系统（真正生效版）
 *
 * 技能 = 预定义的"任务模板"，激活后：
 * 1. 其指令会被注入 system prompt（引导模型按步骤执行）
 * 2. 推荐工具链会提示给模型（可提高小模型的工具选择准确率）
 * 3. 支持参数化模板：{dir} {pattern} {format} 等占位符在激活时填充
 *
 * 内置技能 + 用户自定义技能（持久化到 ~/.miniagent/skills/*.json）
 */

import fs from 'fs/promises'
import path from 'path'

// ── 内置技能库 ─────────────────────────────────────────────

const BUILTIN_SKILLS = [
  {
    name: 'file_organize',
    description: '整理文件：按类型/日期分类到子目录',
    builtin: true,
    instruction: '用户需要整理文件。执行步骤：1) list_files 查看目录内容；2) create_dir 按文件类型建立子目录（如 documents/ images/ data/ archives/ others/）；3) move_file 把每个文件移入对应子目录。完成后汇报整理结果统计。',
    steps: ['list_files', 'create_dir', 'move_file'],
    params: [
      { key: 'dir', label: '目标目录', default: '.' },
    ],
  },
  {
    name: 'batch_rename',
    description: '批量重命名文件',
    builtin: true,
    instruction: '用户需要批量重命名。执行步骤：1) list_files 获取文件列表；2) 按用户给的规则推导新文件名；3) move_file 逐个重命名。执行前先把「旧名 → 新名」对照表展示给用户确认过的规则。',
    steps: ['list_files', 'move_file'],
    params: [
      { key: 'dir', label: '目标目录', default: '.' },
      { key: 'pattern', label: '命名规则说明（如：加日期前缀）', default: '' },
    ],
  },
  {
    name: 'data_convert',
    description: 'CSV 与 JSON 互相转换',
    builtin: true,
    instruction: '用户需要数据格式转换。执行步骤：1) read_csv 或 read_json 读取源文件；2) write_json 或 write_csv 写出目标格式。转换前先向用户确认输出文件名。',
    steps: ['read_csv', 'read_json', 'write_csv', 'write_json'],
    params: [
      { key: 'from', label: '源文件路径', default: '' },
      { key: 'to', label: '输出文件路径', default: '' },
    ],
  },
  {
    name: 'text_process',
    description: '批量处理文本文件（替换/统计/合并）',
    builtin: true,
    instruction: '用户需要批量处理文本。执行步骤：1) list_files 或 search_files 找到目标文件；2) 逐个 read_file；3) 按用户要求处理（text_replace / text_stats）；4) 需要保存时 write_file。处理完汇报每个文件的结果。',
    steps: ['list_files', 'search_files', 'read_file', 'text_replace', 'text_stats', 'write_file'],
    params: [
      { key: 'dir', label: '目标目录', default: '.' },
      { key: 'operation', label: '处理操作说明', default: '' },
    ],
  },
  {
    name: 'report_gen',
    description: '根据数据生成 Markdown 报告',
    builtin: true,
    instruction: '用户需要生成报告。执行步骤：1) read_json / read_csv 读取数据；2) 分析数据要点；3) md_table 生成表格；4) write_file 写出 .md 报告，报告应包含标题、摘要、数据表格、结论。',
    steps: ['read_json', 'read_csv', 'md_table', 'write_file'],
    params: [
      { key: 'data', label: '数据文件路径', default: '' },
      { key: 'format', label: '报告格式', default: 'markdown' },
    ],
  },
]

// ── SkillsManager ──────────────────────────────────────────

export class SkillsManager {
  constructor(configDir) {
    this.configDir = configDir
    this.skillsDir = path.join(configDir, 'skills')
    this.skills = [...BUILTIN_SKILLS]
    // 激活实例：{ skillName, params, instruction }
    this.active = []
  }

  async init() {
    try {
      const files = await fs.readdir(this.skillsDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const data = JSON.parse(await fs.readFile(path.join(this.skillsDir, f), 'utf-8'))
          if (data.name && data.instruction) {
            this.skills.push({
              name: data.name,
              description: data.description || data.name,
              instruction: data.instruction,
              steps: data.steps || [],
              params: data.params || [],
              builtin: false,
              file: f,
            })
          }
        } catch { /* 跳过损坏的技能文件 */ }
      }
    } catch {
      /* 目录不存在 */
    }
  }

  list() {
    return this.skills.map(s => ({
      name: s.name,
      description: s.description,
      steps: s.steps,
      params: s.params,
      active: this.active.some(a => a.skillName === s.name),
      builtin: !!s.builtin,
    }))
  }

  get(name) {
    return this.skills.find(s => s.name === name)
  }

  /**
   * 激活技能（带参数）。会替换同名技能的旧实例。
   * 返回给前端的确认信息。
   */
  activate(name, params = {}) {
    const skill = this.get(name)
    if (!skill) throw new Error(`技能不存在: ${name}`)

    // 解除已有同名激活
    this.active = this.active.filter(a => a.skillName !== name)

    // 填充参数：未提供的用默认值
    const filled = {}
    for (const p of skill.params || []) {
      filled[p.key] = params[p.key] !== undefined && params[p.key] !== '' ? params[p.key] : p.default
    }

    // 实例化指令：替换 {key} 占位符
    let instruction = skill.instruction
    for (const [k, v] of Object.entries(filled)) {
      instruction = instruction.replaceAll(`{${k}}`, v ?? '')
    }
    // 去掉未匹配的占位符
    instruction = instruction.replace(/\{[a-zA-Z_]+\}/g, '')

    this.active.push({
      skillName: name,
      params: filled,
      instruction,
      steps: skill.steps || [],
      activatedAt: new Date().toISOString(),
    })

    return { skillName: name, params: filled, instruction }
  }

  deactivate(name) {
    this.active = this.active.filter(a => a.skillName !== name)
  }

  clear() {
    this.active = []
  }

  /**
   * 获取激活技能的 prompt 片段（注入 system prompt）
   */
  getPromptContext() {
    if (this.active.length === 0) return ''
    const parts = []
    for (const inst of this.active) {
      const skill = this.get(inst.skillName)
      parts.push(`### 技能：${skill?.description || inst.skillName}\n${inst.instruction}${inst.steps?.length ? `\n推荐按顺序使用工具：${inst.steps.join(' → ')}` : ''}`)
    }
    return `## 当前激活的任务技能（严格按技能指令执行）\n${parts.join('\n\n')}`
  }

  /**
   * 用户自定义技能
   */
  async createCustom({ name, description, instruction, steps = [], params = [] }) {
    if (!name || !instruction) throw new Error('技能需要 name 和 instruction')
    if (this.skills.some(s => s.name === name)) throw new Error(`技能名已存在: ${name}`)

    const skill = { name, description: description || name, instruction, steps, params, builtin: false }
    this.skills.push(skill)

    await fs.mkdir(this.skillsDir, { recursive: true })
    const file = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
    await fs.writeFile(path.join(this.skillsDir, file), JSON.stringify(skill, null, 2))
    return skill
  }

  async removeCustom(name) {
    const skill = this.get(name)
    if (!skill) throw new Error(`技能不存在: ${name}`)
    if (skill.builtin) throw new Error('内置技能不可删除')
    this.skills = this.skills.filter(s => s.name !== name)
    this.deactivate(name)
    try {
      const file = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
      await fs.unlink(path.join(this.skillsDir, file))
    } catch { /* 文件可能不存在 */ }
  }
}
