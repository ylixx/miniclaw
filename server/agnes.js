/**
 * Agnes AI 多模态客户端
 *
 * 两个能力：
 * 1) 图像分析（视觉理解）— 模型 agnes-2.5-flash，OpenAI 兼容 chat/completions，
 *    通过 messages[].content[].image_url 接收图片，返回文本。
 * 2) 图像生成/编辑   — 模型 agnes-image-2.5-flash，端点 /v1/images/generations，
 *    支持文生图（不传 image）与图生图（传 image，作为参考图）。
 *
 * 官方端点：
 *   中国节点  https://apihub.agnes-ai.cn/v1   （与 apihub.agnes-ai.com 共用同一把 Key）
 *   国际节点  https://apihub.agnes-ai.com/v1
 * 鉴权：Authorization: Bearer <API_KEY>
 */

const DEFAULT_TEXT_MODEL = 'agnes-2.5-flash'
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.5-flash'

/**
 * 把入参图片归一化为可用的 URL 字符串。
 * 支持三种形式：
 *   - 公网 URL 字符串（如 https://.../a.png）
 *   - data URI（data:image/png;base64,...）
 *   - 对象 { data: base64 或 dataURI, mime? }
 * @param {string|{data:string,mime?:string}} image
 * @returns {string}
 */
function resolveImageUrl(image) {
  if (typeof image === 'string') return image
  if (image && typeof image.data === 'string') {
    if (image.data.startsWith('data:')) return image.data
    const mime = image.mime || 'image/png'
    return `data:${mime};base64,${image.data}`
  }
  throw new Error('image 参数无效：需为 URL 字符串、data URI，或 { data, mime } 对象')
}

/**
 * 图像分析：把图片 + 文本问题发给多模态 chat 模型，返回文本分析结果。
 * @param {object} opt
 * @param {string} opt.baseURL  Agnes baseURL（到 /v1）
 * @param {string} opt.apiKey   API Key
 * @param {string} [opt.model]  默认 agnes-2.5-flash
 * @param {string|object} opt.image  图片（URL / dataURI / {data,mime}）
 * @param {string} [opt.prompt] 问题/指令
 * @param {string} [opt.system] 可选系统提示
 * @param {number} [opt.maxTokens]
 * @param {number} [opt.temperature]
 * @returns {Promise<{text:string, usage:object|null, model:string}>}
 */
export async function analyzeImage({
  baseURL,
  apiKey,
  model = DEFAULT_TEXT_MODEL,
  image,
  prompt,
  system,
  maxTokens = 1024,
  temperature = 0.4,
}) {
  const imageUrl = resolveImageUrl(image)

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt || '请描述这张图片的内容。' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  })

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || '***'}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`Agnes Vision 错误 ${resp.status}: ${err.slice(0, 300)}`)
    }
    const data = await resp.json()
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: data.usage || null,
      model: data.model || model,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 图像生成/编辑：agnes-image-2.5-flash。
 *   - 文生图：不传 image
 *   - 图生图：传 image（参考图，URL / dataURI / {data,mime}）
 * 输出：URL 或 Base64（由 returnBase64 决定；图生图时经 extra_body.response_format 控制）。
 * @param {object} opt
 * @param {string} opt.baseURL
 * @param {string} opt.apiKey
 * @param {string} [opt.model] 默认 agnes-image-2.5-flash
 * @param {string} opt.prompt
 * @param {string|object} [opt.image] 参考图（图生图时必填）
 * @param {string} [opt.size] 默认 '1024x768'
 * @param {string} [opt.ratio] 可选，配合 size 档位（如 '2K'）使用，如 '16:9'
 * @param {boolean} [opt.returnBase64] 是否返回 Base64（默认 false=URL）
 * @returns {Promise<{url:string|null, b64_json:string|null, revised_prompt:string|null}>}
 */
export async function generateImage({
  baseURL,
  apiKey,
  model = DEFAULT_IMAGE_MODEL,
  prompt,
  image,
  size = '1024x768',
  ratio,
  returnBase64 = false,
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error('prompt 不能为空')
  }

  const body = { model, prompt, size }
  if (ratio) body.ratio = ratio

  const extraBody = {}
  if (image) {
    // 图生图：参考图放进 extra_body.image，输出格式走 extra_body.response_format
    extraBody.image = [resolveImageUrl(image)]
    extraBody.response_format = returnBase64 ? 'b64_json' : 'url'
  } else if (returnBase64) {
    // 文生图 + Base64：顶层 return_base64
    body.return_base64 = true
  } else {
    // 文生图 + URL：response_format 放 extra_body
    extraBody.response_format = 'url'
  }
  if (Object.keys(extraBody).length) body.extra_body = extraBody

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)

  try {
    const resp = await fetch(`${baseURL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || '***'}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`Agnes Image 错误 ${resp.status}: ${err.slice(0, 300)}`)
    }
    const data = await resp.json()
    const item = data.data?.[0] || {}
    return {
      url: item.url || null,
      b64_json: item.b64_json || null,
      revised_prompt: item.revised_prompt || null,
    }
  } finally {
    clearTimeout(timer)
  }
}
