/**
 * Tool Registry v2 - 工具注册表（稳健版）
 *
 * v2 变化：
 * 1. 工具名模糊匹配：模型拼错工具名时自动纠正（如 red_file -> read_file），
 *    无近似匹配时抛出结构化 TOOL_NOT_FOUND 错误，由引擎回灌给模型自我纠正。
 * 2. 参数 schema 校验：按 JSON-schema 做类型 coerce（字符串->数字/布尔）、
 *    必填检查、默认值填充，减少因类型不对导致的运行时崩溃。
 * 3. setMCPTools / getSchemas / list 等原有能力保持不变。
 */

export class ToolRegistry {
  constructor() {
    this.tools = new Map()
    this._mcpTools = new Map()  // name -> tool (MCP 动态工具)
    this._mcpExecutor = null    // MCP 工具执行器
  }

  /**
   * 注册内置工具
   */
  register(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error('Tool must have name and execute')
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * 设置 MCP 执行器并注册 MCP 工具
   */
  setMCPTools(tools, executor) {
    this._mcpTools = new Map()
    this._mcpExecutor = executor
    for (const t of tools) {
      this._mcpTools.set(t.name, { ...t, mcp: true })
    }
  }

  /**
   * 获取工具 Schema（内置 + MCP）
   */
  getSchemas() {
    const all = [
      ...Array.from(this.tools.values()),
      ...Array.from(this._mcpTools.values()),
    ]
    return all.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
      mcp: !!t.mcp,
    }))
  }

  /**
   * 执行工具。
   * - 名称模糊匹配自动纠正；
   * - 参数按 schema 校验/coerce；
   * - 失败抛出带 code 的 Error（TOOL_NOT_FOUND / VALIDATION），供引擎处理。
   */
  async execute(name, args) {
    let resolved = name
    if (!this.tools.has(name) && !this._mcpTools.has(name)) {
      const guess = this._fuzzyMatch(name)
      if (!guess) {
        const err = new Error(`未知工具: ${name}。可用: ${this.allNames().join(', ')}`)
        err.code = 'TOOL_NOT_FOUND'
        throw err
      }
      resolved = guess // 自动纠正
    }

    let tool, executor
    if (this.tools.has(resolved)) {
      tool = this.tools.get(resolved)
      executor = tool.execute
    } else {
      tool = this._mcpTools.get(resolved)
      executor = (a) => this._mcpExecutor(resolved, a)
    }

    const coerced = this._coerceArgs(tool, args || {})
    return await executor(coerced)
  }

  /**
   * 解析工具名：精确命中返回原名，否则模糊匹配，都不中返回 null。
   * 供引擎在"子集外工具自动扩容"前判定工具是否真实存在。
   */
  resolveName(name) {
    if (!name) return null
    if (this.tools.has(name) || this._mcpTools.has(name)) return name
    return this._fuzzyMatch(name)
  }

  /**
   * 模糊匹配：返回距离最近的已知工具名（阈值内），否则 null。
   * 使用 Levenshtein 距离，阈值随名称长度自适应。
   */
  _fuzzyMatch(name) {
    const candidates = this.allNames()
    if (candidates.length === 0) return null
    let best = null
    let bestDist = Infinity
    for (const c of candidates) {
      const d = levenshtein(name, c)
      if (d < bestDist) { bestDist = d; best = c }
    }
    // 阈值：名称越长允许越多差异；最多 2，且不超过长度的 1/3
    const threshold = Math.min(2, Math.max(1, Math.floor(best.length / 3)))
    return bestDist <= threshold ? best : null
  }

  /**
   * 按 JSON-schema 校验并 coerce 参数。
   * 仅做安全转换，不抛除非必要的错误。
   */
  _coerceArgs(tool, args) {
    const schema = tool.parameters
    if (!schema || !schema.properties) return args
    const props = schema.properties
    const out = { ...args }

    for (const [key, prop] of Object.entries(props)) {
      const type = prop.type
      const val = out[key]

      if (val === undefined || val === null || val === '') {
        if (prop.default !== undefined) {
          out[key] = prop.default
        } else if (Array.isArray(schema.required) && schema.required.includes(key)) {
          const err = new Error(`参数缺失或为空: ${key}（必需）`)
          err.code = 'VALIDATION'
          throw err
        }
        continue
      }

      // 字符串 -> 目标类型
      if (type === 'number' || type === 'integer') {
        if (typeof val === 'string') {
          const n = type === 'integer' ? parseInt(val, 10) : Number(val)
          if (Number.isNaN(n)) {
            const err = new Error(`参数 ${key} 应为数字，收到: ${val}`)
            err.code = 'VALIDATION'
            throw err
          }
          out[key] = n
        }
      } else if (type === 'boolean') {
        if (typeof val === 'string') {
          out[key] = val === 'true' || val === '1' || val === 'yes'
        }
      } else if ((type === 'object' || type === 'array') && typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { out[key] = JSON.parse(trimmed) } catch { /* 保留原字符串 */ }
        }
      }
    }
    return out
  }

  allNames() {
    return [...this.tools.keys(), ...this._mcpTools.keys()]
  }

  /**
   * 获取工具列表（元数据）
   */
  list() {
    const all = [
      ...Array.from(this.tools.values()),
      ...Array.from(this._mcpTools.values()),
    ]
    return all.map(t => ({
      name: t.name,
      description: t.description,
      mcp: !!t.mcp,
    }))
  }
}

/**
 * Levenshtein 距离（用于工具名模糊匹配）
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[m][n]
}
