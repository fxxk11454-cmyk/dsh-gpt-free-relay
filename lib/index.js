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
import { XrayCore, findCore, UNSUPPORTED, SOCKS_PORT, HTTP_PORT as HTTP_INBOUND_PORT, RELAY_PORT, PLUGIN_ROOT } from './xray.js'
import { SerialRelay, connectThroughProxy } from './relay.js'
import https from 'node:https'
import tls from 'node:tls'
import { CONSOLE_HTML } from './ui.js'
import { WebSession, rewriteSetCookie } from './chatgpt/session.js'
import { WebChat, DEFAULT_WEB_MODEL } from './chatgpt/webchat.js'
import { createLocalChatHandler, isChatPath } from './chatgpt/bridge.js'
import { HeadedBrowser } from './chatgpt/browser.js'
import { WebDriverChat } from './chatgpt/driver.js'
import { VncBridge } from './vnc.js'

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

/** 可一键切换的站点。有人说的"官方站"是聊天站，有人指登录页，有人指拿 Key 的地方。 */
export const WEB_TARGET_PRESETS = {
  chatgpt: 'https://chatgpt.com',
  login: 'https://auth.openai.com',
  openai: 'https://openai.com',
  platform: 'https://platform.openai.com',
  api_keys: 'https://platform.openai.com/api-keys',
}

/** 会被剥掉的"禁止被嵌入"响应头 —— 不剥掉 iframe 就加载不出来 */
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'strict-transport-security',
])

/**
 * 需要改写成"走本地代理"的域名。
 *
 * 写死的而不是通配：改写是在文本里做字符串替换，范围必须可控，
 * 否则会把页面里不相干的第三方链接也一起改坏。
 * auth.openai.com 是登录页（Auth0），auth-cdn 是它的静态资源，
 * 少一个登录流程就断了。
 */
const PROXY_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'auth.openai.com',
  'auth0.openai.com',
  'auth-cdn.oaistatic.com',
  'cdn.oaistatic.com',
  'cdn.openai.com',
  'ab.chatgpt.com',
  'api.oaistatsig.com',
  'chatgpt.livekit.cloud',
])

/** 代理到上游时用的浏览器特征头。缺这些 Cloudflare 会发挑战页。 */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
}

/** 超过这个体积就不改写了，直接透传，免得把内存吃爆 */
const MAX_REWRITE_BYTES = 12 * 1024 * 1024

/** 代理前缀：/web/* 走主站，/proxy/<host>/* 走其它域名 */
const PROXY_PREFIX = '/proxy/'

/**
 * 把响应体里的绝对地址改写成走本地代理的形式。
 *
 * 只用字符串替换，不上 HTML 解析器 —— 页面里的地址出现在 href、src、fetch()、
 * 甚至拼在 JS 字符串里，解析器反而会漏。
 */
export function rewriteUrls(text) {
  let out = text
  for (const host of PROXY_HOSTS) {
    const escaped = host.replace(/\./g, '\\.')
    // https://host  →  /proxy/host
    out = out.replace(new RegExp(`https://${escaped}`, 'g'), `${PROXY_PREFIX}${host}`)
    // 协议相对 //host → /proxy/host
    out = out.replace(new RegExp(`(["'(=])\\/\\/${escaped}`, 'g'), `$1${PROXY_PREFIX}${host}`)
  }
  return out
}

/** 跳转地址也要留在代理里，否则一步 302 就跳出去了。 */
export function rewriteLocation(location, target) {
  let out = String(location)
  for (const host of PROXY_HOSTS) {
    const escaped = host.replace(/\./g, '\\.')
    out = out.replace(new RegExp(`^https://${escaped}`, 'i'), `${PROXY_PREFIX}${host}`)
    out = out.replace(new RegExp(`^//${escaped}`, 'i'), `${PROXY_PREFIX}${host}`)
  }
  // 同域名的相对跳转保持相对即可（浏览器会自动带上前缀）
  return out
}

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

  // 开机自启：反代 + 浏览器。用户要求"跑起来就必定在运行"，不用每次手点。
  state.autostart?.()

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

    /**
     * 组装 provider profile。
     *
     * `withReasoning` 打开时给每个模型声明"会思考"。为什么要做成开关：
     * profile 是**整体校验**的 —— 只要有一个未知键或非法值，整条 profile
     * 落不了盘，表现就是「模型区里什么都没有」（README 里记过这个坑）。
     * 所以这里先带 reasoningEfforts 试一次，若上游 schema 不认就退回不带，
     * 保证模型一定出得来，只是思考开关不可用而已。
     */
    const buildProfile = (withReasoning) => ({
      displayName: PROVIDER_DISPLAY_NAME,
      api: 'openai-completions',
      baseURL: `http://127.0.0.1:${relayPort}/v1`,
      apiKeyEnv: CREDENTIAL_REF,
      models: (models && models.length ? models : DEFAULT_MODELS).map((id) =>
        withReasoning
          ? {
              id,
              /**
               * 声明"这个模型会思考"，DSH 的思考开关才会真的传下来。
               *
               * 不声明的话 pi-ai 一个字节都不发，中继那边的 detectThinking()
               * 就永远是 false —— 开关点了没反应。
               *
               * 只有 `off` 允许留空（含义是"支持但什么都不发"），其余档位必须给
               * 一个非空字符串当作线上取值。网页链路没有 reasoning 参数可传，
               * 这个取值本身不会被用到，中继只判"在不在"。
               */
              reasoningEfforts: { off: null, high: 'high' },
            }
          : { id },
      ),
    })

    const put = (withReasoning) =>
      ctx.settings.mutate('llm-pi-ai', [
        { op: 'set', path: ['providers', PROVIDER_ID], value: buildProfile(withReasoning) },
      ])

    try {
      await put(true)
      log(`已把 provider 注册进 llm-pi-ai（baseURL=http://127.0.0.1:${relayPort}/v1${credentialNote}；含思考开关）`)
      return null
    } catch (e) {
      const first = String(e?.message || e)
      // 带 reasoningEfforts 落不了盘就退回精简版，别让模型因此消失
      try {
        await put(false)
        log(
          `provider 注册时为声明思考开关被拒（${first}），已退回不含思考开关的版本 —— ` +
            '模型能正常出现，但「思考」开关不会生效',
        )
        return null
      } catch (e2) {
        const msg = String(e2?.message || e2)
        log(`注册 provider 失败：${msg}`)
        return msg
      }
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

  /**
   * 防呆自动连接。
   *
   * 网页会话模式其实**也要走机场**：实测直连 chatgpt.com / auth.openai.com
   * 会被 Cloudflare 回 403，只有经机场才通。所以"忘了点连接"的表现不是
   * 明确的报错，而是登录页 403、模型报错 —— 很难自己定位。
   * 既然上次的节点已经落在盘上了，就直接替用户连上。
   */
  if (config.autoConnect !== false && state.nodes.length) {
    setTimeout(() => {
      state.connect().catch((e) => log(`自动连接失败：${String(e?.message || e)}`))
    }, 300)
  }

  log(`已就绪；管理接口 http://127.0.0.1:${config.adminPort || ADMIN_PORT}/status`)
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

  /**
   * 网页端会话 + 本地作答。
   *
   * 登录不在这里做 —— 用户打开卡片里的「网页端」，在那个页面里正常登录，
   * 登录产生的 Set-Cookie 会经过我们的代理，被 WebSession 捞下来换成 accessToken。
   */
  const session = new WebSession({ log, storePath: join(workDir, 'session.json') })
  const webchat = new WebChat({ session, webModel: options.webModel || DEFAULT_WEB_MODEL, log })

  /**
   * 卡片「网页端」加载哪个站点。
   *
   * **必须声明在 HeadedBrowser 之前**：下面第 334 行的 `target` 是个闭包，
   * 而 `browser.status` 这个 getter 会立刻调用它。原来它声明在 100 行之后，
   * 只在 autostart 的 2.5 秒延时下侥幸没被读到 —— 任何提前触碰 status
   * 的路径都会直接 ReferenceError（Cannot access 'webTarget' before
   * initialization）。这是个靠时序掩盖的暂时性死区，不是风格问题。
   */
  let webTarget = options.webTarget || DEFAULT_WEB_TARGET

  /**
   * 是否已经 dispose。
   *
   * 声明在最前面（而不是和 `let nodes` 那一堆放一起）是有原因的：
   * autostart() 的定时器回调要读它，任何在 dispose 之后才触发的异步收尾
   * 也都要读它。放在下面会重演 webTarget 那种暂时性死区。
   */
  let disposed = false

  /**
   * 「有头浏览器」：真 Chromium 跑在 Xvfb 上。
   *
   * 为什么需要它：Node 的 fetch 去访问 chatgpt.com 会被 Cloudflare 回
   * cf-mitigated: challenge（补请求头没用，实测过），因为被判定的是连接本身。
   * 真浏览器的 TLS/HTTP2 指纹是真的，直接就过了。
   *
   * 配套 VncBridge 把这块虚拟屏搬到卡片上，用户能看见并操作它来登录。
   */
  const browser = new HeadedBrowser({
    log,
    target: () => webTarget,
    /**
     * 浏览器出网方式。
     *
     * 默认直连（空串）——见 browser.js 顶部的实测说明。要挂机场线路时，
     * 这里读配置 `browserProxy`，其次读环境变量。以前 AIRPORT_PROXY
     * 是个导出了却没人用的常量，README 还教人去改源码；现在它是真的配置项。
     */
    proxy: options.browserProxy ?? process.env.GPT_FREE_RELAY_BROWSER_PROXY ?? '',
  })
  const vnc = new VncBridge({ log, display: browser.display })

  /**
   * 用浏览器作答。
   *
   * 这是"让中转模拟人去输入输出"的落点：把 DSH 的消息打进 ChatGPT 输入框、
   * 点发送、把回答读回来。不再需要 accessToken，也不碰 Sentinel ——
   * 页面本来就登录着，人怎么用它就怎么用。
   *
   * 输入方式分两档：短句手打（像人），长文粘贴（快且不易被打断），
   * 阈值由 `pasteThreshold` 配，默认 200 字。
   */
  const driver = new WebDriverChat({
    browser,
    log,
    thinkingPrefix: options.thinkingPrefix,
    pasteThreshold: options.pasteThreshold,
  })

  /** 问一下浏览器现在是不是登录着，并记下来。 */
  async function syncBrowserLogin() {
    if (!browser.running) {
      browserLoggedIn = false
      browserEmail = ''
      return { loggedIn: false, running: false }
    }
    try {
      const r = await browser.probeSession()
      browserLoggedIn = Boolean(r.loggedIn)
      browserEmail = r.email || ''
      return { ...r, running: true }
    } catch (e) {
      return { loggedIn: browserLoggedIn, running: true, error: String(e?.message || e) }
    }
  }

  /**
   * 开机自启（持久化）。
   *
   * 用户要求：插件跑起来就把反代和浏览器一起拉起来，不用每次手动点。
   * 这里延后几秒再动，避开和其它插件的启动竞争。
   *
   * **定时器必须记下来，dispose 时要取消。**
   * 这里踩过一个坑：定时器什么都不记，dispose() 之后它照样触发；触发时一看
   * "中继没在监听"（因为刚被 close 掉），就**又起了一个** —— 端口于是永远
   * 占着，插件卸载/重载时那个反代会自己复活。实测能真切看到：
   * 调完 dispose() 后 2.5 秒，12111 端口重新变成 listening。
   */
  let autostartTimer = null
  function autostart() {
    if (disposed) return
    autostartTimer = setTimeout(async () => {
      autostartTimer = null
      if (disposed) return
      try {
        // 反代：listen 在创建时已经做过了，这里只确认一次
        if (!relay.status.listening) await relay.listen()
        if (disposed) return

        // 浏览器：单独一个"开关"，默认开
        if (options.autoBrowser === false) return
        const r = await browser.start()
        if (disposed) return
        if (!r.ok) {
          log(`开机自启浏览器失败：${r.error}`)
          return
        }
        await browser.open()
        vnc.start()
        // 起来之后立刻同步一次登录态，界面直接就是对的
        await syncBrowserLogin()
      } catch (e) {
        log(`开机自启出错：${String(e?.message || e)}`)
      }
    }, 2500)
  }

  /** 网页会话模式：开着的时候对话请求本地处理，不出网到上游 API。 */
  let useWebSession = options.useWebSession !== false

  function applyLocalHandler() {
    if (!useWebSession) {
      relay.setLocalHandler(null)
      return
    }
    relay.setLocalHandler({ match: isChatPath, handle: createLocalChatHandler({ webchat, driver, log }) })
  }
  applyLocalHandler()

  /**
   * 插件一启动就让 relay 开始监听。
   *
   * 不能等「连接」才监听：模型 provider 的 baseURL 指向 127.0.0.1:2082，
   * 没监听的话 DSH 拿到的是 Connection refused —— 连"请先去网页端登录"
   * 这种明确提示都送不出去，只会显示一个没头没尾的网络错误。
   */
  relay.listen().catch((e) => log(`relay 启动监听失败：${String(e?.message || e)}`))

  let nodes = []
  let selectedIndex = -1
  let admin = null
  let settingsScope = null
  let settingsWriter = null
  let publishProvider = null
  /** 浏览器端 apply() 是否真的跑过（用于排查界面为何不出现） */
  let clientBeacon = null

  /** 浏览器里的登录态 —— 它才是真正在用的那条路，所以单独记一份 */
  let browserLoggedIn = false
  let browserEmail = ''

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
        if (typeof raw.webTarget === 'string' && /^https?:\/\//.test(raw.webTarget)) webTarget = raw.webTarget
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
    ports: { socks: SOCKS_PORT, http: HTTP_INBOUND_PORT, relay: relay.port },
    relay: relay.status,
    concurrency: 1,
    toolsAllowed: false,
    clientBeacon,
    settingsNamespace: SETTINGS_NAMESPACE,
    settingsRegistered: Boolean(settingsScope),
    providerId: PROVIDER_ID,
    webTarget,
    pacUrl: `http://127.0.0.1:${ADMIN_PORT}/proxy.pac`,
    /** 前端据此决定用哪套远程画面：Linux 用 VNC，Windows 用 CDP 截图 */
    platform: process.platform,
    driver: driver.status,
    browser: { ...browser.status, vnc: vnc.running, viewerUrl: `http://127.0.0.1:${ADMIN_PORT}/novnc/index.html` },
    store: storeInfo(),
    chatgpt: {
      ...session.status,
      // 登录态以浏览器为准 —— 它才是真正在用的那条路
      browserLoggedIn: Boolean(browserLoggedIn),
      browserEmail: browserEmail || '',
      useWebSession,
      webModel: webchat.webModel,
      localChat: Boolean(useWebSession),
      lastSentinel: webchat.lastSentinel,
    },
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
  /** 走直连（核心没起来时的兜底），返回 https.request 用的 agent。 */
  function directAgent() {
    return new https.Agent({ keepAlive: false })
  }

  /** 经机场 SOCKS 连出去，返回一个自定义 agent；连不上就抛。 */
  async function proxiedAgent(targetHostname) {
    const socket = await connectThroughProxy(targetHostname, 443)
    const agent = new https.Agent({ keepAlive: false })
    agent.createConnection = (opts, cb) => {
      const s = tls.connect({ socket, servername: targetHostname, ...opts })
      s.once('secureConnect', () => cb(null, s))
      s.once('error', cb)
      return s
    }
    return agent
  }

  /**
   * 通用的多域名反向代理。
   *
   * 为什么不能只代理 chatgpt.com：
   * 登录流程会跳到 **auth.openai.com**（Auth0），那是另一个域名。只代理 chatgpt.com 的话，
   * 浏览器会直接跳去真实站点 —— 登录是能登，但会话落在真实域名上，我们一个字节都拿不到，
   * 模型请求那边永远是"未登录"。
   *
   * 所以这里做两件事：
   *   1) 把聊天站之外的域名也代理进来：/proxy/<host>/<路径>
   *   2) 把响应体里的绝对地址改写成走代理的形式，让浏览器不会"跳出去"
   */
  async function proxySite(req, res, targetUrl) {
    const target = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
    const isHttps = target.protocol === 'https:'
    const port = Number(target.port) || (isHttps ? 443 : 80)
    const path = (target.pathname || '/') + (target.search || '')

    const headers = {
      host: target.host,
      'user-agent': req.headers['user-agent'] || BROWSER_HEADERS['user-agent'],
      // Cloudflare 对 `accept: */*` 很敏感，会直接判成机器人发挑战页。
      // 客户端没给像样的 accept 时，补一个真实浏览器导航用的。
      accept: !req.headers.accept || req.headers.accept === '*/*' ? BROWSER_HEADERS.accept : req.headers.accept,
      'accept-language': req.headers['accept-language'] || BROWSER_HEADERS['accept-language'],
      'sec-ch-ua': BROWSER_HEADERS['sec-ch-ua'],
      'sec-ch-ua-mobile': BROWSER_HEADERS['sec-ch-ua-mobile'],
      'sec-ch-ua-platform': BROWSER_HEADERS['sec-ch-ua-platform'],
      'upgrade-insecure-requests': '1',
      // sec-fetch-* 缺失同样是明显的非浏览器特征
      'sec-fetch-dest': req.headers['sec-fetch-dest'] || 'document',
      'sec-fetch-mode': req.headers['sec-fetch-mode'] || 'navigate',
      'sec-fetch-site': req.headers['sec-fetch-site'] || 'same-origin',
      'sec-fetch-user': req.headers['sec-fetch-user'] || '?1',
    }
    for (const k of ['cookie', 'cache-control', 'pragma', 'content-type']) {
      if (req.headers[k]) headers[k] = req.headers[k]
    }
    // 关键：Origin / Referer 要伪装成目标站自己的，否则 Auth0 这类服务会因来源不符而拒绝
    headers.origin = target.origin
    if (req.headers.referer) {
      try {
        const r = new URL(req.headers.referer)
        headers.referer = PROXY_HOSTS.has(r.hostname) ? `https://${target.host}/` : req.headers.referer
      } catch {
        headers.referer = `https://${target.host}/`
      }
    } else {
      headers.referer = `https://${target.host}/`
    }
    // 不让上游返回压缩流，否则没法改写地址
    delete headers['accept-encoding']

    const contentLength = req.headers['content-length']
    if (contentLength) headers['content-length'] = contentLength

    // 一律先试机场。实测：直连访问这几个域名会被 Cloudflare 回 403，
    // 只有走机场才通，所以"核心没起来就直连"这个兜底其实没什么用 ——
    // 但保留它，至少能给出一个明确的错误而不是干等。
    let agent
    if (isHttps) {
      try {
        agent = await proxiedAgent(target.hostname)
      } catch {
        agent = directAgent()
      }
    } else {
      agent = directAgent()
    }

    const up = https.request({ host: target.hostname, port, method: req.method, path, headers, agent }, (upRes) => {
      /**
       * 上游响应的回收。
       *
       * 以前这条路径没有清理：客户端中途断开（关页面、切站、手机切后台）时，
       * `up` 和 proxiedAgent 经 CONNECT 隧道建出来的那个 TLS socket 会一直挂着，
       * 直到上游自己超时。反复开关卡片就能攒出一堆半开连接。
       *
       * 这里把两个方向都接住：客户端断了就把上游拆掉；上游断了就把响应收尾。
       */
      const teardown = () => {
        try {
          upRes.destroy()
        } catch {
          /* 已结束 */
        }
        try {
          up.destroy()
        } catch {
          /* 已结束 */
        }
        try {
          agent?.destroy?.()
        } catch {
          /* 忽略 */
        }
      }
      res.once('close', teardown)
      upRes.once('aborted', teardown)
      upRes.once('error', teardown)

      const out = {}
      let rewritable = false
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase()
        if (STRIP_HEADERS.has(lk)) continue
        // Set-Cookie 必须重写：上游下发的是 Domain=.chatgpt.com，
        // 而我们把它挂在 127.0.0.1 这个源下，浏览器比对域名不匹配会整条丢弃，
        // 页面就永远登不进去。去掉 Domain 变成 host-only 才能存住。
        if (lk === 'set-cookie') {
          const list = (Array.isArray(v) ? v : [v]).filter(Boolean).map(rewriteSetCookie)
          try {
            session.captureSetCookie(list)
          } catch {
            /* 忽略 */
          }
          out[k] = list.length === 1 ? list[0] : list
          continue
        }
        // 跳转必须留在代理内，否则一步 302 就跳出去了
        if (lk === 'location' && typeof v === 'string') {
          out[k] = rewriteLocation(v, target)
          continue
        }
        if (lk === 'content-length') continue // 改写后长度会变，交给 chunked
        if (lk === 'content-encoding') continue // 我们只要未压缩的
        out[k] = v
      }
      // Cloudflare 挑战：不硬碰，记下来并提示用户到内嵌页面手动过验证。
      // 用户过完之后 cf_clearance 会经代理流下来，被 jar 收走，之后就顺畅了。
      if (upRes.headers['cf-mitigated']) {
        session.markChallenged()
        log(`被 Cloudflare 挑战（cf-mitigated=${upRes.headers['cf-mitigated']}）—— 请到「网页端」打开一次并完成人机验证`)
      }
      const ct = String(upRes.headers['content-type'] || '')
      rewritable = /text\/html|text\/css|javascript|ecmascript|application\/json|text\/plain/i.test(ct)

      if (!rewritable) {
        res.writeHead(upRes.statusCode || 502, out)
        upRes.pipe(res)
        return
      }

      // 文本类响应：整段收下来改写地址再发
      const chunks = []
      let size = 0
      /**
       * 体积超限后改成裸透传。
       *
       * 早先的写法是在 data 里判断 `size > MAX_REWRITE_BYTES` 然后 pipe ——
       * 但那个条件**会一直成立**，于是后续每一个 chunk 都再进一次分支，
       * 重复调用 writeHead、重复挂 pipe，最后是 ERR_STREAM_WRITE_AFTER_END。
       * 这里用一次性标志位，进了透传就再不回头。
       */
      let passthrough = false
      upRes.on('data', (c) => {
        if (passthrough) {
          res.write(c)
          return
        }
        size += c.length
        if (size > MAX_REWRITE_BYTES) {
          passthrough = true
          // 太大了就不改写，直接透传（避免把内存吃爆）
          if (!res.headersSent) res.writeHead(upRes.statusCode || 502, out)
          res.write(c)
          upRes.pipe(res)
          return
        }
        chunks.push(c)
      })
      upRes.on('end', () => {
        if (res.headersSent || passthrough) return
        const text = Buffer.concat(chunks).toString('utf8')
        const rewritten = rewriteUrls(text)
        const buf = Buffer.from(rewritten, 'utf8')
        res.writeHead(upRes.statusCode || 502, { ...out, 'content-length': String(buf.length) })
        res.end(buf)
      })
    })
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('上游请求失败: ' + String(e?.message || e))
    })
    // 客户端在发请求体的过程中就断了（连一半就不发了）—— 上游也要跟着拆，
    // 否则它会一直等一个永远发不完的 body。
    req.once('aborted', () => {
      try {
        up.destroy()
      } catch {
        /* 忽略 */
      }
    })
    req.once('error', () => {
      try {
        up.destroy()
      } catch {
        /* 忽略 */
      }
    })
    req.pipe(up)
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
        // 主站（chatgpt.com）。不限方法 —— 登录表单是 POST，只放 GET 会把登录挡掉。
        if (url.pathname === '/web' || url.pathname.startsWith('/web/')) {
          const web = new URL(webTarget)
          const tail = url.pathname === '/web' ? '/' : url.pathname.slice(4)
          return proxySite(req, res, new URL(web.pathname.replace(/\/+$/, '') + tail + url.search, web.origin))
        }
        // 其它域名（登录页 auth.openai.com、它的 CDN 等）走这里
        if (url.pathname.startsWith(PROXY_PREFIX)) {
          const rest = url.pathname.slice(PROXY_PREFIX.length)
          const slash = rest.indexOf('/')
          const host = slash < 0 ? rest : rest.slice(0, slash)
          const tail = slash < 0 ? '/' : rest.slice(slash)
          if (!host) return send(400, { error: '缺少目标域名' })
          return proxySite(req, res, new URL(`https://${host}${tail}${url.search}`))
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
        // 网页端会话：状态 / 立刻换一次 accessToken / 开关本地处理 / 试跑一句话
        // 给"把这个域名绑到机场"用的 PAC：浏览器/手机设成自动代理后，
        // 访问 OpenAI 相关域名会直接走机场（Xray 的 HTTP 入站），
        // 其它流量不受影响。
        if (url.pathname === '/proxy.pac') {
          const pac = [
            'function FindProxyForURL(url, host) {',
            `  var p = 'PROXY 127.0.0.1:${HTTP_INBOUND_PORT}; DIRECT';`,
            "  if (host === 'chatgpt.com' || dnsDomainIs(host, '.chatgpt.com')) return p;",
            "  if (host === 'openai.com' || dnsDomainIs(host, '.openai.com')) return p;",
            "  if (dnsDomainIs(host, '.oaistatic.com')) return p;",
            "  if (dnsDomainIs(host, '.oaiusercontent.com')) return p;",
            "  if (dnsDomainIs(host, '.oaistatsig.com')) return p;",
            "  return 'DIRECT';",
            '}',
            '',
          ].join('\n')
          res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8', ...cors })
          res.end(pac)
          return
        }
        // 远程桌面静态资源（noVNC core + 我们补的查看页）
        if (url.pathname === '/novnc' || url.pathname.startsWith('/novnc/')) {
          return vnc.serveStatic(req, res, url.pathname)
        }
        if (route === 'GET /browser') return send(200, browser.status)
        /**
         * 表单接口 —— 手机端的主力。
         *
         * 手机上 VNC 只有画面、点输入框弹不出软键盘，所以不能靠"操作画面"。
         * 这里把页面上的输入框/按钮列出来，让用户在原生输入框里打字，
         * 再由服务端代填进页面。
         */
        if (route === 'GET /browser/session') {
          return collect(async () => {
            try {
              return send(200, await syncBrowserLogin())
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        /**
         * CDP 远程画面 —— **Windows 专用**。
         *
         * Windows 上没有 Xvfb / x11vnc，VNC 那套起不来。这里改用 Playwright
         * 原生的截图 + 输入注入顶上：截帧、点击、滚动、敲字。
         * Linux 仍然走 VNC，这两套互不干扰。
         */
        if (route === 'GET /browser/frame') {
          return collect(async () => {
            const r = await browser.frame(Number(url.searchParams.get('q')) || 55)
            if (!r.ok) return send(500, { error: r.error })
            res.writeHead(200, {
              'content-type': 'image/jpeg',
              'cache-control': 'no-store',
              'x-viewport': `${r.width}x${r.height}`,
            })
            res.end(Buffer.from(r.jpg, 'base64'))
          })
        }
        if (route === 'GET /browser/frame.json') {
          return collect(async () => {
            const r = await browser.frame(Number(url.searchParams.get('q')) || 55)
            return send(r.ok ? 200 : 500, r)
          })
        }
        if (route === 'POST /browser/tap') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              return send(200, await browser.tap(Number(p.x) || 0, Number(p.y) || 0))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /browser/scroll') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              return send(200, await browser.scroll(Number(p.dy) || 0, p.x, p.y))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /browser/keys') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              if (p.key) return send(200, await browser.pressKey(p.key))
              return send(200, await browser.typeKeys(p.text || ''))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'GET /browser/inputs') {
          return collect(async () => {
            try {
              return send(200, await browser.listInputs())
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /browser/fill') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              if (p.idx === undefined) return send(400, { error: '缺少 idx' })
              return send(200, await browser.fill(Number(p.idx), String(p.text ?? '')))
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /browser/click') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              if (p.idx === undefined) return send(400, { error: '缺少 idx' })
              const r = await browser.click(Number(p.idx))
              // 点完等页面反应一下，再把新表单和状态带回去，省一次往返
              await new Promise((res) => setTimeout(res, 1200))
              let inputs = null
              let sess = null
              try {
                inputs = await browser.listInputs()
              } catch {}
              try {
                sess = await syncBrowserLogin()
              } catch {}
              return send(200, { ...r, inputs, session: sess })
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /browser/start') {
          return collect(async () => {
            // 顺序很重要：browser.start() 会顺带把 Xvfb 拉起来，
            // x11vnc 必须等它之后才能启动，否则会因找不到 display 当场退出。
            const r = await browser.start()
            if (r.ok) {
              vnc.start()
              await browser.open()
              // 起来就同步一次登录态，界面立刻是对的
              await syncBrowserLogin()
            }
            return send(r.ok ? 200 : 500, r.ok ? { ...r, ...browser.status, vnc: vnc.running, session: { loggedIn: browserLoggedIn, email: browserEmail } } : r)
          })
        }
        if (route === 'POST /browser/open') {
          return collect(async (body) => {
            let dest
            try {
              dest = body ? JSON.parse(body).url : ''
            } catch {
              dest = ''
            }
            const r = await browser.open(dest || webTarget)
            if (r.ok) vnc.start()
            return send(r.ok ? 200 : 500, r)
          })
        }
        if (route === 'POST /browser/stop') {
          // 关浏览器要走 CDP，是异步的；这里不等它，避免阻塞路由
          browser.stop().catch(() => {})
          return send(200, { ok: true })
        }
        if (route === 'GET /browser/screenshot.png') {
          return collect(async () => {
            const r = await browser.screenshot()
            if (!r.ok) return send(500, { error: r.error })
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
            res.end(Buffer.from(r.png, 'base64'))
          })
        }
        if (route === 'POST /session/clear') {
          session.clear()
          log('已清空会话 cookie')
          return send(200, { ok: true, ...session.status })
        }
        if (route === 'GET /chatgpt') return send(200, { ...session.status, useWebSession, webModel: webchat.webModel })
        // 切换「网页端」加载的站点。预设四个常用的，也接受任意 URL。
        if (route === 'GET /web-target') return send(200, { webTarget, presets: WEB_TARGET_PRESETS })
        if (route === 'POST /web-target') {
          return collect((body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              const next = p.preset ? WEB_TARGET_PRESETS[p.preset] : p.url
              if (!next) return send(400, { error: '需要 url 或 preset' })
              const u = new URL(String(next))
              if (u.protocol !== 'https:' && u.protocol !== 'http:') return send(400, { error: '只支持 http/https' })
              webTarget = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
              saveStore({ webTarget })
              log(`网页端站点已切换为 ${webTarget}`)
              return send(200, { ok: true, webTarget })
            } catch (e) {
              return send(400, { error: String(e?.message || e) })
            }
          })
        }
        /**
         * 刷新登录态。
         *
         * 以前的实现直接问 session 要 token，但 session 的 cookie jar 靠
         * /web/* 反代填充 —— 卡片改成直连后那个反代不再被使用，jar 永远是空的，
         * 所以这个按钮必然失败。
         *
         * 正确做法：登录态在**浏览器**里。先把浏览器的 cookie 取过来喂给 jar，
         * 再换 accessToken。这样两个作用都达到：
         *   - 按钮真的能用
         *   - webchat 那条后备链路也拿到 token 了
         */
        if (route === 'POST /chatgpt/refresh') {
          return collect(async (body) => {
            try {
              const force = body ? JSON.parse(body)?.force !== false : true
              let adopted = 0
              let browserSession = null
              if (browser.running) {
                try {
                  adopted = session.adoptCookies(await browser.harvestCookies())
                } catch (e) {
                  log(`从浏览器取 cookie 失败：${String(e?.message || e)}`)
                }
                // 顺便问页面自己（这个最准，cookie 一定是对的）
                try {
                  browserSession = await browser.probeSession()
                } catch {
                  /* 忽略 */
                }
              }
              const st = await session.refresh(force)
              const loggedIn = Boolean(browserSession?.loggedIn) || st.loggedIn
              const email = browserSession?.email || st.email
              return send(200, {
                ...st,
                loggedIn,
                email,
                adopted,
                fromBrowser: Boolean(browserSession?.loggedIn),
                browserRunning: browser.running,
                useWebSession,
                webModel: webchat.webModel,
              })
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /chatgpt/toggle') {
          return collect((body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              if (typeof p.useWebSession === 'boolean') useWebSession = p.useWebSession
              else useWebSession = !useWebSession
              applyLocalHandler()
              log(`网页会话本地处理：${useWebSession ? '开' : '关'}`)
              return send(200, { ok: true, useWebSession, localChat: Boolean(useWebSession) })
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
        if (route === 'POST /chatgpt/test') {
          return collect(async (body) => {
            try {
              const p = body ? JSON.parse(body) : {}
              const prompt = p.prompt || '只回复两个字：正常'
              let text = ''
              for await (const d of webchat.stream([{ role: 'user', content: prompt }])) text += d
              return send(200, { ok: true, reply: text, sentinel: webchat.lastSentinel })
            } catch (e) {
              return send(500, { error: String(e?.message || e) })
            }
          })
        }
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
    const listenPort = options.adminPort || ADMIN_PORT
    admin.listen(listenPort, '127.0.0.1', () => log(`管理接口已监听 http://127.0.0.1:${listenPort}/status`))
    // 远程桌面复用同一个端口（/vnc-ws），省掉额外端口与跨端口问题
    vnc.attach(admin).catch((e) => log(`远程桌面挂载失败：${String(e?.message || e)}`))
    admin.on('error', (e) => log(`管理接口启动失败：${String(e?.message || e)}`))
    return null
  }

  /**
   * 卸载清理。
   *
   * 关键是**先停掉还没跑完的启动流程**：autostart 的定时器如果放着不管，
   * 它会在 dispose 之后触发，发现中继"没在监听"就重新 listen ——
   * 端口于是永远占着，插件卸载了但反代还在跑。
   */
  function dispose() {
    disposed = true
    if (autostartTimer) {
      clearTimeout(autostartTimer)
      autostartTimer = null
    }
    try {
      core.stop()
      relay.close()
      browser.stop()
      vnc.stop()
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
    autostart,
    syncBrowserLogin,
    session,
    webchat,
    browser,
    vnc,
    driver,
    setUseWebSession(v) {
      useWebSession = Boolean(v)
      applyLocalHandler()
    },
    get useWebSession() {
      return useWebSession
    },
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
