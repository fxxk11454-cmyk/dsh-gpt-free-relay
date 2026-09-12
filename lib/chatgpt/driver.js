/**
 * 浏览器作答 —— 像人一样在 ChatGPT 页面上打字、发送、读回答。
 *
 * 为什么不走后端接口：直接调 /backend-api 需要 accessToken 和 Sentinel proof，
 * 上游一改就崩，还得过 Cloudflare。人怎么用页面，这里就怎么用 ——
 * 天生带登录态，不碰 token，不碰 Sentinel。
 *
 * 页面结构是**实测**出来的，不是猜的：
 *   - 输入框是 contenteditable（ProseMirror），不是 textarea。
 *     所以不能用 el.fill()，得聚焦后用键盘敲 —— 这也最贴近真人。
 *   - **页面上没有发送按钮**（要输入文字后才出现），发送本质上就是按回车。
 *   - 助手消息：div[data-message-author-role="assistant"]
 *   - 生成中会出现 button[data-testid="stop-button"]
 */

/** 输入框候选选择器，按可靠性排序。 */
const INPUT_SELECTORS = [
  '#prompt-textarea',
  'div[contenteditable="true"]#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]',
  'form div[contenteditable="true"]',
  'textarea[data-id="root"]',
  'textarea[placeholder]',
]

/** 发送按钮 —— 只在有内容时出现，所以"能用就用，不能用就回车"。 */
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
  '#composer-submit-button',
]

/** 生成中的停止按钮。出现说明还在输出，消失说明输出完了。 */
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label*="Stop"]',
]

/** 助手消息容器。 */
const ASSISTANT_SELECTORS = ['[data-message-author-role="assistant"]']

/** 未登录时页面上的登录入口。 */
const LOGIN_SELECTORS = [
  'a[href*="auth.openai.com"]',
  'button[data-testid="login-button"]',
  'a[href*="/auth/login"]',
]

export class WebDriverChat {
  constructor({ browser, log, timeoutMs } = {}) {
    this.browser = browser
    this.log = log || (() => {})
    /** 单轮回答的最长等待。模型想久了很正常，给足。 */
    this.timeoutMs = timeoutMs || 180000
    this.lastError = ''
    this.busy = false
  }

  get available() {
    return Boolean(this.browser && this.browser.running && this.browser.page)
  }

  get status() {
    return {
      available: this.available,
      busy: this.busy,
      lastError: this.lastError,
      url: this.available ? this.browser.page.url() : '',
    }
  }

  get page() {
    if (!this.available) throw new Error('浏览器没在跑 —— 先点「启动并打开 ChatGPT」')
    return this.browser.page
  }

  /**
   * 找到第一个可见的匹配元素。
   *
   * **返回 ElementHandle 本身**，不是包装对象。上一版就是返回了 {el, sel}
   * 而调用方当元素用，报 el.click is not a function —— 整条链路因此不可用。
   */
  async findFirst(selectors, timeoutMs = 8000) {
    const page = this.page
    const deadline = Date.now() + timeoutMs
    for (;;) {
      for (const sel of selectors) {
        try {
          const handles = await page.$$(sel)
          for (const h of handles) {
            if (await h.isVisible().catch(() => false)) return h
          }
        } catch {
          /* 选择器不合法或页面在切，换下一个 */
        }
      }
      if (Date.now() >= deadline) return null
      await page.waitForTimeout(250)
    }
  }

  /** 确认页面可对话。没登录就把话说清楚。 */
  async ensureReady() {
    if (!this.browser.running) {
      const r = await this.browser.start()
      if (!r.ok) throw new Error(r.error)
      await this.browser.open()
    }
    const page = this.page

    if (!/chatgpt\.com/.test(page.url())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(2500)
    }

    const input = await this.findFirst(INPUT_SELECTORS, 15000)
    if (input) return input

    const login = await this.findFirst(LOGIN_SELECTORS, 1500)
    if (login) throw new Error('还没登录 —— 点右下角「键盘」按钮登录一次，之后就不会再问')
    throw new Error('页面上找不到输入框。可能还在加载，或 ChatGPT 改版了；点「启动并打开 ChatGPT」重试')
  }

  /** 清空输入框。用全选+删除，比改 DOM 靠谱（ProseMirror 有自己的状态）。 */
  async clearInput(input) {
    const page = this.page
    try {
      await input.click({ timeout: 5000 })
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      await page.waitForTimeout(80)
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 打字。
   *
   * 用键盘敲而不是 el.fill()：输入框是 contenteditable，ProseMirror 只认真实的
   * 输入事件。逐字敲也最像人。长文本分块，避免被当成一次性粘贴。
   */
  async typeText(input, text) {
    const page = this.page
    await input.click({ timeout: 8000 })
    await page.waitForTimeout(120)
    const CHUNK = 200
    for (let i = 0; i < text.length; i += CHUNK) {
      await page.keyboard.type(text.slice(i, i + CHUNK), { delay: 4 })
    }
    await page.waitForTimeout(150)
  }

  /** 发送：优先点发送按钮，没有就回车。 */
  async submit() {
    const page = this.page
    const send = await this.findFirst(SEND_SELECTORS, 2000)
    if (send) {
      try {
        await send.click({ timeout: 4000 })
        return
      } catch {
        /* 点不动就回车 */
      }
    }
    await page.keyboard.press('Enter')
  }

  /** 读最后一条助手消息的文本。 */
  async lastAnswer() {
    const page = this.page
    return page.evaluate((sels) => {
      let nodes = []
      for (const sel of sels) {
        const found = document.querySelectorAll(sel)
        if (found.length) {
          nodes = Array.from(found)
          break
        }
      }
      if (!nodes.length) return ''
      const last = nodes[nodes.length - 1]
      // 优先读 markdown 正文，避免把工具条上的按钮文字带进来
      const md = last.querySelector('.markdown') || last
      return (md.innerText || md.textContent || '').trim()
    }, ASSISTANT_SELECTORS)
  }

  /** 助手消息条数，用来判断这一轮有没有新增回答。 */
  async answerCount() {
    const page = this.page
    return page.evaluate((sels) => {
      for (const sel of sels) {
        const n = document.querySelectorAll(sel)
        if (n.length) return n.length
      }
      return 0
    }, ASSISTANT_SELECTORS)
  }

  /**
   * 等这一轮答完。
   *
   * 判据分两阶段，缺一不可：
   *   1. 先等它**开始**生成（停止按钮出现，或助手消息条数变多）
   *   2. 再等它**结束**（停止按钮消失，且内容稳定一小会儿）
   * 只等按钮消失是不够的 —— 按钮还没出现时会被误判成"已经答完了"。
   */
  async waitForAnswer(beforeCount, onDelta) {
    const page = this.page
    const start = Date.now()
    const hasStop = async () => Boolean(await this.findFirst(STOP_SELECTORS, 200))

    // 阶段一：等开始（最多 20 秒）
    let started = false
    while (Date.now() - start < 20000) {
      if (await hasStop()) {
        started = true
        break
      }
      if ((await this.answerCount()) > beforeCount) {
        started = true
        break
      }
      await page.waitForTimeout(250)
    }

    // 阶段二：边读边等结束
    let last = ''
    let stableSince = 0
    while (Date.now() - start < this.timeoutMs) {
      const text = await this.lastAnswer()
      if (text && text !== last) {
        last = text
        stableSince = Date.now()
        if (onDelta) onDelta(text)
      }
      if (await hasStop()) {
        await page.waitForTimeout(400)
        continue
      }
      // 不在生成中：内容稳定 1.2 秒就认为结束了
      if (last && stableSince && Date.now() - stableSince > 1200) return last
      await page.waitForTimeout(400)
    }

    if (last) return last
    throw new Error(
      started
        ? '等回答超时 —— 页面可能卡住了'
        : '看起来没有开始生成 —— 确认已登录，或在页面上手动试一句',
    )
  }

  /**
   * 跑一轮：把最后一条用户内容打进去，把回答读回来。
   *
   * 只发最后一条：浏览器里是**同一个真实会话**，历史由 ChatGPT 自己维护。
   * 把整段历史再灌一遍会变成重复提问。system 提示没有对应概念，拼在开头。
   */
  async answer(messages, onDelta) {
    if (this.busy) throw new Error('浏览器正忙着上一轮，稍后再试')
    this.busy = true
    try {
      const input = await this.ensureReady()

      const list = Array.isArray(messages) ? messages : []
      const lastUser = [...list].reverse().find((m) => (m.role || 'user') === 'user')
      let text = lastUser ? flatten(lastUser.content) : ''
      const sys = list.filter((m) => m.role === 'system' || m.role === 'developer')
      if (sys.length) text = `${sys.map((m) => flatten(m.content)).join('\n\n')}\n\n${text}`
      text = text.trim()
      if (!text) throw new Error('这一轮没有可发送的内容')

      const before = await this.answerCount()
      await this.clearInput(input)
      await this.typeText(input, text)
      await this.submit()

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

/** OpenAI 的 content 允许是分片数组，拍平成文本。 */
function flatten(content) {
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

export { INPUT_SELECTORS, SEND_SELECTORS, STOP_SELECTORS, ASSISTANT_SELECTORS }
