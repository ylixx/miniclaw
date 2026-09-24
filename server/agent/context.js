/**
 * Context Manager - 上下文窗口管理器
 *
 * 小模型上下文有限（4K-8K），必须严格管理。
 *
 * v3 修复：裁剪以「单元」为粒度——assistant(tool_calls) 与其后紧跟的所有 tool
 * 结果消息构成一个不可拆分的原子单元。旧版逐条从头删除，会把配对拆散产生
 * "孤儿 tool 消息"（或反之），OpenAI 兼容 API 会直接 400 拒绝，长对话必踩。
 * system 消息（引擎运行中注入的纠错/进度反馈）允许随老化被裁掉——它们是
 * 一次性提示，不属于必须保留的长期上下文。
 */

export class ContextManager {
  constructor(maxTokens = 8192) {
    this.maxTokens = maxTokens
    this.tokenBudget = Math.floor(maxTokens * 0.7) // 留 30% 给生成
  }

  /**
   * 裁剪历史，确保不超限（保序 + 保 tool 配对原子性）
   */
  trim(history) {
    let totalTokens = this._estimateTokens(history)

    if (totalTokens <= this.tokenBudget) {
      return history
    }

    const units = this._splitUnits(history)
    let idx = 0
    while (totalTokens > this.tokenBudget && idx < units.length) {
      // 保底：至少保留最后 2 个单元 / 4 条消息，防止裁到只剩孤儿
      const remainingMsgs = units.slice(idx + 1).reduce((n, u) => n + u.length, 0)
      if (units.length - idx - 1 < 2 || remainingMsgs < 4) break
      totalTokens -= this._estimateTokens(units[idx])
      idx++
    }

    return units.slice(idx).flat()
  }

  /**
   * 把历史切分为不可拆分的单元：
   * - assistant(tool_calls) + 其后连续的 tool 结果 → 一个单元
   * - 其余每条消息自成一个单元
   */
  _splitUnits(history) {
    const units = []
    let i = 0
    while (i < history.length) {
      const msg = history[i]
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const unit = [msg]
        i++
        while (i < history.length && history[i].role === 'tool') {
          unit.push(history[i])
          i++
        }
        units.push(unit)
      } else {
        units.push([msg])
        i++
      }
    }
    return units
  }

  /**
   * 粗略估算 token 数
   * 中文约 1.5 字/token，英文约 4 字符/token
   */
  _estimateTokens(messages) {
    let chars = 0
    for (const msg of messages) {
      if (msg.content) chars += msg.content.length
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += JSON.stringify(tc).length
        }
      }
    }
    return Math.ceil(chars / 2) // 混合中英文的粗略估算
  }

  reset() {
    // 无需操作，历史由 engine 管理
  }
}
