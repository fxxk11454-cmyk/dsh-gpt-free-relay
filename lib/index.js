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
import { createRequire } from 'node:module'

/**
 * schemastery 由 DSH 提供，但插件目录不一定在解析路径上。
 * 这里做多路径兜底 + 失败降级：拿不到就不注册设置命名空间，
 * 但绝不让整个 host 插件加载失败。
 */
async function loadSchema() {
  const candidates = [
    '@deepseek-ai/schemastery',
    '/root/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  ]
  for (const c of candidates) {
    try {
      const m = await import(c)
      const v = m?.default ?? m?.Schema ?? m
      if (v && typeof v.object === 'function') return v
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const Schema = await loadSchema()
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { parseSubscription } from './subscription.js'
import { XrayCore, findCore, UNSUPPORTED, SOCKS_PORT, HTTP_PORT, RELAY_PORT, PLUGIN_ROOT } from './xray.js'
import { SerialRelay, connectThroughProxy } from './relay.js'
import https from 'node:https'
import tls from 'node:tls'
import { CONSOLE_HTML } from './ui.js'

export const name = 'dsh-gpt-free-relay'
export const inject = ['settings']

const ADMIN_PORT = 2083

/** 注册到「模型」区的 provider id 与模型入口 */
const PROVIDER_ID = 'gpt-free-relay'
/**
 * 对外**只暴露一个**统一入口，不再列一串具体型号。
 *
 * 原因：网页版那套的型号一直在变，写死 gpt-4o / gpt-4.1-mini 这类列表
 * 等于给自己埋维护债 —— 上游一更新，列表就过期。现在收敛成一个稳定别名，
 * 真型号只在中转的 `upstreamModel` 一处改（见 relay.js 的 rewriteModel）。
 * 客户端如果直接点名真实型号，中转会原样透传，不会被吃掉。
 */
const MODEL_ALIAS = 'free-chat'
const DEFAULT_MODELS = [MODEL_ALIAS]
/** 别名实际转发到哪个上游型号 —— 上游换型号时改这一个字符串 */
const DEFAULT_UPSTREAM_MODEL = 'gpt-4o-mini'
/** 「模型」区里显示的名字 */
const PROVIDER_DISPLAY_NAME = 'Free Chat'

/**
 * 凭据引用名。
 *
 * llm-pi-ai 的 provider profile 里**没有 apiKey 字段**，只有
 * `apiKeyEnv: z.string().role("credential-ref")` —— 它要的是"凭据名"，
 * 真正的值走 DSH 凭据库解析。之前写明文 apiKey 属于未知键，
 * 整条 profile 落不了盘，这就是「模型没出现」的原因。
 *
 * 中转链路上的 Key 由本插件自己注入，所以这里的值只是个占位，
 * 但**不能为空**：凭据 seam 的规则是"空值等于未配置"。
 */
const CREDENTIAL_REF = 'GPT_FREE_RELAY_API_KEY'

/** 「网页端」卡片里要渲染的站点（走同一套代理） */
const DEFAULT_WEB_TARGET = 'https://chatgpt.com'

/** 会被剥掉的"禁止被嵌入"响应头 —— 不剥掉 iframe 就加载不出来 */
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'strict-transport-security',
])

/** 设置命名空间：客户端那张卡片以它为 key，host 必须先注册它 */
const SETTINGS_NAMESPACE = 'gpt-free-relay'

/** 可在「插件配置」里持久化的字段 */
const ConfigSchema = Schema ? Schema.object({
  subscriptionUrl: Schema.string().default(''),
  upstreamBase: Schema.string().default('https://api.openai.com/v1'),
  apiKey: Schema.string().default(''),
  upstreamModel: Schema.string().default(DEFAULT_UPSTREAM_MODEL),
  selectedIndex: Schema.number().default(0),
}) : null

export function apply(ctx, config = {}) {
  const log = (m) => {
    try {
      ctx?.logger?.info?.(`[gpt-free-relay] ${m}`)
    } catch {
      /* 忽略 */
    }
  }
  const state = createRelayState({ ...config, log })

  // 关键：注册设置命名空间。客户端卡片用 settings.plugin.item + 这个 key 渲染，
  // 少了这一步，卡片不会出现在「插件配置」里。
  try {
    if (!Schema) {
      log('拿不到 schemastery，跳过设置命名空间注册（设置卡片不会出现）')
    } else if (typeof ctx?.settings?.register === 'function') {
      const scope = ctx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, { applies: 'live' })
      state.attachSettings(scope, async (patch) => {
        const ops = Object.entries(patch).map(([k, v]) => ({ op: 'set', path: [k], value: v }))
        if (ops.length) await ctx.settings.mutate(SETTINGS_NAMESPACE, ops)
      })
      log(`已注册设置命名空间 ${SETTINGS_NAMESPACE}`)
    } else {
      log('settings 服务不可用，设置卡片可能不会出现')
    }
  } catch (e) {
    log(`注册设置命名空间失败：${String(e?.message || e)}`)
  }

  state.startAdmin()

  /**
   * 把本轮代理注册成 llm-pi-ai 的 provider —— 「模型」区据此显示。
   * baseURL 指向本地串行代理，真正的上游与 Key 由代理注入。
   */
  const relayPort = state.status().ports.relay
  const publishProvider = async (models) => {
    if (typeof ctx?.settings?.mutate !== 'function') return 'settings.mutate 不可用，无法注册模型'

    // 第一步：凭据。apiKeyEnv 指向的名字必须在凭据库里存在，否则这条 route
    // 会被判成"未配置"，模型区里也就看不到。中转自己管 Key，值只是占位。
    let credentialNote = ''
    try {
      if (typeof ctx?.credentials?.set === 'function') {
        await ctx.credentials.set(CREDENTIAL_REF, 'relay-managed')
        credentialNote = `，凭据 ${CREDENTIAL_REF} 已写入`
      } else {
        credentialNote = `，credentials 服务不可用（${CREDENTIAL_REF} 未写入）`
      }
    } catch (e) {
      credentialNote = `，写凭据失败：${String(e?.message || e)}`
    }

    try {
      await ctx.settings.mutate('llm-pi-ai', [
        {
          op: 'set',
          path: ['providers', PROVIDER_ID],
          value: {
            displayName: PROVIDER_DISPLAY_NAME,
            api: 'openai-completions',
            baseURL: `http://127.0.0.1:${relayPort}/v1`,
            apiKeyEnv: CREDENTIAL_REF,
            models: (models && models.length ? models : DEFAULT_MODELS).map((id) => ({ id })),
          },
        },
      ])
      log(`已把 provider 注册进 llm-pi-ai（baseURL=http://127.0.0.1:${relayPort}/v1${credentialNote}）`)
      return null
    } catch (e) {
      const msg = String(e?.message || e)
      log(`注册 provider 失败：${msg}`)
      return msg
    }
  }
  state.attachPublisher(publishProvider)
  publishProvider().catch(() => {})

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
    modelAlias: MODEL_ALIAS,
    upstreamModel: options.upstreamModel || DEFAULT_UPSTREAM_MODEL,
    log,
  })

  let nodes = []
  let selectedIndex = -1
  let admin = null
  let settingsScope = null
  let settingsWriter = null
  let publishProvider = null
  /** 浏览器端 apply() 是否真的跑过（用于排查界面为何不出现） */
  let clientBeacon = null

  /**
   * 机场数据的落盘位置。
   *
   * 为什么不写进设置命名空间：`ctx.settings.register()` 返回的 scope 只有
   * get/watch，写入只能走 `ctx.settings.mutate`，而往 schema 里加字段一旦
   * 校验不过，整个命名空间注册失败 —— 卡片会直接消失。机场数据不是配置，
   * 是运行状态，放插件自己的目录里更合适，也不会污染 settings.yaml。
   */
  const storePath = join(workDir, 'airport.json')
  let subscriptionUrl = ''
  let storeSavedAt = 0

  /** 合并规则：只增不减 —— 新数据更短时保留旧的，这就是「保留最长的数据」。 */
  function mergeStore(prev, next) {
    const out = { ...prev, ...next }
    const older = Array.isArray(prev.nodes) ? prev.nodes : []
    const newer = Array.isArray(next.nodes) ? next.nodes : []
    if (newer.length < older.length) {
      out.nodes = older
      out.keptLonger = true
      out.nodesFrom = prev.savedAt || 0
    } else {
      out.keptLonger = false
      out.nodesFrom = next.savedAt || Date.now()
    }
    if (!next.subscriptionUrl) out.subscriptionUrl = prev.subscriptionUrl || ''
    if (next.subscriptionUrl && prev.subscriptionUrl && next.subscriptionUrl.length < prev.subscriptionUrl.length) {
      out.subscriptionUrl = prev.subscriptionUrl
    }
    return out
  }

  function loadStore() {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.nodes) && raw.nodes.length) {
          nodes = raw.nodes
          selectedIndex = Number.isInteger(raw.selectedIndex) ? raw.selectedIndex : 0
          if (selectedIndex < 0 || selectedIndex >= nodes.length) selectedIndex = 0
        }
        subscriptionUrl = typeof raw.subscriptionUrl === 'string' ? raw.subscriptionUrl : ''
        storeSavedAt = Number(raw.savedAt) || 0
        log(`已恢复上次的机场数据：${nodes.length} 个节点${subscriptionUrl ? '，订阅地址已保留' : ''}`)
      }
    } catch {
      /* 首次运行没有这个文件，正常 */
    }
  }

  function saveStore(patch) {
    try {
      let prev = {}
      try {
        prev = JSON.parse(readFileSync(storePath, 'utf8')) || {}
      } catch {
        prev = {}
      }
      const next = mergeStore(prev, { ...patch, savedAt: Date.now(), version: 1 })
      writeFileSync(storePath, JSON.stringify(next, null, 2), { mode: 0o600 })
      storeSavedAt = next.savedAt
      return next
    } catch (e) {
      log(`保存机场数据失败：${String(e?.message || e)}`)
      return null
    }
  }

  function storeInfo() {
    return {
      path: storePath,
      savedAt: storeSavedAt,
      subscriptionUrl,
      nodeCount: nodes.length,
      nodes: nodes.map((n, i) => ({ index: i, name: n.name, protocol: n.protocol, server: n.server, port: n.port })),
    }
  }

  /** 清除数据：断开、清空节点、删掉落盘文件。卡片上的「清除数据」走这里。 */
  function clearData() {
    try {
      core.stop()
      relay.close()
    } catch {
      /* 忽略 */
    }
    nodes = []
    selectedIndex = -1
    subscriptionUrl = ''
    storeSavedAt = 0
    let removed = false
    try {
      rmSync(storePath, { force: true })
      removed = true
    } catch (e) {
      log(`删除机场数据文件失败：${String(e?.message || e)}`)
    }
    log('已清除机场数据')
    return { ok: true, removed, ...storeInfo() }
  }

  loadStore()

  const status = () => ({
    ok: true,
    coreRunning: core.isRunning(),
    nodeCount: nodes.length,
    selected: selectedIndex >= 0 ? nodes[selectedIndex] : null,
    ports: { socks: SOCKS_PORT, http: HTTP_PORT, relay: relay.port },
    relay: relay.status,
    concurrency: 1,
    toolsAllowed: false,
    clientBeacon,
    settingsNamespace: SETTINGS_NAMESPACE,
    settingsRegistered: Boolean(settingsScope),
    providerId: PROVIDER_ID,
    webTarget: options.webTarget || DEFAULT_WEB_TARGET,
    store: storeInfo(),
  })

  async function fetchSubscription(url) {
    const res = await fetch(url, { headers: { 'user-agent': 'ClashMeta/1.18.0' } })
    if (!res.ok) throw new Error(`订阅拉取失败 HTTP ${res.status}`)
    const body = await res.text()
    const parsed = parseSubscription(body)
    nodes = parsed.nodes
    selectedIndex = nodes.length ? 0 : -1
    subscriptionUrl = url
    const kept = saveStore({ subscriptionUrl: url, nodes, selectedIndex })
    let detail = parsed.detail
    // 落盘时发现这次拿到的更少 —— 那内存里也换回更长的那份，
    // 否则会出现"显示保留了 30 个、下拉框里只有 3 个"的分裂状态。
    if (kept && kept.keptLonger && Array.isArray(kept.nodes) && kept.nodes.length > nodes.length) {
      nodes = kept.nodes
      selectedIndex = 0
      detail += `；本次只拿到 ${parsed.nodes.length} 个，已沿用上次更长的 ${nodes.length} 个`
    }
    // 订阅地址同时写进设置，落盘文件被清掉后还能从设置里恢复
    try {
      await settingsWriter?.({ subscriptionUrl: url })
    } catch {
      /* 设置写入失败不影响主流程 */
    }
    log(`订阅解析：${parsed.kind} —— ${detail}`)
    return { ...parsed, detail, keptLonger: Boolean(kept && kept.keptLonger), nodes: nodes.map((n) => ({ name: n.name, protocol: n.protocol, server: n.server, port: n.port })) }
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

    saveStore({ nodes, selectedIndex })
    log(`已连接：${node.name || node.server}（${node.protocol}）`)
    return { node: { name: node.name, protocol: node.protocol, server: node.server, port: node.port }, ports: status().ports }
  }

  /** 由 apply() 注入设置作用域，用于持久化订阅地址等。 */
  function attachSettings(scope, writer) {
    settingsScope = scope
    settingsWriter = typeof writer === 'function' ? writer : null
    try {
      const v = scope.get()
      // 设置里存着的订阅地址和落盘文件互为兜底，取更长的那个（信息更全）
      if (v && v.subscriptionUrl) {
        if (!subscriptionUrl || v.subscriptionUrl.length > subscriptionUrl.length) {
          subscriptionUrl = v.subscriptionUrl
        }
        if (!nodes.length) log('检测到已保存的订阅地址，可点「拉取并解析」')
      }
    } catch {
      /* 忽略 */
    }
  }

  /** 由 apply() 注入「发布 provider」能力。 */
  function attachPublisher(fn) {
    publishProvider = fn
  }

  function disconnect() {
    core.stop()
    relay.close()
    log('已断开')
    return { ok: true }
  }

  /**
   * 「网页端」网站穿透：把目标站点经本机 Xray 拉回来，再喂给卡片里的 iframe。
   *
   * 关键点：剥掉 X-Frame-Options / CSP 这类"禁止被嵌入"的头，
   * 否则浏览器会直接拒绝渲染 iframe。
   */
  function proxySite(req, res, rest) {
    const target = new URL(options.webTarget || DEFAULT_WEB_TARGET)
    const isHttps = target.protocol === 'https:'
    const port = Number(target.port) || (isHttps ? 443 : 80)
    const path = (target.pathname.replace(/\/+$/, '') + rest) || '/'

    const headers = { host: target.host, 'user-agent': req.headers['user-agent'] || 'Mozilla/5.0', accept: req.headers.accept || '*/*' }
    for (const k of ['cookie', 'accept-language', 'accept-encoding', 'referer', 'origin']) {
      if (req.headers[k]) headers[k] = req.headers[k]
    }
    // 别让上游返回压缩流，便于处理
    delete headers['accept-encoding']

    connectThroughProxy(target.hostname, port)
      .then((socket) => {
        const agent = new https.Agent({ keepAlive: false })
        agent.createConnection = (opts, cb) => {
          const s = tls.connect({ socket, servername: target.hostname, ...opts })
          s.once('secureConnect', () => cb(null, s))
          s.once('error', cb)
          return s
        }
        const up = https.request(
          { host: target.hostname, port, method: req.method, path, headers, agent },
          (upRes) => {
            const out = {}
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (STRIP_HEADERS.has(k.toLowerCase())) continue
              out[k] = v
            }
            res.writeHead(upRes.statusCode || 502, out)
            upRes.pipe(res)
          },
        )
        up.on('error', (e) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('上游请求失败: ' + String(e?.message || e))
        })
        req.pipe(up)
      })
      .catch((e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('代理连接失败: ' + String(e?.message || e))
      })
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
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors })
          res.end(CONSOLE_HTML)
          return
        }
        if (req.method === 'GET' && url.pathname.startsWith('/web/')) {
          return proxySite(req, res, url.pathname.slice(4) + url.search)
        }
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
        if (route === 'GET /airport') return send(200, storeInfo())
        if (route === 'POST /clear') return send(200, clearData())
        if (route === 'POST /publish-provider') {
          return collect(async (body) => {
            try {
              if (!publishProvider) return send(500, { error: '发布器未注入' })
              const payload = body ? JSON.parse(body) : {}
              const err = await publishProvider(payload.models)
              return send(err ? 500 : 200, err ? { error: err } : { ok: true, providerId: PROVIDER_ID })
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /client-applied') {
          return collect((body) => {
            clientBeacon = { at: Date.now(), note: body || '' }
            log(`浏览器端 apply() 已执行 ${body || ''}`)
            return send(200, { ok: true })
          })
        }
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

  return {
    status,
    fetchSubscription,
    connect,
    disconnect,
    clearData,
    storeInfo,
    attachSettings,
    attachPublisher,
    startAdmin,
    dispose,
    get nodes() {
      return nodes
    },
  }
}

export default { name, inject, apply }
