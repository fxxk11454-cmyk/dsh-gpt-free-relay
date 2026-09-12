/**
 * OpenAI 兼容层：把 /v1/chat/completions 的请求交给网页会话，再按 OpenAI 的格式吐回去。
 *
 * 这一层是"请求统一本地处理"的落点 —— DSH 完全不知道背后是网页会话，
 * 它只看到一个标准的 openai-completions provider。
 *
 * 顺带一个好处：输出是我们自己拼的，**天然不含 tool_calls**，
 * 「不传工具」这条约束在这一条链路上是结构上成立的，不靠过滤。
 */
import { randomUUID } from 'node:crypto'

/** 判断是不是我们要接管的对话请求。 */
export function isChatPath(url) {
  return /\/v1\/chat\/completions(\?|$)/.test(String(url || '')) || /\/chat\/completions(\?|$)/.test(String(url || ''))
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

/**
 * 造一个本地处理器。
 * @param {{webchat: import('./webchat.js').WebChat, log?: Function}} deps
 * @returns {(bodyText: string, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createLocalChatHandler({ webchat, log = () => {} }) {
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

    try {
      if (!wantStream) {
        // 非流式：先把整段收完
        let text = ''
        for await (const d of webchat.stream(messages)) text += d
        const payload = {
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
        return
      }

      // 流式：先发头，再边收边转
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 开场必须先给一个 role delta，某些客户端据此初始化消息
      sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

      let any = false
      for await (const d of webchat.stream(messages)) {
        if (!d) continue
        any = true
        sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: d }, finish_reason: null }] })
      }
      if (!any) {
        // 一个字都没吐出来：明确说一句，别让上游看到空回答
        sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] })
      }
      sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (e) {
      const msg = String(e?.message || e)
      log(`本地处理失败：${msg}`)
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      }
      // 流已经开了就不能改状态码，只能把错误当内容送出去，让用户看到原因
      try {
        sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `[中转错误] ${msg}` }, finish_reason: null }] })
        sseChunk(res, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
      } catch {
        /* 忽略 */
      }
      res.end()
    }
  }
}
