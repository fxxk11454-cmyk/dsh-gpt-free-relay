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

/**
 * 开了「思考」时加在提问前面的话。
 *
 * 网页版没有 reasoning 这种参数可传 —— 想让它认真想，只能用话术。
 * 改这里就能换说法，不用动别处。
 */
export const THINKING_PREFIX = '请你深度思考'

/**
 * 超过这个字数就用剪贴板粘贴，不再逐字敲。
 *
 * 逐字敲是"最像人"的做法，但代价是每个字符一次往返（delay 默认 4ms，
 * 实际含协议开销远不止）。几百字以上的提问逐字敲要好几秒甚至更久，
 * 而且中途被打断就前功尽弃。长文直接粘贴，短句仍然手打。
 *
 * 设为 0 表示永远手打；设为负数表示永远粘贴。
 */
export const DEFAULT_PASTE_THRESHOLD = 200

/** 未登录时页面上的登录入口。 */
const LOGIN_SELECTORS = [
  'a[href*="auth.openai.com"]',
  'button[data-testid="login-button"]',
  'a[href="/auth/login"]',
]

export class WebDriverChat {
  constructor({ browser, log, timeoutMs, thinkingPrefix, pasteThreshold } = {}) {
    this.browser = browser
    this.log = log || (() => {})
    /** 单轮回答的最长等待。模型想久了很正常，给足。 */
    this.timeoutMs = timeoutMs || 180000
    /** 开思考时加的前缀，可配 */
    this.thinkingPrefix = thinkingPrefix === undefined ? THINKING_PREFIX : thinkingPrefix
    /** 超过多少字改用剪贴板粘贴 */
    this.pasteThreshold = pasteThreshold === undefined ? DEFAULT_PASTE_THRESHOLD : pasteThreshold
    this.lastError = ''
    this.busy = false
    /** 最近一轮是怎么输入的，界面上能看到 */
    this.lastInput = null
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
      pasteThreshold: this.pasteThreshold,
      thinkingPrefix: this.thinkingPrefix,
      lastInput: this.lastInput,
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
   * 输入内容。短的手打，长的走剪贴板。
   *
   * 两条路都**不能**让换行变成发送 —— 见 typeByKeyboard 的说明。
   *
   * @param {import('playwright-core').ElementHandle} input 输入框
   * @param {string} text
   * @returns {Promise<'paste'|'type'|'insertText'>} 实际用了哪种方式
   */
  async typeText(input, text) {
    const page = this.page
    await input.click({ timeout: 8000 })
    await page.waitForTimeout(120)

    // 归一化换行；制表符在聊天框里可能移动焦点，换成空格更安全
    const normalized = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')

    // 长文本走剪贴板。阈值可配，见 DEFAULT_PASTE_THRESHOLD。
    const usePaste =
      this.pasteThreshold < 0 || (this.pasteThreshold > 0 && normalized.length > this.pasteThreshold)

    if (usePaste) {
      const how = await this.pasteText(normalized)
      if (how) {
        this.lastInput = { mode: how, chars: normalized.length }
        return how
      }
      // 剪贴板不可用（没授权 / 页面不在前台）—— 退回手打，别让整轮失败
      this.log('剪贴板粘贴不可用，退回逐字输入')
    }

    await this.typeByKeyboard(input, normalized)
    this.lastInput = { mode: 'type', chars: normalized.length }
    return 'type'
  }

  /**
   * 走剪贴板：把内容写进剪贴板，再按 Ctrl+V。
   *
   * 优先用真的剪贴板（Ctrl+V），失败则退到 execCommand('insertText') ——
   * 后者不需要任何权限，效果同样是"一次性插入一段文本"，
   * 与粘贴在 ProseMirror 看来几乎一样。
   *
   * @returns {Promise<'paste'|'insertText'|null>} 成功方式，都失败返回 null
   */
  async pasteText(text) {
    const page = this.page

    // 一：真剪贴板 + Ctrl+V
    try {
      const wrote = await page.evaluate(async (t) => {
        try {
          await navigator.clipboard.writeText(t)
          return true
        } catch {
          return false
        }
      }, text)
      if (wrote) {
        await page.keyboard.press('Control+V')
        await page.waitForTimeout(250)
        return 'paste'
      }
    } catch {
      /* 落到下一种 */
    }

    // 二：直接插入（不需要剪贴板权限）
    try {
      const ok = await page.evaluate((t) => {
        const el = document.activeElement || document.querySelector('[contenteditable="true"]')
        if (!el) return false
        el.focus()
        return document.execCommand('insertText', false, t)
      }, text)
      if (ok) {
        await page.waitForTimeout(200)
        return 'insertText'
      }
    } catch {
      /* 落到手打 */
    }

    return null
  }

  /**
   * 逐字键盘输入。
   *
   * 用键盘敲而不是 el.fill()：输入框是 contenteditable，ProseMirror 只认真实的
   * 输入事件。逐字敲也最像人。
   *
   * **换行必须用 Shift+Enter，不能用 \n。**
   * 这是本文件最容易踩的坑：Playwright 的 `keyboard.type` 遇到 `\n` 会真的按下
   * Enter 键，而在 ChatGPT 里 Enter 就是**发送**。而 `answer()` 总会把 system
   * 提示拼在前面（`sys.join('\n\n') + '\n\n' + text`），所以过去每一次带 system
   * 提示的请求都会变成：先把 system 提示当成一条消息发出去，再发一条空消息，
   * 真正的问题**根本没发出去**，然后卡在等一个不会来的回答上。
   *
   * 实测（模拟 Enter 发送的 contenteditable）：
   *   输入 "SYSTEM 提示\n\n用户的问题"  →  发送 2 次：["SYSTEM 提示", ""]
   *   输入框里还剩 "用户的问题"        ← 真正要发的东西没出去
   *
   * 改用 Shift+Enter 之后，换行只是换行，整段一次发出。
   */
  async typeByKeyboard(input, text) {
    const page = this.page
    const normalized = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')

    const lines = normalized.split('\n')
    const CHUNK = 200
    for (let li = 0; li < lines.length; li++) {
      // 段与段之间插一个真换行（不是发送）
      if (li > 0) await page.keyboard.press('Shift+Enter')
      const line = lines[li]
      for (let i = 0; i < line.length; i += CHUNK) {
        await page.keyboard.type(line.slice(i, i + CHUNK), { delay: 4 })
      }
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
   *
   * @param {Array} messages OpenAI 格式的消息
   * @param {(text: string) => void} [onDelta] 每拿到一段就回调
   * @param {{thinking?: boolean}} [options] thinking 为真时在提问前加一句
   *        让网页版认真想 —— 网页链路没有 reasoning 参数可传，只能用话术。
   */
  async answer(messages, onDelta, options = {}) {
    if (this.busy) throw new Error('浏览器正忙着上一轮，稍后再试')
    this.busy = true
    try {
      const input = await this.ensureReady()

      const text = buildPromptText(messages, {
        thinking: Boolean(options.thinking),
        prefix: this.thinkingPrefix,
      })
      if (!text) throw new Error('这一轮没有可发送的内容')
      const thinking = Boolean(options.thinking) && Boolean(this.thinkingPrefix) && text.startsWith(this.thinkingPrefix)

      const before = await this.answerCount()
      await this.clearInput(input)
      const mode = await this.typeText(input, text)
      await this.submit()

      const answer = await this.waitForAnswer(before, onDelta)
      this.lastSent = { chars: text.length, mode, thinking }
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

/**
 * 组装这一轮要打进输入框的文本。
 *
 * 抽成纯函数是为了能单独测 —— 它以前内联在 answer() 里，而 answer() 一调用
 * 就会去 ensureReady()（可能跳转页面），根本没法在不登录的情况下验证。
 *
 * 规则：
 *   - 只取**最后一条 user 消息**。浏览器里是同一个真实会话，历史由 ChatGPT
 *     自己维护；把整段历史再灌一遍会变成重复提问。
 *   - system / developer 提示没有对应概念，拼在最前面。
 *   - 开了思考再在最前面加一句前缀（见 THINKING_PREFIX）。
 *
 * @param {Array} messages OpenAI 格式消息
 * @param {{thinking?: boolean, prefix?: string}} [opts]
 * @returns {string} 要发送的文本（可能为空串）
 */
export function buildPromptText(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : []
  const lastUser = [...list].reverse().find((m) => (m.role || 'user') === 'user')
  let text = lastUser ? flatten(lastUser.content) : ''

  const sys = list.filter((m) => m.role === 'system' || m.role === 'developer')
  if (sys.length) text = `${sys.map((m) => flatten(m.content)).join('\n\n')}\n\n${text}`

  text = text.trim()

  const prefix = opts.prefix === undefined ? THINKING_PREFIX : opts.prefix
  if (opts.thinking && prefix && text && !text.startsWith(prefix)) {
    text = `${prefix}\n\n${text}`
  }
  return text
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
