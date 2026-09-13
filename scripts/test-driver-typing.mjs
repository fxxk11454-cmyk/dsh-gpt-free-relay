/**
 * 「浏览器作答」输入链路回归测试。
 *
 * 这条链路过去一直没验证通过，README 里写着"文字真正进入输入框这一步还没跑通"。
 * 真因是 Playwright 的 `keyboard.type` 遇到 `\n` 会真的按 Enter，而在 ChatGPT
 * 里 Enter 就是**发送**。于是带 system 提示的请求会先把提示发出去、再发一条空
 * 消息，真正的问题根本没发出去。
 *
 * 这个测试不需要 ChatGPT 账号，也不需要登录 —— 它用一个模拟页把
 * "Enter 就发送、Shift+Enter 换行"这条约定复刻出来，然后驱动**真实的
 * WebDriverChat**，检查四件事：
 *   1. 打字阶段绝不能触发发送（这是那个致命 bug 的回归测试）
 *   2. 输入框里的内容要和输入一致
 *   3. 长文走剪贴板、短文手打（阈值按字数切换）
 *   4. 没有剪贴板权限时要能自动退到 insertText，不能整轮失败
 *   另外单独测 detectThinking() 的判定矩阵。
 *
 * 跑法：node scripts/test-driver-typing.mjs
 * 没有 Playwright / Chromium 时自动跳过（不算失败）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const BROWSER_HOME = process.env.BROWSER_HOME || '/root/.dsh-browser'
const BROWSERS_PATH = `${BROWSER_HOME}/browsers`

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (e) {
    failed += 1
    failures.push([name, e])
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`)
  }
}

function group(title) {
  process.stdout.write(`\n${title}\n`)
}

/** 模拟页：复刻 ChatGPT 输入框的两条关键行为。 */
const MOCK_HTML = `<!doctype html><html><body>
<div id="box" contenteditable="true"
     style="border:1px solid #000;min-height:80px;white-space:pre-wrap"></div>
<script>
  const box = document.getElementById('box')
  window.sent = []
  window.shiftEnters = 0
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { window.shiftEnters += 1; return }
    if (e.key === 'Enter') {
      e.preventDefault()
      window.sent.push(box.innerText)
      box.innerHTML = ''
    }
  })
</script>
</body></html>`

// ─────────────────────────────────────────── detectThinking
group('思考判定（detectThinking）')

const { detectThinking } = await import('../lib/chatgpt/bridge.js')

const THINK_CASES = [
  ['不发任何思考字段', {}, false],
  ['reasoning_effort: high', { reasoning_effort: 'high' }, true],
  ['reasoning_effort: off', { reasoning_effort: 'off' }, false],
  ['reasoning_effort: none', { reasoning_effort: 'none' }, false],
  ['reasoning_effort: 空串', { reasoning_effort: '' }, false],
  ['reasoning: { effort: medium }', { reasoning: { effort: 'medium' } }, true],
  ['reasoning: { enabled: true }', { reasoning: { enabled: true } }, true],
  ['reasoning: low', { reasoning: 'low' }, true],
  ['thinking: { type: enabled }', { thinking: { type: 'enabled' } }, true],
  ['thinking: { type: disabled }', { thinking: { type: 'disabled' } }, false],
  ['thinking: true', { thinking: true }, true],
  ['enable_thinking: true', { enable_thinking: true }, true],
  ['chat_template_kwargs.enable_thinking', { chat_template_kwargs: { enable_thinking: true } }, true],
  ['null', null, false],
  ['非对象', 'x', false],
]
for (const [name, body, want] of THINK_CASES) {
  test(name, () => assert.equal(detectThinking(body), want))
}

// ─────────────────────────────────────────── 浏览器部分
async function loadChromium() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH
  for (const c of ['playwright-core', join(BROWSER_HOME, 'node_modules/playwright-core/index.js')]) {
    try {
      const mod = await import(c)
      const chromium = mod?.chromium || mod?.default?.chromium
      if (chromium) return chromium
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const chromium = await loadChromium()
if (!chromium || !existsSync(BROWSERS_PATH)) {
  process.stdout.write('\n输入链路测试：跳过（本机没有 Playwright / Chromium）\n')
  process.stdout.write(`  预期浏览器在 ${BROWSERS_PATH}\n`)
  process.stdout.write('  装它：bash setup.sh（Linux）或 setup.bat（Windows）\n')
  process.stdout.write(`\n${'─'.repeat(52)}\n通过 ${passed} · 失败 ${failed}\n`)
  process.exit(failed ? 1 : 0)
}

// 起一个本地 http 服务当模拟站（127.0.0.1 是安全上下文，剪贴板 API 才可用）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
  res.end(MOCK_HTML)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const { WebDriverChat, buildPromptText, THINKING_PREFIX } = await import('../lib/chatgpt/driver.js')

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

/** 开一个页面；withClipboard 决定是否授予剪贴板权限。 */
async function newPage(withClipboard) {
  const ctx = await browser.newContext()
  if (withClipboard) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
  }
  const page = await ctx.newPage()
  await page.goto(ORIGIN + '/')
  return page
}

function makeDriver(page, opts = {}) {
  return new WebDriverChat({ browser: { running: true, page }, log: () => {}, ...opts })
}

const reset = (page) =>
  page.evaluate(() => {
    window.sent = []
    window.shiftEnters = 0
    document.getElementById('box').innerHTML = ''
  })

// ─────────────────────────────────────────── 手打路径
group('手打路径（短文）')

const pageA = await newPage(true)
const driverA = makeDriver(pageA, { pasteThreshold: 200 })
const inputA = await pageA.$('#box')

async function typeCase(name, text, expected, opts = {}) {
  const d = opts.driver || driverA
  const p = opts.page || pageA
  const input = opts.input || inputA
  await reset(p)
  await d.typeText(input, text)
  const sent = await p.evaluate(() => window.sent)
  const left = await p.evaluate(() => document.getElementById('box').innerText)
  assert.equal(sent.length, 0, `输入阶段不该发送，却发了 ${sent.length} 条：${JSON.stringify(sent)}`)
  assert.equal(left, expected, `输入框内容不对\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(left)}`)
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

await typeCase('单行文本', '你好', '你好')
await typeCase('带 system 提示（旧代码在此必炸）', 'SYSTEM 提示\n\n用户的问题', 'SYSTEM 提示\n\n用户的问题')
await typeCase('多行代码块', '看这段：\n```js\nconst a = 1\n```', '看这段：\n```js\nconst a = 1\n```')
await typeCase('CRLF 归一化成 LF', 'A\r\nB\r\nC', 'A\nB\nC')
await typeCase('制表符换成空格', '列1\t列2', '列1  列2')
await typeCase('空字符串', '', '')

await reset(pageA)
await driverA.typeText(inputA, 'A\nB\nC')
const shifts = await pageA.evaluate(() => window.shiftEnters)
await test('两处换行 = 两次 Shift+Enter', () => assert.equal(shifts, 2, `期望 2，实际 ${shifts}`))

// ─────────────────────────────────────────── 剪贴板路径
group('剪贴板路径（长文，已授权）')

// 必须超过默认阈值 200，才能验到"长文自动转粘贴"这条规则本身
const LONG = '这是一段很长的文本。'.repeat(25) // 275 字 > 200
assert.ok(LONG.length > 200, '测试数据要长过默认阈值')
const driverDefault = makeDriver(pageA) // 用默认阈值（200）
const defaultThreshold = driverDefault.pasteThreshold
assert.equal(defaultThreshold, 200, `默认阈值应为 200，实际 ${defaultThreshold}`)

await reset(pageA)
const modeLong = await driverDefault.typeText(inputA, LONG)
await test('超过默认阈值自动走粘贴', () => assert.equal(modeLong, 'paste', `实际用了 ${modeLong}`))

const leftLong = await pageA.evaluate(() => document.getElementById('box').innerText)
await test('粘贴后内容逐字一致', () => assert.equal(leftLong, LONG, `长度 ${leftLong.length} vs ${LONG.length}`))

const sentLong = await pageA.evaluate(() => window.sent)
await test('粘贴不会误触发发送', () => assert.equal(sentLong.length, 0))

await reset(pageA)
const modeShort = await driverA.typeText(inputA, '短句')
await test('未超过阈值仍手打', () => assert.equal(modeShort, 'type', `实际用了 ${modeShort}`))

// 阈值可配：设成 0 表示永远手打
const neverPaste = makeDriver(pageA, { pasteThreshold: 0 })
await reset(pageA)
const modeNever = await neverPaste.typeText(inputA, LONG)
await test('阈值 0 = 永远手打', () => assert.equal(modeNever, 'type', `实际用了 ${modeNever}`))

// 阈值负数 = 永远粘贴
const alwaysPaste = makeDriver(pageA, { pasteThreshold: -1 })
await reset(pageA)
const modeAlways = await alwaysPaste.typeText(inputA, 'x')
await test('阈值负数 = 永远粘贴', () => assert.equal(modeAlways, 'paste', `实际用了 ${modeAlways}`))

// ─────────────────────────────────────────── 无权限退路
group('剪贴板无权限时的退路')

const pageB = await newPage(false) // 故意不授权
const driverB = makeDriver(pageB, { pasteThreshold: 10 })
const inputB = await pageB.$('#box')
await reset(pageB)
const modeFallback = await driverB.typeText(inputB, LONG)
await test('无权限时自动退到 insertText 或手打', () => {
  assert.ok(['insertText', 'type'].includes(modeFallback), `实际用了 ${modeFallback}`)
})
const leftFallback = await pageB.evaluate(() => document.getElementById('box').innerText)
await test('退路下内容依然逐字一致', () => assert.equal(leftFallback, LONG, `长度 ${leftFallback.length} vs ${LONG.length}`))

// ─────────────────────────────────────────── 提示词组装
//
// buildPromptText 是纯函数，不需要浏览器 —— 这正是不把它内联在 answer() 里的原因：
// answer() 一调用就会 ensureReady() 跳转页面，不登录根本没法验。
group('提示词组装（buildPromptText）')

await test('只取最后一条 user 消息，历史不重灌', () => {
  const out = buildPromptText([
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回答一' },
    { role: 'user', content: '第二轮' },
  ])
  assert.equal(out, '第二轮', '只应发最后一条 user，否则浏览器里会重复提问')
})

await test('system 提示拼在最前面', () => {
  const out = buildPromptText([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '问题' },
  ])
  assert.equal(out, '你是助手\n\n问题')
})

await test('开思考时最前面加「请你深度思考」', () => {
  const out = buildPromptText([{ role: 'user', content: '问题' }], { thinking: true })
  assert.ok(out.startsWith(THINKING_PREFIX), `实际：${JSON.stringify(out)}`)
  assert.ok(out.endsWith('问题'))
})

await test('不开思考时一个字都不加', () => {
  const out = buildPromptText([{ role: 'user', content: '问题' }], { thinking: false })
  assert.equal(out, '问题')
})

await test('思考前缀在 system 之前', () => {
  const out = buildPromptText(
    [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题' },
    ],
    { thinking: true },
  )
  assert.ok(out.startsWith(THINKING_PREFIX), `实际：${JSON.stringify(out)}`)
  assert.ok(out.indexOf(THINKING_PREFIX) < out.indexOf('你是助手'), '前缀要在 system 之前')
})

await test('已有前缀时不重复添加', () => {
  const once = buildPromptText([{ role: 'user', content: '问题' }], { thinking: true })
  const twice = buildPromptText([{ role: 'user', content: once }], { thinking: true })
  assert.equal((twice.match(/请你深度思考/g) || []).length, 1, `重复添加了：${JSON.stringify(twice)}`)
})

await test('空输入不产生只带前缀的空消息', () => {
  assert.equal(buildPromptText([], { thinking: true }), '')
  assert.equal(buildPromptText([{ role: 'user', content: '' }], { thinking: true }), '')
})

await test('前缀可配成空串 = 不加', () => {
  const out = buildPromptText([{ role: 'user', content: '问题' }], { thinking: true, prefix: '' })
  assert.equal(out, '问题')
})

await test('content 分片数组能拍平', () => {
  const out = buildPromptText([{ role: 'user', content: [{ type: 'text', text: '分片' }] }])
  assert.equal(out, '分片')
})

// ─────────────────────────────────────────── 对照：旧实现确实会炸
group('对照实验（证明这个测试抓得住旧实现）')

await reset(pageA)
await pageA.keyboard.type('SYSTEM 提示\n\n用户的问题', { delay: 1 })
const oldSent = await pageA.evaluate(() => window.sent)
await test('旧实现把一条消息拆成多条（premature send）', () => {
  assert.ok(oldSent.length > 1, `旧实现应当误发多条，实际只发了 ${oldSent.length} 条`)
})

await browser.close()
server.close()

process.stdout.write(`\n${'─'.repeat(52)}\n`)
process.stdout.write(`通过 ${passed} · 失败 ${failed}\n`)
if (failed) {
  process.stdout.write('\n失败明细：\n')
  for (const [name, e] of failures) process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过。\n')
}
