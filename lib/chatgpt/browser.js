/**
 * 「有头浏览器」模式。
 *
 * 为什么需要它：用 Node 的 fetch 去访问 chatgpt.com，TLS 指纹不是浏览器，
 * Cloudflare 一律回 cf-mitigated: challenge。补请求头没用（实测过），
 * 因为被判定的是连接本身，不是那几个头。
 *
 * 所以干脆用**真 Chromium**：
 *   - 跑在 Xvfb 虚拟屏上（有头模式，不是 headless —— headless 的指纹不一样）
 *   - 默认**直连**（真浏览器直连也能过 Cloudflare）；需要时可指定出口代理
 *   - TLS / HTTP2 / 指纹全是真的，Cloudflare 自己就放行了
 *
 * 关键取舍：**不做本地 MITM**。浏览器直连真域名，所以 cookie 在浏览器里，
 * 我们拿不到。因此需要 cookie 的那一步（sentinel）放到页面里用
 * page.evaluate 执行；不需要网络的部分（PoW 求解）留在 Node 里做。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 机场的 HTTP 入站。默认**不用**它 —— 浏览器直连。
 *
 * 实测：真 Chromium 直连 chatgpt.com 同样 200、无 Cloudflare 挑战，
 * 因为被判定的是连接指纹，真浏览器本来就是对的。少挂一层代理就少一类
 * 莫名其妙的故障（节点抖动、分流规则、DNS 泄漏…）。
 * 需要走机场时把这个地址传给 proxy 即可。
 */
const AIRPORT_PROXY = 'http://127.0.0.1:2081'
const DEFAULT_DISPLAY = ':99'
const SCREEN = '1280x900x24'

/** 浏览器环境装在插件目录外 —— 体积大，不该塞进仓库 */
const BROWSER_HOME = '/root/.dsh-browser'
/** Chromium 二进制位置（playwright 按这个环境变量找） */
const BROWSERS_PATH = `${BROWSER_HOME}/browsers`

export class HeadedBrowser {
  constructor(options = {}) {
    this.log = options.log || (() => {})
    this.display = options.display || DEFAULT_DISPLAY
    // 空字符串 = 直连（默认）。要走出网代理就传 AIRPORT_PROXY 进来。
    this.proxy = options.proxy === undefined ? '' : options.proxy
    this.target = options.target || 'https://chatgpt.com'
    this.userDataDir = options.userDataDir || '/root/.dsh-browser/profile'
    this.screen = options.screen || SCREEN
    this.context = null
    this.page = null
    this.xvfb = null
    this.lastError = ''
    this.lastNavAt = 0
  }

  get running() {
    return Boolean(this.context && this.page && !this.page.isClosed())
  }

  get status() {
    return {
      running: this.running,
      display: this.display,
      proxy: this.proxy || '(直连)',
      target: typeof this.target === 'function' ? this.target() : this.target,
      url: this.page && !this.page.isClosed() ? this.page.url() : '',
      userDataDir: this.userDataDir,
      lastError: this.lastError,
      lastNavAt: this.lastNavAt,
    }
  }

  /**
   * Xvfb 有没有真的在这个 display 上跑着。
   *
   * 注意：**不能只看 socket 文件存在**。/tmp/.X11-unix/X99 这种文件在 Xvfb
   * 被杀掉后不会自动清理，下次启动时它还在。只看文件就会误判成"已经跑着"，
   * 于是跳过启动 —— 结果 Chromium 找不到 X server 直接崩，
   * 报 "Missing X server or $DISPLAY"。
   *
   * 所以这里真的去连一下那个 socket：连得上才算活着。
   */
  displayUp() {
    const sockPath = `/tmp/.X11-unix/X${String(this.display).replace(':', '')}`
    if (!existsSync(sockPath)) return false
    try {
      // 同步探一下这个 unix socket 有没有人 accept
      execFileSync('node', ['-e', `
        const net = require('net')
        const s = net.connect(${JSON.stringify(sockPath)})
        s.on('connect', () => { s.destroy(); process.exit(0) })
        s.on('error', () => process.exit(1))
        setTimeout(() => process.exit(1), 800)
      `], { stdio: 'ignore', timeout: 3000 })
      return true
    } catch {
      // 文件在但没人听 —— 残留，删掉以免后续再被误导
      try {
        rmSync(sockPath, { force: true })
      } catch {
        /* 忽略 */
      }
      return false
    }
  }

  /**
   * 需要的话把 Xvfb 拉起来，并**确认它真的起来了**再返回。
   *
   * 盲目 return true 是不行的：Chromium 紧接着就启动，Xvfb 还没就绪的话
   * 一样是 "Missing X server"。所以这里轮询等 socket 可用。
   */
  async ensureDisplay() {
    if (this.displayUp()) return true
    try {
      this.xvfb = spawn('Xvfb', [this.display, '-screen', '0', this.screen, '-nolisten', 'tcp'], {
        // 全部忽略 stdio 并 detached，父进程退出后它还能活着
        stdio: 'ignore',
        detached: true,
      })
      this.xvfb.unref()
      this.xvfb.on('error', (e) => this.log(`Xvfb 进程错误：${String(e?.message || e)}`))
      this.log(`正在启动 Xvfb ${this.display}（${this.screen}）`)
    } catch (e) {
      this.lastError = `Xvfb 启动失败：${String(e?.message || e)}`
      this.log(this.lastError)
      return false
    }
    // 最多等 5 秒，每 250ms 确认一次
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (this.displayUp()) {
        this.log(`Xvfb ${this.display} 已就绪`)
        return true
      }
    }
    this.lastError = `Xvfb ${this.display} 启动后 5 秒内仍不可用（检查 xvfb 是否装上：apt-get install xvfb）`
    this.log(this.lastError)
    return false
  }

  /** 载入 playwright-core。找不到就把原因说清楚，别抛一个看不懂的错。 */
  async loadPlaywright() {
    // 浏览器环境装在插件目录外（体积大，不该塞进仓库），所以做多路径兜底
    const candidates = ['playwright-core', `${BROWSER_HOME}/node_modules/playwright-core/index.js`]
    for (const c of candidates) {
      try {
        process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH
        const mod = await import(c)
        const chromium = mod?.chromium || mod?.default?.chromium
        if (chromium) return chromium
      } catch {
        /* 试下一个 */
      }
    }
    this.lastError =
      '加载 playwright-core 失败。需要先跑 scripts/setup-browser.sh 安装浏览器环境' +
      `（预期在 ${BROWSER_HOME}，浏览器在 ${BROWSERS_PATH}）。`
    return null
  }

  async start() {
    if (this.running) return { ok: true, ...this.status }
    if (!(await this.ensureDisplay())) return { ok: false, error: this.lastError }

    const chromium = await this.loadPlaywright()
    if (!chromium) return { ok: false, error: this.lastError }

    try {
      mkdirSync(this.userDataDir, { recursive: true })
      // 浏览器装在独立目录，用环境变量指过去
      process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH
      // 关键：Chromium 要知道往哪块屏上画。不设这个它会直接报
      // "Missing X server or $DISPLAY" 然后退出。
      process.env.DISPLAY = this.display

      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        // 关键：有头。headless 的指纹跟真浏览器有差异，Cloudflare 认得出来
        headless: false,
        viewport: { width: 1280, height: 900 },
        // 只有显式指定了出口代理才挂；默认直连
        ...(this.proxy ? { proxy: { server: this.proxy } } : {}),
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          // 关掉自动化特征，Cloudflare 会看 navigator.webdriver
          '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      })
      // 再抹一层自动化痕迹
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      })

      const pages = this.context.pages()
      this.page = pages.length ? pages[0] : await this.context.newPage()
      this.log(`浏览器已启动（有头，display=${this.display}，出网=${this.proxy || '直连'}）`)
      return { ok: true, ...this.status }
    } catch (e) {
      this.lastError = `浏览器启动失败：${String(e?.message || e)}`
      this.log(this.lastError)
      await this.stop()
      return { ok: false, error: this.lastError }
    }
  }

  /** 打开目标站点。已经在了就不重复跳。 */
  async open(url) {
    if (!this.running) {
      const r = await this.start()
      if (!r.ok) return r
    }
    // target 允许是函数 —— 站点可以在运行中被切换
    const dest = url || (typeof this.target === 'function' ? this.target() : this.target)
    try {
      const cur = this.page.url()
      if (!cur || cur === 'about:blank' || !cur.startsWith(dest.split('/').slice(0, 3).join('/'))) {
        await this.page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 60000 })
        this.lastNavAt = Date.now()
      }
      this.lastError = ''
      return { ok: true, ...this.status }
    } catch (e) {
      this.lastError = `打开 ${dest} 失败：${String(e?.message || e)}`
      return { ok: false, error: this.lastError, ...this.status }
    }
  }

  /** 截一张图（base64 PNG），让用户在卡片里能看到浏览器现在什么样。 */
  async screenshot() {
    if (!this.running) return { ok: false, error: '浏览器没在跑' }
    try {
      const buf = await this.page.screenshot({ type: 'png' })
      return { ok: true, png: buf.toString('base64'), url: this.page.url() }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  /**
   * 在页面里执行一次带 cookie 的请求。
   *
   * 这是整个方案的关键：需要登录态的那一步必须发生在页面里，
   * 因为 cookie 在浏览器手上，不在 Node 这边。
   */
  async fetchInPage(path, init) {
    if (!this.running) {
      const r = await this.start()
      if (!r.ok) throw new Error(r.error)
    }
    const result = await this.page.evaluate(
      async ({ path, init }) => {
        try {
          const res = await fetch(path, init)
          const text = await res.text()
          return { status: res.status, text, headers: { 'cf-mitigated': res.headers.get('cf-mitigated') || '' } }
        } catch (e) {
          return { status: 0, text: String((e && e.message) || e), headers: {} }
        }
      },
      { path, init },
    )
    return result
  }

  /**
   * 列出页面上可填的输入框和可点的按钮。
   *
   * 为什么需要它：手机上 VNC 只有画面、弹不出软键盘，点输入框也打不了字。
   * 所以手机上不该靠"操作画面"，而该由这里探测出表单，让用户在**原生输入框**
   * 里打字，我们再代填进去。
   */
  async listInputs() {
    if (!this.running) {
      const r = await this.start()
      if (!r.ok) throw new Error(r.error)
    }
    return this.page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const st = getComputedStyle(el)
        return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0'
      }
      const seen = new Set()
      const out = []
      // 输入框
      for (const el of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
        if (!visible(el)) continue
        if (el.type === 'hidden') continue
        if (seen.has(el)) continue
        seen.add(el)
        const rect = el.getBoundingClientRect()
        el.setAttribute('data-dsh-idx', String(out.length))
        out.push({
          idx: out.length,
          kind: 'input',
          type: el.tagName === 'INPUT' ? el.type || 'text' : el.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable',
          name: el.name || '',
          placeholder: el.placeholder || el.getAttribute('aria-label') || '',
          value: el.tagName === 'INPUT' && el.type === 'password' ? '' : el.value || el.textContent || '',
          top: Math.round(rect.top),
        })
      }
      // 按钮
      for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], a[href]')) {
        if (!visible(el)) continue
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40)
        if (!label) continue
        if (seen.has(el)) continue
        seen.add(el)
        const rect = el.getBoundingClientRect()
        el.setAttribute('data-dsh-idx', String(out.length))
        out.push({ idx: out.length, kind: 'button', label, top: Math.round(rect.top) })
      }
      return { url: location.href, title: document.title, items: out }
    })
  }

  /** 往第 idx 个元素里填字。手机上由用户在原生输入框打字，这里代填。 */
  async fill(idx, text) {
    if (!this.running) throw new Error('浏览器没在跑')
    return this.page.evaluate(
      ({ idx, text }) => {
        const el = document.querySelector(`[data-dsh-idx="${idx}"]`)
        if (!el) return { ok: false, error: '这个元素已经不在了，点「刷新表单」重来' }
        el.focus()
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, text)
          else el.value = text
        } else {
          el.textContent = text
        }
        // React 靠事件才知道值变了，光改 value 不算数
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
      },
      { idx, text },
    )
  }

  /** 点第 idx 个元素。 */
  async click(idx) {
    if (!this.running) throw new Error('浏览器没在跑')
    return this.page.evaluate((idx) => {
      const el = document.querySelector(`[data-dsh-idx="${idx}"]`)
      if (!el) return { ok: false, error: '这个元素已经不在了，点「刷新表单」重来' }
      el.scrollIntoView({ block: 'center' })
      el.click()
      return { ok: true }
    }, idx)
  }

  /** 当前页面是不是登录态（问的是页面自己，所以 cookie 一定对）。 */
  async probeSession() {
    const r = await this.fetchInPage('/api/auth/session', { method: 'GET' })
    if (r.status !== 200) return { ok: false, status: r.status, error: `HTTP ${r.status}` }
    try {
      const j = JSON.parse(r.text)
      return { ok: true, loggedIn: Boolean(j.accessToken), email: j?.user?.email || '', plan: j?.account?.planType || '' }
    } catch {
      return { ok: false, error: '会话接口返回的不是 JSON' }
    }
  }

  async stop() {
    try {
      await this.context?.close()
    } catch {
      /* 忽略 */
    }
    this.context = null
    this.page = null
    return { ok: true }
  }
}

export { AIRPORT_PROXY, BROWSERS_PATH, BROWSER_HOME }
