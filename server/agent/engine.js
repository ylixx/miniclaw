/**
 * MiniAgent - Agent Engine v2
 * 核心 Agent 循环，专为 4B 小模型优化
 *
 * v2 变化：
 * 1. 任务历史持久化：每轮对话后同步到 WorkspaceManager
 * 2. 动态工作目录：每个项目可绑定不同的工作目录
 * 3. MCP 工具：通过注册表统一调度
 * 4. 技能指令注入：激活的技能写入 system prompt
 * 5. 修复：目录穿越防护后的错误信息更友好
 */

import { buildPrompt, buildToolResult } from './prompt.js'
import { parseResponse, buildToolFormatHint } from './parser.js'
import { ContextManager } from './context.js'
import { checkPermissionMode } from '../tools/safety-gate.js'
import { selectTools, READ_ONLY_WHITELIST } from './tool-router.js'

// ─── Agent 状态 ──────────────────────────────────────────────────

const AgentState = {
  IDLE: 'idle',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  RESPONDING: 'responding',
  ERROR: 'error',
}

// ─── Agent 引擎 ──────────────────────────────────────────────────

export class AgentEngine {
  constructor({ tools, mcpClient, skills, config, workspace }) {
    this.tools = tools           // 工具注册表
    this.mcp = mcpClient         // MCP 客户端
    this.skills = skills         // Skills 系统
    this.config = config         // 配置
    this.workspace = workspace   // 工作区管理（项目/任务/历史）
    this.context = new ContextManager(config.contextLength || 8192)
    this.state = AgentState.IDLE
    this.history = []            // 当前任务的对话历史
    this.maxSteps = config.maxSteps || 8
    this.hardMaxSteps = config.hardMaxSteps || 24  // token 免费场景：允许更长的目标推进
    this.permissionMode = config.permissionMode || 'guarded'  // guarded | read-only | unattended
    this._tokenStats = { prompt: 0, completion: 0, requests: 0 }  // 本次任务累计 token 统计
    this.goal = null
    this.currentPlan = null
    this._selfVerifyHint = null
    this._scope = null         // 当前注入的工具子集（4B 减负：只给相关工具）
    this.onEvent = null          // 事件回调
    this._activeTaskId = null    // 当前绑定任务
  }

  // ── 任务切换 ───────────────────────────────────────────────

  /**
   * 绑定任务：切换当前对话到指定任务（恢复历史）
   */
  async bindTask(taskId) {
    if (!this.workspace) return
    if (taskId === null) {
      this._activeTaskId = null
      this.history = []
      return
    }
    const found = this.workspace.findTask(taskId)
    if (!found) throw new Error(`任务不存在: ${taskId}`)
    this._activeTaskId = taskId
    this.history = found.task.messages || []
    this._tokenStats = { prompt: 0, completion: 0, requests: 0 }
    this._emit('usage_reset', {})
    this._emit('task_switched', { taskId, title: found.task.title })
  }

  /**
   * 获取当前工作目录（项目绑定目录）
   */
  getWorkDir() {
    if (this.workspace) {
      const d = this.workspace.getActiveDir()
      if (d) return d
    }
    return this.config.baseDir || process.cwd()
  }

  // ── 消息处理 ───────────────────────────────────────────────

  async handleMessage(userMessage) {
    this.state = AgentState.THINKING
    this._emit('state', { state: this.state })

    // 添加用户消息到历史
    this.history.push({ role: 'user', content: userMessage })
    this.goal = userMessage  // 记录用户目标，供目标评估循环使用

    // 工具子集路由（A 技能 / B 意图）：每轮用户消息重算一次，减少注入量
    this._refreshToolScope(userMessage)

    // 规划前置（s05）：复杂任务先让模型产出步骤清单，提升 4B 模型多步稳定性
    if (this.config.planning !== false && this._looksMultiStep(userMessage)) {
      this._emit('planning', { active: true })  // UI 反馈：正在规划，避免空白卡顿
      const plan = await this._planTask(userMessage)
      if (plan) this.currentPlan = plan
    }

    // 管理上下文窗口
    this.history = this.context.trim(this.history)

    const steps = []
    let stepCount = 0
    this._failSignatures = new Map()   // 记录「工具+参数签名」失败次数，识别重复硬闯

    try {
      while (stepCount < this.hardMaxSteps) {
        stepCount++
        this._emit('step', { step: stepCount })

        // 1. 构建 prompt（注入工作目录 + 技能指令 + 工具子集 + 计划 + 自校验提示）
        const prompt = buildPrompt({
          history: this.history,
          tools: this._scope.tools,
          toolScope: this._scope,
          skills: this.skills.list ? this.skills.list() : [],
          skillContext: this.skills.getPromptContext ? this.skills.getPromptContext() : '',
          config: this.config,
          workDir: this.getWorkDir(),
          plan: this.currentPlan,
          selfVerifyHint: this._selfVerifyHint,
        })
        this._selfVerifyHint = null  // 提示已并入本轮 system prompt，清空避免重复注入

        // 2. 调用模型（携带 tools schema，开启原生 function calling 通道）
        this.state = AgentState.THINKING
        this._emit('state', { state: this.state })

        // 流式：开始 → 增量 token → 结束（前端实时渲染思考过程）
        this._emit('token_start')
        const rawResponse = await this._callModel(
          prompt,
          this._toOpenAITools(this._scope.tools),
          { onDelta: (d) => this._emit('token', { delta: d }) }
        )
        this._emit('token_end')

        // 3. 解析响应（双通道：原生 tool_calls 优先，回落文本 JSON 解析）
        const parsed = this._parseDual(rawResponse)

        if (parsed.type === 'text') {
          // 纯文本回复 → 结束
          this.history.push({ role: 'assistant', content: parsed.text })
          this.state = AgentState.IDLE
          this._emit('state', { state: this.state })
          this._emit('response', { text: parsed.text })
          await this._syncHistory(steps.length)
          return { type: 'text', text: parsed.text, steps }
        }

        if (parsed.type === 'tool_call') {
          const { name, arguments: args } = parsed.call
          const callId = parsed.id || `call_${stepCount}`
          this.state = AgentState.TOOL_CALL
          this._emit('state', { state: this.state })
          this._emit('tool_call', { name, arguments: args })

          // 记录 assistant 消息（含 tool_call）
          this.history.push({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          })

          // 4. 执行工具
          this.state = AgentState.TOOL_RESULT
          this._emit('state', { state: this.state })

          let result
          try {
            // 权限模式闸：read-only 拦截写/删类工具（在工具执行前统一管控，含 MCP）
            const block = checkPermissionMode(this.permissionMode, name)
            if (block) {
              result = { error: block, code: 'PERMISSION_MODE' }
            } else {
              // 子集外工具：先解析（模糊纠名），存在即自动扩容，避免"省 token"变成"任务卡死"
              const resolved = this.tools.resolveName ? this.tools.resolveName(name) : name
              if (!resolved || !this._ensureTool(resolved)) {
                result = {
                  error: `未知工具: ${name}。当前可用: ${this._scope.names.join ? [...this._scope.names].join(', ') : ''}`,
                  code: 'TOOL_NOT_FOUND',
                }
              } else {
                result = await this.tools.execute(resolved, args)
                if (result && result.isError) {
                  result = { error: result.content }
                }
              }
            }
          } catch (err) {
            result = { error: err.message }
          }

          // 工具出错 / 安全拦截 → 注入自校验提示，要求模型复核而非硬闯（s06 自验证回环）
          if (result && result.error) {
            if (result.needConfirm) {
              this._emit('safety', { tool: name, reason: result.error })
            }
            // 重复失败检测：4B 模型缺乏"换策略"能力，出错时倾向于原样重试
            // （实测同一错误动作连试 8 次直到步数耗尽，最后还谎报成功）。
            // 同一工具+同一参数签名失败 ≥2 次即强制禁止重试，并要求如实汇报。
            const sig = `${name}|${JSON.stringify(args || {})}`
            const fails = (this._failSignatures.get(sig) || 0) + 1
            this._failSignatures.set(sig, fails)
            if (fails >= 2) {
              this._selfVerifyHint = `【禁止重试】你已用 ${name} 以完全相同的参数连续失败 ${fails} 次，继续重试没有任何意义。请立即改用别的工具或改变参数完成任务；若确实做不到，直接如实告诉用户失败原因和已完成的部分，严禁声称成功。`
            } else {
              this._selfVerifyHint = '上一步工具返回了错误或被安全拦截，请先核实参数、路径与权限，必要时修正后重试；若确实无法完成，明确告知用户原因。'
            }
          }

          const resultText = buildToolResult(result)
          steps.push({ tool: name, args, result: resultText })

          // 记录工具结果
          this.history.push({
            role: 'tool',
            tool_call_id: callId,
            content: resultText,
          })

          this._emit('tool_result', { name, result: resultText })

          // 软预算到达后做目标评估：达成则收尾，否则注入进度提醒继续推进
          if (stepCount === this.maxSteps) {
            const done = await this._evaluateGoal()
            if (done) {
              return await this._finalSummary(steps, true)
            }
            this.history.push({
              role: 'system',
              content: `[进度提示] 你已使用 ${stepCount} 步，但用户目标尚未完成：「${this.goal}」。请聚焦目标，优先推进关键路径，避免重复或无关操作。`,
            })
          }

          // 工具执行后继续循环（让模型决定下一步）
          continue
        }

        if (parsed.type === 'error') {
          // 解析错误 → 帮模型纠正（最多连续纠错 2 次，防死循环）
          this._parseErrorCount = (this._parseErrorCount || 0) + 1
          if (this._parseErrorCount >= 3) {
            const fallback = '抱歉，我无法理解当前输出格式，请重试或简化请求。'
            this.history.push({ role: 'assistant', content: fallback })
            this._emit('response', { text: fallback })
            await this._syncHistory(steps.length)
            return { type: 'text', text: fallback, steps }
          }
          this.history.push({
            role: 'system',
            content: `[格式错误] 你的回复无法解析为工具调用。${buildToolFormatHint(this._scope ? this._scope.tools : this.tools.getSchemas())}\n错误详情：${parsed.error || ''}`,
          })
          this._emit('parse_error', { error: parsed.error, raw: rawResponse })
          continue
        }
      }

      // 达到硬上限 → 强制收尾（软预算处已通过目标评估给过机会）
      return await this._finalSummary(steps, false)

    } catch (err) {
      this.state = AgentState.ERROR
      this._emit('state', { state: this.state })
      this._emit('error', { error: err.message })
      await this._syncHistory(steps.length).catch(() => {})
      return { type: 'error', error: err.message, steps }
    } finally {
      this._parseErrorCount = 0
    }
  }

  // ── 工具子集路由（4B 减负）───────────────────────────────

  /**
   * 重算本轮要注入的工具子集：技能优先，其次意图关键词，兜底 core。
   */
  _refreshToolScope(message) {
    const all = this.tools.getSchemas()
    const activeSkills = (this.skills && Array.isArray(this.skills.active)) ? this.skills.active : []
    const scope = selectTools({
      schemas: all,
      activeSkills,
      message,
      permissionMode: this.permissionMode,
    })
    scope.allCount = all.length
    this._scope = scope
    this._emit('tool_scope', {
      groups: scope.groups,
      source: scope.source,
      count: scope.tools.length,
      all: all.length,
    })
    return scope
  }

  /**
   * 逃生舱：模型调用了子集外但确实存在的工具时，动态扩容并放行。
   * 只读模式下白名单外一律拒绝。
   */
  _ensureTool(name) {
    if (!this._scope) return false
    if (this._scope.names.has(name)) return true
    if (this.permissionMode === 'read-only' && !READ_ONLY_WHITELIST.includes(name)) return false
    const hit = this.tools.getSchemas().find(t => t.name === name)
    if (!hit) return false
    this._scope.tools.push(hit)
    this._scope.names.add(name)
    this._emit('tool_scope_expand', { name, count: this._scope.tools.length })
    return true
  }

  /**
   * 同步历史到当前任务
   */
  async _syncHistory(stepCount) {
    if (!this.workspace || !this._activeTaskId) return
    try {
      await this.workspace.syncTaskHistory(this._activeTaskId, this.history, stepCount)
    } catch { /* 持久化失败不阻塞对话 */ }
  }

  /**
   * 调用模型（双通道）
   * @param {Array} messages 对话消息
   * @param {Array} [tools] OpenAI 格式 tools schema，开启原生 function calling
   * @returns {{ content: string, tool_calls: object[]|null }}
   */
  async _callModel(messages, tools, overrides = {}) {
    const baseURL = this.config.baseURL || 'http://localhost:11434/v1'
    const model = this.config.model || 'qwen3:4b'
    const apiKey = this.config.apiKey || '***'

    const body = {
      model,
      messages,
      temperature: overrides.temperature ?? this.config.temperature ?? 0.3,
      max_tokens: overrides.maxTokens || this.config.maxTokens || 1024,
      stream: overrides.stream !== false,  // 默认开启流式（吐 token 实时回传）
      stream_options: { include_usage: true },  // 请求末端返回 usage 统计
    }

    // 双通道：开启原生 function calling（模型不支持时静默忽略，回落文本解析）
    if (this.config.nativeTools !== false && tools && tools.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const t0 = Date.now()
    let content = ''
    let tool_calls = null
    let usage = null
    const onDelta = overrides.onDelta  // 流式增量回调（仅主对话传入，用于实时展示）

    // 超时策略：首字节超时（无响应头即判端点不可达）+ 流空闲超时（连续无 chunk 即判生成中断）
    // 不再使用整体硬超时，避免偶发慢/抖动被误杀
    const abortCtl = new AbortController()
    let _timeoutKind = null
    const FIRST_BYTE_MS = 60000
    const IDLE_MS = 90000
    const firstByteTimer = setTimeout(() => { _timeoutKind = 'firstByte'; abortCtl.abort() }, FIRST_BYTE_MS)
    let _idleTimer = null
    const _resetIdle = () => {
      if (_idleTimer) clearTimeout(_idleTimer)
      _idleTimer = setTimeout(() => { _timeoutKind = 'idle'; abortCtl.abort() }, IDLE_MS)
    }

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortCtl.signal,
      })
      clearTimeout(firstByteTimer)  // 首字节已到 → 关闭首字节超时，转流空闲保护
      if (!response.ok) {
        const err = await response.text()
        throw new Error(`Model API error: ${response.status} - ${err.slice(0, 300)}`)
      }

      const ct = response.headers.get('content-type') || ''

      if (!body.stream || !ct.includes('text/event-stream')) {
        // 端点不支持流式 → 非流式回退（仍触发一次 onDelta，保证 UI 行为一致）
        _resetIdle()  // 非流式用一次兜底，避免大响应体下载挂死
        const data = await response.json()
        if (_idleTimer) clearTimeout(_idleTimer)
        const msg = data.choices?.[0]?.message || {}
        content = msg.content || ''
        tool_calls = msg.tool_calls || null
        usage = data.usage || null
        if (onDelta && content) onDelta(content)
      } else {
        // 流式：逐块读取 SSE（data: {...}\n\n）
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let finished = false
        while (!finished) {
          const { done, value } = await reader.read()
          if (done) break
          _resetIdle()  // 每收到一块即续期空闲计时，模型持续思考不会误杀
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunkStr = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of chunkStr.split('\n')) {
              const s = line.trim()
              if (!s.startsWith('data:')) continue
              const data = s.slice(5).trim()
              if (data === '[DONE]') { finished = true; break }
              let json
              try { json = JSON.parse(data) } catch { continue }
              const delta = json.choices?.[0]?.delta
              if (delta?.content) {
                content += delta.content
                if (onDelta) onDelta(delta.content)
              }
              if (delta?.tool_calls) {
                tool_calls = mergeToolCallDeltas(tool_calls, delta.tool_calls)
              }
              if (json.usage) usage = json.usage
            }
            if (finished) break
          }
        }
        if (_idleTimer) clearTimeout(_idleTimer)
      }
    } catch (err) {
      clearTimeout(firstByteTimer)
      if (_idleTimer) clearTimeout(_idleTimer)
      if (_timeoutKind === 'firstByte' || _timeoutKind === 'idle') {
        const msg = _timeoutKind === 'firstByte'
          ? `模型端点首字节超时（>${FIRST_BYTE_MS / 1000}s 无响应，疑似网络不通或端点不可达）`
          : `模型流响应空闲超时（连续 ${IDLE_MS / 1000}s 无数据，生成中断）`
        const e = new Error(msg)
        e.code = 'MODEL_TIMEOUT'
        throw e
      }
      throw err
    }

    const elapsedMs = Date.now() - t0

    // 累计 token 统计（usage 优先，缺失时按字符数估算 ~1.6 字符/token）
    const estCompletion = Math.ceil(content.length / 1.6)
    if (usage) {
      this._tokenStats.prompt += usage.prompt_tokens || 0
      this._tokenStats.completion += usage.completion_tokens || 0
    } else {
      this._tokenStats.completion += estCompletion
    }
    this._tokenStats.requests++
    const completionTokens = usage?.completion_tokens || estCompletion
    const tps = elapsedMs > 0 ? Math.round(completionTokens / (elapsedMs / 1000)) : 0

    // 推送用量事件（前端实时显示累计 K token 与吞吐率）
    this._emit('usage', {
      prompt: this._tokenStats.prompt,
      completion: this._tokenStats.completion,
      total: this._tokenStats.prompt + this._tokenStats.completion,
      totalK: +((this._tokenStats.prompt + this._tokenStats.completion) / 1000).toFixed(2),
      requests: this._tokenStats.requests,
      tps,
      elapsedMs,
    })

    return { content, tool_calls, usage, tps, elapsedMs }
  }

  /**
   * 将内部工具 schema 转为 OpenAI function-calling 格式
   */
  _toOpenAITools(schemas) {
    if (!schemas || !schemas.length) return undefined
    return schemas.map(s => ({
      type: 'function',
      function: {
        name: s.name,
        description: s.description || '',
        parameters: s.parameters || { type: 'object', properties: {} },
      },
    }))
  }

  /**
   * 规划前置（s05）：生成编号步骤清单，供 UI 展示与模型按步执行
   */
  async _planTask(goal) {
    const sys = '你是任务规划器。把用户的请求拆成简洁、可执行的步骤清单，每步一行并用数字编号。只输出步骤本身，不要执行任何操作。'
    const usr = `用户请求：\n${goal}\n\n请规划执行步骤：`
    try {
      const r = await this._callModel([
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ], undefined, { maxTokens: 400, temperature: 0.2 })  // 规划只需简短步骤，限制 token 加速
      const text = (r.content || '').trim()
      if (!text) return null
      this._emit('plan', { text })
      return text
    } catch {
      return null  // 规划失败不阻塞主流程
    }
  }

  /**
   * 启发式：判断请求是否值得先做规划（多步/复杂任务）
   */
  _looksMultiStep(msg) {
    if (!msg) return false
    const kw = ['步骤', '计划', '先', '然后', '再', '接着', '实现', '创建', '开发', '修复', '配置', '并且', '同时', '最后', '搭建', '总结', '整理', '对比', '生成']
    const hits = kw.filter(k => msg.includes(k))
    // 至少两个动作词（明确多步），或较长指令且含一个顺序/动作词，才视为需规划。
    // 收紧以避免简单请求也额外消耗一次规划调用（影响首响速度）。
    if (hits.length >= 2) return true
    if (msg.length >= 40 && hits.length >= 1) return true
    return false
  }

  /**
   * 双通道解析：原生 tool_calls 优先，失败回落文本 JSON 解析
   */
  _parseDual(resp) {
    if (resp.tool_calls && resp.tool_calls.length) {
      const native = parseNativeToolCalls(resp.tool_calls)
      if (native) return native
    }
    return parseResponse(resp.content)
  }

  /**
   * 目标评估（s17 Goal Loop）：判断用户目标是否已达成。
   * 轻量调用：不传 tools、短回复，仅要 YES/NO。
   */
  async _evaluateGoal() {
    if (!this.goal) return false
    const ctx = this._recentSteps()
    const sys = '你是任务进度评估器。判断用户目标是否已经由助手完成。只回复一行：开头 YES 或 NO，紧接着一句话说明。'
    const usr = `用户目标：\n${this.goal}\n\n已执行步骤摘要：\n${ctx}\n\n目标是否已达成？仅回复 YES 或 NO。`
    try {
      const r = await this._callModel([
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ])
      const t = (r.content || '').trim().toUpperCase()
      return t.startsWith('YES')
    } catch {
      return false  // 评估失败默认认为未完成，继续推进
    }
  }

  /**
   * 收尾：用模型生成简洁中文总结（已完成/未完成/下一步），并结束对话
   */
  async _finalSummary(steps, achieved) {
    const summary = await this._summarize(achieved)
    this.history.push({ role: 'assistant', content: summary })
    this.state = AgentState.IDLE
    this._emit('state', { state: this.state })
    this._emit('response', { text: summary })
    await this._syncHistory(steps.length)
    return { type: 'text', text: summary, steps }
  }

  async _summarize(achieved) {
    const stepsText = this._recentSteps()
    const sys = '你是任务总结器。基于对话历史，用简体中文给用户一个简洁总结：已完成什么、未完成什么、下一步建议。不要输出 JSON。'
      + '【判定规则·必须遵守】严格依据步骤记录里每个工具的返回结果判定成败：'
      + '标记失败/error/被拒绝/被安全拦截的操作一律记为「未完成」，严禁把失败或重试中的操作说成成功；'
      + '「成功创建 N 个」这类数字必须能在步骤记录里数出对应数量的成功返回，数不出来就不要写；'
      + '若目标产物（如某个文件）没有任何一次成功的生成记录，必须明确写「未生成」。'
    const usr = `用户目标：\n${this.goal}\n\n已执行步骤：\n${stepsText}\n\n请给出总结（${achieved ? '目标已达成' : '达到步骤上限，未能在预算内完成'}）。`
    try {
      const r = await this._callModel([
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ])
      return (r.content || '').trim() || '任务已结束，但未能生成总结。'
    } catch {
      const n = this.history.filter(m => m.role === 'tool').length
      return `已执行 ${n} 步操作。${achieved ? '目标已基本完成。' : '达到步骤上限，请检查目标或分步提出请求。'}`
    }
  }

  /**
   * 取最近若干工具结果作为进度上下文（截断，控制评估/总结的 token 量）
   */
  _recentSteps(limit = 6) {
    const toolMsgs = this.history.filter(m => m.role === 'tool')
    const tail = toolMsgs.slice(-limit)
    if (!tail.length) return '（尚无工具执行记录）'
    return tail.map((m, i) => `${i + 1}. ${String(m.content).slice(0, 300)}`).join('\n')
  }

  /**
   * 重置会话（清空当前任务历史）
   */
  reset() {
    this.history = []
    this.state = AgentState.IDLE
    this._parseErrorCount = 0
    this._scope = null
    this._tokenStats = { prompt: 0, completion: 0, requests: 0 }
    this._emit('usage_reset', {})
    this._emit('state', { state: this.state })
    this._emit('reset', {})
  }

  /**
   * 获取状态
   */
  getState() {
    return {
      state: this.state,
      historyLength: this.history.length,
      steps: this.history.filter(m => m.role === 'tool').length,
      taskId: this._activeTaskId,
      toolScope: this._scope ? {
        groups: this._scope.groups,
        source: this._scope.source,
        count: this._scope.tools.length,
        all: this._scope.allCount,
      } : null,
    }
  }

  _emit(event, data) {
    if (this.onEvent) this.onEvent(event, data)
  }
}

/**
 * 从 OpenAI 原生 tool_calls 中提取第一个合法的工具调用
 * @returns {{ type:'tool_call', call:{name,arguments}, id:string }|null}
 */
function parseNativeToolCalls(toolCalls) {
  for (const tc of toolCalls) {
    const fn = tc.function
    if (!fn || !fn.name) continue
    let args = fn.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}') } catch { args = {} }
    }
    return {
      type: 'tool_call',
      call: { name: fn.name, arguments: args || {} },
      id: tc.id || undefined,
    }
  }
  return null
}

/**
 * 合并流式原生 tool_calls 的增量 delta（每个 delta 的 arguments 是字符串片段）。
 * @returns {Array|null} 累积后的 tool_calls 数组
 */
function mergeToolCallDeltas(acc, deltas) {
  acc = acc || []
  for (const dt of deltas) {
    const i = dt.index ?? acc.length
    if (!acc[i]) acc[i] = { id: dt.id || '', type: 'function', function: { name: '', arguments: '' } }
    if (dt.id) acc[i].id = dt.id
    if (dt.function?.name) acc[i].function.name += dt.function.name
    if (dt.function?.arguments) acc[i].function.arguments += dt.function.arguments
  }
  return acc
}
