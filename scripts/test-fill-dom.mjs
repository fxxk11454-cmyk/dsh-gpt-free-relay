/**
 * 「触控 DOM 注入」回归测试 —— 表单面板往页面里代填文字这条链路。
 *
 * 手机端的主力就是这个：VNC 画面点不出软键盘，所以由用户在原生输入框里打字、
 * 服务端代填进页面。过去这条链路上有一处**静默失效**：
 *
 *   contenteditable（ChatGPT 的输入框是 ProseMirror）走的是
 *       el.textContent = text
 *       el.dispatchEvent(new Event('input'))
 *   DOM 确实变了，但 ProseMirror 内部那份文档模型没变 —— 它下一次按键就把
 *   内容写回旧值。表现是"填了没反应"，再点发送就发出一条空消息，
 *   而且 fill() 一路回 ok:true，界面上什么都看不出来。
 *
 * 这个测试用一个**会写回的模拟页**复刻 ProseMirror 的判据（只认
 * inputType=insertText 的 input 事件），然后驱动真实的 HeadedBrowser：
 *   1. 老做法必须被拒绝 —— 证明这个坑是真的
 *   2. 新做法走 execCommand('insertText')，DOM 与"模型"都要同步
 *   3. execCommand 不可用时自动降级到手写 DOM 兜底，不能整轮失败
 *   4. 两级都失败时必须回 ok:false + 错误文案，不许谎报成功
 *   5. input / textarea 走原生 setter（React 才认），覆盖写是替换不是叠加
 *
 * 跑法：node scripts/test-fill-dom.mjs
 * 没有 Playwright / Chromium 时自动跳过（不算失败）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/**
 * 模拟页：复刻 ProseMirror 的判据。
 * #prompt-textarea 认 inputType=insertText 的 input（execCommand 与兜底都带），
 * 其它 input 一律回滚；#stubborn 谁也不认，用来测"失败要如实报错"。
 */
const MOCK_HTML = `<!doctype html><html><body>
<div id="prompt-textarea" class="ProseMirror" contenteditable="true"
     style="border:1px solid #000;min-height:80px;white-space:pre-wrap"></div>
<div id="stubborn" contenteditable="true"
     style="border:1px solid #000;min-height:40px;white-space:pre-wrap"></div>
<input id="plain" type="text">
<textarea id="ta"></textarea>
<script>
  window.pm = { committed: '', accepted: 0, rejected: 0 }
  const pm = document.getElementById('prompt-textarea')
  pm.addEventListener('input', (e) => {
    if (e.inputType === 'insertText') {
      window.pm.accepted += 1
      window.pm.committed = pm.innerText
      return
    }
    window.pm.rejected += 1
    pm.innerText = window.pm.committed
  })
  // 顽固元素：无论怎么改都写回自己那份，模拟"这个框真的填不进去"
  const st = document.getElementById('stubborn')
  st.addEventListener('input', () => { st.innerText = '拒绝写入' })
</script>
</body></html>`

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
const hasBrowser = Boolean(chromium) && existsSync(BROWSERS_PATH)

if (!hasBrowser) {
  process.stdout.write('没有 Playwright / Chromium，跳过（不算失败）。\n')
  process.stdout.write('装法见 scripts/linux/setup-browser.sh\n')
  process.exit(0)
}

const { HeadedBrowser } = await import('../lib/chatgpt/browser.js')

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext()
const page = await context.newPage()
await page.setContent(MOCK_HTML)

// 把真实实例的 page/context 换成这一套，其余逻辑原样跑
const hb = new HeadedBrowser({ log: () => {} })
hb.context = context
hb.page = page

const listed = await hb.listInputs()
const inputs = listed.items.filter((i) => i.kind === 'input')
const composer = inputs.find((i) => i.type === 'contenteditable')

// ─────────────────────────────────────────── 列表
group('表单探测（listInputs）')

await test('列得出页面上的控件', () => {
  assert.equal(inputs.length, 4, `应当有 4 个输入控件，实际 ${inputs.length}`)
})

await test('contenteditable 读的是当前内容，不是初始节点', async () => {
  await page.evaluate(() => {
    const el = document.getElementById('prompt-textarea')
    el.innerText = '已有的内容'
    window.pm.committed = '已有的内容'
  })
  const again = await hb.listInputs()
  const it = again.items.find((i) => i.type === 'contenteditable')
  assert.equal(it.value, '已有的内容')
})

// ─────────────────────────────────────────── 老做法
group('老做法必须失败（这就是原来的 bug）')

await test('直接改 textContent + 裸 input 事件，会被 ProseMirror 回滚', async () => {
  await page.evaluate(() => {
    const el = document.getElementById('prompt-textarea')
    el.textContent = '老做法写入'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const r = await page.evaluate(() => ({
    dom: document.getElementById('prompt-textarea').innerText,
    committed: window.pm.committed,
  }))
  assert.notEqual(r.committed, '老做法写入', '模型不该认这次写入')
  assert.notEqual(r.dom, '老做法写入', 'DOM 也该被回滚')
})

// ─────────────────────────────────────────── 新做法
group('新做法：逐级尝试 + 每级核对')

await test('走 execCommand，多行文本，DOM 与模型同步', async () => {
  const r = await hb.fill(composer.idx, '你好，这是第一行\n这是第二行')
  assert.equal(r.ok, true, `fill 应当成功：${JSON.stringify(r)}`)
  assert.equal(r.method, 'execCommand')
  const s = await page.evaluate(() => ({
    dom: document.getElementById('prompt-textarea').innerText,
    committed: window.pm.committed,
  }))
  assert.match(s.dom, /第一行/)
  assert.match(s.dom, /第二行/)
  assert.equal(s.committed, s.dom, '模型内容要和 DOM 一致')
})

await test('execCommand 不可用时降级到 DOM 兜底，仍然成功', async () => {
  await page.evaluate(() => {
    window.__origQCS = document.queryCommandSupported
    document.queryCommandSupported = () => false
  })
  const r = await hb.fill(composer.idx, '兜底写入的文本')
  await page.evaluate(() => {
    document.queryCommandSupported = window.__origQCS
  })
  assert.equal(r.ok, true, `兜底应当成功：${JSON.stringify(r)}`)
  assert.equal(r.method, 'dom')
  const dom = await page.evaluate(() => document.getElementById('prompt-textarea').innerText)
  assert.equal(dom.trim(), '兜底写入的文本')
})

await test('覆盖写是替换，不是叠加', async () => {
  await hb.fill(composer.idx, '换成这一句')
  const dom = await page.evaluate(() => document.getElementById('prompt-textarea').innerText)
  assert.equal(dom.trim(), '换成这一句')
})

await test('传空串 = 清空输入框', async () => {
  const r = await hb.fill(composer.idx, '')
  const dom = await page.evaluate(() => document.getElementById('prompt-textarea').innerText)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(dom.trim(), '')
})

await test('两级都失败时如实报错，不许谎报成功', async () => {
  const stubborn = (await hb.listInputs()).items.filter((i) => i.kind === 'input')[1]
  const r = await hb.fill(stubborn.idx, '写不进去的字')
  assert.equal(r.ok, false, `应当报失败：${JSON.stringify(r)}`)
  assert.match(r.error, /没接受|进到页面/)
})

// ─────────────────────────────────────────── 原生控件
group('原生表单控件')

await test('input 走原生 setter + input/change（React 才认）', async () => {
  const idx = inputs.find((i) => i.type === 'text').idx
  const r = await hb.fill(idx, 'abc')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.method, 'value')
  const v = await page.evaluate(() => document.getElementById('plain').value)
  assert.equal(v, 'abc')
})

await test('textarea 支持多行', async () => {
  const idx = inputs.find((i) => i.type === 'textarea').idx
  const r = await hb.fill(idx, '多行\n文本')
  assert.equal(r.ok, true, JSON.stringify(r))
  const v = await page.evaluate(() => document.getElementById('ta').value)
  assert.equal(v, '多行\n文本')
})

// ─────────────────────────────────────────── 边界
group('边界')

await test('元素不存在时返回 ok:false 并带提示', async () => {
  const r = await hb.fill(9999, 'x')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

await browser.close()

process.stdout.write(`\n${'─'.repeat(52)}\n`)
process.stdout.write(`通过 ${passed} · 失败 ${failed}\n`)
if (failed) {
  process.stdout.write('\n失败明细：\n')
  for (const [name, e] of failures) process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过。\n')
}
