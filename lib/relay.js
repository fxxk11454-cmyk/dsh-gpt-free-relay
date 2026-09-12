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

/** 剥掉所有工具相关字段。 */
export function stripTools(bodyText) {
  try {
    const body = JSON.parse(bodyText)
    if (!body || typeof body !== 'object') return bodyText
    let touched = false
    for (const k of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']) {
      if (k in body) {
        delete body[k]
        touched = true
      }
    }
    return touched ? JSON.stringify(body) : bodyText
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

/** 过滤流式响应里可能出现的 tool_calls 增量。 */export function filterToolCalls(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const choices = payload.choices
  if (!Array.isArray(choices)) return payload
  for (const c of choices) {
    const d = c?.delta
    if (d && typeof d === 'object' && 'tool_calls' in d) delete d.tool_calls
    if (c?.message && typeof c.message === 'object' && 'tool_calls' in c.message) delete c.message.tool_calls
  }
  return payload
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
    this.gate = new SerialGate()
    this.server = null
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
    }
  }

  async listen() {
    if (this.server) return null
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', resolvePromise)
    })
    this.log(`串行反向代理已监听 127.0.0.1:${this.port}（并发强制为 1）`)
    return null
  }

  close() {
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

      // 先剥工具，再把统一入口名换成真上游型号
      const prepared = rewriteModel(stripTools(raw), this.modelAlias, this.upstreamModel)

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
