/**
 * 文本工具协议 —— 让"只会一轮一轮聊天"的网页版，表现得像支持 function calling。
 *
 * 背景：OpenAI 的 tools 是**结构化**协议，一次请求里模型直接吐 tool_calls，
 * 客户端执行完再把 role:"tool" 的结果塞回去。网页版没有这条通道：
 * 它就是个人在对话框里打字，一次一问一答，没有 tool_calls 这种字段。
 *
 * 所以这里做**翻译**，把结构化协议摊平成文本：
 *
 *   发出去：把工具清单和输出格式写成一段说明，拼在提问前面
 *   收回来：模型按约定吐一个 JSON，我们解析成标准 tool_calls 回给 DSH
 *   下一轮：DSH 把工具执行结果（role:"tool"）发回来，我们把它渲染成
 *          "工具 xx 返回：……" 递回对话框，模型接着往下说
 *
 * 于是"一次只能一问一答"的限制还在，但多轮工具调用能跑起来 ——
 * 每一轮工具调用就是一轮对话，靠 DSH 那边把循环续上。
 *
 * 本文件只做纯文本的组装与解析，不碰浏览器、不发请求，便于单测。
 */

/** 一个稳妥的输出约定：只输出 JSON，别裹代码块，别加解释。 */
export const TOOL_CALL_FORMAT = '{"tool_call":{"name":"工具名","arguments":{参数}}}'

/**
 * 工具清单 + 输出约定，拼成一段插在提问前面的说明。
 *
 * @param {Array} tools OpenAI 格式的 tools 数组
 * @returns {string} 说明文本；没有工具时返回空串
 */
export function buildToolPreamble(tools) {
  const list = normalizeTools(tools)
  if (!list.length) return ''

  const lines = [
    '【工具调用协议】',
    '你可以调用下面这些工具来完成这件事。需要调用时，**只输出一个 JSON 对象**，',
    `格式固定为：${TOOL_CALL_FORMAT}`,
    '不要用代码块包裹，不要在 JSON 前后加任何解释文字。',
    '不需要调用工具时，就像平常一样正常回答。',
    `可用工具（${list.length} 个）：`,
  ]

  list.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.name} —— ${t.description || '（无说明）'}`)
    const params = t.parameters && typeof t.parameters === 'object' ? t.parameters : null
    lines.push(`   参数：${params ? JSON.stringify(params) : '{}'}`)
  })

  return lines.join('\n')
}

/** 把各家写法归一成 `{name, description, parameters}`。 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    // OpenAI 风格 {type:'function', function:{...}}，也认摊平的 {name, parameters}
    const fn = raw.function && typeof raw.function === 'object' ? raw.function : raw
    const name = typeof fn.name === 'string' ? fn.name.trim() : ''
    if (!name) continue
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters ?? fn.input_schema ?? null,
    })
  }
  return out
}

/**
 * 从模型输出里解析出工具调用。
 *
 * 模型不一定老实，所以要容三种情况：纯 JSON、裹在代码块里、JSON 前后带废话。
 * 但**不能太宽松** —— 普通回答里出现一个 JSON 不该被误判成工具调用，
 * 所以只在结构上明确像调用时才认（有 tool_call/tool_calls 键，或 name+arguments 同时出现）。
 *
 * @param {string} text 模型输出
 * @returns {{name: string, arguments: object}|null}
 */
export function parseToolCall(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const candidates = [raw]

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) candidates.push(fence[1].trim())

  // 前后带废话：取第一个 { 到最后一个 } 的片段
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  for (const c of candidates) {
    try {
      const call = shapeCheck(JSON.parse(c))
      if (call) return call
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

function shapeCheck(obj) {
  if (!obj || typeof obj !== 'object') return null

  const node = obj.tool_call || (Array.isArray(obj.tool_calls) ? obj.tool_calls[0] : null)
  const explicit = Boolean(node)
  const c = node || obj

  const fn = c.function && typeof c.function === 'object' ? c.function : c
  const name = typeof fn.name === 'string' ? fn.name.trim() : ''
  let args = fn.arguments ?? fn.parameters ?? null

  // 没有 tool_call 外壳时，必须 name 和 arguments 同时出现才算，避免误判
  if (!explicit && (!name || args == null)) return null
  if (!name) return null

  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}

  return { name, arguments: args }
}

/** 把 role:"tool" 的消息渲染成一段人话，递回对话框。 */
export function formatToolResult(msg) {
  const name = msg?.name || msg?.tool_call_id || '工具'
  const body = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '')
  return `【工具 ${name} 返回】\n${body}`
}

/** 历史里助手那次工具调用，也渲染成人话（模型自己看得见上下文）。 */
export function formatToolCallTurn(msg) {
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
  return calls
    .map((c) => {
      const name = c?.function?.name || c?.name || '工具'
      const args = c?.function?.arguments ?? c?.arguments ?? '{}'
      return `【我调用了工具 ${name}】参数：${typeof args === 'string' ? args : JSON.stringify(args)}`
    })
    .join('\n')
}

/** 拍平 OpenAI 的多段 content。 */
export function flatten(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 这一轮真正要"打进对话框"的文本。
 *
 * 关键在**只发尾巴**：网页会话自己记着历史，把整段历史再灌一遍等于重复提问。
 * 所以从最后一条 assistant 消息往后取 ——
 *   - 普通一轮：尾巴就是那条 user 消息
 *   - 工具那一轮：尾巴是 DSH 带回来的 role:"tool" 结果
 * 这样工具循环就能一轮一轮续下去，而不会把历史越堆越长。
 *
 * @param {Array} messages OpenAI 格式消息
 * @param {{thinking?: boolean, prefix?: string, tools?: Array}} [opts]
 */
export function buildTurnText(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : []

  let cut = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i]?.role || '') === 'assistant') {
      cut = i
      break
    }
  }
  const tail = list.slice(cut + 1)

  const blocks = []

  // 工具协议放在最前面 —— 它是这一轮的"游戏规则"，得先看到
  const preamble = opts.tools && opts.tools.length ? buildToolPreamble(opts.tools) : ''
  if (preamble) blocks.push(preamble)

  // 网页会话没有 system 概念，只能每轮拼在前面
  const sys = list.filter((m) => m.role === 'system' || m.role === 'developer')
  if (sys.length) blocks.push(sys.map((m) => flatten(m.content)).join('\n\n'))

  const body = tail
    // system / developer 已经在上面单独拼过一遍了，这里要跳过，
    // 否则第一次提问（还没有 assistant 消息、tail 就是全部消息）会拼两遍
    .filter((m) => {
      const role = m?.role || 'user'
      return role !== 'system' && role !== 'developer'
    })
    .map((m) => {
      const role = m?.role || 'user'
      if (role === 'tool') return formatToolResult(m)
      if (role === 'assistant') return formatToolCallTurn(m)
      return flatten(m.content)
    })
    .filter((s) => s && s.trim())
    .join('\n\n')

  if (body) blocks.push(body)

  let text = blocks.join('\n\n').trim()
  if (!text) return ''

  // 让它认真想 —— 网页版没有 reasoning 参数，只能用话术
  const prefix = opts.prefix
  if (opts.thinking && prefix && !text.startsWith(prefix)) {
    text = `${prefix}\n\n${text}`
  }
  return text
}
