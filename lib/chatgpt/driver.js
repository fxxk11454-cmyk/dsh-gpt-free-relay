/**
 * 用「有头浏览器」作答 —— 真的模拟人去输入和读取。
 *
 * 跟 webchat.js 的区别：
 *   webchat.js  直接调 ChatGPT 的后端接口，本质是"冒充网页端"，要 Sentinel、
 *               要 accessToken，Cloudflare 一变就崩
 *   driver.js   就是在页面上打字、点发送、读回答 —— 人怎么做它就怎么做，
 *               天然带登录态，不需要 token，也不需要过 Sentinel
 *
 * 代价是慢（要等页面渲染），换来的是稳。
 */

/** ChatGPT 页面上的关键选择器。多套并存，因为上游会改。 */
const SEL = {
  input: [
    '#prompt-textarea',
    'div[contenteditable="true"]#prompt-textarea',
    'textarea[data-id="root"]',
    'form textarea',
    'div[contenteditable="true"]',
  ],
  send: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    '#composer-submit-button',
  ],
  /** 停止生成按钮 —— 出现说明还在输出中 */
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
  ],
  /** 助手消息气泡 */
  assistant: [
    '[data-message-author-role="assistant"]',
    'div[data-testid^="conversation-turn-"] .markdown',
  ],
  loginLink: ['a[href*="auth.openai.com"]', 'button[data-testid="login-button"]'],
}

/**
 * 浏览器作答器。
 *
 * @param {{browser: import('./browser.js').HeadedBrowser, log?: Function, timeoutMs?: number}} deps
 */
export class WebDriverChat {
  constructor({ browser, log, timeoutMs } = {}) {
    this.browser = browser
    this.log = log || (() => {})
    this.timeoutMs = timeoutMs || 180000
    this.lastError = ''
    this.busy = false
  }

  get available() {
    return Boolean(this.browser && this.browser.running)
  }

  get status() {
    return {
      available: this.available,
      busy: this.busy,
      lastError: this.lastError,
      url: this.browser?.running ? this.browser.page.url() : '',
    }
  }

  /** 页面里找一个元素，返回第一个命中的选择器。 */
  async find(selectors, timeout = 8000) {
    const page = this.browser.page
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel)
          if (el && (await el.isVisible().catch(() => false))) return { el, sel }
        } catch {
          /* 换下一个 */
        }
      }
      await page.waitForTimeout(300)
    }
    return null
  }

  /** 确认页面处于可对话状态；没登录就把话说清楚。 */
  async ensureReady() {
    if (!this.browser.running) {
      const r = await this.browser.start()
      if (!r.ok) throw new Error(r.error)
      await this.browser.open()
    }
    const page = this.browser.page

    // 没在 ChatGPT 上就先过去
    if (!/chatgpt\.com/.test(page.url())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(2500)
    }

    // 有输入框 = 能对话（未登录也能打字，但发出去会要求登录）
    const input = await this.find(SEL.input, 12000)
    if (!input) {
      // 可能是登录页或者被挡
      const hasLogin = await this.find(SEL.loginLink, 1500)
      if (hasLogin) {
        throw new Error('还没登录 —— 请在「有头浏览器」里点「键盘」按钮，用软键盘登录一次')
      }
      throw new Error('页面上找不到输入框。可能还在加载，或页面结构变了；点「启动并打开 ChatGPT」重试')
    }
    return input
  }

  /** 把内容打进输入框。contenteditable 用 type，textarea 直接填。 */
  async typeInto(el, text) {
    await el.click({ timeout: 5000 }).catch(() => {})
    // 先清空，避免和上次残留拼在一起
    try {
      await el.evaluate((node) => {
        if (node.tagName === 'TEXTAREA') node.value = ''
        else node.textContent = ''
      })
    } catch {
      /* 忽略 */
    }
    // 用键盘逐字打，跟真人一致；React 对这种输入最买账
    await el.type(text, { delay: 8 })
  }

  /** 点发送。找不到发送按钮就回退到回车。 */
  async submit(inputEl) {
    const send = await this.find(SEL.send, 2500)
    if (send) {
      await send.el.click({ timeout: 5000 })
      return
    }
    await inputEl.press('Enter')
  }

  /**
   * 等回答结束，并返回文本。
   *
   * 判断"结束"的方式：先等出现"停止生成"按钮（说明在输出），
   * 再等它消失（说明输出完了）。比数消息条数可靠。
   */
  async waitForAnswer(beforeCount, onDelta) {
    const page = this.browser.page
    const deadline = Date.now() + this.timeoutMs
    let sawStop = false
    let last = ''

    while (Date.now() < deadline) {
      // 有没有在生成
      const stop = await this.find(SEL.stop, 300)
      if (stop) sawStop = true

      // 读当前最后一条助手消息
      const text = await page.evaluate((sels) => {
        let nodes = []
        for (const sel of sels) {
          const found = document.querySelectorAll(sel)
          if (found.length) {
            nodes = Array.from(found)
            break
          }
        }
        if (!nodes.length) return ''
        const lastNode = nodes[nodes.length - 1]
        return (lastNode.innerText || lastNode.textContent || '').trim()
      }, SEL.assistant)

      if (text && text !== last) {
        last = text
        if (onDelta) onDelta(text)
      }

      // 结束条件：见过"停止"按钮，且它已经消失，并且有内容
      if (sawStop && !stop && last) return last
      // 没出现过停止按钮（很快答完），用"内容稳定"兜底
      if (!sawStop && last && Date.now() > deadline - this.timeoutMs + 6000) {
        const again = await page.evaluate((sels) => {
          const n = document.querySelectorAll(sels[0])
          return n.length ? (n[n.length - 1].innerText || '').trim() : ''
        }, SEL.assistant)
        if (again === last) return last
      }

      await page.waitForTimeout(400)
    }
    if (last) return last
    throw new Error('等回答超时了 —— 页面可能卡住，或需要重新登录')
  }

  /**
   * 跑一轮：把 messages 里最后一条 user 内容打进去，取回回答。
   *
   * 注意只发最后一条 —— 浏览器里是真实会话，历史由 ChatGPT 自己维护，
   * 把整段历史再灌一遍反而会重复。
   */
  async answer(messages, onDelta) {
    if (this.busy) throw new Error('浏览器正忙着上一轮，稍后再试')
    this.busy = true
    try {
      const input = await this.ensureReady()
      const page = this.browser.page

      const lastUser = [...(messages || [])].reverse().find((m) => (m.role || 'user') === 'user')
      let text = ''
      if (lastUser) {
        text = typeof lastUser.content === 'string' ? lastUser.content : flatten(lastUser.content)
      }
      if (!text) throw new Error('这轮没有可发送的用户内容')

      // 若有 system，拼在开头 —— 浏览器里没有 system 概念
      const sys = (messages || []).filter((m) => m.role === 'system' || m.role === 'developer')
      if (sys.length) {
        text = sys.map((m) => (typeof m.content === 'string' ? m.content : flatten(m.content))).join('\n\n') + '\n\n' + text
      }

      const before = await page.evaluate((sels) => {
        for (const sel of sels) {
          const n = document.querySelectorAll(sel)
          if (n.length) return n.length
        }
        return 0
      }, SEL.assistant)

      await this.typeInto(input, text)
      await page.waitForTimeout(150)
      await this.submit(input)

      const answer = await this.waitForAnswer(before, onDelta)
      this.lastError = ''
      return answer
    } catch (e) {
      this.lastError = String(e?.message || e)
      throw e
    } finally {
      this.busy = false
    }
  }
}

/** OpenAI 的 content 允许是分片数组。 */
function flatten(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  }
  return ''
}

export { SEL }
