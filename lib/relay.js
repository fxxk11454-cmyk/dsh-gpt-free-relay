/**
 * 本地串行反向代理。
 *
 * 两个硬性约束（由使用方明确要求）：
 *
 * 1. **强制并发 1** —— 所有请求进入同一条串行队列；只有当前请求的响应体
 *    **完全写回客户端之后**，下一个请求才会被放行。不是"排队发出去"，
 *    而是真正等上一轮结束。
 *
 * 2. **不允许工具调用** —— 请求体里的 `tools` / `tool_choice` / `functions` /
 *    `function_call` 一律剥掉；响应流里若出现 `tool_calls`，也一并过滤，
 *    模型因此看不到工具，也不会试图调用。
 *
 * 转发路径：客户端 → 本服务器 → 本机 Xray 的 HTTP 入站（127.0.0.1:HTTP_PORT）→ 机场线路 → 上游。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { HTTP_PORT, RELAY_PORT } from './xray.js'

/** 串行闸门：保证并发为 1，且必须等上一轮彻底结束。 */
export class SerialGate {
  constructor() {
    this.tail = Promise.resolve()
    this.depth = 0
    this.current = null
  }

  get waiting() {
    return Math.max(0, this.depth - (this.current ? 1 : 0))
  }

  /** 把任务排进队列；返回的 Promise 在任务真正跑完时 settle。 */
  run(label, task) {
    this.depth += 1
    const started = this.tail.then(
      () => {
        this.current = label
        return task()
      },
      () => {
        this.current = label
        return task()
      },
    )
    // 无论成败都推进队列，且不吞掉调用方拿到的结果
    this.tail = started.then(
      () => {
        this.depth -= 1
        this.current = null
      },
      () => {
        this.depth -= 1
        this.current = null
      },
    )
    return started
  }
}

/** 经本机 Xray HTTP 代理建立到目标的隧道（HTTPS 用 CONNECT）。 */
export function connectThroughProxy(targetHost, targetPort) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      agent: false,
      timeout: 20000,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`))
        return
      }
      resolvePromise(socket)
    })
    req.on('timeout', () => {
      req.destroy(new Error('代理 CONNECT 超时'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 递归剥掉所有工具相关字段。
 *
 * 为什么必须递归：只删顶层那 5 个键是不够的。DSH 发多轮对话时，历史里
 * 本来就带着上一轮的 `assistant.tool_calls` 和 `role:"tool"` 的消息 ——
 * 实测这些会原样透传给上游，模型的上下文里于是**看得见工具调用记录**，
 * 与「不允许工具调用」这条硬约束直接冲突。
 *
 * 递归要处理三种形态：
 *   1. 对象键：tools / tool_choice / functions / function_call / parallel_tool_calls
 *   2. 消息数组里的 assistant.tool_calls（连同被它引用的 tool 消息一起删）
 *   3. content 数组里的 {type:"tool_result"} / {type:"tool_use"} 分片
 *
 * 注意：只删"工具语义"的结构，不动普通 content。消息本身保留，
 * 免得把对话轮次也削掉导致上下文对不上。
 */
const TOOL_KEYS = ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']

/** 这是不是一个"工具回执"消息（role=tool，或 content 全是 tool_result）。 */
function isToolMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.role === 'tool' || m.role === 'function') return true
  const parts = Array.isArray(m.content) ? m.content : null
  if (parts && parts.length && parts.every((p) => p && typeof p === 'object' && /^tool_(result|use)$/.test(String(p.type)))) {
    return true
  }
  return false
}

/** 递归清理任意层级的工具字段。返回是否改动过。 */
function scrub(node, depth = 0) {
  // 防御性深度上限：畸形输入不该把栈打爆
  if (!node || typeof node !== 'object' || depth > 12) return false
  let touched = false

  if (Array.isArray(node)) {
    for (const item of node) if (scrub(item, depth + 1)) touched = true
    return touched
  }

  for (const k of TOOL_KEYS) {
    if (k in node) {
      delete node[k]
      touched = true
    }
  }

  // 消息内联的 tool_calls（assistant 上一轮调过工具）。它不在顶层，
  // 但同样是"工具语义"，必须一起删。
  if ('tool_calls' in node) {
    delete node.tool_calls
    touched = true
  }

  // content 数组里的工具分片
  if (Array.isArray(node.content)) {
    const kept = node.content.filter((p) => {
      const isToolPart = p && typeof p === 'object' && /^tool_(result|use)$/.test(String(p.type))
      if (isToolPart) touched = true
      return !isToolPart
    })
    if (kept.length !== node.content.length) node.content = kept
  }

  // 全键递归。原来只走 messages/choices/delta/message/input/data 这几个
  // 已知键，任何自定义容器（比如 {a:{b:{messages:[…]}}}）都会漏过去。
  // 这里改成遍历所有键，但只对"工具语义"做删除 —— 普通 content 一个字节不动。
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object') continue
    if (scrub(value, depth + 1)) touched = true
    // assistant.tool_calls 被删掉之后，紧跟其后的 role:tool 回执就失去所指，
    // 一并删掉，否则上游会看到孤立的 tool 消息而报 400。
    if (Array.isArray(value)) {
      const cleaned = value.filter((m) => !isToolMessage(m))
      if (cleaned.length !== value.length) {
        node[key] = cleaned
        touched = true
      }
    }
  }

  return touched
}

export function stripTools(bodyText) {
  try {
    const body = JSON.parse(bodyText)
    if (!body || typeof body !== 'object') return bodyText
    return scrub(body) ? JSON.stringify(body) : bodyText
  } catch {
    return bodyText
  }
}

/**
 * 统一模型入口：把别名（默认 `free-chat`）换成真正的上游模型名。
 *
 * 为什么要这层：网页版的模型名一直在变，写死一长串列表就是给自己找维护。
 * 对外只暴露一个稳定入口，真正的型号收敛到这一处，改一个字符串就行。
 *
 * 只替换完全相等的别名 —— 客户端如果直接点名真实型号（比如 `gpt-4o`），
 * 原样透传，不会被这层吃掉。
 */
export function rewriteModel(bodyText, alias, target) {
  if (!alias || !target || alias === target) return bodyText
  try {
    const body = JSON.parse(bodyText)
    if (!body || typeof body !== 'object' || body.model !== alias) return bodyText
    body.model = target
    return JSON.stringify(body)
  } catch {
    return bodyText
  }
}

/**
 * 过滤流式响应里可能出现的 tool_calls 增量。
 *
 * 光把 `tool_calls` 删掉还不够：如果上游把 `finish_reason` 报成
 * `"tool_calls"`，客户端（DSH 那侧）会据此认为"模型要调工具"，转头去
 * 找工具结果 —— 可内容已经被我们剥空了，什么都没有。表现是消息**空转**，
 * 界面上一片空白，还查不出原因。
 *
 * 所以这里把 finish_reason 也归一化：凡是工具相关的终止原因，一律
 * 改写成 stop，让客户端老老实实收下这段文本。
 *
 * @param {object} payload 一条 OpenAI 兼容的响应/分片
 * @param {boolean} [inPlace] true 时原地改（流式路径逐条处理，省一次拷贝）
 */
export function filterToolCalls(payload, inPlace = true) {
  if (!payload || typeof payload !== 'object') return payload
  const out = inPlace ? payload : JSON.parse(JSON.stringify(payload))

  const fixReason = (holder) => {
    if (!holder || typeof holder !== 'object') return
    const r = holder.finish_reason
    if (typeof r === 'string' && /^tool(_calls)?$/i.test(r)) {
      holder.finish_reason = isDone(holder) ? 'stop' : null
    }
  }
  /**
   * 这一条是不是"收尾帧"。
   *
   * 判据是 delta 里有没有实际内容，而不是 delta 这个键在不在 ——
   * 收尾帧普遍长成 `{delta:{}, finish_reason:"tool_calls"}`，delta 是空对象。
   * 只看键存不存在会把它当成中途分片，于是 finish_reason 被错误地留成
   * null，客户端永远等不到结束信号。
   */
  const isDone = (holder) => {
    if (holder.message) return true // 非流式：整条消息
    const d = holder.delta
    if (!d || typeof d !== 'object') return true // 连 delta 都没有，也只能是收尾
    return Object.keys(d).length === 0
  }

  const choices = out.choices
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const d = c?.delta
      if (d && typeof d === 'object' && 'tool_calls' in d) delete d.tool_calls
      if (c?.message && typeof c.message === 'object' && 'tool_calls' in c.message) delete c.message.tool_calls
      fixReason(c)
    }
  }
  return out
}

export class SerialRelay {
  /**
   * @param {{upstreamBase: string, apiKey: string, port?: number, log?: Function}} options
   */
  constructor(options) {
    this.upstreamBase = String(options.upstreamBase || '').replace(/\/+$/, '')
    this.apiKey = options.apiKey || ''
    this.port = options.port ?? RELAY_PORT
    this.log = options.log || (() => {})
    /** 对外统一的模型入口名（provider 里只声明这一个） */
    this.modelAlias = options.modelAlias || 'free-chat'
    /** 别名实际换成的上游模型名 —— 网页版型号更新时只改这里 */
    this.upstreamModel = options.upstreamModel || 'gpt-4o-mini'
    /**
     * 本地处理器：`{match(url), handle(bodyText, res)}`。
     * 设了它，匹配到的请求就不出网，由网页会话本地作答。
     */
    this.localHandler = options.localHandler || null
    this.gate = new SerialGate()
    this.server = null
    /** close() 之后置真，listen() 据此拒绝"复活" */
    this.closed = false
    this.stats = { total: 0, done: 0, dropped: 0 }
  }

  get status() {
    return {
      listening: Boolean(this.server),
      port: this.port,
      upstreamBase: this.upstreamBase,
      concurrency: 1,
      inFlight: this.gate.current,
      waiting: this.gate.waiting,
      stats: { ...this.stats },
      modelAlias: this.modelAlias,
      upstreamModel: this.upstreamModel,
      localChat: Boolean(this.localHandler),
    }
  }

  /** 装上/摘掉本地处理器（网页会话就绪后调用）。 */
  setLocalHandler(handler) {
    this.localHandler = handler || null
  }

  async listen() {
    if (this.server) return null
    /**
     * close() 之后不许再 listen。
     *
     * 这是防"复活"的第二道闸：即使有谁在卸载之后又调了一次 listen
     * （比如没被取消的定时器），也只能拿到一个明确的错误，
     * 而不是悄悄把端口重新占上。
     */
    if (this.closed) return '串行反向代理已关闭，不再接受监听'
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', resolvePromise)
    })
    this.log(`串行反向代理已监听 127.0.0.1:${this.port}（并发强制为 1）`)
    return null
  }

  close() {
    this.closed = true
    if (!this.server) return
    try {
      this.server.close()
    } catch {
      /* 忽略 */
    }
    this.server = null
  }

  handle(req, res) {
    // 队列里第 N 个：先把请求体收完，再排队（排队期间不占用上游）
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const label = `${req.method} ${req.url}`
      this.stats.total += 1

      // 先剥工具（两条路都要）
      const stripped = stripTools(raw)

      // 「统一本地处理」：对话请求交给网页会话，不出网到 api.openai.com。
      // 注意这条分支**不做型号改写** —— 改写的目标（upstreamModel）是给上游 API 用的，
      // 网页会话有自己的 slug（默认 auto），混用会把型号改错。
      const local = this.localHandler
      if (local && local.match(req.url)) {
        this.gate
          .run(label, () => local.handle(stripped, res))
          .then(
            () => {
              this.stats.done += 1
            },
            () => {
              this.stats.dropped += 1
            },
          )
        return
      }

      // 转发路：把统一入口名换成真上游型号
      const prepared = rewriteModel(stripped, this.modelAlias, this.upstreamModel)

      // 关键：整个"转发 + 流式回写"都在串行闸门内，前一个没写完不会开始下一个
      this.gate
        .run(label, () => this.forward(req, res, prepared))
        .then(
          () => {
            this.stats.done += 1
          },
          (err) => {
            this.stats.dropped += 1
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { message: String(err?.message || err) } }))
            } else {
              try {
                res.end()
              } catch {
                /* 忽略 */
              }
            }
          },
        )
    })
  }

  /** 真正的转发；返回的 Promise 在响应体彻底写完后才 resolve。 */
  async forward(clientReq, clientRes, bodyText) {
    if (!this.upstreamBase) throw new Error('未配置上游地址')

    const base = new URL(this.upstreamBase)
    const targetPath = clientReq.url || '/'
    const isHttps = base.protocol === 'https:'
    const targetPort = Number(base.port) || (isHttps ? 443 : 80)
    const targetHost = base.hostname

    const headers = {
      'content-type': clientReq.headers['content-type'] || 'application/json',
      accept: clientReq.headers.accept || 'application/json',
      'user-agent': clientReq.headers['user-agent'] || 'dsh-gpt-free-relay',
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    if (clientReq.headers['accept-language']) headers['accept-language'] = clientReq.headers['accept-language']
    const bodyBuf = Buffer.from(bodyText, 'utf8')
    headers['content-length'] = String(bodyBuf.length)

    // 统一经本机 Xray 的 HTTP 代理出网（CONNECT 隧道）
    const socket = await connectThroughProxy(targetHost, targetPort)
    const agent = new https.Agent({ keepAlive: false })
    agent.createConnection = (opts, cb) => {
      const tlsSocket = tls.connect({ socket, servername: targetHost, ...opts })
      tlsSocket.once('secureConnect', () => cb(null, tlsSocket))
      tlsSocket.once('error', cb)
      return tlsSocket
    }

    const path = base.pathname.replace(/\/+$/, '') + targetPath

    await new Promise((resolvePromise, reject) => {
      const upstream = (isHttps ? https : http).request(
        {
          host: targetHost,
          port: targetPort,
          method: clientReq.method,
          path,
          headers,
          agent: isHttps ? agent : undefined,
        },
        (upRes) => {
          const ct = String(upRes.headers['content-type'] || '')
          const isStream = ct.includes('text/event-stream')

          clientRes.writeHead(upRes.statusCode || 502, {
            'content-type': ct || 'application/json',
            'cache-control': 'no-store',
          })

          if (!isStream) {
            const parts = []
            upRes.on('data', (c) => parts.push(c))
            upRes.on('end', () => {
              let payload = Buffer.concat(parts).toString('utf8')
              try {
                payload = JSON.stringify(filterToolCalls(JSON.parse(payload)))
              } catch {
                /* 非 JSON 原样透传 */
              }
              clientRes.end(payload)
            })
            upRes.on('error', reject)
            return
          }

          // SSE：逐行过滤 tool_calls 后回写
          let buffer = ''
          upRes.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data:')) {
                clientRes.write(line + '\n')
                continue
              }
              const data = line.slice(5).trim()
              if (!data || data === '[DONE]') {
                clientRes.write(line + '\n')
                continue
              }
              try {
                clientRes.write('data: ' + JSON.stringify(filterToolCalls(JSON.parse(data))) + '\n')
              } catch {
                clientRes.write(line + '\n')
              }
            }
          })
          upRes.on('end', () => {
            if (buffer) clientRes.write(buffer)
            clientRes.end()
          })
          upRes.on('error', reject)
        },
      )

      upstream.on('error', reject)
      upstream.end(bodyBuf)
    })
  }
}
