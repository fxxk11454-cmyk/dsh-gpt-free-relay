/**
 * OpenAI 兼容层：把 /v1/chat/completions 的请求交给网页会话，再按 OpenAI 的格式吐回去。
 *
 * 这一层是"请求统一本地处理"的落点 —— DSH 完全不知道背后是网页会话，
 * 它只看到一个标准的 openai-completions provider。
 *
 * 顺带一个好处：输出是我们自己拼的，默认**天然不含 tool_calls** ——
 * 「不传工具」这条约束在这一条链路上是结构上成立的，不靠过滤。
 *
 * 例外是显式打开工具模式（allowTools）：那时走 toolbridge.js 的文本协议，
 * 把工具清单写进提问、把模型吐的 JSON 翻译回标准 tool_calls。
 * 默认关闭，所以上面那条约束在默认状态下依然成立。
 */
import { randomUUID } from 'node:crypto'
import { parseToolCall } from './toolbridge.js'

/** 判断是不是我们要接管的对话请求。 */
export function isChatPath(url) {
  return /\/v1\/chat\/completions(\?|$)/.test(String(url || '')) || /\/chat\/completions(\?|$)/.test(String(url || ''))
}

/**
 * 判定这一轮要不要"认真想"。
 *
 * 为什么只看 body：网页版没有 reasoning 参数可传，ChatGPT 自己决定想不想。
 * 我们唯一能做的是**在提问前加一句话**（见 driver.js 的 THINKING_PREFIX）。
 * 所以这里不需要把参数转发给谁 —— 只需要一个布尔判断。
 *
 * DSH 侧靠 provider profile 里模型声明的 `reasoningEfforts` 决定要不要发
 * `reasoning_effort`；不声明就永远不发，这个判定就永远是 false。
 *
 * 认的形态放宽一点：不同上游/插件对"开思考"的表达不一样，
 * 认多种写法比只认一种稳。
 *
 * @param {object} body OpenAI 兼容请求体
 * @returns {boolean} 是否处于"思考已开"的状态
 */
export function detectThinking(body) {
  if (!body || typeof body !== 'object') return false

  /** 这些取值表示"没开"，别当成开了 */
  const OFF = /^(off|none|disabled|false|0|no|minimal)$/i
  const isOn = (v) => typeof v === 'string' && v.trim() !== '' && !OFF.test(v.trim())

  // 1. OpenAI 风格：reasoning_effort: "high"
  if (isOn(body.reasoning_effort)) return true

  // 2. 嵌套风格：reasoning: { effort: "high" } / { enabled: true }
  const r = body.reasoning
  if (r) {
    if (typeof r === 'string') {
      if (isOn(r)) return true
    } else if (typeof r === 'object') {
      if (isOn(r.effort)) return true
      if (r.enabled === true) return true
    }
  }

  // 3. Anthropic 风格：thinking: { type: "enabled" }
  const t = body.thinking
  if (t === true) return true
  if (t && typeof t === 'object') {
    if (/^(enabled|on|true)$/i.test(String(t.type || ''))) return true
    if (t.enabled === true) return true
  }

  // 4. 通义/各家风格：enable_thinking: true
  if (body.enable_thinking === true) return true

  // 5. vLLM 风格：chat_template_kwargs: { enable_thinking: true }
  const kw = body.chat_template_kwargs || body.chat_template_args
  if (kw && typeof kw === 'object' && kw.enable_thinking === true) return true

  return false
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

/**
 * 造一个本地处理器。
 * @param {{webchat: import('./webchat.js').WebChat, log?: Function}} deps
 * @returns {(bodyText: string, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createLocalChatHandler({ webchat, driver, log = () => {}, allowTools = () => false }) {
  /**
   * 统一取回答。
   *
   * 优先**真浏览器**（driver）：它就是在页面上打字、读回答，自带登录态，
   * 不需要 accessToken，也不碰 Sentinel，上游怎么改都影响不到它。
   * 浏览器没起来时才退回 webchat（直接调后端接口那条路）。
   *
   * @param {(text: string) => void} onPartial 每拿到一段就回调（用来边出边发）
   * @param {{thinking?: boolean, tools?: Array}} opts
   * @returns {Promise<string>} 完整回答
   */
  async function run(messages, onPartial, opts = {}) {
    if (driver && driver.available) {
      const text = await driver.answer(messages, (partial) => onPartial(partial), {
        thinking: Boolean(opts.thinking),
        tools: opts.tools,
      })
      return text || ''
    }
    let text = ''
    for await (const d of webchat.stream(messages)) {
      text += d
      onPartial(text)
    }
    return text
  }

  /** 造一个标准 tool_call 对象（id 每次都要新的，DSH 靠它配对结果）。 */
  function makeToolCall(call) {
    return {
      id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }
  }

  return async function handleLocalChat(bodyText, res) {
    let body
    try {
      body = JSON.parse(bodyText || '{}')
    } catch {
      body = {}
    }

    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const model = body?.model || 'free-chat'
    const wantStream = body?.stream !== false
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const base = { id, created, model }

    // 这一轮要不要认真想 —— 只看这一个判定，不转发任何参数（网页链路没处转）
    const thinking = detectThinking(body)
    if (thinking) log('本轮判定为「开思考」，提问前会加一句')

    /**
     * 这一轮要不要走文本工具协议。
     *
     * 网页版没有 tool_calls 通道，所以把工具清单写进提问、让模型吐 JSON，
     * 我们再翻译回标准 tool_calls（见 toolbridge.js）。开关默认关 ——
     * 「不透传工具调用」是这个插件原本的硬约束，要开得显式开。
     */
    const offered = allowTools() && Array.isArray(body?.tools) && body.tools.length ? body.tools : null
    if (offered) log(`本轮带 ${offered.length} 个工具，走文本工具协议`)

    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    try {
      if (!wantStream) {
        const text = await run(messages, () => {}, { thinking, tools: offered })
        const call = offered ? parseToolCall(text) : null
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify(
            call
              ? {
                  ...base,
                  object: 'chat.completion',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: null, tool_calls: [makeToolCall(call)] },
                      finish_reason: 'tool_calls',
                    },
                  ],
                  usage,
                }
              : {
                  ...base,
                  object: 'chat.completion',
                  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                  usage,
                },
          ),
        )
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      sseChunk(res, {
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })

      // 浏览器是整段给的，所以要按增量算差值；webchat 本来就逐段给
      let emitted = ''
      let any = false

      /**
       * 带工具时要多一层判断：模型可能吐的是工具调用 JSON，那东西不能当正文
       * 流出去 —— DSH 会把 `{"tool_call":...}` 原样显示成回答，用户看到一堆
       * JSON，工具却不会被执行。
       *
       * 所以第一个非空白字符是 `{` 或反引号就先扣住，等这轮结束再决定：
       * 解析得出工具调用就发 tool_calls，否则当普通正文补发。
       */
      let holding = Boolean(offered)

      await run(
        messages,
        (partial) => {
          if (typeof partial !== 'string' || partial.length <= emitted.length) return
          // 内容被上游重写过（少见）时，差值也要吐出去，否则会卡住不动
          const piece = partial.startsWith(emitted) ? partial.slice(emitted.length) : partial
          emitted = partial
          if (!piece) return

          if (holding) {
            const head = partial.trimStart()[0] || ''
            if (!head) return // 还全是空白，先不下结论
            if (head === '{' || head === '`') return // 像 JSON，继续扣着
            holding = false // 是正文，放行（连同刚才扣住的一起发）
          }

          any = true
          sseChunk(res, {
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })
        },
        { thinking, tools: offered },
      )

      // 扣住的这段到底是不是工具调用，现在才知道
      const call = offered && holding && !any ? parseToolCall(emitted) : null
      if (call) {
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...makeToolCall(call) }] }, finish_reason: null }],
        })
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 扣住了但并不是工具调用（比如模型就是想输出一段 JSON 文本）：补发出去
      if (holding && !any && emitted) {
        any = true
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: emitted }, finish_reason: null }],
        })
      }

      if (!any) {
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
        })
      }
      sseChunk(res, {
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (e) {
      const msg = String(e?.message || e)
      log(`本地处理失败：${msg}`)
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      try {
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: `[中转错误] ${msg}` }, finish_reason: null }],
        })
        sseChunk(res, {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
        res.write('data: [DONE]\n\n')
      } catch {
        /* 忽略 */
      }
      res.end()
    }
  }
}
