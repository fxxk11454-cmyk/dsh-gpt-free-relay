/**
 * Xray 核心：配置生成 + 子进程管理（从 Android 版移植）。
 *
 * 与 Android 版的差异：DSH 跑在 Linux 上，所以核心用 Linux 构建而不是 Android 构建。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = resolve(HERE, '..')

export const SOCKS_PORT = 2080
export const HTTP_PORT = 2081
/** 本地串行反向代理端口：DSH 的 provider 应指向它。 */
export const RELAY_PORT = 2082

/** Xray 不支持的协议，界面上需要明确告知而不是静默失败。 */
export const UNSUPPORTED = new Set(['hysteria2', 'tuic', 'hysteria'])

export function buildConfig(node, logLevel = 'warning') {
  const p = node.params || {}
  const inbounds = [
    { tag: 'socks-in', listen: '127.0.0.1', port: SOCKS_PORT, protocol: 'socks', settings: { auth: 'noauth', udp: true } },
    { tag: 'http-in', listen: '127.0.0.1', port: HTTP_PORT, protocol: 'http', settings: {} },
  ]

  const outbounds = [buildOutbound(node), { tag: 'direct', protocol: 'freedom' }]

  return { log: { loglevel: logLevel }, inbounds, outbounds, routing: { domainStrategy: 'AsIs', rules: [] } }
}

function buildOutbound(node) {
  const p = node.params || {}
  const o = { tag: 'proxy', protocol: node.protocol }

  switch (node.protocol) {
    case 'vmess':
      o.settings = {
        vnext: [
          {
            address: node.server,
            port: node.port,
            users: [{ id: p.id || '', alterId: Number.parseInt(p.aid || '0', 10) || 0, security: p.scy || 'auto' }],
          },
        ],
      }
      break
    case 'vless': {
      const user = { id: p.uuid || '', encryption: 'none' }
      if (p.flow) user.flow = p.flow
      o.settings = { vnext: [{ address: node.server, port: node.port, users: [user] }] }
      break
    }
    case 'trojan':
      o.settings = { servers: [{ address: node.server, port: node.port, password: p.password || '' }] }
      break
    case 'shadowsocks':
      o.settings = {
        servers: [{ address: node.server, port: node.port, method: p.method || '', password: p.password || '' }],
      }
      break
    default:
      // 未知协议退化成 freedom。注意 direct/freedom 不接受 address/port 字段。
      return { tag: 'proxy', protocol: 'freedom' }
  }

  o.streamSettings = streamSettings(node)
  return o
}

function streamSettings(node) {
  const p = node.params || {}
  const s = {}

  const net = (p.net || p.type || 'tcp').toLowerCase()
  const network = net === 'ws' || net === 'websocket' ? 'ws' : net === 'grpc' ? 'grpc' : net === 'http' || net === 'h2' ? 'h2' : 'tcp'
  s.network = network

  const realityPk = p.pbk || ''
  const security =
    p.security === 'reality' || realityPk
      ? 'reality'
      : p.security === 'tls' || String(p.tls).toLowerCase() === 'tls' || node.protocol === 'trojan'
        ? 'tls'
        : 'none'
  s.security = security

  const sni = p.sni || p.host || node.server
  const fp = p.fp || 'chrome'
  const insecure = p.insecure === '1' || p.insecure === 'true'

  if (security === 'tls') {
    const tls = { serverName: sni, fingerprint: fp }
    if (insecure) tls.allowInsecure = true
    if (p.alpn) tls.alpn = String(p.alpn).split(',').map((x) => x.trim()).filter(Boolean)
    s.tlsSettings = tls
  } else if (security === 'reality') {
    s.realitySettings = { serverName: sni, fingerprint: fp, publicKey: realityPk, shortId: p.sid || '', spiderX: '/' }
  }

  if (network === 'ws') {
    const ws = { path: p.path || '/' }
    if (p.host) ws.headers = { Host: p.host }
    s.wsSettings = ws
  } else if (network === 'grpc') {
    s.grpcSettings = { serviceName: p.serviceName || p.path || '' }
  } else if (network === 'h2') {
    const h = {}
    if (p.host) h.host = String(p.host).split(',').map((x) => x.trim()).filter(Boolean)
    if (p.path) h.path = p.path
    s.httpSettings = h
  }

  return s
}

/** 找一个可用的核心二进制。 */
export function findCore(explicit) {
  const candidates = [
    explicit,
    process.env.GPT_FREE_RELAY_CORE,
    join(PLUGIN_ROOT, 'core', 'xray'),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export class XrayCore {
  constructor({ corePath, workDir }) {
    this.corePath = corePath
    this.workDir = workDir
    this.proc = null
    this.logPath = join(workDir, 'core.log')
    this.configPath = join(workDir, 'config.json')
  }

  isRunning() {
    return Boolean(this.proc && this.proc.exitCode === null)
  }

  /** 写入配置。 */
  write(node) {
    mkdirSync(this.workDir, { recursive: true })
    const cfg = buildConfig(node)
    writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')
    return this.configPath
  }

  /** 启动核心。返回 null 表示成功，否则是错误描述。 */
  async start() {
    if (this.isRunning()) return null
    if (!this.corePath) return '未找到 Xray 核心，请先运行 scripts/fetch-core.sh 下载'
    if (!existsSync(this.configPath)) return '配置文件不存在，请先写配置'

    writeFileSync(this.logPath, '', 'utf8')
    const out = openSync(this.logPath, 'a')

    this.proc = spawn(this.corePath, ['run', '-c', this.configPath], {
      cwd: this.workDir,
      stdio: ['ignore', out, out],
    })
    const proc = this.proc
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })

    // 给一点启动时间，捕捉最常见的"配置/权限"失败
    await new Promise((r) => setTimeout(r, 900))
    if (proc.exitCode !== null) {
      return `核心启动即退出（code=${proc.exitCode}）\n${this.errorSummary()}`
    }
    return null
  }

  stop() {
    const p = this.proc
    this.proc = null
    if (!p) return
    try {
      p.kill('SIGTERM')
      setTimeout(() => {
        try {
          p.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
      }, 1500).unref?.()
    } catch {
      /* 忽略 */
    }
  }

  /** 从日志里挑出真正有用的错误行，并去掉 ANSI 颜色码。 */
  errorSummary(max = 6) {
    let text = ''
    try {
      text = readFileSync(this.logPath, 'utf8')
    } catch {
      return '（核心没有输出任何日志）'
    }
    const cleaned = text
      .split('\n')
      .map((l) => l.replace(/\u001B\[[;\d]*m/g, ''))
      .filter(Boolean)
    const hits = cleaned.filter((l) => {
      const s = l.toLowerCase()
      return (
        (s.includes('panic') || s.includes('fatal') || s.includes('error') || s.includes('invalid') || s.includes('unknown')) &&
        !s.includes('missing default interface') &&
        !s.includes('package manager')
      )
    })
    const lines = hits.length ? hits : cleaned
    return lines.slice(-max).join('\n')
  }
}
