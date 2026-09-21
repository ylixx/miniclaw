/**
 * Prompt Builder - 专为小模型优化的提示词构建器
 *
 * v2 变化：
 * 1. 注入工作目录信息（模型需要知道当前在哪操作）
 * 2. 注入激活技能的指令（Skills 真正生效）
 * 3. 注入 MCP 工具（自动合并进工具列表）
 * 4. 工具结果裁剪上限从 2000 → 1500 字符，进一步省 token
 */

/**
 * 构建消息数组
 */
export function buildPrompt({ history, tools, skills, config, workDir, skillContext, plan, selfVerifyHint }) {
  const messages = []

  // 1. 系统提示词
  const systemPrompt = buildSystemPrompt(tools, skills, config, workDir, skillContext, plan, selfVerifyHint)
  messages.push({ role: 'system', content: systemPrompt })

  // 2. 对话历史（已裁剪，保序）
  for (const msg of history) {
    if (msg.role === 'system') continue // system 指令统一收口在顶部，避免重复
    messages.push(msg)
  }

  return messages
}

/**
 * 构建系统提示词
 */
function buildSystemPrompt(tools, skills, config, workDir, skillContext, plan, selfVerifyHint) {
  const parts = []

  // 角色定义
  parts.push('你是一个本地办公助手，帮助用户处理文件和日常任务。')

  // 工作目录（让模型知道操作范围）
  if (workDir) {
    parts.push(`## 工作目录\n当前工作目录是「${workDir}」。所有文件路径都相对此目录。若需操作其他项目，先用 list_files 确认。`)
  }

  // 执行计划（规划前置：模型按步骤推进，提升多步任务稳定性）
  if (plan) {
    parts.push(`## 执行计划\n${plan}\n请严格按步骤逐步执行，每完成一步再继续，不要跳步。`)
  }

  // 工具列表（完整 schema 注入，含 MCP 工具）
  if (tools && tools.length > 0) {
    const toolDesc = tools.map(t => describeTool(t)).join('\n\n')
    parts.push(`## 可用工具\n${toolDesc}`)
  }

  // 输出格式（严格要求）
  parts.push(`## 输出规则
- 要调用工具，只输出一个 JSON 代码块（不要包裹多余文字）：
\`\`\`json
{"tool":"工具名","arguments":{"参数1":"值1","参数2":"值2"}}
\`\`\`
- 不调用工具时，直接用自然语言回复，不要输出 JSON。
- 一次只调一个工具，不要并行调用多个。
- 调用前先用 list_files / read_file 确认文件存在，避免路径错误。
- 不要重复调用相同工具做相同的事。`)

  // 激活技能指令（真正生效的关键：完整的步骤化指令注入）
  if (skillContext) {
    parts.push(skillContext)
  } else if (skills && skills.length > 0) {
    parts.push(`## 技能\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`)
  }

  // 只读模式提示：明确约束模型只调用查询类工具（权限模式开关的一部分）
  if (config && config.permissionMode === 'read-only') {
    parts.push(`## 权限限制
当前处于 read-only（只读）模式：你只能调用读取/查询类工具（如 list_files、read_file、file_info、search_files），严禁调用任何写文件、删除、移动、复制或执行命令的工具。若用户要求修改，请明确告知其当前为只读模式，无法执行写操作。`)
  }

  // 自我校验提醒（工具出错时注入，要求模型复核而非硬闯）
  if (selfVerifyHint) {
    parts.push(`## 自我校验提醒\n${selfVerifyHint}`)
  }

  return parts.join('\n\n')
}

/**
 * 把单个工具 schema 渲染为可读文本（完整参数 + 类型 + 必填/可选）
 */
function describeTool(t) {
  const mcpTag = t.mcp ? ' [MCP]' : ''
  const lines = [`- ${t.name}${mcpTag}: ${t.description || ''}`]
  const props = t.parameters?.properties || {}
  const required = t.parameters?.required || []
  const keys = Object.keys(props)
  if (keys.length) {
    lines.push('  参数:')
    for (const k of keys) {
      const p = props[k]
      const req = required.includes(k) ? '必需' : '可选'
      const def = p.default !== undefined ? `，默认 ${JSON.stringify(p.default)}` : ''
      lines.push(`    - ${k} (${p.type || 'any'}, ${req}${def}): ${p.description || ''}`)
    }
  } else {
    lines.push('  参数: 无')
  }
  return lines.join('\n')
}

/**
 * 构建工具结果消息
 */
export function buildToolResult(result) {
  if (result === null || result === undefined) return '执行成功，无返回结果'
  if (typeof result === 'string') return result.slice(0, 1500)
  try {
    return JSON.stringify(result).slice(0, 1500)
  } catch {
    return String(result).slice(0, 1500)
  }
}
