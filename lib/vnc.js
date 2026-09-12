/**
 * 远程桌面：把容器里那个「有头浏览器」的画面和操作搬到卡片上。
 *
 * 为什么要它：Chromium 跑在 Xvfb 虚拟屏上，用户看不见也就没法登录。
 * x11vnc 把虚拟屏暴露成 VNC，这里再用一个 WebSocket 桥把 VNC 的 TCP
 * 转给浏览器里的 noVNC —— 于是卡片里就能直接看到并操作那个浏览器。
 *
 * 全部只监听 127.0.0.1，不对外。
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import net from 'node:net'

const RUNTIME_DIR = '/root/.dsh-browser'
const NOVNC_DIR = join(RUNTIME_DIR, 'node_modules/@novnc/novnc')
const WS_PATH = '/vnc-ws'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/** noVNC 自带的是模块化 core，没有开箱可用的页面，这里补一个最简的。 */
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>浏览器画面</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b0c;overflow:hidden;
    font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#ddd}
  #screen{width:100%;height:100%}
  #tip{position:fixed;left:0;right:0;top:0;padding:6px 10px;text-align:center;
    background:rgba(0,0,0,.55);font-size:12px;pointer-events:none;z-index:9}
  /* 藏在画面底部：不可见但仍可聚焦，这样软键盘才会弹出来。
     用 display:none / visibility:hidden 都不行 —— 那样无法聚焦。 */
  #kbBtn{position:fixed;right:12px;bottom:12px;z-index:10;
    padding:10px 16px;border-radius:999px;border:0;
    background:rgba(40,40,44,.92);color:#fff;font:600 14px system-ui,sans-serif;
    box-shadow:0 2px 10px rgba(0,0,0,.45);cursor:pointer;
    -webkit-tap-highlight-color:transparent}
  #kbBtn:active{background:rgba(80,80,90,.95)}
  #kbd{position:fixed;left:0;bottom:0;width:100%;height:1px;opacity:0.01;
    border:0;padding:0;margin:0;background:transparent;color:transparent;
    font-size:16px; /* iOS 上小于 16px 会触发页面缩放 */
    z-index:5;resize:none;outline:none}
</style>
</head>
<body>
<div id="screen"></div>
<div id="tip">正在准备浏览器…</div>

<!-- 手机上点这个按钮唤出系统软键盘，再往画面里打字 -->
<button id="kbBtn" type="button">键盘</button>

<!--
  手机软键盘的入口。
  手机上点 VNC 画面，浏览器不会弹键盘 —— 因为没有可聚焦的输入元素。
  所以这里放一个几乎看不见的 textarea：点画面时聚焦它，系统软键盘就出来了，
  敲的字通过 keydown 转发给 VNC，再清空它。
-->
<textarea id="kbd" autocomplete="off" autocorrect="off" autocapitalize="off"
  spellcheck="false" aria-label="键盘输入"></textarea>
<script type="module">
import RFB from '/novnc/core/rfb.js'
const tip = document.getElementById('tip')
const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '${WS_PATH}'

let rfb = null
let tries = 0

function show(msg) { tip.style.display = ''; tip.textContent = msg }

function connect() {
  if (rfb) { try { rfb.disconnect() } catch {} }
  rfb = new RFB(document.getElementById('screen'), url, { credentials: { password: '' } })
  rfb.scaleViewport = true
  rfb.resizeSession = false
  rfb.showDotCursor = true

  // 关键：TCP 连上不代表有画面。x11vnc 没起来时连接会挂在那儿一个字节都不来，
  // 表现就是「永远卡在加载」。所以这里加超时，连不上就自己去拉起后端。
  const watchdog = setTimeout(async () => {
    if (connected) return
    try { rfb.disconnect() } catch {}
    show('正在启动浏览器…（第一次要十几秒）')
    try {
      await fetch('/browser/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    } catch {}
    setTimeout(connect, 1200)
  }, 4000)

  let connected = false
  rfb.addEventListener('connect', () => {
    connected = true
    clearTimeout(watchdog)
    tries = 0
    show('已连接 —— 直接在上面操作即可')
    tip.style.display = 'none'
  })
  rfb.addEventListener('disconnect', () => {
    clearTimeout(watchdog)
    if (connected) {
      connected = false
      tries += 1
      if (tries > 5) { show('连接不稳定，点此重试'); tip.style.pointerEvents = 'auto'; tip.onclick = () => location.reload(); return }
    }
    show('正在重连…')
    setTimeout(connect, 1500)
  })
}

connect()

// ── 手机软键盘 ──────────────────────────────────────────────────────────────
// 点画面就把焦点给隐藏 textarea，系统键盘随即弹出；按键逐个转给 VNC。
const kbd = document.getElementById('kbd')
const screen = document.getElementById('screen')

function focusKbd() {
  try { kbd.focus({ preventScroll: true }) } catch { try { kbd.focus() } catch {} }
  // noVNC 平时把键盘挂在 canvas 上；我们的按键从隐藏 textarea 来，
  // 所以顺手确保它的键盘处理器处于 grab 状态，事件才会被处理。
  try { rfb && rfb._keyboard && rfb._keyboard.grab() } catch {}
}

// 只由这个按钮唤出键盘 —— 点画面容易误触，用户明确要求用按钮
const kbBtn = document.getElementById('kbBtn')
// 注意：不能 preventDefault。软键盘只允许在"真实的用户手势"里唤起，
// 一旦阻止默认行为，浏览器就认为这不是用户意图，键盘不会出来。
// 只留 click 就够 —— 手机点按钮同样会派发 click。
kbBtn.addEventListener('click', () => focusKbd())

// 关键：不自己算 keysym，而是把事件转交给 noVNC 的 Keyboard 处理器。
// 它内部用 KeyboardUtil.getKeysym() 做 DOM key → X11 keysym 的映射，
// 还维护按下状态、numlock/capslock。自己手写这套一定会有字符对不上。
function forward(type, srcEvent, extra) {
  if (!rfb) return
  const handler = rfb._keyboard
  if (!handler) return
  const ev = new KeyboardEvent(type, {
    key: srcEvent.key || '',
    code: srcEvent.code || '',
    keyCode: srcEvent.keyCode || 0,
    which: srcEvent.which || 0,
    location: srcEvent.location || 0,
    ctrlKey: !!srcEvent.ctrlKey,
    altKey: !!srcEvent.altKey,
    shiftKey: !!srcEvent.shiftKey,
    metaKey: !!srcEvent.metaKey,
    bubbles: true,
    cancelable: true,
    ...(extra || {}),
  })
  try {
    // noVNC 的处理器就是挂在 document 上的 keydown/keyup
    if (type === 'keydown') handler._handleKeyDown(ev)
    else handler._handleKeyUp(ev)
  } catch {
    try { rfb.dispatchEvent(ev) } catch {}
  }
}

kbd.addEventListener('keydown', (e) => {
  // Enter / 退格 / 方向键这些必须真的送过去，否则远端收不到
  forward('keydown', e)
  if (e.key && e.key.length === 1) {
    // 普通字符：让 textarea 收下然后走 input 事件，避免重复发送
  } else {
    e.preventDefault()
  }
})
kbd.addEventListener('keyup', (e) => forward('keyup', e))

// 中文/表情/手机输入法的候选词：keydown 拿不到，只能靠 input 事件。
// 这时用 Unicode 码点当 keysym 发（X11 里 BMP 内的字符码点就是 keysym）。
kbd.addEventListener('input', () => {
  if (!rfb) return
  const v = kbd.value
  if (!v) return
  for (const ch of v) {
    const cp = ch.codePointAt(0)
    if (!cp) continue
    try {
      rfb.sendKey(cp, null, true)
      rfb.sendKey(cp, null, false)
    } catch {}
  }
  kbd.value = ''
})

// 键盘弹出后画面会被顶上去，重新适配一次
window.addEventListener('resize', () => {
  try { rfb && (rfb.scaleViewport = true) } catch {}
})
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    try { rfb && (rfb.scaleViewport = true) } catch {}
  })
}
</script>
</body>
</html>`

export class VncBridge {
  constructor(options = {}) {
    this.log = options.log || (() => {})
    this.display = options.display || ':99'
    this.rfbPort = options.rfbPort || 5900
    this.proc = null
    this.attached = false
  }

  get running() {
    return Boolean(this.proc)
  }

  /** 把 Xvfb 那块虚拟屏暴露成 VNC。 */
  start() {
    if (this.proc) return true
    try {
      this.proc = spawn(
        'x11vnc',
        [
          '-display', this.display,
          '-rfbport', String(this.rfbPort),
          // -localhost 只监听本机就够。注意**不要**再加 '-listen 127.0.0.1'：
          // 实测两者同时给时 x11vnc 会打印「Listening for VNC connections on
          // TCP port 5900」但实际并不服务，连上去一个字节都没有 ——
          // 表现就是画面永远卡在加载。
          '-localhost',
          // 容器里没有 IPv6 地址，x11vnc 默认还会去 rfbListenOnTCP6Port，
          // getaddrinfo 失败就退出（帮助里写明用 -no6 关掉）。
          '-no6',
          // 同样致命：容器没有 SysV 共享内存，shmget(scanline) 失败会导致退出。
          '-noshm',
          '-nopw',           // 本机免密；对外不可达
          '-forever',
          '-shared',
          '-noxdamage',
        ],
        // detached + unref 让 x11vnc 独立于本进程存活；stdio 全部忽略，
        // 否则父进程退出时管道断开可能把它一起带走。
        { stdio: 'ignore', detached: true },
      )
      this.proc.unref()
      // x11vnc 失败时不会抛异常，只会退出并打一行日志。不接住的话
      // 表现就是"VNC 莫名其妙不可用"，很难查。
      this.proc.stderr?.on('data', (d) => {
        const line = String(d).trim()
        if (line && /error|fail|cannot|unable|refused|in use/i.test(line)) {
          this.log(`x11vnc: ${line.slice(0, 200)}`)
        }
      })
      this.proc.on('error', (e) => {
        this.lastError = `x11vnc 无法启动：${String(e?.message || e)}`
        this.log(this.lastError)
        this.proc = null
      })
      this.proc.on('exit', (code) => {
        if (code !== 0 && code !== null) this.log(`x11vnc 退出，code=${code}`)
        this.proc = null
      })
      this.log(`x11vnc 已启动（display=${this.display}，端口 ${this.rfbPort}）`)
      return true
    } catch (e) {
      this.log(`x11vnc 启动失败：${String(e?.message || e)}`)
      return false
    }
  }

  stop() {
    try {
      this.proc?.kill()
    } catch {
      /* 忽略 */
    }
    this.proc = null
  }

  /** noVNC 的静态资源 + 我们补的查看页。 */
  serveStatic(req, res, pathname) {
    const rel = pathname.replace(/^\/novnc\/?/, '') || 'index.html'
    if (rel === 'index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(VIEWER_HTML)
      return true
    }
    // 防目录穿越：normalize 后必须还在 NOVNC_DIR 里面
    const full = normalize(join(NOVNC_DIR, rel))
    if (!full.startsWith(NOVNC_DIR) || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return true
    }
    const ext = full.slice(full.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
    createReadStream(full).pipe(res)
    return true
  }

  /**
   * 连 VNC 端口，带退避重试。
   *
   * x11vnc 刚 spawn 出来时端口还没就绪，直接 connect 会 ECONNREFUSED；
   * 对用户来说就是"永远加载中"。这里重试约 4 秒。
   */
  async connectVnc() {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms))
    let lastErr = null
    for (let n = 0; n <= 10; n++) {
      const tcp = await new Promise((resolve) => {
        const s = net.connect(this.rfbPort, '127.0.0.1')
        let done = false
        const finish = (ok) => {
          if (done) return
          done = true
          s.removeListener('error', onErr)
          s.removeListener('connect', onOk)
          resolve(ok ? s : null)
        }
        const onErr = (e) => {
          lastErr = e
          s.destroy()
          finish(false)
        }
        const onOk = () => finish(true)
        s.once('error', onErr)
        s.once('connect', onOk)
      })
      if (tcp) return tcp
      if (n < 10) await delay(200 + n * 100)
    }
    throw new Error(`连不上 VNC 端口 ${this.rfbPort}${lastErr ? `（${lastErr.code || lastErr.message}）` : ''}`)
  }

  /**
   * 把 WebSocket 桥到 VNC 的 TCP 上。
   *
   * 挂到管理服务器的 upgrade 事件上，复用同一个端口 —— 卡片本身就是从
   * 那个端口加载的，省掉一个额外端口和跨端口问题。
   */
  async attach(server) {
    if (this.attached) return true
    let WebSocketServer
    try {
      const mod = await loadWs()
      WebSocketServer = mod.WebSocketServer || mod.Server
    } catch (e) {
      this.log(`加载 ws 失败，远程桌面不可用：${String(e?.message || e)}`)
      return false
    }
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      let pathname = ''
      try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
      } catch {
        return
      }
      if (pathname !== WS_PATH) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, async (ws) => {
        // x11vnc 起来需要时间，而且可能刚崩过。一次性 connect 容易踩空，
        // 踩空的表现同样是"永远加载中"，所以这里带重试。
        let tcp
        try {
          tcp = await this.connectVnc()
        } catch (e) {
          this.log(String(e?.message || e))
          try { ws.close(1011, 'vnc unavailable') } catch {}
          return
        }
        const close = () => {
          try {
            ws.close()
          } catch {}
          try {
            tcp.destroy()
          } catch {}
        }
        tcp.on('connect', () => this.log('远程桌面已连接'))
        tcp.once('error', () => {})
        tcp.on('data', (d) => {
          try {
            // 必须按二进制发。以文本发会把 RFB 的二进制握手字节弄坏，
            // 前端表现就是连上后立刻断（只到 1 字节）。
            ws.send(d, { binary: true })
          } catch {
            close()
          }
        })
        tcp.on('error', () => close())
        tcp.on('close', () => close())
        ws.on('message', (d, isBinary) => {
          try {
            tcp.write(Buffer.isBuffer(d) ? d : Buffer.from(d))
          } catch {
            close()
          }
        })
        ws.on('close', () => close())
        ws.on('error', () => close())
      })
    })
    this.attached = true
    this.log('远程桌面 WebSocket 已挂载（/vnc-ws）')
    return true
  }
}

/** ws 装在插件目录外，做多路径兜底。 */
async function loadWs() {
  const candidates = ['ws', join(RUNTIME_DIR, 'node_modules/ws/index.js')]
  for (const c of candidates) {
    try {
      const m = await import(c)
      if (m) return m.default?.WebSocketServer ? m.default : m
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 ws 模块')
}

export { WS_PATH, RUNTIME_DIR, NOVNC_DIR }
