/**
 * 客户端卡片的渲染冒烟测试。
 *
 * 为什么需要它：卡片是**展开时才渲染主体**的。折叠态看起来一切正常，
 * 一旦用户点开就会执行那一大段 JSX —— 如果里面有未定义变量，
 * React 会抛异常，表现是**整张卡片直接消失**，而且界面上没有任何报错。
 *
 * 这个坑踩过两次（br 和 banner 的定义在重构时被误删）。静态检查查不出
 * "变量没定义"，只有真渲染才会暴露，所以把它固化成测试。
 *
 * 用法：node scripts/test-client-render.mjs
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 忠实模拟 React 的 hooks：按调用顺序存储，setState 可触发重渲染。
 * 关键是**顺序必须对上**，否则测出来的结果是假的。
 */
function makeReact() {
  let hooks = []
  let cursor = 0
  let schedule = null
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(init) {
      const i = cursor++
      if (hooks.length <= i) hooks[i] = typeof init === 'function' ? init() : init
      return [hooks[i], (v) => {
        hooks[i] = typeof v === 'function' ? v(hooks[i]) : v
        if (schedule) schedule()
      }]
    },
    useCallback: (f) => f,
    useEffect: () => {},
  }
  return {
    react,
    /** 设定初始 hooks 值。不传就是全 undefined（等同组件里的默认初值）。 */
    reset(initial) {
      hooks = initial ? [...initial] : []
      cursor = 0
    },
    setScheduler(fn) {
      schedule = fn
    },
  }
}

const sim = makeReact()
let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      mod = factory((n) => (n === 'react' ? sim.react : {}))
    },
  },
}
globalThis.fetch = async () => ({ json: async () => ({}) })

await import(pathToFileURL(join(ROOT, 'lib/client.js')).href)

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  ❌ ${name}`)
    console.log(`     ${e.message}`)
  }
}

// 装载插件，取出卡片组件
const slots = []
mod.apply({
  effect: (f) => f(),
  locale: { register: () => {}, bind: () => (k) => k },
  slots: {
    inject: (name, gen) => {
      for (const s of gen()) slots.push(s)
    },
    register: (opts, C) => ({ opts, C }),
  },
})
const Card = slots[0].C

/**
 * hooks 顺序（与 lib/client.js 里的 useState 声明顺序一致）：
 *  0 open   1 mode   2 status  3 url     4 nodes  5 picked  6 msg   7 busy
 *  8 saved  9 keptLonger 10 askClear 11 nonce 12 vncNonce
 * 13 form  14 formMsg   15 drafts
 */
const RUNNING_BROWSER = {
  browser: { running: true, url: 'https://chatgpt.com/', viewerUrl: 'http://127.0.0.1:2083/novnc/index.html', vnc: true },
}
const FORM_DATA = {
  items: [
    { idx: 0, kind: 'input', type: 'text', placeholder: 'Ask ChatGPT' },
    { idx: 1, kind: 'button', label: 'Send' },
  ],
}

console.log('客户端卡片渲染测试')
check('模块加载 + apply', () => {
  if (!mod || typeof mod.apply !== 'function') throw new Error('没有导出 apply')
  if (slots.length !== 1) throw new Error(`应注册 1 张卡片，实际 ${slots.length}`)
})

check('折叠态', () => {
  sim.reset()
  Card({ t: (k) => k })
})

check('展开 · 普通端', () => {
  sim.reset([true, 'normal'])
  Card({ t: (k) => k })
})

check('展开 · 浏览器作答（未启动）', () => {
  sim.reset([true, 'vnc'])
  Card({ t: (k) => k })
})

check('展开 · 浏览器作答（运行中）', () => {
  sim.reset([true, 'vnc', RUNNING_BROWSER])
  Card({ t: (k) => k })
})

check('展开 · 表单列表', () => {
  sim.reset([true, 'vnc', RUNNING_BROWSER, '', [], '0', '', false, null, false, false, 0, 0, FORM_DATA, '', {}])
  Card({ t: (k) => k })
})

check('展开 · 被 Cloudflare 挑战（横幅）', () => {
  sim.reset([true, 'normal', { chatgpt: { challengedAt: Date.now(), hasClearance: false, loggedIn: false } }])
  Card({ t: (k) => k })
})

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
