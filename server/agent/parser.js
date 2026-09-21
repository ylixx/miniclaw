/**
 * Response Parser v2 - 小模型响应解析器（稳健版）
 *
 * 设计目标：让 4B 级小模型稳定输出可解析的工具调用。
 *
 * 关键改进（相对 v1）：
 * 1. 用「平衡括号扫描」定位 JSON 对象，取代贪婪正则 —— 不再误吞正文。
 * 2. 修复策略只做「安全」操作（去尾逗号、补键引号），
 *    彻底移除 v1 的全局 `'` -> `"` 替换（它会把合法字符串里的撇号/引号改坏）。
 * 3. 解析失败只返回 null，绝不静默篡改参数内容。
 * 4. 暴露 buildToolFormatHint()，供引擎在纠错时回灌「正确格式 + 示例」。
 */

/**
 * 解析模型响应
 * @returns {{ type: 'text', text: string }
 *         | { type: 'tool_call', call: { name, arguments } }
 *         | { type: 'error', error: string }}
 */
export function parseResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    return { type: 'text', text: raw || '' }
  }

  const text = raw.trim()

  // 1. 尝试从文本中提取工具调用 JSON（平衡括号扫描，安全）
  const toolCall = extractToolCall(text)
  if (toolCall) {
    return { type: 'tool_call', call: toolCall }
  }

  // 2. XML / Hermes 兜底：4B 模型常把 JSON 括号写崩，但 XML 标签极少写错
  const xmlCall = extractXmlToolCall(text)
  if (xmlCall) {
    return { type: 'tool_call', call: xmlCall }
  }

  // 3. 纯文本回复
  return { type: 'text', text: cleanText(text) }
}

/**
 * 从文本中提取工具调用对象。
 * 支持：
 *  - ```json / ```tool_call 代码块
 *  - 直接 {"tool": "...", "arguments": {...}}
 *  - {"name": "...", "arguments": {...}} 简化格式
 *  - {"function": {"name": "...", "arguments": "..."}} OpenAI function_call 格式
 */
function extractToolCall(text) {
  // 模式1: 代码块（去掉围栏再扫）
  const fence = text.match(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/i)
  const searchIn = fence ? fence[1] : text

  // 平衡括号扫描，找到第一个可解析且形如工具调用的 JSON 对象
  const obj = extractFirstToolObject(searchIn)
  if (obj) {
    const normalized = normalizeCall(obj)
    if (normalized) return normalized
  }
  return null
}

/**
 * 扫描文本，返回第一个「结构平衡」且解析为工具调用形态的 JSON 对象。
 * 不依赖贪婪正则，字符串内的括号/引号被正确跳过。
 */
function extractFirstToolObject(src) {
  const start = src.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inStr = false
  let esc = false

  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = src.slice(start, i + 1)
        const parsed = tryParseJson(candidate)
        if (parsed && (parsed.tool || parsed.name || parsed.function)) {
          return parsed
        }
        // 这个对象不是工具调用，继续往后找（depth 回到 0 后 start 失效，
        // 但工具调用通常在最外层，找到第一个平衡对象即可，这里直接返回 null 避免误吞）
        return null
      }
    }
  }
  // 扫描结束仍 depth>0：最外层对象被截断（4B 模型常见 max_tokens 截断）。
  // 尝试修复后再解析一次，避免整条工具调用丢失。
  if (depth > 0) {
    const candidate = src.slice(start)
    const parsed = tryParseJson(candidate)
    if (parsed && (parsed.tool || parsed.name || parsed.function)) return parsed
  }
  return null
}

/**
 * 尝试解析 JSON，仅做「安全」修复：
 *  - 去掉尾逗号
 *  - 为无引号的简单键补双引号
 *  - 为单引号的键补双引号
 * 绝不替换字符串值内的引号/撇号。
 */
function tryParseJson(text) {
  // 直接尝试
  try { return JSON.parse(text) } catch { /* 继续 */ }

  let s = text.trim()
  // 去掉尾逗号（安全）
  s = s.replace(/,(\s*[}\]])/g, '$1')
  // 无引号键 -> 双引号（仅简单标识符）
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
  // 单引号键 -> 双引号
  s = s.replace(/([{,]\s*)'([A-Za-z_$][\w$]*)'(\s*:)/g, '$1"$2"$3')

  try { return JSON.parse(s) } catch { /* 失败，进入修复 */ }

  // 最后一搏：括号/引号补全修复（针对截断输出），修复后仍失败才放弃
  const repaired = repairJson(s)
  if (repaired !== s) {
    try { return JSON.parse(repaired) } catch { /* 修复后依旧无效 */ }
  }
  return null
}

/**
 * 轻量 JSON 修复（json-repair 思路的精简版，专为小模型「截断 / 括号崩坏」输出设计）。
 *
 * 仅做「安全」补全，不改动已解析出的字符串值内容：
 *  1. 扫描时跳过字符串与转义，统计未闭合的 { } [ ] ( ) 与未闭合引号；
 *  2. 末尾若仍处字符串内，先补上未闭合引号；
 *  3. 再按后进先出顺序补齐未闭合的右括号；
 *  4. 清理尾随的无效片段（尾逗号、悬空的 "key":）。
 * 返回修复后的字符串；调用方需自行 JSON.parse 验证。
 */
function repairJson(text) {
  let s = text.trim()
  if (!s) return s

  const open = { '{': '}', '[': ']', '(': ')' }
  const close = { '}': '{', ']': '[', ')': '(' }
  const stack = []
  let inStr = false
  let esc = false

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (open[c]) stack.push(c)
    else if (close[c]) {
      // 与栈顶匹配才弹出，不匹配的闭合括号直接忽略（容错）
      if (stack.length && stack[stack.length - 1] === close[c]) stack.pop()
    }
  }

  // 1. 仍有未闭合字符串 -> 先补引号
  if (inStr) s += '"'
  // 2. 按顺序补齐未闭合右括号
  while (stack.length) {
    const o = stack.pop()
    s += open[o]
  }
  // 3. 清理尾随无效片段
  s = s.replace(/,(\s*[}\]])/g, '$1')          // 尾逗号
  s = s.replace(/(?:,\s*)?"[^"]*"\s*:\s*$/, '') // 悬空的 ,"key": 或 "key":
  return s
}

/**
 * 标准化工具调用格式为 { name, arguments }
 */
function normalizeCall(parsed) {
  if (parsed.tool) {
    return {
      name: parsed.tool,
      arguments: parsed.arguments || parsed.args || parsed.params || {},
    }
  }
  if (parsed.function?.name) {
    let args = parsed.function.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { args = {} }
    }
    return { name: parsed.function.name, arguments: args || {} }
  }
  if (parsed.name) {
    // 兼容 Hermes 风格 { name, parameters } 与 { name, arguments }
    return { name: parsed.name, arguments: parsed.arguments ?? parsed.parameters ?? {} }
  }
  return null
}

/**
 * XML / Hermes 格式工具调用兜底解析。
 * 支持：
 *  - Hermes：<|function_call|>{"name":"x","parameters":{...}}<|/function_call|>
 *  - XML：<function=name> <parameter=key>val</parameter> ... </function>
 *  - XML：<function name="x"> <arg name="k">v</arg> ... </function>
 */
function extractXmlToolCall(text) {
  // Hermes 风格：标签内是 JSON
  const hermes = text.match(/<\|function_call[s]?\|>\s*([\s\S]*?)(?:<\/\|function_call[s]?\|>|$)/i)
  if (hermes) {
    const parsed = tryParseJson(hermes[1].trim())
    if (parsed && (parsed.name || parsed.tool)) {
      const norm = normalizeCall(parsed)
      if (norm) return norm
    }
  }

  // 纯 XML：<function=name> ... </function>
  const xml = text.match(/<function\s*=?\s*([\w.-]+)\s*>([\s\S]*?)<\/function>/i)
    || text.match(/<function\s+name\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/function>/i)
  if (xml) {
    const name = xml[1]
    const body = xml[2]
    const args = {}
    const paramRe = /<parameter\s*=?\s*([\w.-]+)\s*>([\s\S]*?)<\/parameter>/gi
    let m
    while ((m = paramRe.exec(body))) args[m[1]] = m[2].trim()
    const argRe = /<arg\s+name\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/arg>/gi
    while ((m = argRe.exec(body))) args[m[1]] = m[2].trim()
    if (name) return { name, arguments: args }
  }
  return null
}

/**
 * 清理文本（去掉 markdown 包裹等）
 */
function cleanText(text) {
  return text
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/```$/gm, '')
    .trim()
}

/**
 * 构建「工具调用格式提示」用于纠错回灌。
 * 给出一个正确格式示例 + 当前可用工具名清单，帮助小模型二次成功。
 * @param {Array} schemas 工具 schema 列表（来自 ToolRegistry.getSchemas()）
 */
export function buildToolFormatHint(schemas = []) {
  const names = schemas.map(s => s.name)
  const exampleName = names[0] || 'read_file'
  const hint = [
    '请严格使用以下 JSON 格式调用工具（不要使用自然语言或 markdown 以外的内容）：',
    '```json',
    JSON.stringify({ tool: exampleName, arguments: {} }, null, 2),
    '```',
    `可用工具：${names.join(', ') || '（无）'}`,
    '若无需调用工具，直接用自然语言回复。',
  ].join('\n')
  return hint
}
