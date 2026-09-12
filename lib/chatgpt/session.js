/**
 * 网页端会话（登录态）管理。
 *
 * 思路：登录这件事**完全交给卡片里那个内嵌的 ChatGPT 页面**去做，用户正常输账号密码就行。
 * 我们不用管登录流程，只在旁边把会话捞出来：
 *
 *   浏览器 ──► /web/* ──► 我们的代理 ──► chatgpt.com
 *                  ▲                        │
 *                  └──── Set-Cookie ────────┘
 *                             │
 *                             ▼
 *                       host 端 cookie jar ──► GET /api/auth/session ──► accessToken
 *
 * 拿到 accessToken 之后，模型请求就可以在 host 端本地处理，不再需要浏览器参与。
 */
import { randomUUID } from 'node:crypto'

const BASE = 'https://chatgpt.com'

/**
 * 重写 Set-Cookie，让它能在 127.0.0.1 这个源上生效。
 *
 * 为什么必须做：代理把 chatgpt.com 的内容挂在 `127.0.0.1:2083` 下，
 * 而 ChatGPT 下发的 cookie 带 `Domain=.chatgpt.com` —— 浏览器比对域名不匹配，
 * **整条 cookie 直接丢弃**，页面就永远登不进去。
 * 所以要把 Domain 去掉，变成 host-only cookie（就是 127.0.0.1）。
 *
 * Secure 保留：Chrome 把 127.0.0.1 当作可信源，http 下也接受 Secure cookie。
 * 另外把 SameSite=None 降成 Lax，避免无谓的跨站限制。
 */
export function rewriteSetCookie(raw) {
  const parts = String(raw).split(';')
  const out = [parts[0].trim()]
  for (const p of parts.slice(1)) {
    const k = p.trim().toLowerCase()
    if (k.startsWith('domain=')) continue // 关键：去掉域名限制
    if (k.startsWith('samesite=none')) {
      out.push('SameSite=Lax')
      continue
    }
    if (k.startsWith('partitioned')) continue
    out.push(p.trim())
  }
  return out.join('; ')
}

/** 从一条 Set-Cookie 里取出 name=value 与是否删除。 */
function parseCookie(raw) {
  const first = String(raw).split(';')[0].trim()
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  const lower = String(raw).toLowerCase()
  // Max-Age=0 / 过期时间在过去 → 这是删除指令
  const dead =
    /max-age\s*=\s*0(?:\D|$)/.test(lower) ||
    /expires\s*=\s*thu,\s*01\s*jan\s*1970/.test(lower)
  return { name, value, dead }
}

export class WebSession {
  constructor(options = {}) {
    this.log = options.log || (() => {})
    /** name -> value */
    this.cookies = new Map()
    this.accessToken = ''
    this.tokenExpires = 0
    this.email = ''
    this.plan = ''
    this.lastError = ''
    this.lastRefreshAt = 0
    this.deviceId = options.deviceId || randomUUID()
    /** 登录态变更时通知外部（比如刷新 provider） */
    this.onChange = options.onChange || null
    this._loggedIn = false
  }

  get cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get loggedIn() {
    return Boolean(this.accessToken)
  }

  get status() {
    return {
      loggedIn: this.loggedIn,
      email: this.email,
      plan: this.plan,
      cookieCount: this.cookies.size,
      tokenExpires: this.tokenExpires,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
      deviceId: this.deviceId,
    }
  }

  /** 从上游响应里吸收会话 cookie。传进来的应当是**已经重写**的那份。 */
  captureSetCookie(values) {
    const list = Array.isArray(values) ? values : [values]
    let changed = false
    for (const raw of list) {
      if (!raw) continue
      const c = parseCookie(raw)
      if (!c) continue
      if (c.dead) {
        if (this.cookies.delete(c.name)) changed = true
        continue
      }
      // 只关心会话相关的，避免把统计类 cookie 也囤起来
      if (!/^(__Secure-|__Host-|oai-|_puid|cf_|__cf|oai-did)/i.test(c.name) && !/session|token|auth/i.test(c.name)) {
        continue
      }
      if (this.cookies.get(c.name) !== c.value) {
        this.cookies.set(c.name, c.value)
        changed = true
      }
    }
    if (changed) this._dirty = true
    return changed
  }

  /** 用当前的 cookie 去换 accessToken。 */
  async refresh(force = false) {
    const now = Date.now()
    // 没有 cookie 就没什么可换的
    if (!this.cookies.size) {
      this.accessToken = ''
      this.lastError = '还没有会话 cookie —— 请先在卡片的「网页端」里登录 ChatGPT'
      return this.status
    }
    // token 还没过期就不用换
    if (!force && this.accessToken && this.tokenExpires && now < this.tokenExpires - 60000) {
      return this.status
    }
    if (!force && now - this.lastRefreshAt < 5000) return this.status
    this.lastRefreshAt = now

    try {
      const res = await fetch(`${BASE}/api/auth/session`, {
        headers: {
          cookie: this.cookieHeader,
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          referer: `${BASE}/`,
        },
      })
      if (!res.ok) {
        this.lastError = `换取 accessToken 失败：HTTP ${res.status}`
        this.accessToken = ''
        return this.status
      }
      const data = await res.json().catch(() => null)
      const token = data?.accessToken
      if (typeof token !== 'string' || !token) {
        this.accessToken = ''
        this.lastError = '会话里没有 accessToken —— cookie 可能已过期，请在「网页端」重新登录'
        return this.status
      }
      const was = this._loggedIn
      this.accessToken = token
      this.email = data?.user?.email || ''
      this.plan = data?.account?.planType || data?.user?.planType || ''
      // JWT 里的 exp 更准；拿不到就按 1 小时兜底
      this.tokenExpires = jwtExpiry(token) || now + 3600_000
      this.lastError = ''
      this._loggedIn = true
      this.log(`网页端会话就绪${this.email ? `（${this.email}）` : ''}`)
      if (!was && typeof this.onChange === 'function') {
        try {
          this.onChange(this.status)
        } catch {
          /* 忽略回调异常 */
        }
      }
      return this.status
    } catch (e) {
      this.lastError = `换取 accessToken 出错：${String(e?.message || e)}`
      this.accessToken = ''
      return this.status
    }
  }

  /** 给 backend-api 用的请求头。 */
  backendHeaders() {
    return {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      authorization: `Bearer ${this.accessToken}`,
      'oai-device-id': this.deviceId,
      'oai-session-id': randomUUID(),
      'oai-language': 'en-US',
      origin: BASE,
      referer: `${BASE}/`,
      accept: '*/*',
      cookie: this.cookieHeader,
    }
  }

  /** 会话是否已经变了（cookie 有更新）—— 外层据此决定要不要重新换 token。 */
  takeDirty() {
    const d = Boolean(this._dirty)
    this._dirty = false
    return d
  }
}

/** 从 JWT 里读 exp（毫秒）。解不出来返回 0。 */
export function jwtExpiry(token) {
  try {
    const part = String(token).split('.')[1]
    if (!part) return 0
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp * 1000 : 0
  } catch {
    return 0
  }
}
