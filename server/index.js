/**
 * MiniAgent Server v2.1 - 主服务入口
 *
 * 新增：
 * - 项目管理 API（CRUD）
 * - 任务管理 API（创建/切换/重命名/删除 + 历史查看）
 * - MCP 服务器管理 API（添加/连接/断开/删除/调用）
 * - Skills API（激活带参数/停用/自定义技能）
 */

import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import { AgentEngine } from './agent/engine.js'
import { ToolRegistry } from './tools/registry.js'
import { registerFileOps } from './tools/file-ops.js'
import { registerDocOps } from './tools/doc-ops.js'
import { registerPptxOps } from './tools/pptx-ops.js'
import { registerDocxOps } from './tools/docx-ops.js'
import { registerXlsxOps } from './tools/xlsx-ops.js'
import { registerPdfOps } from './tools/pdf-ops.js'
import { registerShell } from './tools/shell.js'
import { registerScriptOps } from './tools/script-ops.js'
import { MCPClient } from './mcp/client.js'
import { SkillsManager } from './skills/loader.js'
import { installSkillFromZip } from './skills/install.js'
import { ModelManager } from './models/manager.js'
import { WorkspaceManager } from './workspace/manager.js'
import { analyzeImage, generateImage } from './agnes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const BASE_DIR = process.env.WORK_DIR || process.cwd()
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE, '.miniagent')

// ── 初始化组件 ──────────────────────────────────────────────────

// 动态工作目录：取当前激活项目目录，无激活项目时回退到 BASE_DIR
function getBaseDir() {
  try {
    return (workspace && typeof workspace.getActiveDir === 'function' && workspace.getActiveDir()) || BASE_DIR
  } catch {
    return BASE_DIR
  }
}

function getPermissionMode() {
  try {
    return (workspace && typeof workspace.getPermissionMode === 'function' && workspace.getPermissionMode()) || 'guarded'
  } catch {
    return 'guarded'
  }
}

const tools = new ToolRegistry()

// 注册内置工具（文件/文档/Office 等）。
// 关键：这些 register* 调用必须执行，否则 ToolRegistry 为空——
// 全部工具（含 docx/xlsx/pptx/pdf 等 Office 文档操作）都不会注入给模型，界面里"用不了"。
registerFileOps(tools, { getBaseDir, getPermissionMode })
registerDocOps(tools, { getBaseDir })
registerPptxOps(tools, { getBaseDir })
registerDocxOps(tools, { getBaseDir })
registerXlsxOps(tools, { getBaseDir })
registerPdfOps(tools, { getBaseDir })
// 命令类：run_command（单条命令）与 run_script（多行脚本），两者都受 safety-gate 管控。
// 注意：这两个 register 若漏调，命令能力会整体消失（此前回归过一次）。
registerShell(tools, { getBaseDir, getPermissionMode })
registerScriptOps(tools, { getBaseDir, getPermissionMode })
const mcp = new MCPClient(CONFIG_DIR)
const skills = new SkillsManager(CONFIG_DIR)
const modelManager = new ModelManager(CONFIG_DIR)
const workspace = new WorkspaceManager(BASE_DIR, CONFIG_DIR)
const clients = new Set() // 活跃 WebSocket 连接，用于事件广播
let engine = null

function rebuildEngine() {
  engine = new AgentEngine({ tools, mcpClient: mcp, skills, config: getModelConfig(), workspace })
  // 每次重建引擎（引擎对象会被替换）后重新挂载事件广播
  engine.onEvent = (event, data) => {
    const msg = JSON.stringify({ event, data })
    for (const c of clients) {
      try { c.send(msg) } catch {}
    }
  }
}

// MCP 工具同步到注册表
async function syncMCPTools() {
  const mcpTools = mcp.getTools()
  tools.setMCPTools(mcpTools, (name, args) => mcp.callTool(name, args))
}

// ── Express 应用 ────────────────────────────────────────────────

const app = express()
app.use(cors())
// 体积上限放宽到 32mb，以容纳本地图片经 base64 内联上传（图像分析/图生图场景）
app.use(express.json({ limit: '32mb' }))
// 前端为开发期静态资源，强制 no-store，避免浏览器缓存旧 app.js/styles.css 导致 UI 改动不生效
app.use(express.static(path.join(__dirname, '../web'), {
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  },
}))

// ── 技能包（zip）一键安装 ────────────────────────────────
// 接收 zip 原始字节，解包→识别 SKILL.md/JSON→写入 skills 目录→热重载
app.post('/api/skills/install', express.raw({ type: 'application/zip', limit: '15mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: '缺少 zip 数据' })
    }
    const result = await installSkillFromZip(req.body, skills)
    res.json({ ok: true, skill: result })
  } catch (err) {
    res.status(400).json({ error: err.message || '安装失败' })
  }
})

// ── 对话 API ───────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, taskId, image, hasImage } = req.body
  // 允许「只发图不写文字」：图片分析场景下 message 可为空，仅当两者皆空才拦截
  if (!message && !hasImage) return res.status(400).json({ error: 'message required' })
  try {
    // 若指定 taskId 且与当前不同，先切换
    if (taskId && taskId !== engine.getState().taskId) {
      await workspace.setActiveTask(taskId)
      await engine.bindTask(taskId)
    } else if (!taskId && !engine.getState().taskId) {
      // 未绑定任务时自动创建一个
      const active = workspace.getActiveTask()
      if (active) {
        await engine.bindTask(active.id)
      }
    }
    
    // 如果有图片，先进行图像分析
    let imageAnalysis = null
    if (image && hasImage) {
      try {
        // 视觉分析统一走 Agnes 多模态服务：baseURL/apiKey 取当前激活模型，
        // 模型名默认 agnes-2.5-flash（视觉端点）。注意 analyzeImage 需要一个
        // 配置对象，而不是 (image, message) 两个位置参数——之前这里签名写错，
        // 导致 baseURL/apiKey 全丢、图片根本没送进模型。
        const cfg = resolveAgnesConfig({}, { model: 'agnes-2.5-flash' })
        imageAnalysis = await analyzeImage({
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model || 'agnes-2.5-flash',
          image,
          prompt: message || '请描述这张图片的内容。',
          maxTokens: 1024,
          temperature: 0.4,
        })
        console.log('图像分析完成:', imageAnalysis?.text)
      } catch (err) {
        console.error('图像分析失败:', err)
        // 把失败原因透传给前端，避免"传了图却得到无关纯文本回答"的困惑
        imageAnalysis = { text: '', error: err.message }
      }
    }
    
    // 构建增强的消息：仅当视觉分析成功且有文本时才注入结果。
    // 若分析失败（imageAnalysis.error 存在），不注入——避免模型拿空结果瞎答。
    let enhancedMessage = message
    if (imageAnalysis && imageAnalysis.text) {
      enhancedMessage = `${message}\n\n[图像分析结果] ${imageAnalysis.text}`
    }

    const result = await engine.handleMessage(enhancedMessage)
    // 把视觉分析的失败原因回传给前端，便于明确提示，不再静默吞掉
    if (imageAnalysis && imageAnalysis.error) {
      result.imageAnalysisError = imageAnalysis.error
    }
    res.json(result)
  } catch (err) {
    // 错误分类：区分网络/端点不可达、超时、模型 API 错误，给出可读提示
    const code = err.code || (err.cause && err.cause.code) || ''
    const msg = (err.message || '').toLowerCase()
    const isNet = /fetch failed|econnrefused|enotfound|etimedout|err_ssl|ssl|certificate|getaddrinfo|network/i.test(msg + ' ' + code)
    if (err.code === 'MODEL_TIMEOUT') {
      res.status(504).json({ error: `模型响应超时：${err.message}（建议：检查 baseURL/网络，或切换本地模型）` })
    } else if (isNet) {
      res.status(502).json({ error: `模型端点不可达：${err.message}（请检查 baseURL、网络连通性、API Key 是否有效）` })
    } else if (msg.includes('model api error')) {
      res.status(502).json({ error: err.message })
    } else {
      res.status(500).json({ error: err.message })
    }
  }
})

// ── 状态 API ───────────────────────────────────────────────────

// 轻量健康探活（供 agent/监控用 curl http://localhost:3000/health）
// 与 /api/status 区别：前者只返回是否存活，后者返回完整状态。
function healthPayload() {
  return {
    ok: true,
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString(),
    tools: tools.list().length,
    mcpServers: mcp.listServers().length,
  }
}
app.get('/health', (req, res) => res.json(healthPayload()))
app.get('/api/health', (req, res) => res.json(healthPayload()))

app.get('/api/status', (req, res) => {
  const active = modelManager.getActive()
  const activeTask = workspace.getActiveTask()
  res.json({
    ...engine.getState(),
    tools: tools.list(),
    skills: skills.list(),
    model: active ? { name: active.name, model: active.model, provider: active.provider } : null,
    activeTaskId: workspace.activeTaskId,
    activeTaskTitle: activeTask?.title || null,
    projects: workspace.listProjects(),
  })
})

// ── 项目管理 API ───────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  res.json(workspace.listProjects())
})

app.post('/api/projects', async (req, res) => {
  try {
    const project = await workspace.createProject(req.body)
    res.json({ success: true, project })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.put('/api/projects/:id', async (req, res) => {
  try {
    const project = await workspace.updateProject(req.params.id, req.body)
    res.json({ success: true, project })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await workspace.deleteProject(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── 任务管理 API ──────────────────────────────────────────────

app.get('/api/projects/:id/tasks', async (req, res) => {
  try {
    const tasks = await workspace.listTasks(req.params.id)
    res.json(tasks)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/projects/:id/tasks', async (req, res) => {
  try {
    const task = await workspace.createTask(req.params.id, req.body)
    res.json({ success: true, task })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 激活/切换任务：设置激活态 + 绑定引擎历史 + 返回该任务对话历史
app.post('/api/tasks/:id/activate', async (req, res) => {
  try {
    await workspace.setActiveTask(req.params.id)
    await engine.bindTask(req.params.id)
    const found = workspace.findTask(req.params.id)
    if (!found) return res.status(404).json({ error: '任务不存在' })
    res.json({
      success: true,
      task: { ...found.task, messages: undefined },
      messages: found.task.messages || [],
      project: { id: found.project.id, name: found.project.name, dir: found.project.dir },
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 获取任务详情（含历史）
app.get('/api/tasks/:id', (req, res) => {
  const found = workspace.findTask(req.params.id)
  if (!found) return res.status(404).json({ error: '任务不存在' })
  res.json({
    task: { ...found.task, messages: undefined },
    messages: found.task.messages || [],
    project: { id: found.project.id, name: found.project.name, dir: found.project.dir },
  })
})

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const task = await workspace.updateTask(req.params.id, req.body)
    res.json({ success: true, task })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await workspace.deleteTask(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/tasks/:id/history', async (req, res) => {
  try {
    const history = await workspace.getTaskHistory(req.params.id)
    res.json(history)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── 模型管理 API ───────────────────────────────────────────────

function getModelConfig() {
  const active = modelManager.getActive()
  if (!active) return {}
  return {
    baseURL: active.baseURL,
    apiKey: active.apiKey,
    model: active.model,
    maxTokens: active.maxTokens || 2048,
    contextLength: active.contextLength || 32768,
    temperature: active.temperature || 0.3,
  }
}

app.get('/api/models', (req, res) => {
  res.json(modelManager.list())
})

app.post('/api/models', async (req, res) => {
  try {
    const model = await modelManager.add(req.body)
    rebuildEngine()
    res.json({ success: true, model })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.put('/api/models/:id', async (req, res) => {
  try {
    const model = await modelManager.update(req.params.id, req.body)
    rebuildEngine()
    res.json({ success: true, model })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/models/:id', async (req, res) => {
  try {
    await modelManager.remove(req.params.id)
    rebuildEngine()
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/models/:id/activate', async (req, res) => {
  try {
    await modelManager.setActive(req.params.id)
    rebuildEngine()
    // 恢复当前任务绑定
    const activeTask = workspace.getActiveTask()
    if (activeTask) await engine.bindTask(activeTask.id)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/models/test', async (req, res) => {
  const result = await modelManager.testConnection(req.body)
  res.json(result)
})

app.post('/api/models/fetch', async (req, res) => {
  const { baseURL, apiKey } = req.body
  if (!baseURL) return res.status(400).json({ error: 'baseURL required' })
  const result = await modelManager.fetchModels(baseURL, apiKey)
  res.json(result)
})

// ── Agnes 多模态 API ──────────────────────────────────────
// 图像分析与图像生成复用"已配置的 Agnes 模型"的 baseURL / API Key；
// 请求体也可携带 baseURL / apiKey / model 覆盖（便于临时切换节点或模型）。

/**
 * 解析 Agnes 配置：优先用请求体覆盖，否则回退到当前激活模型。
 * @param {object} body
 * @param {object} [fallback] 额外默认（如图像生成的默认模型名）
 */
function resolveAgnesConfig(body = {}, fallback = {}) {
  const active = modelManager.getActive() || {}

  const cfg = {
    baseURL: body.baseURL || active.baseURL || '',
    apiKey: body.apiKey || active.apiKey || '***',
    model: body.model || fallback.model || active.model || '',
  }
  if (!cfg.baseURL) {
    throw new Error('未配置 Agnes 模型：请先在「🧠 模型」中添加 Agnes（apihub.agnes-ai.cn）并填入 API Key，或在请求中提供 baseURL / apiKey。')
  }
  return cfg
}

// 图像分析（视觉理解）：agnes-2.5-flash 多模态 chat，返回文本
app.post('/api/vision/analyze', async (req, res) => {
  const { image, prompt, system, maxTokens, temperature, model } = req.body || {}
  if (!image) return res.status(400).json({ error: 'image 必填（URL / dataURI / {data,mime}）' })
  try {
    const cfg = resolveAgnesConfig(req.body, { model: 'agnes-2.5-flash' })
    const result = await analyzeImage({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: model || cfg.model || 'agnes-2.5-flash',
      image,
      prompt,
      system,
      maxTokens: maxTokens ? Number(maxTokens) : 1024,
      temperature: temperature != null ? Number(temperature) : 0.4,
    })
    res.json({ success: true, ...result })
  } catch (err) {
    const msg = (err.message || '').toLowerCase()
    if (msg.includes('unauthorized') || msg.includes('invalid api key')) {
      res.status(401).json({ error: `Agnes API 认证失败：${err.message}（请检查 API Key 是否正确）` })
    } else if (msg.includes('rate limit') || msg.includes('too many requests')) {
      res.status(429).json({ error: `Agnes API 限流：${err.message}（请稍后重试）` })
    } else {
      res.status(500).json({ error: err.message })
    }
  }
})

// 图像生成（文生图/图生图）：agnes-image-2.5-flash，返回图片 URL 或 base64
app.post('/api/image/generate', async (req, res) => {
  const { prompt, image, size, ratio, returnBase64, model } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt 必填' })
  try {
    const cfg = resolveAgnesConfig(req.body, { model: 'agnes-image-2.5-flash' })
    const result = await generateImage({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: model || cfg.model || 'agnes-image-2.5-flash',
      prompt,
      image,
      size,
      ratio,
      returnBase64,
    })
    res.json({ success: true, ...result })
  } catch (err) {
    const msg = (err.message || '').toLowerCase()
    if (msg.includes('unauthorized') || msg.includes('invalid api key')) {
      res.status(401).json({ error: `Agnes API 认证失败：${err.message}（请检查 API Key 是否正确）` })
    } else if (msg.includes('rate limit') || msg.includes('too many requests')) {
      res.status(429).json({ error: `Agnes API 限流：${err.message}（请稍后重试）` })
    } else {
      res.status(500).json({ error: err.message })
    }
  }
})

// ── Skills API ──────────────────────────────────────────────────

app.get('/api/skills', (req, res) => {
  res.json(skills.list())
})

app.post('/api/skills/activate', async (req, res) => {
  const { name, params } = req.body
  try {
    await skills.activate(name, params)
    rebuildEngine()
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/skills/deactivate', async (req, res) => {
  const { name } = req.body
  try {
    await skills.deactivate(name)
    rebuildEngine()
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/skills/custom', async (req, res) => {
  try {
    const skill = await skills.addCustom(req.body)
    rebuildEngine()
    res.json({ success: true, skill })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 删除自定义技能
app.delete('/api/skills/:name', async (req, res) => {
  try {
    await skills.removeCustom(req.params.name)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/reset', (req, res) => {
  engine.reset()
  res.json({ success: true })
})

// ── MCP 管理 API ───────────────────────────────────────────────

app.get('/api/mcp', (req, res) => res.json(mcp.listServers()))

// 添加 MCP 服务器
app.post('/api/mcp', async (req, res) => {
  const { name, type = 'stdio', command, args, url, headers, env, cwd } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const config = type === 'http' || type === 'sse'
    ? { type, url, headers }
    : { type: 'stdio', command, args: args || [], env: env || {}, cwd }
  try {
    mcp.addServer(name, config)
    await mcp.save()
    res.json({ success: true, servers: mcp.listServers() })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 连接 MCP 服务器
app.post('/api/mcp/:name/connect', async (req, res) => {
  try {
    const result = await mcp.connect(req.params.name)
    await syncMCPTools()
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 断开
app.post('/api/mcp/:name/disconnect', async (req, res) => {
  await mcp.disconnect(req.params.name)
  await syncMCPTools()
  res.json({ success: true })
})

// 删除
app.delete('/api/mcp/:name', async (req, res) => {
  mcp.removeServer(req.params.name)
  await mcp.save()
  await syncMCPTools()
  res.json({ success: true })
})

// ── WebSocket ──────────────────────────────────────────────────

const server = createServer(app)
const wss = new WebSocketServer({ server })

// 连接只负责登记/注销；事件广播在 rebuildEngine 中统一处理（支持多标签页并发）
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
})

// ── 启动 ───────────────────────────────────────────────────────

// 必须先加载磁盘上的模型配置（models.json）。否则 modelManager 内存里模型列表为空，
// getActive() 返回 undefined，会导致：
//   1) 视觉分析 resolveAgnesConfig 抛「未配置 Agnes 模型」——图片分析失败（驴唇不对马嘴的根因）；
//   2) engine 回退到默认 Ollama qwen3:4b，与激活的 Agnes 模型对不上。
await modelManager.init()
// 同样必须先把磁盘配置读进内存，否则重启后项目/任务、技能、MCP 服务器「看不见」：
//   - workspace.init()：读取 workspace.json（项目/任务历史）
//   - skills.init()：扫描 skills 目录（自定义技能）
//   - mcp.init()：读取已保存的 MCP 服务器配置（仅加载，不主动连接）
await workspace.init()
await skills.init()
await mcp.init()
const active = modelManager.getActive()
// 启动即构建引擎，避免 WebSocket 连接时 engine 仍为 null 导致崩溃
rebuildEngine()
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║              MiniAgent v2.1                      ║
║   Lightweight Agent for Small Models             ║
╠══════════════════════════════════════════════════╣
║  Web UI:   http://localhost:${PORT}                ║
║  Model:    ${(active?.model || '未配置').padEnd(37)}║
║  Provider: ${(active?.provider || '-').padEnd(37)}║
║  Tools:    ${String(tools.list().length).padEnd(37)}║
║  MCP:      ${String(mcp.listServers().length + ' servers').padEnd(37)}║
╚══════════════════════════════════════════════════╝
  `)
  
  // 保持服务器运行
  console.log('🚀 服务器已启动，按 Ctrl+C 停止')
  
  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n👋 正在关闭服务器...')
    wss.close(() => {
      server.close(() => {
        console.log('✅ 服务器已关闭')
        process.exit(0)
      })
    })
  })
})