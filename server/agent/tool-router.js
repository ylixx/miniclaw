/**
 * Tool Router - 工具子集动态注入（专为 4B 小模型设计）
 *
 * 背景：
 * 全量 36 个工具的完整 schema 常驻 system prompt，约吃掉 3000-5000 token，
 * 对 4B 模型意味着：上下文被挤压 + 候选过多导致选错工具（选择过载）。
 *
 * 策略：每次请求只注入与当前任务相关的 8-14 个工具。
 *   A. 技能路由：激活技能时注入其 steps 所需工具 + 技能对应分组
 *   B. 意图路由：无技能时按用户消息关键词判定任务类型，注入对应分组
 *   兜底：只给 core 最小闭环集
 *   逃生：模型调用了子集外的工具时，引擎自动扩容（见 engine._ensureTool），
 *         保证「省 token」不会变成「任务卡死」
 *
 * 只读模式：进一步收敛为只读白名单，从源头杜绝写操作。
 */

// ── 工具分组 ──────────────────────────────────────────────────
// core：任何任务都可能用到的最小闭环（查→读→写→建→移），始终注入
// 说明：组内工具按「重要程度」从高到低排列，注入超限的截断从组尾开始，
//       保证被砍掉的永远是最不常用的那个（而不是 read_csv 这类关键工具）。
export const TOOL_GROUPS = {
  core: [
    'list_files', 'read_file', 'write_file', 'search_files', 'create_dir', 'move_file',
  ],
  file: [
    'file_info', 'scan_directory', 'copy_file', 'append_file', 'batch_organize', 'delete_file',
  ],
  command: [
    'run_command', 'run_script',
  ],
  data: [
    'read_csv', 'read_json', 'md_table', 'text_stats',
    'write_csv', 'write_json', 'text_replace', 'text_summary',
  ],
  docx: [
    'read_docx', 'create_docx', 'docx_to_markdown', 'replace_docx_text',
  ],
  xlsx: [
    'read_xlsx', 'create_xlsx', 'xlsx_to_markdown', 'xlsx_to_csv',
  ],
  pptx: [
    'create_pptx', 'read_pptx', 'pptx_to_markdown', 'replace_pptx_text', 'append_pptx_slide',
  ],
  pdf: [
    'read_pdf', 'create_pdf', 'merge_pdf', 'split_pdf',
  ],
}

export const GROUP_LABELS = {
  core: '基础文件',
  file: '文件管理',
  command: '命令执行',
  data: '数据处理',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PPT 演示',
  pdf: 'PDF 文档',
}

// 只读模式下允许注入的工具（写/删/移动/执行类一律剔除）
export const READ_ONLY_WHITELIST = [
  'list_files', 'read_file', 'search_files', 'file_info',
  'read_csv', 'read_json', 'text_stats', 'text_summary', 'md_table',
  'read_docx', 'docx_to_markdown',
  'read_xlsx', 'xlsx_to_csv', 'xlsx_to_markdown',
  'read_pptx', 'pptx_to_markdown',
  'read_pdf',
]

// ── 技能 → 分组映射（A 通道）──────────────────────────────────
export const SKILL_GROUPS = {
  file_organize: ['file'],
  batch_rename: ['file'],
  data_convert: ['data'],
  text_process: ['data'],
  report_gen: ['data'],
}

// ── 意图关键词 → 分组（B 通道）────────────────────────────────
// kw 命中数即得分；同分组内多个词命中只加权一次由实现保证（按关键词去重计分）
export const INTENT_RULES = [
  {
    group: 'pdf',
    kw: ['pdf', 'PDF'],
  },
  {
    group: 'pptx',
    kw: ['ppt', 'pptx', 'PPT', '幻灯片', '演示文稿', '演示文档', 'slides', '课件'],
  },
  {
    group: 'xlsx',
    kw: ['xlsx', 'xls', 'excel', 'Excel', '表格', '工作表', '电子表格', '报表', '单元格', 'sheet'],
  },
  {
    group: 'docx',
    kw: ['docx', 'word', 'Word', '文档', '报告', '纪要', '合同', '公文', '简历', '总结报告', '说明书'],
  },
  {
    group: 'data',
    kw: ['csv', 'json', '数据', '统计', '统计表', '转换格式', '格式化数据', '表格数据', '字段', '数据集'],
  },
  {
    group: 'file',
    kw: ['整理', '归类', '归档', '分类', '重命名', '批量移动', '复制文件', '删除文件', '清空', '目录结构'],
  },
  {
    group: 'command',
    kw: ['运行', '执行', '编译', '命令行', '终端', 'cmd', 'git', 'npm', 'node ', 'python', '启动服务', '端口', 'curl', 'ping', '脚本', '批量重命名'],
  },
]

// 注入上限：core + 若干组，超出即截断（防止省 token 的目的被抵消）
const MAX_TOOLS = 14
const MAX_TOOLS_WITH_SKILL = 18
const MAX_INTENT_GROUPS = 2

/**
 * 选择本次请求要注入的工具子集
 *
 * @param {Object} opts
 * @param {Array}  opts.schemas     全量工具 schema（tools.getSchemas()，含 MCP）
 * @param {Array}  opts.activeSkills 激活的技能实例 [{ skillName, steps }]
 * @param {string} opts.message     本轮用户消息
 * @param {string} opts.permissionMode guarded | read-only | unattended
 * @returns {{ tools: Array, names: Set<string>, groups: string[], source: string, hits: string[] }}
 */
export function selectTools({ schemas = [], activeSkills = [], message = '', permissionMode = 'guarded' } = {}) {
  const byName = new Map(schemas.map(s => [s.name, s]))
  const picked = new Set()

  const add = (n) => { if (byName.has(n)) picked.add(n) }
  const addGroup = (g) => { for (const n of TOOL_GROUPS[g] || []) add(n) }

  // 1. core 最小闭环（始终）
  addGroup('core')

  // 2. A 通道：技能所需工具（steps 是技能指令里写死的工具名，必须给全）
  const skillGroups = []
  for (const inst of activeSkills) {
    for (const n of inst.steps || []) add(n)
    for (const g of SKILL_GROUPS[inst.skillName] || []) {
      skillGroups.push(g)
      addGroup(g)
    }
  }

  // 3. B 通道：意图关键词
  const hits = scoreIntents(message)
  for (const h of hits.slice(0, MAX_INTENT_GROUPS)) addGroup(h.group)

  // 4. MCP 工具始终注入（数量少，且是用户显式接入的能力）
  //    read-only 除外：无法静态判定 MCP 工具的读写性质，deny-first 不注入
  //    （即使被注入，引擎层 checkPermissionMode 也会拦截 mcp__* 工具）。
  if (permissionMode !== 'read-only') {
    for (const s of schemas) if (s.mcp) picked.add(s.name)
  }

  // 5. 截断：core + 技能组优先保留，意图组按分数从低到高让位（组内从尾部砍，保关键工具）
  const limit = activeSkills.length ? MAX_TOOLS_WITH_SKILL : MAX_TOOLS
  if (picked.size > limit) {
    const intentGroups = hits.slice(0, MAX_INTENT_GROUPS).map(h => h.group)
    for (let i = intentGroups.length - 1; i >= 0 && picked.size > limit; i--) {
      const gTools = [...(TOOL_GROUPS[intentGroups[i]] || [])].reverse()
      for (const n of gTools) {
        if (picked.size <= limit) break
        picked.delete(n)
      }
    }
  }

  let tools = schemas.filter(s => picked.has(s.name))

  // 6. 只读模式收敛
  if (permissionMode === 'read-only') {
    const ro = tools.filter(s => READ_ONLY_WHITELIST.includes(s.name))
    if (ro.length) tools = ro  // 交集为空时保留原集，避免出现"无工具可用"
  }

  const groups = []
  if (skillGroups.length) groups.push(...new Set(skillGroups))
  for (const h of hits.slice(0, MAX_INTENT_GROUPS)) groups.push(h.group)
  const source = activeSkills.length ? 'skill' : (hits.length ? 'intent' : 'core')

  return {
    tools,
    names: new Set(tools.map(t => t.name)),
    groups: [...new Set(groups)],
    source,
    hits: hits.map(h => `${h.group}(${h.score})`),
  }
}

/**
 * 关键词打分：返回按分数降序的分组命中列表
 */
export function scoreIntents(message) {
  if (!message) return []
  const text = String(message)
  const out = []
  for (const rule of INTENT_RULES) {
    const matched = rule.kw.filter(k => text.includes(k))
    if (!matched.length) continue
    // 去重叠加：长词命中后，被其包含的短词不再重复计分
    const uniq = matched.filter(k => !matched.some(o => o !== k && o.includes(k)))
    out.push({ group: rule.group, score: uniq.length, matched: uniq })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * 生成一行「当前工具范围」说明，注入 system prompt 尾部，
 * 让模型知道还有别的工具可用，避免它以为世界只有这么大。
 */
export function describeScope(scope, allCount) {
  const labels = scope.groups.map(g => GROUP_LABELS[g] || g).filter(Boolean)
  const tag = labels.length ? `（当前任务类型：${labels.join('/')}）` : ''
  return `## 工具范围说明${tag}
上面列出的是**与当前任务最相关的 ${scope.tools.length} 个工具**（全部共 ${allCount} 个）。
- 优先使用上面列出的工具。
- 若任务确实需要上面没有的能力，仍可直接按格式调用你需要的工具名，系统会自动补充；不要编造不存在的工具名。`
}
