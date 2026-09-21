/**
 * MCP Client - Model Context Protocol 客户端（真实实现）
 *
 * 支持两种传输：
 * - stdio：spawn 子进程，按 JSON-RPC over stdin/stdout 通信
 * - http / sse：Streamable HTTP（POST JSON-RPC 到 /mcp 端点）
 *
 * 协议流程（Initialize → listTools → callTool）遵循 MCP 规范 2024-11-05 / 2025-03-26。
 * 工具名加前缀 mcp__<server>__<tool> 防止与内置工具冲突。
 */

import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { checkCommandLine } from '../tools/safety-gate.js'

const REQ_TIMEOUT = 30000        // 单次 JSON-RPC 请求超时
const INIT_TIMEOUT = 20000       // 初始化超时
const MAX_STDIO_LINE = 10 * 1024 * 1024

// stdio 传输允许的命令白名单（仅这些可执行程序可被 spawn，降低 RCE 风险）
const ALLOWED_STDIO_COMMANDS = new Set([
  'npx', 'npx.cmd', 'node', 'uvx', 'python', 'python3',
  'bun', 'deno', 'docker', 'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd',
  'yarn', 'yarn.cmd', 'cmd', 'powershell', 'pwsh', 'go',
])

// 允许的绝对路径前缀（受信任的安装目录），命中亦可放行
function allowedBinaryDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dirs = [
    path.join(home, '.miniagent'),
    path.join(home, 'AppData', 'Local', 'Programs'),
    'C:\\Program Files', 'C:\\Program Files (x86)',
  ]
  if (process.env.PATH) {
    for (const p of process.env.PATH.split(path.delimiter)) {
      if (p && !p.includes('..')) dirs.push(p)
    }
  }
  return dirs
}

export class MCPClient {
  /**
   * @param {string} configDir 配置目录
   * @param {string} [baseDir] 工作目录（沙箱根），stdio 子进程 cwd 锁定于此
   */
  constructor(configDir, baseDir) {
    this.configDir = configDir
    this.baseDir = baseDir || null
    this.configFile = path.join(configDir, 'mcp.json')
    this.servers = new Map()     // name -> { name, config, transport, tools, connected, error }
    this.pending = new Map()     // requestId -> {resolve, reject, timer}
  }

  // ── 配置持久化 ─────────────────────────────────────────────

  async init() {
    try {
      const data = await fs.readFile(this.configFile, 'utf-8')
      const config = JSON.parse(data)
      for (const s of config.servers || []) {
        this.servers.set(s.name, {
          name: s.name,
          config: s.config,
          transport: null,
          tools: [],
          connected: false,
          error: null,
        })
      }
    } catch {
      /* 首次运行无配置 */
    }
  }

  async save() {
    await fs.mkdir(this.configDir, { recursive: true })
    await fs.writeFile(this.configFile, JSON.stringify({
      servers: Array.from(this.servers.values()).map(s => ({
        name: s.name,
        config: s.config,
      })),
    }, null, 2))
  }

  // ── 服务器管理 ─────────────────────────────────────────────

  addServer(name, config) {
    if (!name || typeof name !== 'string') throw new Error('服务器名称必填')
    const existing = this.servers.get(name)
    if (existing) this.disconnect(name).catch(() => {})
    this.servers.set(name, { name, config, transport: null, tools: [], connected: false, error: null })
    return this.listServers()
  }

  removeServer(name) {
    this.disconnect(name).catch(() => {})
    this.servers.delete(name)
    return this.listServers()
  }

  listServers() {
    return Array.from(this.servers.values()).map(s => ({
      name: s.name,
      type: s.config.type || 'stdio',
      connected: s.connected,
      error: s.error,
      tools: s.tools.map(t => t.name),
    }))
  }

  // ── 连接 ───────────────────────────────────────────────────

  async connect(name) {
    const server = this.servers.get(name)
    if (!server) throw new Error(`MCP 服务器不存在: ${name}`)

    if (server.connected) return { name, tools: server.tools.length }
    if (server.transport) await this.disconnect(name) // 重建

    try {
      const transport = server.config.type === 'http' || server.config.type === 'sse'
        ? this._createHTTPTransport(server.config)
        : this._createStdioTransport(server.config)

      server.transport = transport
      server.error = null

      // 1. initialize
      const initResult = await this._request(server, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'MiniAgent', version: '2.1.0' },
      }, INIT_TIMEOUT)

      // 2. initialized 通知
      this._notify(server, 'notifications/initialized')

      // 3. listTools
      const toolsResult = await this._request(server, 'tools/list', {})
      const rawTools = toolsResult?.tools || []

      server.tools = rawTools.map(t => ({
        name: `mcp__${name}__${t.name}`,
        originalName: t.name,
        serverName: name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
        mcp: true,
      }))

      server.connected = true
      return { name, tools: server.tools.length, serverInfo: initResult?.serverInfo }
    } catch (err) {
      server.connected = false
      server.error = err.message
      if (server.transport) { try { await server.transport.close() } catch {} }
      server.transport = null
      throw err
    }
  }

  async disconnect(name) {
    const server = this.servers.get(name)
    if (!server) return
    if (server.transport) {
      try { await server.transport.close() } catch {}
    }
    server.transport = null
    server.connected = false
    server.tools = []
  }

  async connectAll() {
    const results = []
    for (const name of this.servers.keys()) {
      try {
        results.push(await this.connect(name))
      } catch (err) {
        results.push({ name, error: err.message })
      }
    }
    return results
  }

  // ── 工具发现与执行 ─────────────────────────────────────────

  getTools() {
    const tools = []
    for (const server of this.servers.values()) {
      if (server.connected) tools.push(...server.tools)
    }
    return tools
  }

  /**
   * 执行 MCP 工具（带 mcp__server__tool 前缀的完整名）
   */
  async callTool(fullName, args = {}) {
    const server = this.servers.get(this._serverNameFromTool(fullName))
    if (!server) throw new Error(`MCP 工具所属服务器未配置: ${fullName}`)
    if (!server.connected) throw new Error(`MCP 服务器 ${server.name} 未连接`)

    const tool = server.tools.find(t => t.name === fullName)
    if (!tool) throw new Error(`MCP 工具不存在: ${fullName}`)

    const result = await this._request(server, 'tools/call', {
      name: tool.originalName,
      arguments: args,
    })

    // MCP 返回 content 数组（text/image 等），拼成文本
    const content = result?.content || []
    const text = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
    const isError = result?.isError === true

    return {
      content: text || JSON.stringify(result).slice(0, 2000),
      isError,
    }
  }

  _serverNameFromTool(fullName) {
    const m = fullName.match(/^mcp__([^_]+(?:_[^_]+)?)__/)
    return m ? m[1] : null
  }

  // ── 传输层：stdio ──────────────────────────────────────────

  _createStdioTransport(config) {
    const { command, args = [], env = {}, cwd } = config
    if (!command) throw new Error('stdio 服务器必须提供 command')

    // ── 安全门 1：命令白名单校验 ──
    // 默认拒绝任意命令；仅放行白名单，或 operator 显式 trustCommand，
    // 或绝对路径落在受信任安装目录内。
    this._validateStdioCommand(command, config)

    // ── 安全门 1b：危险命令黑名单（deny-first，优先级高于 trustCommand）──
    const cli = [command, ...(Array.isArray(args) ? args : [])].join(' ')
    const cmdDeny = checkCommandLine(cli)
    if (cmdDeny) {
      throw new Error(`MCP stdio 命令被安全闸拒绝：${cmdDeny}（危险命令黑名单优先级高于 trustCommand）`)
    }

    // ── 安全门 2：cwd 锁定在沙箱根（baseDir），拒绝逃逸到系统目录 ──
    const safeCwd = this.baseDir || this.configDir
    let lockedCwd = safeCwd
    if (cwd) {
      const resolvedReq = path.resolve(cwd)
      const rel = path.relative(safeCwd, resolvedReq)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        lockedCwd = resolvedReq // 仅当请求 cwd 落在沙箱内才采纳
      }
    }

    const child = spawn(command, args, {
      cwd: lockedCwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    let buffer = ''
    let closed = false

    const transport = {
      child,
      send: (obj) => new Promise((resolve, reject) => {
        if (closed) return reject(new Error('传输已关闭'))
        try {
          child.stdin.write(JSON.stringify(obj) + '\n', resolve)
        } catch (e) {
          reject(e)
        }
      }),
      close: () => new Promise((resolve) => {
        closed = true
        try { child.kill() } catch {}
        setTimeout(resolve, 500)
      }),
      onMessage: null,
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line && transport.onMessage) {
          try { transport.onMessage(JSON.parse(line)) } catch {}
        }
      }
      if (buffer.length > MAX_STDIO_LINE) buffer = '' // 防爆内存
    })

    child.stderr.on('data', (d) => {
      const text = d.toString()
      // 给调试用；MCP 规范允许 stderr 输出日志
      if (process.env.MCP_DEBUG) console.error(`[mcp:${config.command}] ${text}`)
    })

    child.on('exit', (code) => {
      closed = true
      // 通知所有等待中的请求失败
      for (const [, p] of this.pending) p.reject(new Error(`MCP 进程退出 (code ${code})`))
      this.pending.clear()
    })

    return transport
  }

  /**
   * 校验 stdio 命令是否允许被 spawn（安全门）
   * @throws 若命令不在白名单且未显式信任
   */
  _validateStdioCommand(command, config) {
    if (config.trustCommand === true) return  // operator 显式信任，跳过白名单
    const base = path.basename(command).toLowerCase()
    if (ALLOWED_STDIO_COMMANDS.has(base)) return
    // 绝对路径：必须落在受信任安装目录内
    if (path.isAbsolute(command)) {
      const norm = path.resolve(command)
      for (const d of allowedBinaryDirs()) {
        const rel = path.relative(path.resolve(d), norm)
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return
      }
    }
    throw new Error(
      `MCP stdio 命令被拒绝：「${command}」不在白名单。\n` +
      `允许的命令：${[...ALLOWED_STDIO_COMMANDS].join(', ')}。\n` +
      `如需运行其他命令，请在服务器配置中加入 "trustCommand": true（需你明确信任该服务器）。`
    )
  }

  // ── 传输层：HTTP (Streamable HTTP / SSE) ───────────────────

  _createHTTPTransport(config) {
    const { url, headers = {} } = config
    if (!url) throw new Error('http 服务器必须提供 url')

    let sessionId = null
    let closed = false

    return {
      send: async (obj) => {
        const h = { 'Content-Type': 'application/json', ...headers }
        if (sessionId) h['Mcp-Session-Id'] = sessionId
        const res = await fetch(url, {
          method: 'POST',
          headers: h,
          body: JSON.stringify(obj),
          signal: AbortSignal.timeout(REQ_TIMEOUT),
        })
        const sid = res.headers.get('Mcp-Session-Id')
        if (sid) sessionId = sid
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`)
        }
        const body = await res.json().catch(() => null)
        // 直接返回响应消息（含 id 即为响应）
        if (body && transport.onMessage) transport.onMessage(body)
      },
      close: async () => { closed = true },
      onMessage: null,
    }
  }

  // ── JSON-RPC 请求框架 ──────────────────────────────────────

  _notify(server, method, params = {}) {
    if (!server.transport) return
    server.transport.send({
      jsonrpc: '2.0', method, params,
    }).catch(() => {})
  }

  _request(server, method, params = {}, timeout = REQ_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!server.transport) return reject(new Error('传输未建立'))
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer })

      server.transport.onMessage = (msg) => {
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.error) {
            p.reject(new Error(`MCP 错误 [${msg.error.code}]: ${msg.error.message}`))
          } else {
            p.resolve(msg.result)
          }
        }
      }

      server.transport.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        if (this.pending.has(id)) {
          const p = this.pending.get(id)
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.reject(e)
        }
      })
    })
  }
}
