/**
 * Model Manager - 多模型提供商管理
 * 
 * 支持：
 * - OpenAI 兼容 API（DeepSeek、Qwen、Moonshot 等）
 * - Ollama 本地模型
 * - vLLM / llama.cpp
 * - 自定义 endpoint
 */

import fs from 'fs/promises'
import path from 'path'

const CONFIG_FILE = 'models.json'

// ── 预置提供商模板 ─────────────────────────────────────────

const PROVIDER_TEMPLATES = {
  agnes: {
    name: 'Agnes AI',
    baseURL: 'https://apihub.agnes-ai.cn/v1',
    apiKey: '',
    api: 'openai-completions',
    model: 'agnes-2.5-flash',
    description: 'Agnes AI（中国节点 apihub.agnes-ai.cn；国际 apihub.agnes-ai.com，同一 Key 通用）。文本/多模态用 agnes-2.5-flash，图像生成用 agnes-image-2.5-flash',
  },
  ollama: {
    name: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    apiKey: '***',
    api: 'openai-completions',
    description: '本地 Ollama 模型服务',
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    description: 'DeepSeek 官方 API',
  },
  qwen: {
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    description: '阿里云通义千问 API',
  },
  moonshot: {
    name: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    description: '月之暗面 Kimi API',
  },
  zhipu: {
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    description: '智谱 GLM API',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    api: 'openai-completions',
    description: 'OpenAI 官方 API',
  },
  custom: {
    name: '自定义',
    baseURL: '',
    api: 'openai-completions',
    description: '自定义 OpenAI 兼容 API',
  },
}

// ── ModelManager 类 ───────────────────────────────────────

export class ModelManager {
  constructor(configDir) {
    this.configDir = configDir
    this.configFile = path.join(configDir, CONFIG_FILE)
    this.models = []
    this.activeModelId = null
    this._writeLock = Promise.resolve() // 串行化写入，防止并发/断电损坏
  }

  /**
   * 初始化：加载配置
   */
  async init() {
    try {
      const data = await fs.readFile(this.configFile, 'utf-8')
      const config = JSON.parse(data)
      this.models = config.models || []
      this.activeModelId = config.activeModelId || null
    } catch {
      // 首次运行，创建默认配置
      this.models = []
      this.activeModelId = null
    }

    // 如果没有任何模型，添加 Ollama 默认
    if (this.models.length === 0) {
      this.models.push({
        id: 'default-ollama',
        name: 'Ollama 本地模型',
        provider: 'ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: '***',
        api: 'openai-completions',
        model: 'qwen3:4b',
        maxTokens: 2048,
        contextLength: 32768,
        temperature: 0.3,
      })
      this.activeModelId = 'default-ollama'
      await this.save()
    }
  }

  /**
   * 保存配置（原子写 + 串行锁，防止并发/断电损坏，对齐 workspace/manager.js）
   */
  async save() {
    const run = async () => {
      await fs.mkdir(this.configDir, { recursive: true })
      const tmp = this.configFile + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({
        models: this.models,
        activeModelId: this.activeModelId,
      }, null, 2))
      await fs.rename(tmp, this.configFile)
    }
    this._writeLock = this._writeLock.then(run, run)
    return this._writeLock
  }

  /**
   * 获取所有模型
   */
  list() {
    return this.models.map(m => ({
      ...m,
      apiKey: m.apiKey ? '***' : '',  // 脱敏
      isActive: m.id === this.activeModelId,
    }))
  }

  /**
   * 获取激活的模型配置
   */
  getActive() {
    return this.models.find(m => m.id === this.activeModelId) || this.models[0]
  }

  /**
   * 添加模型
   */
  async add(model) {
    const id = `model-${Date.now()}`
    const newModel = {
      id,
      name: model.name || '未命名模型',
      provider: model.provider || 'custom',
      baseURL: model.baseURL || '',
      apiKey: model.apiKey || '',
      api: model.api || 'openai-completions',
      model: model.model || '',
      maxTokens: model.maxTokens || 2048,
      contextLength: model.contextLength || 8192,
      temperature: model.temperature || 0.3,
    }
    this.models.push(newModel)
    if (!this.activeModelId) this.activeModelId = id
    await this.save()
    return newModel
  }

  /**
   * 更新模型
   */
  async update(id, updates) {
    const idx = this.models.findIndex(m => m.id === id)
    if (idx === -1) throw new Error(`Model not found: ${id}`)
    const patch = { ...updates }
    // 空串 / 掩码值 = 未修改（编辑表单不回填已保存的 Key，list() 也只返回 '***'），
    // 跳过这两个值，避免"改个名字就把 apiKey 清空/覆盖成掩码"导致模型失效。
    if (patch.apiKey === '' || patch.apiKey === '***') delete patch.apiKey
    this.models[idx] = { ...this.models[idx], ...patch, id }
    await this.save()
    return this.models[idx]
  }

  /**
   * 删除模型
   */
  async remove(id) {
    this.models = this.models.filter(m => m.id !== id)
    if (this.activeModelId === id) {
      this.activeModelId = this.models[0]?.id || null
    }
    await this.save()
  }

  /**
   * 切换激活模型
   */
  async setActive(id) {
    if (!this.models.find(m => m.id === id)) {
      throw new Error(`Model not found: ${id}`)
    }
    this.activeModelId = id
    await this.save()
  }

  /**
   * 获取提供商模板
   */
  getProviderTemplates() {
    return PROVIDER_TEMPLATES
  }

  /**
   * 测试模型连接
   */
  async testConnection(modelConfig) {
    try {
      const response = await fetch(`${modelConfig.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${modelConfig.apiKey || '***'}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        const err = await response.text()
        return { success: false, error: `HTTP ${response.status}: ${err.slice(0, 200)}` }
      }

      const data = await response.json()
      const reply = data.choices?.[0]?.message?.content || ''
      return { success: true, reply: reply.slice(0, 100) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  /**
   * 获取远程模型列表
   */
  async fetchModels(baseURL, apiKey) {
    try {
      const url = `${baseURL}/models`
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey || '***'}`,
        },
        signal: AbortSignal.timeout(20000),
      })

      if (!response.ok) {
        const err = await response.text()
        return { success: false, error: `HTTP ${response.status}: ${err.slice(0, 200)}` }
      }

      const data = await response.json()
      // OpenAI 格式: { data: [{ id: "model-name" }] }
      const models = (data.data || data.models || []).map(m => ({
        id: m.id || m.name || m,
        name: m.id || m.name || m,
      }))
      return { success: true, models }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }
}