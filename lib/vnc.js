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
</style>
</head>
<body>
<div id="screen"></div>
<div id="tip">连接中…</div>
<script type="module">
import RFB from '/novnc/core/rfb.js'
const tip = document.getElementById('tip')
const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '${WS_PATH}'
const rfb = new RFB(document.getElementById('screen'), url, { credentials: { password: '' } })
rfb.scaleViewport = true
rfb.resizeSession = false
rfb.showDotCursor = true
rfb.addEventListener('connect', () => { tip.textContent = '已连接 —— 直接在上面操作即可'; tip.style.display='none' })
rfb.addEventListener('disconnect', (e) => {
  tip.style.display = ''
  tip.textContent = e.detail && e.detail.clean ? '已断开，正在重连…' : '连接中断，正在重连…'
  setTimeout(() => location.reload(), 2500)
})
window.addEventListener('resize', () => { try { rfb.scaleViewport = true } catch {} })
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
          '-localhost',      // 只监听本机
          '-listen', '127.0.0.1',
          // 容器里没有 IPv6 地址，x11vnc 默认还会去 rfbListenOnTCP6Port，
          // getaddrinfo 失败就退出。帮助里写明用 -no6 关掉 IPv6 监听。
          '-no6',
          // 同样致命：容器没有 SysV 共享内存，shmget(scanline) 失败会导致退出。
          '-noshm',
          '-nopw',           // 本机免密；对外不可达
          '-forever',
          '-shared',
          '-noxdamage',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        const tcp = net.connect(this.rfbPort, '127.0.0.1')
        const close = () => {
          try {
            ws.close()
          } catch {}
          try {
            tcp.destroy()
          } catch {}
        }
        tcp.on('connect', () => this.log('远程桌面已连接'))
        tcp.on('data', (d) => {
          try {
            ws.send(d)
          } catch {
            close()
          }
        })
        tcp.on('error', () => close())
        tcp.on('close', () => close())
        ws.on('message', (d) => {
          try {
            tcp.write(d)
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
