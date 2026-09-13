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
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 机场的 HTTP 入站。默认**不用**它 —— 浏览器直连。
 *
 * 实测：真 Chromium 直连 chatgpt.com 同样 200、无 Cloudflare 挑战，
 * 因为被判定的是连接指纹，真浏览器本来就是对的。少挂一层代理就少一类
 * 莫名其妙的故障（节点抖动、分流规则、DNS 泄漏…）。
 *
 * 要让浏览器走机场，不用改这里的代码：在插件配置里设
 * `browserProxy: "http://127.0.0.1:2081"`，或者设环境变量
 * `GPT_FREE_RELAY_BROWSER_PROXY`。这个常量只是那个默认值的出处。
 */
const AIRPORT_PROXY = 'http://127.0.0.1:2081'
const DEFAULT_DISPLAY = ':99'
const SCREEN = '1280x900x24'

/**
 * 浏览器环境装在哪。
 *
 * 以前这里写死 `/root/.dsh-browser` —— 在 Linux 上没问题，但 Windows 上
 * 根本没有 /root 这个路径，`loadPlaywright` 与 `launchPersistentContext`
 * 必然失败。而 Windows 的远程画面（CDP 截图）恰恰要走这个文件，
 * 所以那是"安装脚本分开了、运行时却没分开"的真 bug。
 *
 * 现在按用户家目录推导：
 *   Linux    → /root/.dsh-browser（家目录是 /root 时与旧行为一致）
 *   Windows → C:\Users\<你>\.dsh-browser
 * 也可以用 DSH_BROWSER_HOME 覆盖（与 setup-browser.sh 认的是同一个名字）。
 */
const BROWSER_HOME = process.env.DSH_BROWSER_HOME || join(homedir(), '.dsh-browser')
/** Chromium 二进制位置（playwright 按这个环境变量找） */
const BROWSERS_PATH = join(BROWSER_HOME, 'browsers')

export class HeadedBrowser {
  constructor(options = {}) {
    this.log = options.log || (() => {})
    this.display = options.display || DEFAULT_DISPLAY
    // 空字符串 = 直连（默认）。要走出网代理就传 AIRPORT_PROXY 进来。
    this.proxy = options.proxy === undefined ? '' : options.proxy
    this.target = options.target || 'https://chatgpt.com'
    // 同样不能写死 /root —— Windows 上要用家目录
    this.userDataDir = options.userDataDir || join(BROWSER_HOME, 'profile')
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
      '加载 playwright-core 失败。请先装浏览器环境：Linux 跑 bash setup.sh，Windows 跑 setup.bat' +
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

      /**
       * 授剪贴板权限。
       *
       * 长文本走 Ctrl+V 粘贴（见 driver.js 的 typeText），需要页面能读剪贴板。
       * 不给的话 navigator.clipboard.writeText 会抛，driver 会退到
       * execCommand('insertText') —— 那条路也能用，但既然能授权就先授上，
       * 让真粘贴（更接近人）成为默认路径。
       *
       * 授权失败不影响浏览器可用，只是长文本会走退路。
       */
      try {
        await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://chatgpt.com',
        })
      } catch (e) {
        this.log(`授予剪贴板权限失败（长文本会走退路，不影响使用）：${String(e?.message || e)}`)
      }

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

  /**
   * 刷新当前页。
   *
   * 用在「断开机场」之后：页面可能是在经机场加载的，断开后那个连接上下文
   * 已经失效，得重新加载一次才能反映现在的状态（直连或断网）。
   * 没在跑就什么都不做，返回 ok。
   */
  async reload() {
    if (!this.running || !this.page || this.page.isClosed?.()) return { ok: true, skipped: true }
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      this.lastNavAt = Date.now()
      this.lastError = ''
      return { ok: true, ...this.status }
    } catch (e) {
      this.lastError = `刷新失败：${String(e?.message || e)}`
      return { ok: false, error: this.lastError, ...this.status }
    }
  }

  /**
   * 换出口代理 —— 重启浏览器套上新代理。
   *
   * 代理是在 launchPersistentContext 时定的，中途改不了，只能重启。
   * 用在「连/断机场」时：连上机场让浏览器走干净出口 IP（ChatGPT 才
   * 不报「请关闭 VPN」—— 它把机房/代理 IP 一律当 VPN 拦），断开回直连。
   *
   * 已经是这个代理就不重启（避免重复 relaunch 浪费几秒）。
   * 没在跑就只改 this.proxy，下次 start() 生效。
   * userDataDir 保留，登录态不丢，只是页面重新加载一次。
   */
  async setProxy(proxy) {
    const next = proxy || ''
    if (this.proxy === next) return { ok: true, ...this.status, unchanged: true }
    this.proxy = next
    if (!this.running) return { ok: true, ...this.status, pending: true }
    await this.stop()
    const r = await this.start()
    if (!r.ok) return r
    await this.open()
    return { ok: true, ...this.status }
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
          // contenteditable 的当前内容在 innerText 里，textContent 拿到的是初始节点；
          // textarea 的 textContent 同理只是初值，所以分开取。
          value:
            el.tagName === 'INPUT' && el.type === 'password'
              ? ''
              : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
                ? el.value || ''
                : (el.innerText || el.textContent || '').trim(),
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

  /**
   * 往第 idx 个元素里填字。手机上由用户在原生输入框打字，这里代填。
   *
   * 三类元素，三条路，不能一把梭：
   *   - input / textarea：走原生 value setter（React 只认这个，直接赋值它看不见），
   *     再补 input/change。
   *   - contenteditable（ChatGPT 的输入框是 ProseMirror）：**不能直接改
   *     textContent**。那样 DOM 是变了，但 ProseMirror 的内部文档模型没变，
   *     下一次按键它就把内容写回旧值 —— 表现就是"填了没反应、发出去是空的"。
   *     必须走 execCommand('insertText')：它会发一个 inputType=insertText 的
   *     input 事件（实测 Chromium 只发 input、不发 beforeinput），PM 的 input
   *     插件据此把这次编辑映射进自己的文档模型 —— 这才是它认的入口。
   *   - 兜底：手写 DOM 再补发 InputEvent，让 PM 的 DOM observer 重新解析节点。
   *
   * 填完一律**读回来核对**。填失败却回 ok:true 是最坏的一种错：用户以为填上了，
   * 点发送却发出空消息，还查不出为什么。所以核对不过就如实报错，让界面提示。
   */
  async fill(idx, text) {
    if (!this.running) throw new Error('浏览器没在跑')
    return this.page.evaluate(
      ({ idx, text }) => {
        const el = document.querySelector(`[data-dsh-idx="${idx}"]`)
        if (!el) return { ok: false, error: '这个元素已经不在了，点「刷新表单」重来' }

        const want = String(text ?? '')
        const norm = (s) =>
          String(s ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        const readBack = () =>
          el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value || '' : el.innerText || el.textContent || ''
        const before = readBack()

        el.scrollIntoView({ block: 'center' })
        el.focus()

        // ── 1) 原生表单控件 ──────────────────────────────────────────────
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, want)
          else el.value = want
          // React 靠事件才知道值变了，光改 value 不算数
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          const got = readBack()
          return got === want
            ? { ok: true, method: 'value', before, after: got }
            : { ok: false, method: 'value', before, after: got, error: '填了但页面没接受，可能不是同一个输入框' }
        }

        // ── 2) contenteditable：逐级尝试，**每一级都要核对** ─────────────
        //
        // 注意 execCommand 的返回值不能信：Chromium 在没能真正插入时也会回
        // true（实测：页面/选区状态不对时它返回 true 而 DOM 一个字节没变）。
        // 所以这里每一级都插完读回来，不通过就换下一级。
        const selectAll = () => {
          try {
            el.focus()
            const range = document.createRange()
            range.selectNodeContents(el)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
            return true
          } catch {
            return false
          }
        }

        const strategies = [
          // A：execCommand('insertText')。它会发一个 inputType=insertText 的 input
          //    事件，ProseMirror 的 input 插件据此更新自己的文档模型 —— 正门。
          () => {
            if (!document.queryCommandSupported?.('insertText')) return false
            selectAll()
            document.execCommand('insertText', false, want)
            return true
          },
          // B：手写 DOM，再补发一个带 inputType 的 InputEvent。PM 的 DOM observer
          //    会因此重新解析被改动的节点，属于"绕过正门但从窗户进"。
          () => {
            while (el.firstChild) el.removeChild(el.firstChild)
            const lines = want.split('\n')
            lines.forEach((line, i) => {
              if (i) el.appendChild(document.createElement('br'))
              el.appendChild(document.createTextNode(line))
            })
            try {
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: want }))
            } catch {
              el.dispatchEvent(new Event('input', { bubbles: true }))
            }
            return true
          },
        ]

        let method = ''
        let after = ''
        for (const [i, attempt] of strategies.entries()) {
          try {
            if (!attempt()) continue
          } catch {
            continue
          }
          after = readBack()
          if (norm(after) === norm(want)) {
            method = i === 0 ? 'execCommand' : 'dom'
            break
          }
        }

        return method
          ? { ok: true, method, before, after }
          : {
              ok: false,
              method: 'none',
              before,
              after,
              error: '文字没能进到页面里（ProseMirror 没接受）—— 改用右下角「键盘」按钮直接在画面上敲',
            }
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

  /**
   * 截一帧（JPEG，小体积，适合连续刷新）。
   *
   * 这是 VNC 的平替：Playwright 原生就能截图，三个平台一模一样，
   * 不需要 Xvfb / x11vnc / noVNC。画面质量低一点，但胜在到处都能跑。
   */
  async frame(quality = 55) {
    if (!this.running) return { ok: false, error: '浏览器没在跑' }
    try {
      const buf = await this.page.screenshot({ type: 'jpeg', quality, animations: 'disabled' })
      const vp = this.page.viewportSize() || { width: 1280, height: 900 }
      return { ok: true, jpg: buf.toString('base64'), width: vp.width, height: vp.height, url: this.page.url() }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  /**
   * 在页面上点一下。
   *
   * 坐标是**视口坐标**（跟 frame() 返回的 width/height 同一套），
   * 前端按显示尺寸等比换算好再传进来。
   */
  async tap(x, y) {
    if (!this.running) throw new Error('浏览器没在跑')
    await this.page.mouse.click(Math.round(x), Math.round(y))
    return { ok: true }
  }

  /** 滚轮，手机上滑页面用。 */
  async scroll(dy, x, y) {
    if (!this.running) throw new Error('浏览器没在跑')
    const vp = this.page.viewportSize() || { width: 1280, height: 900 }
    await this.page.mouse.move(Math.round(x ?? vp.width / 2), Math.round(y ?? vp.height / 2))
    await this.page.mouse.wheel(0, Math.round(dy))
    return { ok: true }
  }

  /** 敲一段文本（走键盘，跟真人输入一致）。 */
  async typeKeys(text) {
    if (!this.running) throw new Error('浏览器没在跑')
    if (text) await this.page.keyboard.type(String(text), { delay: 8 })
    return { ok: true }
  }

  /** 按一个特殊键：Enter / Backspace / Tab / 方向键等。 */
  async pressKey(name) {
    if (!this.running) throw new Error('浏览器没在跑')
    await this.page.keyboard.press(String(name))
    return { ok: true }
  }

  /**
   * 把最后一条助手消息的真实 HTML 取出来 —— **只为调选择器用**。
   *
   * 网页版一改版选择器就得跟着改，靠猜没用。特别是"思考过程"那块，
   * 各版本节点结构不一样，得先看一眼真的长什么样才能写对选择器。
   * 所以留一个只读探针：回答完 curl 一下就知道结构。
   */
  async dumpTurn(maxChars = 20000) {
    if (!this.running) throw new Error('浏览器没在跑')
    return this.page.evaluate((limit) => {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]')
      const last = nodes[nodes.length - 1]
      if (!last) return { ok: false, error: '页面上还没有助手消息' }
      const html = last.outerHTML
      return {
        ok: true,
        count: nodes.length,
        textPreview: (last.innerText || '').slice(0, 400),
        html: html.slice(0, limit),
        truncated: html.length > limit,
        htmlLength: html.length,
      }
    }, maxChars)
  }

  /**
   * 把浏览器里的会话 cookie 取出来。
   *
   * 为什么需要它：cookie jar 原本靠 /web/* 反代填充，但卡片已经改成直连、
   * 不再走那个反代，jar 就永远是空的 ——「刷新登录态」因此必然失败。
   * 而浏览器里是**真的登录着**，Playwright 能直接读出来，何必再绕。
   *
   * @returns {Promise<Array<{name: string, value: string}>>}
   */
  async harvestCookies() {
    if (!this.running) return []
    try {
      const all = await this.context.cookies()
      return all
        .filter((c) => /(^|\.)(chatgpt\.com|openai\.com|oaistatic\.com)$/.test(c.domain) || c.domain.includes('chatgpt') || c.domain.includes('openai'))
        .map((c) => ({ name: c.name, value: c.value }))
    } catch (e) {
      this.lastError = `读取浏览器 cookie 失败：${String(e?.message || e)}`
      return []
    }
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
