/**
 * 机场订阅解析（从 Android 版 1:1 移植）。
 *
 * 支持三种输入形态：
 *   1. Clash / Clash Meta YAML —— 区块风格与流式（flow）风格都支持
 *   2. base64 —— 解码后可能是 YAML 或 URI 列表
 *   3. 明文 URI 列表 —— vmess / vless / trojan / ss / hysteria2
 *
 * 只做解析，不碰网络，便于单独测试。
 */

// ---------------------------------------------------------------- Clash YAML

export function looksLikeClash(text) {
  const lower = String(text).toLowerCase()
  return (
    lower.includes('\nproxies:') ||
    lower.startsWith('proxies:') ||
    lower.includes('\nproxy-groups:') ||
    lower.includes('\nproxy-providers:')
  )
}

/** 解析内联流式映射 `{k: v, k2: {k3: v3}}`，嵌套展平成 `父.子`。 */
function inlineMap(raw) {
  let body = String(raw).trim()
  if (body.startsWith('{')) body = body.slice(1)
  if (body.endsWith('}')) body = body.slice(0, -1)

  const parts = []
  let cur = ''
  let quote = null
  let depth = 0
  for (const ch of body) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
    } else if (ch === '{') {
      depth += 1
      cur += ch
    } else if (ch === '}') {
      depth -= 1
      cur += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)

  const out = new Map()
  for (const part of parts) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const key = part.slice(0, i).trim().replace(/^['"]|['"]$/g, '')
    const value = part.slice(i + 1).trim()
    if (!key) continue
    if (value.startsWith('{')) {
      for (const [k2, v2] of inlineMap(value)) out.set(`${key}.${k2}`, v2)
    } else {
      out.set(key, value.replace(/^['"]|['"]$/g, ''))
    }
  }
  return out
}

export function parseClash(text) {
  const nodes = []
  let inProxies = false
  let current = null
  // 嵌套层级：[[indent, key], ...]
  const path = []

  const prefixFor = (indent) => {
    while (path.length && path[path.length - 1][0] >= indent) path.pop()
    return path.map(([, k]) => k).join('.')
  }
  const push = (indent, key) => {
    while (path.length && path[path.length - 1][0] >= indent) path.pop()
    path.push([indent, key])
  }
  const flush = () => {
    if (current && current.size) {
      const node = toNode(current)
      if (node) nodes.push(node)
    }
    current = null
  }

  const lines = String(text).split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    let indent = line.length - line.trimStart().length
    let content = line.trim()
    if (content.startsWith('#')) continue

    if (indent === 0) {
      flush()
      path.length = 0
      inProxies = content.slice(0, content.indexOf(':')).trim().toLowerCase() === 'proxies'
      continue
    }
    if (!inProxies) continue

    if (content.startsWith('- ') || content === '-') {
      flush()
      path.length = 0
      content = content.replace(/^-/, '').trim()
      indent += 2
      current = new Map()
      if (!content) continue
      if (content.startsWith('{')) {
        for (const [k, v] of inlineMap(content)) current.set(k, v)
        continue
      }
    }

    if (!current) continue
    const colon = content.indexOf(':')
    if (colon <= 0) continue
    const key = content.slice(0, colon).trim()
    const value = content.slice(colon + 1).trim()

    if (!value) {
      push(indent, key)
    } else if (value.startsWith('{')) {
      for (const [k2, v2] of inlineMap(value)) current.set(`${key}.${k2}`, v2)
    } else {
      const prefix = prefixFor(indent)
      current.set(prefix ? `${prefix}.${key}` : key, value.replace(/^['"]|['"]$/g, ''))
    }
  }
  flush()
  return nodes
}

function toNode(m) {
  const type = (m.get('type') || '').toLowerCase().trim()
  const server = (m.get('server') || '').trim()
  const port = Number.parseInt((m.get('port') || '').trim(), 10)
  if (!type || !server || !Number.isInteger(port) || port < 1 || port > 65535) return null

  const name = m.get('name') || ''
  const params = {}
  const pick = (...keys) => {
    for (const k of keys) {
      const v = m.get(k)
      if (v != null && String(v).length) return String(v)
    }
    return ''
  }

  const sni = pick('servername', 'sni', 'ws-opts.headers.Host', 'ws-opts.headers.host')
  const wsPath = pick('ws-opts.path', 'ws-path')
  const wsHost = pick('ws-opts.headers.Host', 'ws-opts.headers.host', 'ws-headers.Host')
  const insecure = pick('skip-cert-verify')
  const net = pick('network') || 'tcp'

  switch (type) {
    case 'vmess':
      Object.assign(params, {
        id: pick('uuid'),
        aid: pick('alterId') || '0',
        scy: pick('cipher') || 'auto',
        net,
        sni,
        host: wsHost,
        path: wsPath,
        serviceName: pick('grpc-opts.grpc-service-name'),
        insecure,
      })
      if (String(m.get('tls')).toLowerCase() === 'true') params.tls = 'tls'
      break
    case 'vless':
      Object.assign(params, {
        uuid: pick('uuid'),
        flow: pick('flow'),
        net,
        security: pick('reality-opts.public-key') ? 'reality' : (String(m.get('tls')).toLowerCase() === 'true' ? 'tls' : ''),
        sni,
        host: wsHost,
        path: wsPath,
        serviceName: pick('grpc-opts.grpc-service-name'),
        pbk: pick('reality-opts.public-key'),
        sid: pick('reality-opts.short-id'),
        fp: pick('client-fingerprint') || 'chrome',
        insecure,
      })
      break
    case 'trojan':
      Object.assign(params, {
        password: pick('password'),
        net,
        sni,
        host: wsHost,
        path: wsPath,
        serviceName: pick('grpc-opts.grpc-service-name'),
        insecure,
        security: 'tls',
      })
      break
    case 'ss':
    case 'shadowsocks':
      Object.assign(params, { method: pick('cipher'), password: pick('password') })
      break
    case 'hysteria2':
    case 'hy2':
      Object.assign(params, {
        password: pick('password', 'auth'),
        sni,
        insecure,
        alpn: pick('alpn'),
      })
      break
    default:
      return null
  }

  const protocol = type === 'ss' ? 'shadowsocks' : type === 'hy2' ? 'hysteria2' : type
  return { name, protocol, server, port, params }
}

// ---------------------------------------------------------------- URI 列表

function decodeBase64Loose(value) {
  const v = String(value).trim()
  for (const mode of ['base64', 'base64url']) {
    try {
      const buf = Buffer.from(v, mode)
      const out = buf.toString('utf8')
      if (out) return out
    } catch {
      /* 换下一种 */
    }
  }
  return ''
}

function splitFragment(uri) {
  const i = uri.indexOf('#')
  if (i < 0) return [uri, '']
  return [uri.slice(0, i), safeDecode(uri.slice(i + 1))]
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function queryOf(uri) {
  const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : ''
  const out = {}
  if (!q) return out
  for (const part of q.split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    if (i <= 0) out[safeDecode(part)] = ''
    else out[safeDecode(part.slice(0, i))] = safeDecode(part.slice(i + 1))
  }
  return out
}

function authority(rest) {
  const at = rest.lastIndexOf('@')
  const userinfo = at >= 0 ? rest.slice(0, at) : ''
  const hostPort = at >= 0 ? rest.slice(at + 1) : rest
  const colon = hostPort.lastIndexOf(':')
  if (colon <= 0) return null
  const host = hostPort.slice(0, colon).replace(/^\[|\]$/g, '')
  const port = Number.parseInt(hostPort.slice(colon + 1).split('/')[0], 10)
  if (!host || !Number.isInteger(port)) return null
  return [userinfo, host, port]
}

export function parseUri(uri) {
  try {
    if (/^vmess:\/\//i.test(uri)) {
      const json = decodeBase64Loose(uri.slice('vmess://'.length))
      if (!json) return null
      const j = JSON.parse(json)
      const port = Number.parseInt(j.port, 10)
      if (!j.add || !Number.isInteger(port)) return null
      const params = {}
      for (const [k, v] of Object.entries(j)) params[k] = String(v ?? '')
      return { name: j.ps || `${j.add}:${port}`, protocol: 'vmess', server: j.add, port, params }
    }
    if (/^vless:\/\//i.test(uri)) {
      const [body, name] = splitFragment(uri)
      const rest = body.slice('vless://'.length)
      const a = authority(rest)
      if (!a) return null
      const [uuid, host, port] = a
      return { name: name || `${host}:${port}`, protocol: 'vless', server: host, port, params: { ...queryOf(rest), uuid } }
    }
    if (/^trojan:\/\//i.test(uri)) {
      const [body, name] = splitFragment(uri)
      const rest = body.slice('trojan://'.length)
      const a = authority(rest)
      if (!a) return null
      const [password, host, port] = a
      return { name: name || `${host}:${port}`, protocol: 'trojan', server: host, port, params: { ...queryOf(rest), password } }
    }
    if (/^ss:\/\//i.test(uri)) {
      const [body, name] = splitFragment(uri)
      let rest = body.slice('ss://'.length)
      let method = ''
      let password = ''
      let host
      let port
      const at = rest.lastIndexOf('@')
      if (at >= 0) {
        const cred = decodeBase64Loose(rest.slice(0, at))
        const c = cred.indexOf(':')
        if (c > 0) {
          method = cred.slice(0, c)
          password = cred.slice(c + 1)
        }
        const hostPort = rest.slice(at + 1)
        const colon = hostPort.lastIndexOf(':')
        if (colon <= 0) return null
        host = hostPort.slice(0, colon).replace(/^\[|\]$/g, '')
        port = Number.parseInt(hostPort.slice(colon + 1).split('/')[0], 10)
      } else {
        const decoded = decodeBase64Loose(rest)
        const a = decoded.lastIndexOf('@')
        if (a < 0) return null
        const cred = decoded.slice(0, a)
        const c = cred.indexOf(':')
        if (c > 0) {
          method = cred.slice(0, c)
          password = cred.slice(c + 1)
        }
        const hostPort = decoded.slice(a + 1)
        const colon = hostPort.lastIndexOf(':')
        if (colon <= 0) return null
        host = hostPort.slice(0, colon).replace(/^\[|\]$/g, '')
        port = Number.parseInt(hostPort.slice(colon + 1), 10)
      }
      if (!method || !host || !Number.isInteger(port)) return null
      return { name: name || `${host}:${port}`, protocol: 'shadowsocks', server: host, port, params: { ...queryOf(rest), method, password } }
    }
    if (/^hysteria2:\/\//i.test(uri) || /^hy2:\/\//i.test(uri)) {
      const [body, name] = splitFragment(uri)
      const rest = body.slice(body.indexOf('://') + 3)
      const a = authority(rest)
      if (!a) return null
      const [password, host, port] = a
      return { name: name || `${host}:${port}`, protocol: 'hysteria2', server: host, port, params: { ...queryOf(rest), password } }
    }
  } catch {
    return null
  }
  return null
}

// ---------------------------------------------------------------- 总入口

/**
 * @param {string} body 订阅原文
 * @returns {{nodes: Array, kind: string, detail: string}}
 */
export function parseSubscription(body) {
  const raw = String(body ?? '').trim()
  if (!raw) return { nodes: [], kind: '空内容', detail: '订阅返回内容为空' }

  if (looksLikeClash(raw)) {
    const nodes = parseClash(raw)
    return { nodes, kind: 'Clash YAML', detail: `识别为 Clash 配置，proxies 段解析出 ${nodes.length} 个` }
  }

  if (raw.includes('://')) {
    const nodes = parseUriList(raw)
    return { nodes, kind: 'URI 列表', detail: `明文链接列表，解析出 ${nodes.length} 个` }
  }

  const decoded = tryBase64(raw)
  if (decoded) {
    if (looksLikeClash(decoded)) {
      const nodes = parseClash(decoded)
      return { nodes, kind: 'base64 → Clash', detail: `解码后是 Clash 配置，解析出 ${nodes.length} 个` }
    }
    if (decoded.includes('://')) {
      const nodes = parseUriList(decoded)
      return { nodes, kind: 'base64 → URI', detail: `解码后是链接列表，解析出 ${nodes.length} 个` }
    }
    return {
      nodes: [],
      kind: 'base64（无法识别）',
      detail: `base64 解出来了但既不是 Clash 也不是链接，前 80 字：${decoded.slice(0, 80)}`,
    }
  }

  return { nodes: [], kind: '未知格式', detail: `既不是 Clash YAML，也不是 base64 或链接列表。前 80 字：${raw.slice(0, 80)}` }
}

function parseUriList(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const node = parseUri(t)
    if (node) out.push(node)
  }
  return out
}

function tryBase64(raw) {
  const compact = raw.replace(/\s+/g, '')
  if (compact.length < 8) return ''
  for (const mode of ['base64', 'base64url']) {
    try {
      const decoded = Buffer.from(compact, mode).toString('utf8')
      if (decoded.includes('://') || looksLikeClash(decoded)) return decoded
    } catch {
      /* 换下一种 */
    }
  }
  return ''
}
