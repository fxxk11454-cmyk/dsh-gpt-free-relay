/**
 * 本地驱动 ChatGPT 网页会话，产出 OpenAI 兼容的回答。
 *
 * 链路：
 *   /v1/chat/completions ──► sentinel（PoW + turnstile）──► /backend-api/conversation ──► SSE ──► OpenAI chunk
 *
 * 全程在 host 端跑，不需要浏览器参与（PoW 与 turnstile 都是纯 Node 实现，
 * 见 lib/chatgpt/pow.ts 与 turnstile.ts）。
 */
import { randomUUID } from 'node:crypto'
import { getSentinelTokens } from './sentinel.ts'

const BASE = 'https://chatgpt.com'
const CONV_URL = `${BASE}/backend-api/conversation`

/**
 * 被 Cloudflare 挑战时的提示语。
 *
 * 这里**不打算硬过验证**——challenge 是给人看的，就得让人去过。
 * 用户在内嵌页面里过完之后，cf_clearance 会经代理流下来被我们存住，
 * host 端的请求带上它就不再被挑战。所以这句话的重点是"去哪儿过"。
 */
export const CHALLENGE_HINT =
  '被 Cloudflare 人机验证拦住了。请切到卡片的「网页端」，等页面加载出来后按提示完成一次验证' +
  '（通常点一下复选框即可），然后回来重试。验证凭证会自动保存，不用每次过。'

/** ChatGPT 网页端认的模型 slug。默认 auto —— 让 ChatGPT 自己挑，省得跟着上游改。 */
export const DEFAULT_WEB_MODEL = 'auto'

/**
 * 把 OpenAI 的 messages 转成 ChatGPT 的 messages。
 *
 * `system` 会被并进第一条 user 消息：网页端对独立 system 消息的接受度不稳定，
 * 并进去是最兼容的做法。
 */
export function toChatGptMessages(messages) {
  const sys = []
  const rest = []
  for (const m of messages || []) {
    const role = m?.role || 'user'
    const content = typeof m?.content === 'string' ? m.content : flattenContent(m?.content)
    if (!content) continue
    if (role === 'system' || role === 'developer') sys.push(content)
    else rest.push({ role: role === 'tool' ? 'user' : role, content })
  }
  if (sys.length) {
    const prefix = sys.join('\n\n')
    if (rest.length && rest[0].role === 'user') rest[0] = { ...rest[0], content: `${prefix}\n\n${rest[0].content}` }
    else rest.unshift({ role: 'user', content: prefix })
  }
  return rest
}

/** OpenAI 的 content 允许是分片数组，这里拍平成纯文本。 */
function flattenContent(content) {
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

/** 构造 /backend-api/conversation 的请求体。 */
export function buildPayload(model, messages, opts = {}) {
  return {
    action: 'next',
    messages: messages.map((m) => ({
      id: randomUUID(),
      author: { role: m.role },
      content: { content_type: 'text', parts: [m.content] },
    })),
    parent_message_id: opts.parentMessageId || randomUUID(),
    model: model || DEFAULT_WEB_MODEL,
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_rate_limit: false,
    force_use_sse: true,
    timezone_offset_min: -480,
    // 不留历史，避免污染用户自己的会话列表
    history_and_training_disabled: opts.temporary !== false,
    system_hints: [],
    ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
  }
}

//#region 流式解析

/** 逐条吐出 SSE 的 data 负载。 */
async function* sseData(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        yield data
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 新版接口用 JSON Patch 增量下发，老版直接给整条 message。
 * 两种都要吃得下，否则会退化成"一个字都不吐"。
 */
function applyOp(state, op) {
  const path = typeof op?.p === 'string' ? op.p : ''
  const kind = op?.o
  const value = op?.v
  if (!path || path === '/') {
    if (value && typeof value === 'object') Object.assign(state, value)
    return state
  }
  const segs = path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur = state
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]
    if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(segs[i + 1]) ? [] : {}
    cur = cur[k]
  }
  const last = segs[segs.length - 1]
  if (kind === 'append') {
    const base = cur[last]
    if (typeof base === 'string') cur[last] = base + (typeof value === 'string' ? value : '')
    else if (Array.isArray(base)) base.push(value)
    else cur[last] = value
  } else if (kind === 'remove') {
    if (Array.isArray(cur) && /^\d+$/.test(last)) cur.splice(Number(last), 1)
    else delete cur[last]
  } else if (kind === 'patch') {
    // 嵌套 patch 有两种形态：op 数组，或直接一个对象
    if (Array.isArray(value)) {
      const target = segs.length ? cur[last] ?? (cur[last] = {}) : cur
      for (const sub of value) applyOp(target, sub)
    } else if (value && typeof value === 'object') {
      applyPatchInto(segs.length ? (cur[last] ?? (cur[last] = {})) : cur, value)
    }
  } else {
    cur[last] = value
  }
  return state
}

function applyPatchInto(obj, patchObj) {
  for (const [k, v] of Object.entries(patchObj || {})) {
    if (typeof v === 'string' && typeof obj[k] === 'string') obj[k] += v
    else obj[k] = v
  }
  return obj
}

/** 从累积出来的 message 里抠出助手文本。 */
export function extractText(message) {
  const parts = message?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts.filter((p) => typeof p === 'string').join('')
}

//#endregion

export class WebChat {
  /**
   * @param {object} deps
   * @param {import('./session.js').WebSession} deps.session
   * @param {string} [deps.webModel]
   * @param {Function} [deps.log]
   */
  constructor({ session, webModel, log } = {}) {
    this.session = session
    this.webModel = webModel || DEFAULT_WEB_MODEL
    this.log = log || (() => {})
    this.lastSentinel = null
  }

  /**
   * 跑一轮对话，边生成边吐出增量文本。
   * @returns {AsyncGenerator<string>}
   */
  async *stream(messages, options = {}) {
    const session = this.session
    if (!session) throw new Error('会话未初始化')

    // token 可能是刚过期的，先确保它新鲜
    await session.refresh()
    if (!session.loggedIn) {
      throw new Error(
        session.lastError ||
          '还没有登录 ChatGPT —— 请打开卡片里的「网页端」，在那个页面里登录一次即可',
      )
    }

    const headers = session.backendHeaders()
    let sentinel
    try {
      sentinel = await getSentinelTokens(headers)
    } catch (e) {
      const msg = String(e?.message || e)
      if (/403|429|challenge|HTTP 5/i.test(msg)) {
        session.markChallenged()
        throw new Error(`${CHALLENGE_HINT}（sentinel: ${msg.slice(0, 120)}）`)
      }
      throw e
    }
    this.lastSentinel = { at: Date.now(), hasProof: Boolean(sentinel.proof), hasTurnstile: Boolean(sentinel.turnstile) }

    const sendHeaders = {
      ...headers,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'openai-sentinel-chat-requirements-token': sentinel['chat-requirements'],
    }
    if (sentinel.proof) sendHeaders['openai-sentinel-proof-token'] = sentinel.proof
    if (sentinel.turnstile) sendHeaders['openai-sentinel-turnstile-token'] = sentinel.turnstile

    const model = options.model && options.model !== 'free-chat' ? options.model : this.webModel
    const payload = buildPayload(model, toChatGptMessages(messages), options)

    const res = await fetch(CONV_URL, {
      method: 'POST',
      headers: sendHeaders,
      body: JSON.stringify(payload),
      signal: options.signal,
    })

    if (res.status === 401) throw new Error('401：网页端会话已失效，请到「网页端」重新登录')
    if (res.status === 403 || res.headers.get('cf-mitigated')) {
      session.markChallenged()
      throw new Error(CHALLENGE_HINT)
    }
    if (res.status === 429) throw new Error('429：被限流了，等一会儿再试')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}：${body.slice(0, 300)}`)
    }

    const state = {}
    let emitted = ''
    let convId = options.conversationId || null
    this.lastResult = { conversationId: null, text: '' }

    for await (const data of sseData(res)) {
      let obj
      try {
        obj = JSON.parse(data)
      } catch {
        continue
      }
      if (!obj || typeof obj !== 'object') continue

      const err = obj.error
      if (err) throw new Error(`ChatGPT 返回错误：${typeof err === 'string' ? err : JSON.stringify(err).slice(0, 300)}`)
      if (obj.type === 'error') throw new Error(`ChatGPT 错误：${JSON.stringify(obj).slice(0, 300)}`)

      if (obj.conversation_id) convId = obj.conversation_id

      if (typeof obj.o === 'string' && (obj.p !== undefined || obj.v !== undefined)) {
        applyOp(state, obj)
      } else if (obj.message) {
        state.message = obj.message
      }

      const full = extractText(state.message)
      if (full.length > emitted.length && full.startsWith(emitted)) {
        yield full.slice(emitted.length)
        emitted = full
      } else if (full.length > emitted.length && !full.startsWith(emitted)) {
        // 上游重写了内容（少见）——把差值当新内容吐出去
        yield full.slice(emitted.length)
        emitted = full
      }

      if (obj.type === 'message_stream_complete') break
    }

    // for-await 拿不到 generator 的 return 值，结果挂到实例上
    this.lastResult = { conversationId: convId, text: emitted }
  }
}
