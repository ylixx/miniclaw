/**
 * Context Manager - 上下文窗口管理器
 *
 * 小模型上下文有限（4K-8K），必须严格管理。
 *
 * v2 修复：裁剪时保持消息原有顺序（旧版会把 system 消息提到最前，打乱时序）。
 */

export class ContextManager {
  constructor(maxTokens = 8192) {
    this.maxTokens = maxTokens
    this.tokenBudget = Math.floor(maxTokens * 0.7) // 留 30% 给生成
  }

  /**
   * 裁剪历史，确保不超限（保序）
   */
  trim(history) {
    let totalTokens = this._estimateTokens(history)

    if (totalTokens <= this.tokenBudget) {
      return history
    }

    // 复制一份，从最早的非 system 消息开始删除（保留最近的）
    const trimmed = [...history]
    let i = 0
    while (totalTokens > this.tokenBudget && i < trimmed.length) {
      // 保底：至少保留最近 4 条消息
      if (trimmed.length <= 4) break
      if (trimmed[i].role === 'system') { i++; continue }
      const removed = trimmed.splice(i, 1)[0]
      totalTokens -= this._estimateTokens([removed])
      // splice 后 i 指向下一条，不递增
    }

    return trimmed
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
