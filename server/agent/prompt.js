/**
 * Prompt Builder - 专为小模型优化的提示词构建器
 *
 * v2 变化：
 * 1. 注入工作目录信息（模型需要知道当前在哪操作）
 * 2. 注入激活技能的指令（Skills 真正生效）
 * 3. 注入 MCP 工具（自动合并进工具列表）
 * 4. 工具结果裁剪上限从 2000 → 1500 字符，进一步省 token
 */

import { describeScope } from './tool-router.js'

/**
 * 构建消息数组
 */
export function buildPrompt({ history, tools, skills, config, workDir, skillContext, plan, selfVerifyHint, toolScope }) {
  const messages = []

  // 1. 系统提示词
  const systemPrompt = buildSystemPrompt(tools, skills, config, workDir, skillContext, plan, selfVerifyHint, toolScope)
  messages.push({ role: 'system', content: systemPrompt })

  // 2. 对话历史（已裁剪，保序）。
  //    历史中的 system 消息是引擎运行中注入的动态反馈（[格式错误] 纠错回灌、
  //    [进度提示] 等），必须透传给模型——此前这里一刀切过滤，导致纠错机制整个失效
  //    （模型看不到错误详情和格式示例，只会盲目重试）。
  //    顶层 system prompt 仍由 buildSystemPrompt 统一构建，与此互不冲突。
  for (const msg of history) {
    messages.push(msg)
  }

  return messages
}

/**
 * 构建系统提示词
 */
function buildSystemPrompt(tools, skills, config, workDir, skillContext, plan, selfVerifyHint, toolScope) {
  const parts = []

  // 角色定义
  parts.push('你是一个本地办公助手，帮助用户处理文件和日常任务。')

  // 工作目录（让模型知道操作范围）
  if (workDir) {
    parts.push(`## 工作目录\n当前工作目录是「${workDir}」。所有文件路径都相对此目录。若需操作其他项目，先用 list_files 确认。`)
  }

  // 行为边界（防过度自主：一句问候不该引发命令狂奔）
  parts.push(`## 行为边界（避免过度自主）
- 当用户只是打招呼、闲聊、寒暄（如「你好」「在吗」「你是谁」），或纯粹表达情绪时，直接用自然语言友好回复，**不要调用任何工具**：不要去检查服务状态、不要启动/重启服务、不要执行任何命令、不要主动「验证环境健康」、不要跑测试或蜂群任务。
- 只有当用户提出明确的、与文件 / 命令执行 / 代码 / 数据 / 查询相关的**具体任务**时，才调用对应工具。
- 用户没有明确要求时，不要主动探测健康、检查连接、启动服务。先确认需求再动手。
- 能用一句话回答的，就不要动工具。调用工具前先想清楚是否真的需要。`)

  // 执行计划（规划前置：模型按步骤推进，提升多步任务稳定性）
  if (plan) {
    parts.push(`## 执行计划\n${plan}\n请严格按步骤逐步执行，每完成一步再继续，不要跳步。`)
  }

  // 工具列表（动态子集注入：只给当前任务相关的工具，省 token + 降选择过载）
  if (tools && tools.length > 0) {
    const toolDesc = tools.map(t => describeTool(t)).join('\n\n')
    parts.push(`## 可用工具\n${toolDesc}`)
    if (toolScope) parts.push(describeScope(toolScope, toolScope.allCount))
  }

  // 输出格式（严格要求）
  parts.push(`## 执行命令（运行/编译程序）
- 当用户要求「运行 / 编译 / 执行某个文件或命令」时，使用 run_command 工具，不要只给文字说明。
- 编译并运行 C++ 示例：\`g++ hello.cpp -o hello && hello\`（Windows 上运行生成的可执行文件直接用程序名 \`hello\`，会自动找 \`hello.exe\`，不要写 \`./hello\`）。
- 运行脚本示例：\`python app.py\`、\`node app.js\`。
- run_command 返回 stdout / stderr / exitCode；若 exitCode 非 0，先读 stderr 判断原因（如编译错误）再修正重试。
- 危险命令（rm -rf /、curl|sh、sudo、git reset --hard 等）会被安全闸拒绝，不要尝试。

## 输出规则
- 要调用工具，只输出一个 JSON 代码块（不要包裹多余文字）：
\`\`\`json
{"tool":"工具名","arguments":{"参数1":"值1","参数2":"值2"}}
\`\`\`
- 不调用工具时，直接用自然语言回复，不要输出 JSON。
- 回复中出现任何代码（源码、命令、文件路径、配置、示例）时，必须且只用 \`\`\` 围栏代码块包裹，并标注语言（如 \`\`\`python、\`\`\`bash、\`\`\`cpp），不要用行内反引号包裹整段代码，以便前端渲染代码块并提供一键复制。
- 换行请用真实换行符，不要使用 HTML 的 <br> 标签。
- 一次只调一个工具，不要并行调用多个。
- 调用前先用 list_files / read_file 确认文件存在，避免路径错误。
- 不要重复调用相同工具做相同的事。`)

  // 激活技能指令（真正生效的关键：完整的步骤化指令注入）
  if (skillContext) {
    parts.push(skillContext)
  } else if (skills && skills.length > 0) {
    parts.push(`## 技能\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`)
  }

  // Windows 命令行注意事项（项目仅运行在 Windows 上）
  if (process.platform === 'win32') {
    parts.push(`## Windows 命令行注意事项
- 本服务运行在 Windows 上，run_command 的命令经 cmd.exe 执行。
- 终止进程**不要**用 kill（Windows 没有该命令）。正确做法：\`taskkill /PID <pid> /F /T\`（/T 杀进程树），或用 PowerShell：\`powershell -Command "Stop-Process -Id <pid> -Force"\`。
- 等待延时**不要**用 sleep，用：\`timeout /t 3 /nobreak\`。
- 文本查找用 findstr（不是 grep），例如 \`netstat -ano | findstr :3000\`。
- curl 可用（Windows 10+ 自带 curl.exe）；若提示找不到 curl，改写 curl.exe。
- 不要用 Linux 的 rm / ls / chmod / cat，改用 del / dir 等；列目录用 \`dir\`。
- 运行生成的可执行文件直接用程序名（如 \`hello\`），不要写 \`./hello\`。
- 一次命令里若需多条语句，用 \`&&\` 或 \`&\` 连接，不要依赖 Linux 的分号行为歧义。`)
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
 * @param {*} result 工具原始返回值
 * @param {string} [toolName] 工具名，用于区分读类工具（放宽截断、直接吐正文）
 *
 * 修复 P1-9：此前对所有结果一刀切 JSON.stringify 后 slice(0,1500)，而 read_file
 * 等读类工具返回 {content,totalLines,truncated}，导致模型只能看到约 1400 字符且是
 * JSON 字符串的中段截断（引号不闭合）。读类工具是办公 Agent 的核心场景，这里直接
 * 吐出正文（放宽到 5000），其余工具保持紧凑上限省 token。
 */
const RESULT_LIMIT = 1500
const RESULT_LIMIT_READ = 5000
const READ_TOOL_RE = /^read_/i

export function buildToolResult(result, toolName = '') {
  if (result === null || result === undefined) return '执行成功，无返回结果'
  if (typeof result === 'string') return result.slice(0, RESULT_LIMIT_READ)
  // 读类工具：直接吐正文，避免 JSON 包裹导致中段截断、引号不闭合
  if (toolName && READ_TOOL_RE.test(toolName) && result && typeof result.content === 'string') {
    const c = result.content
    if (c.length <= RESULT_LIMIT_READ) return c
    return `${c.slice(0, RESULT_LIMIT_READ)}\n…（结果过长已截断，共 ${c.length} 字符；可用 offset/limit 分段读取）`
  }
  try {
    const s = JSON.stringify(result)
    if (s.length <= RESULT_LIMIT) return s
    return `${s.slice(0, RESULT_LIMIT)}\n…（结果过长已截断，共 ${s.length} 字符）`
  } catch {
    return String(result).slice(0, RESULT_LIMIT)
  }
}
