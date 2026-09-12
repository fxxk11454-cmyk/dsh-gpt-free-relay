/**
 * dsh-gpt-free-relay —— DSH 插件（从 Android 版 GPT Free 代理移植）。
 *
 * 提供的能力：
 *   - 机场订阅解析（Clash YAML 区块/流式、base64、明文 URI）
 *   - 内置 Xray 核心子进程（SOCKS5 + HTTP 双本地入站）
 *   - **本地串行反向代理**：并发强制为 1，必须等上一轮回答彻底结束才放行下一个；
 *     并且完全剥掉工具调用（tools / tool_choice / functions），模型看不到工具
 *
 * 让 DSH 走机场的方式：把模型 provider 的 baseURL 指向
 * `http://127.0.0.1:<relayPort>/v1`（默认 2082），转发会自动经机场出网。
 *
 * 移植说明：Android 版的「网页模式（WebView + DOM 转发）」和安卓 UI 依赖系统组件，
 * 在 DSH 里没有对应物，因此未移植；其余功能都在。
 */
import http from 'node:http'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { parseSubscription } from './subscription.js'
import { XrayCore, findCore, UNSUPPORTED, SOCKS_PORT, HTTP_PORT, RELAY_PORT, PLUGIN_ROOT } from './xray.js'
import { SerialRelay } from './relay.js'

export const name = 'dsh-gpt-free-relay'
export const inject = []

const ADMIN_PORT = 2083

export function apply(ctx, config = {}) {
  const log = (m) => {
    try {
      ctx?.logger?.info?.(`[gpt-free-relay] ${m}`)
    } catch {
      /* 忽略 */
    }
  }
  const state = createRelayState({ ...config, log })
  state.startAdmin()
  try {
    ctx?.effect?.(() => () => state.dispose(), 'gpt-free-relay: lifecycle')
  } catch {
    /* 非 Cordis 环境（例如单测）直接跳过 */
  }
  if (config.autoConnect) state.connect().catch(() => {})
  log(`已就绪；管理接口 http://127.0.0.1:${ADMIN_PORT}/status`)
  return state
}

export function createRelayState(options = {}) {
  const log = options.log || (() => {})
  const workDir = options.workDir || join(PLUGIN_ROOT, '.runtime')
  mkdirSync(workDir, { recursive: true })

  const core = new XrayCore({ corePath: findCore(options.corePath), workDir })
  const relay = new SerialRelay({
    upstreamBase: options.upstreamBase || 'https://api.openai.com/v1',
    apiKey: options.apiKey || '',
    port: options.relayPort || RELAY_PORT,
    log,
  })

  let nodes = []
  let selectedIndex = -1
  let admin = null

  const status = () => ({
    ok: true,
    coreRunning: core.isRunning(),
    nodeCount: nodes.length,
    selected: selectedIndex >= 0 ? nodes[selectedIndex] : null,
    ports: { socks: SOCKS_PORT, http: HTTP_PORT, relay: relay.port },
    relay: relay.status,
    concurrency: 1,
    toolsAllowed: false,
  })

  async function fetchSubscription(url) {
    const res = await fetch(url, { headers: { 'user-agent': 'ClashMeta/1.18.0' } })
    if (!res.ok) throw new Error(`订阅拉取失败 HTTP ${res.status}`)
    const body = await res.text()
    const parsed = parseSubscription(body)
    nodes = parsed.nodes
    selectedIndex = nodes.length ? 0 : -1
    log(`订阅解析：${parsed.kind} —— ${parsed.detail}`)
    return { ...parsed, nodes: nodes.map((n) => ({ name: n.name, protocol: n.protocol, server: n.server, port: n.port })) }
  }

  async function connect(indexOrName) {
    if (!nodes.length) throw new Error('还没有节点：请先 POST /subscription')
    let idx = selectedIndex
    if (typeof indexOrName === 'number') idx = indexOrName
    else if (typeof indexOrName === 'string' && indexOrName) {
      const found = nodes.findIndex((n) => n.name === indexOrName)
      if (found < 0) throw new Error(`找不到节点：${indexOrName}`)
      idx = found
    }
    const node = nodes[idx] ?? nodes[0]
    selectedIndex = idx < 0 ? 0 : idx

    if (UNSUPPORTED.has(node.protocol)) {
      throw new Error(`该节点是 ${node.protocol}，Xray 核心不支持；请换 vmess / vless / trojan / ss 节点`)
    }

    core.stop()
    core.write(node)
    const err = await core.start()
    if (err) throw new Error(err)

    const listenErr = await relay.listen()
    if (listenErr) throw new Error(listenErr)

    log(`已连接：${node.name || node.server}（${node.protocol}）`)
    return { node: { name: node.name, protocol: node.protocol, server: node.server, port: node.port }, ports: status().ports }
  }

  function disconnect() {
    core.stop()
    relay.close()
    log('已断开')
    return { ok: true }
  }

  /** 本地管理接口：DSH 里的 agent 可以直接 curl 驱动它。 */
  function startAdmin() {
    if (admin) return null
    admin = http.createServer((req, res) => {
      // 设置卡片在浏览器里跨端口访问这个接口，需要 CORS
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      }
      const send = (code, obj) => {
        const body = JSON.stringify(obj, null, 2)
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...cors })
        res.end(body)
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = `${req.method} ${url.pathname}`
      const collect = (cb) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')))
      }

      try {
        if (route === 'GET /status') return send(200, status())
        if (route === 'GET /nodes') return send(200, { nodes: nodes.map((n, i) => ({ index: i, name: n.name, protocol: n.protocol, server: n.server, port: n.port })) })
        if (route === 'GET /config') {
          let text = ''
          try {
            text = readFileSync(core.configPath, 'utf8')
          } catch {
            text = '(尚未生成，请先 connect)'
          }
          return send(200, { path: core.configPath, config: text, log: core.errorSummary() })
        }
        if (route === 'POST /subscription') {
          return collect(async (body) => {
            try {
              const payload = JSON.parse(body || '{}')
              if (!payload.url) return send(400, { error: '缺少 url' })
              return send(200, await fetchSubscription(payload.url))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /connect') {
          return collect(async (body) => {
            try {
              const payload = JSON.parse(body || '{}')
              return send(200, await connect(payload.index ?? payload.name))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /disconnect') return send(200, disconnect())
        return send(404, { error: `未知路由 ${route}` })
      } catch (e) {
        return send(500, { error: String(e?.message || e) })
      }
    })
    admin.listen(ADMIN_PORT, '127.0.0.1', () => log(`管理接口已监听 http://127.0.0.1:${ADMIN_PORT}/status`))
    admin.on('error', (e) => log(`管理接口启动失败：${String(e?.message || e)}`))
    return null
  }

  function dispose() {
    try {
      core.stop()
      relay.close()
      admin?.close()
    } catch {
      /* 忽略 */
    }
    admin = null
  }

  return { status, fetchSubscription, connect, disconnect, startAdmin, dispose, get nodes() { return nodes } }
}

export default { name, inject, apply }
