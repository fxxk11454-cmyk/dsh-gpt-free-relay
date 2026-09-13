/**
 * 核心逻辑回归测试。
 *
 * 覆盖四块最容易悄悄坏掉的地方：
 *   1. 工具调用剥离（含嵌套）—— 这是对外承诺的硬约束，坏了没人看得出来
 *   2. 串行闸门 —— 并发必须恒为 1，且异常不能把队列卡死
 *   3. 响应过滤 —— finish_reason 归一化，避免客户端空转
 *   4. 订阅解析 —— 三种输入形态
 *   5. 配置生成 —— 真实 Xray 能跑通（有核心时才算）
 *
 * 跑法：node scripts/test-core.mjs
 * 退出码非 0 表示有失败项。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { stripTools, filterToolCalls, rewriteModel, SerialGate } from '../lib/relay.js'
import { parseSubscription } from '../lib/subscription.js'
import { buildConfig, findCore } from '../lib/xray.js'
import { rewriteSetCookie, jwtExpiry } from '../lib/chatgpt/session.js'

let passed = 0
let failed = 0
const failures = []

/**
 * 跑一个测试。
 *
 * **必须 async 且必须 await 调用**：早先这函数是同步的，`fn()` 的返回值
 * 直接丢掉 —— 于是所有 async 测试都变成空转：立刻记成"通过"，
 * 真正的断言失败要到汇总之后才以 unhandled rejection 的形式炸出来。
 * 表现就是"55 项全过"然后进程报一个莫名其妙的 AssertionError。
 * 所以下面每条都以 `await test(...)` 调用，别漏 await。
 */
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

const J = (o) => JSON.stringify(o)
const P = (s) => JSON.parse(s)

// ─────────────────────────────────────────── 1. 工具调用剥离
group('工具调用剥离')

await test('顶层 tools / tool_choice / functions 全部剥掉', () => {
  const out = P(
    stripTools(
      J({
        model: 'free-chat',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function' }],
        tool_choice: 'auto',
        functions: [{}],
        function_call: 'auto',
        parallel_tool_calls: true,
      }),
    ),
  )
  for (const k of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']) {
    assert.equal(k in out, false, `${k} 应当被删除`)
  }
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }])
})

await test('消息历史里的 assistant.tool_calls 被剥掉', () => {
  const out = P(
    stripTools(
      J({
        model: 'm',
        messages: [
          { role: 'assistant', tool_calls: [{ id: '1', function: { name: 'f' } }] },
          { role: 'tool', content: '回执' },
          { role: 'user', content: 'next' },
        ],
      }),
    ),
  )
  assert.equal('tool_calls' in out.messages[0], false, 'tool_calls 应当被删除')
  // 失去所指的 tool 回执也要一起删，否则上游会 400
  assert.equal(out.messages.some((m) => m.role === 'tool'), false, '孤立的 tool 消息应当被删除')
  assert.equal(out.messages.some((m) => m.role === 'user'), true, '普通消息要保留')
})

await test('content 数组里的 tool_result 分片被剥掉，普通分片保留', () => {
  const out = P(
    stripTools(
      J({
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: 'keep' }] },
        ],
      }),
    ),
  )
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'keep' }])
})

await test('深层自定义容器也覆盖', () => {
  const out = P(stripTools(J({ model: 'm', a: { b: { messages: [{ role: 'assistant', tool_calls: [{ id: 'z' }] }] } } })))
  assert.equal('tool_calls' in out.a.b.messages[0], false)
})

await test('普通对话一个字节都不改', () => {
  const input = J({ model: 'm', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }] })
  assert.equal(stripTools(input), input, '没有工具字段时应当原样返回')
})

await test('正文里出现 tool_calls 这个词不会被误删', () => {
  const input = J({ model: 'm', messages: [{ role: 'user', content: 'tool_calls 是个词' }] })
  assert.equal(P(stripTools(input)).messages[0].content, 'tool_calls 是个词')
})

await test('畸形输入不抛异常，原样返回', () => {
  assert.equal(stripTools('not json'), 'not json')
  assert.equal(stripTools(''), '')
  assert.doesNotThrow(() => stripTools(J({ model: 'm', messages: 'not-an-array' })))
  assert.equal(P(stripTools(J({}))).model, undefined)
})

// ─────────────────────────────────────────── 2. 串行闸门
group('串行闸门（并发必须恒为 1）')

await test('三个异步任务严格串行，总耗时 = 各自之和', async () => {
  const gate = new SerialGate()
  const order = []
  const mk = (name, ms) => async () => {
    await new Promise((r) => setTimeout(r, ms))
    order.push(name)
    return name
  }
  const t0 = Date.now()
  const results = await Promise.all([
    gate.run('a', mk('a', 120)),
    gate.run('b', mk('b', 60)),
    gate.run('c', mk('c', 30)),
  ])
  const elapsed = Date.now() - t0
  assert.deepEqual(order, ['a', 'b', 'c'], '顺序必须是入队顺序')
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.ok(elapsed >= 200, `总耗时应当 ≥210ms（串行），实测 ${elapsed}ms`)
})

await test('峰值并发恒为 1', async () => {
  const gate = new SerialGate()
  let running = 0
  let peak = 0
  const task = () => async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 25))
    running -= 1
  }
  await Promise.all([1, 2, 3, 4, 5].map((n) => gate.run('t' + n, task())))
  assert.equal(peak, 1, `峰值并发必须为 1，实测 ${peak}`)
})

await test('任务抛异常不会卡死队列', async () => {
  const gate = new SerialGate()
  const done = []
  const ok = (n) => async () => {
    done.push(n)
    return n
  }
  const boom = async () => {
    throw new Error('boom')
  }
  const r = await Promise.allSettled([
    gate.run('1', ok(1)),
    gate.run('2', boom),
    gate.run('3', ok(3)),
    gate.run('4', ok(4)),
  ])
  assert.equal(r[1].status, 'rejected', '异常应当传给调用方')
  assert.deepEqual(done, [1, 3, 4], '异常之后队列必须继续推进')
  assert.equal(gate.depth, 0, '跑完后队列深度应当归零')
})

await test('同步抛出的任务同样不卡队列', async () => {
  const gate = new SerialGate()
  const r = await Promise.allSettled([
    gate.run('s', () => {
      throw new Error('sync boom')
    }),
    gate.run('after', async () => 'ok'),
  ])
  assert.equal(r[0].status, 'rejected')
  assert.equal(r[1].value, 'ok', '同步异常之后仍要能继续')
})

// ─────────────────────────────────────────── 3. 响应过滤
group('响应过滤（避免客户端空转）')

await test('delta 里的 tool_calls 被剥掉', () => {
  const out = filterToolCalls({ choices: [{ delta: { tool_calls: [{ id: 1 }] }, finish_reason: null }] })
  assert.equal('tool_calls' in out.choices[0].delta, false)
})

await test('message 里的 tool_calls 被剥掉', () => {
  const out = filterToolCalls({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 1 }] }, finish_reason: 'stop' }] })
  assert.equal('tool_calls' in out.choices[0].message, false)
  assert.equal(out.choices[0].message.content, 'hi')
})

await test('还有内容要发时，finish_reason=tool_calls 归一化为 null', () => {
  const out = filterToolCalls({
    choices: [{ delta: { content: 'x', tool_calls: [{ id: 1 }] }, finish_reason: 'tool_calls' }],
  })
  assert.equal(out.choices[0].finish_reason, null)
})

await test('收尾帧（空 delta）的 finish_reason 归一化为 stop', () => {
  const out = filterToolCalls({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  assert.equal(out.choices[0].finish_reason, 'stop', '收尾帧必须给出明确的结束信号')
})

await test('非流式响应归一化为 stop', () => {
  const out = filterToolCalls({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 1 }] }, finish_reason: 'tool_calls' }] })
  assert.equal(out.choices[0].finish_reason, 'stop')
})

await test('正常的 stop / length 不被改动', () => {
  assert.equal(filterToolCalls({ choices: [{ message: { content: 'a' }, finish_reason: 'length' }] }).choices[0].finish_reason, 'length')
  assert.equal(filterToolCalls({ choices: [{ delta: { content: 'a' }, finish_reason: null }] }).choices[0].finish_reason, null)
})

await test('畸形载荷不抛异常', () => {
  assert.equal(filterToolCalls(null), null)
  assert.doesNotThrow(() => filterToolCalls({}))
  assert.doesNotThrow(() => filterToolCalls({ choices: 'x' }))
})

// ─────────────────────────────────────────── 4. 模型别名
group('模型别名映射')

await test('别名被替换成上游型号', () => {
  const out = P(rewriteModel(J({ model: 'free-chat', messages: [] }), 'free-chat', 'gpt-4o-mini'))
  assert.equal(out.model, 'gpt-4o-mini')
})

await test('客户端直接点名真实型号时原样透传', () => {
  const input = J({ model: 'gpt-4o', messages: [] })
  assert.equal(rewriteModel(input, 'free-chat', 'gpt-4o-mini'), input)
})

await test('别名与目标相同时不做无谓改写', () => {
  const input = J({ model: 'same', messages: [] })
  assert.equal(rewriteModel(input, 'same', 'same'), input)
})

// ─────────────────────────────────────────── 5. 订阅解析
group('订阅解析')

await test('Clash 区块风格', () => {
  const r = parseSubscription(
    'proxies:\n  - {name: n1, type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-3333-4444-555555555555}\n  - {name: n2, type: trojan, server: 5.6.7.8, port: 8443, password: pw}\n',
  )
  assert.equal(r.nodes.length, 2)
  assert.equal(r.nodes[0].protocol, 'vmess')
  assert.equal(r.nodes[1].protocol, 'trojan')
})

await test('Clash 多行缩进风格', () => {
  const r = parseSubscription(
    [
      'proxies:',
      '  - name: "节点A"',
      '    type: vless',
      '    server: a.example.com',
      '    port: 443',
      '    uuid: 11111111-2222-3333-4444-555555555555',
      '    tls: true',
      '    network: ws',
      '    ws-opts:',
      '      path: /ws',
      '',
    ].join('\n'),
  )
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].server, 'a.example.com')
  assert.equal(r.nodes[0].params.path, '/ws')
})

await test('base64 编码的 URI 列表', () => {
  const list = 'vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#节点A\n'
  const r = parseSubscription(Buffer.from(list, 'utf8').toString('base64'))
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'vless')
  assert.equal(r.nodes[0].name, '节点A')
})

await test('明文 URI 列表', () => {
  const r = parseSubscription('trojan://pw@b.example.com:443#节点B\n')
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'trojan')
})

await test('vmess:// 的 base64 JSON', () => {
  const j = { v: '2', ps: 'vm', add: 'c.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555', aid: '0', net: 'ws', tls: 'tls' }
  const r = parseSubscription('vmess://' + Buffer.from(JSON.stringify(j), 'utf8').toString('base64'))
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'vmess')
  assert.equal(r.nodes[0].server, 'c.example.com')
})

await test('空内容与无法识别的输入不抛异常', () => {
  assert.equal(parseSubscription('').nodes.length, 0)
  assert.equal(parseSubscription('这不是订阅').nodes.length, 0)
  assert.doesNotThrow(() => parseSubscription(null))
  assert.doesNotThrow(() => parseSubscription(undefined))
})

// ─────────────────────────────────────────── 6. Xray 配置生成
group('Xray 配置生成')

await test('vless + ws + tls 生成合法结构', () => {
  const cfg = buildConfig({
    protocol: 'vless',
    server: 'x.example.com',
    port: 443,
    params: { uuid: '11111111-2222-3333-4444-555555555555', net: 'ws', security: 'tls', sni: 's.example.com', path: '/p', host: 's.example.com' },
  })
  assert.equal(cfg.inbounds.length, 2, '应当有 socks 与 http 两个入站')
  const proxy = cfg.outbounds.find((o) => o.tag === 'proxy')
  assert.equal(proxy.protocol, 'vless')
  assert.equal(proxy.streamSettings.network, 'ws')
  assert.equal(proxy.streamSettings.security, 'tls')
  assert.equal(proxy.streamSettings.wsSettings.path, '/p')
  assert.ok(cfg.outbounds.some((o) => o.tag === 'direct'), '应当有 direct 出站')
})

await test('trojan 默认走 tls', () => {
  const cfg = buildConfig({ protocol: 'trojan', server: 't.example.com', port: 443, params: { password: 'pw' } })
  assert.equal(cfg.outbounds.find((o) => o.tag === 'proxy').streamSettings.security, 'tls')
})

await test('未知协议退化成 freedom 且不带 address/port', () => {
  const cfg = buildConfig({ protocol: '别的东西', server: 'z.example.com', port: 1, params: {} })
  const proxy = cfg.outbounds.find((o) => o.tag === 'proxy')
  assert.equal(proxy.protocol, 'freedom')
  assert.equal('settings' in proxy, false, 'freedom 不接受 settings')
})

await test('生成的配置能被真实 Xray 校验（有核心时）', () => {
  const core = findCore()
  if (!core || !existsSync(core)) {
    process.stdout.write('      （跳过：本机没有 Xray 核心）\n')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  try {
    const cfgPath = join(dir, 'config.json')
    writeFileSync(
      cfgPath,
      J(
        buildConfig({
          protocol: 'vless',
          server: 'x.example.com',
          port: 443,
          params: { uuid: '11111111-2222-3333-4444-555555555555', net: 'ws', security: 'tls', path: '/p', host: 's.example.com' },
        }),
      ),
    )
    const r = spawnSync(core, ['run', '-c', cfgPath, '-test'], { encoding: 'utf8', timeout: 20000 })
    const combined = `${r.stdout || ''}${r.stderr || ''}`
    assert.ok(/Configuration OK/i.test(combined), `xray -test 未通过：\n${combined.slice(0, 400)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────── 7. 会话工具函数
group('会话工具函数')

await test('Set-Cookie 去掉 Domain 变成 host-only', () => {
  const out = rewriteSetCookie('__Secure-next-auth.session-token=abc; Domain=.chatgpt.com; Path=/; Secure; HttpOnly')
  assert.ok(!/domain=/i.test(out), 'Domain 必须去掉，否则浏览器整条丢弃')
  assert.ok(out.startsWith('__Secure-next-auth.session-token=abc'))
  assert.ok(/Path=\//.test(out))
})

await test('SameSite=None 降级成 Lax，Partitioned 去掉', () => {
  const out = rewriteSetCookie('cf_clearance=x; SameSite=None; Partitioned; Secure')
  assert.ok(/SameSite=Lax/i.test(out))
  assert.ok(!/partitioned/i.test(out))
})

await test('JWT exp 能正确解出毫秒', () => {
  const payload = Buffer.from(J({ exp: 1700000000 })).toString('base64url')
  const token = `x.${payload}.y`
  assert.equal(jwtExpiry(token), 1700000000000)
})

await test('畸形 JWT 返回 0 而不是抛异常', () => {
  assert.equal(jwtExpiry('not-a-jwt'), 0)
  assert.equal(jwtExpiry(''), 0)
  assert.doesNotThrow(() => jwtExpiry(null))
})

// ─────────────────────────────────────────── 8. 仓库结构约束
//
// 这一组把 AGENTS.md 里写下的规矩变成**可执行的检查**。
// 规矩写在文档里会腐烂，写成测试才会在改坏的那一刻拦下来。
group('仓库结构约束')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readFile(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function listFiles(rel, ext) {
  const dir = join(ROOT, rel)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => `${rel}/${f}`)
}

await test('scripts/_shared/ 里不出现平台判断', () => {
  // 允许：形如 `plat === 'win32'` 的参数判断（plat 是调用方传进来的）
  // 禁止：直接读 process.platform / platform() / uname
  const offenders = []
  for (const f of [...listFiles('scripts/_shared', '.mjs')]) {
    const text = readFile(f)
    text.split('\n').forEach((line, i) => {
      // 跳过注释行 —— 说明文字里提到 process.platform 是允许的
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
      if (!code.trim()) return
      if (/process\.platform|os\.platform\(\)|platform\(\)\s*===|\buname\b/.test(code)) {
        offenders.push(`${f}:${i + 1}  ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `_shared 必须与平台无关，以下位置在读平台：\n${offenders.join('\n')}`)
})

await test('Linux 入口里不出现 Windows 专有代码', () => {
  const text = readFile('scripts/linux/deploy.mjs')
  // 唯一允许提到 win32 的地方是那句"你在 Windows 上"的守卫
  const body = text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const stripped = body.replace(/platform\(\)\s*===\s*'win32'[\s\S]{0,120}?process\.exit\(1\)\}/, '')
  assert.ok(!/xray\.exe/.test(stripped), 'Linux 入口不该提到 xray.exe')
  assert.ok(!/Expand-Archive/.test(stripped), 'Linux 入口不该出现 PowerShell 解压')
  assert.ok(!/junction/.test(stripped), 'Linux 入口不该用 junction')
})

await test('Windows 入口里不出现 Linux 专有代码', () => {
  const text = readFile('scripts/windows/deploy.mjs')
  const body = text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.ok(!/'dir'/.test(body), "Windows 入口不该用符号链接 'dir'")
  assert.ok(!/setup-browser\.sh/.test(body), 'Windows 入口不该调 setup-browser.sh')
  assert.ok(!/spawnSync\('unzip'/.test(body), 'Windows 入口不该依赖 unzip')
})

await test('两个平台入口都显式传 linkMode', () => {
  assert.ok(/linkMode:\s*'dir'/.test(readFile('scripts/linux/deploy.mjs')), "Linux 入口要传 linkMode: 'dir'")
  assert.ok(/linkMode:\s*'junction'/.test(readFile('scripts/windows/deploy.mjs')), "Windows 入口要传 linkMode: 'junction'")
})

await test('AGENTS.md 指向的文档都真实存在', () => {
  const agents = readFile('AGENTS.md')
  const refs = [...agents.matchAll(/`(docs\/[a-z]+\.md|README\.md|setup\.[a-z]+)`/g)].map((m) => m[1])
  assert.ok(refs.length > 0, 'AGENTS.md 应当引用文档')
  for (const r of [...new Set(refs)]) {
    assert.ok(existsSync(join(ROOT, r)), `AGENTS.md 引用了不存在的文件：${r}`)
  }
})

await test('README 与 AGENTS.md 不引用已删除的旧脚本路径', () => {
  const stale = ['scripts/deploy.sh', 'scripts/deploy.bat', 'scripts/deploy.mjs', 'scripts/setup-browser.sh', 'scripts/fetch-core.sh', 'scripts/register-plugin.mjs']
  for (const f of ['README.md', 'AGENTS.md', 'docs/linux.md', 'docs/windows.md']) {
    const text = readFile(f)
    for (const s of stale) {
      assert.ok(!text.includes(s), `${f} 里还残留旧路径：${s}`)
    }
  }
})

await test('package.json 的 files 覆盖对外文档与入口', () => {
  const pkg = JSON.parse(readFile('package.json'))
  for (const need of ['docs', 'AGENTS.md', 'scripts', 'setup.sh', 'setup.bat', 'lib']) {
    assert.ok(pkg.files.includes(need), `package.json files 缺少 ${need}`)
  }
})

await test('lib/chatgpt/*.ts 是 vendored，改动需慎重（存在性 + 后缀引用）', () => {
  for (const f of ['lib/chatgpt/pow.ts', 'lib/chatgpt/turnstile.ts', 'lib/chatgpt/sentinel.ts']) {
    assert.ok(existsSync(join(ROOT, f)), `vendored 文件不见了：${f}`)
  }
  // 引用 vendored 模块必须带 .ts 后缀，Node 的 ESM 解析不会自动补
  const webchat = readFile('lib/chatgpt/webchat.js')
  assert.ok(/from '\.\/sentinel\.ts'/.test(webchat), "webchat.js 必须用 './sentinel.ts'（带后缀）引用")
  const sentinel = readFile('lib/chatgpt/sentinel.ts')
  assert.ok(/from "\.\/pow\.ts"/.test(sentinel), 'sentinel.ts 必须带 .ts 后缀引用 pow')
})

// ─────────────────────────────────────────── 9. provider 注册契约
//
// 这一段用桩 ctx 跑真实的 apply()，把注册进 llm-pi-ai 的那份 profile 截下来检查。
// 为什么值得测：profile 是整体校验的，一个非法键就会让整条落不了盘，
// 表现是「模型区里什么都没有」而不是一条明确的报错 —— README 里记过这个坑。
group('provider 注册契约')

const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * 用桩 ctx 跑一次 apply()，收集它写进 llm-pi-ai 的 profile。
 * 关掉自动连接与自动开浏览器，避免测试期间真去连机场 / 起 Chromium。
 */
async function captureProviderProfiles() {
  const written = []
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(String(m)) },
    settings: {
      register: () => ({ get: () => ({}) }),
      mutate: async (ns, ops) => {
        if (ns === 'llm-pi-ai') written.push(ops[0]?.value)
      },
    },
    credentials: { set: async () => {} },
    effect: () => {},
  }
  const { apply } = await import('../lib/index.js')
  const state = apply(ctx, {
    autoBrowser: false,
    autoConnect: false,
    adminPort: 12110,
    relayPort: 12111,
  })
  // 等一次微任务让 publishProvider() 跑完
  await new Promise((r) => setTimeout(r, 300))
  state.dispose()
  return { written, logs }
}

const { written: profiles, logs: applyLogs } = await captureProviderProfiles()

await test('apply() 会往 llm-pi-ai 注册 provider', () => {
  assert.ok(profiles.length > 0, `没有注册任何 profile；日志：\n${applyLogs.join('\n')}`)
})

const profile = profiles[0] || {}

await test('profile 的必填字段齐全', () => {
  for (const k of ['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models']) {
    assert.ok(profile[k], `profile 缺少 ${k}`)
  }
})

await test('baseURL 指向本地串行中继', () => {
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(profile.baseURL), `baseURL 不对：${profile.baseURL}`)
})

await test('apiKeyEnv 用的是凭据引用名而不是明文 key', () => {
  assert.equal(profile.apiKey, undefined, 'profile 里不能出现明文 apiKey（未知键会让整条落不了盘）')
  assert.ok(typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv, 'apiKeyEnv 必须是非空字符串')
})

await test('对外只暴露 free-chat 一个入口', () => {
  assert.deepEqual(
    profile.models.map((m) => m.id),
    ['free-chat'],
    '收敛成单一别名是刻意设计，别又铺开成型号列表',
  )
})

await test('reasoningEfforts 的键都是合法档位', () => {
  const eff = profile.models[0].reasoningEfforts
  if (!eff) return // 退回模式，另有测试覆盖
  for (const k of Object.keys(eff)) {
    assert.ok(VALID_THINKING_LEVELS.has(k), `非法档位 ${k}；合法值：${[...VALID_THINKING_LEVELS].join(', ')}`)
  }
})

await test('reasoningEfforts.off 留空、其余档位是非空字符串', () => {
  const eff = profile.models[0].reasoningEfforts
  if (!eff) return
  if ('off' in eff) assert.equal(eff.off, null, 'off 只能留空（表示支持但不发参数）')
  for (const [k, v] of Object.entries(eff)) {
    if (k === 'off') continue
    assert.equal(typeof v, 'string', `${k} 的线上取值必须是字符串`)
    assert.ok(v.length > 0, `${k} 的线上取值不能是空字符串`)
  }
})

await test('reasoningEfforts 至少声明一个非 off 档位', () => {
  const eff = profile.models[0].reasoningEfforts
  if (!eff) return
  assert.ok(Object.keys(eff).some((k) => k !== 'off'), '只声明 off 等于没有思考能力')
})

await test('schema 拒绝思考声明时，会退回并保住模型', async () => {
  const logs = []
  const seen = []
  const ctx = {
    logger: { info: (m) => logs.push(String(m)) },
    settings: {
      register: () => ({ get: () => ({}) }),
      mutate: async (ns, ops) => {
        if (ns !== 'llm-pi-ai') return
        const v = ops[0]?.value
        seen.push(Boolean(v?.models?.[0]?.reasoningEfforts))
        if (v?.models?.[0]?.reasoningEfforts) throw new Error('未知键 reasoningEfforts')
      },
    },
    credentials: { set: async () => {} },
    effect: () => {},
  }
  const { apply } = await import('../lib/index.js')
  const state = apply(ctx, { autoBrowser: false, autoConnect: false, adminPort: 12112, relayPort: 12113 })
  await new Promise((r) => setTimeout(r, 300))
  state.dispose()

  assert.deepEqual(seen, [true, false], '应当先带思考声明试一次，被拒后不带再试一次')
  assert.ok(
    logs.some((l) => l.includes('退回')),
    `退回这件事必须留下日志，否则用户不知道思考开关为何无效：\n${logs.join('\n')}`,
  )
})

// ─────────────────────────────────────────── 10. 生命周期
//
// 这一组守着一个真出现过的 bug：autostart 的 2.5 秒定时器没被取消，
// dispose() 之后它照样触发，一看"中继没在监听"就重新 listen ——
// 端口于是永远占着，插件卸载了反代还在跑。
group('生命周期（dispose 要真的停干净）')

await test('SerialRelay 在 close() 之后拒绝再次 listen', async () => {
  const { SerialRelay } = await import('../lib/relay.js')
  const r = new SerialRelay({ upstreamBase: 'https://example.com/v1', port: 12130, log: () => {} })
  await r.listen()
  r.close()
  const err = await r.listen()
  assert.ok(typeof err === 'string' && err.length > 0, 'close() 之后 listen() 应当返回错误而不是重新占端口')
  assert.equal(r.status.listening, false, 'close() 之后不该处于监听状态')
})

await test('dispose() 之后中继不会自己复活', async () => {
  const net = await import('node:net')
  const { createRelayState } = await import('../lib/index.js')
  const PORT = 12131
  const st = createRelayState({ log: () => {}, adminPort: 12132, relayPort: PORT, autoBrowser: false })
  st.autostart() // 起那个 2.5 秒的定时器，这正是当初复活中继的元凶
  await new Promise((r) => setTimeout(r, 200))
  st.dispose()

  // 等过定时器原本该触发的时刻
  await new Promise((r) => setTimeout(r, 2800))

  const listening = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1')
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
  assert.equal(listening, false, `dispose() 之后 ${PORT} 又被监听了 —— 定时器没被取消`)
})

await test('disconnect() 不关中继 —— DSH 端点要一直活着', async () => {
  const net = await import('node:net')
  const { createRelayState } = await import('../lib/index.js')
  const PORT = 12135
  const st = createRelayState({ log: () => {}, adminPort: 12136, relayPort: PORT, autoBrowser: false })

  const listeningBefore = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1')
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
  assert.equal(listeningBefore, true, '初始中继应在监听')

  // disconnect 之前会关中继（连带把 closed 置真，reconnect 就废了）；现在不该关
  await st.disconnect()

  const listeningAfter = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1')
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
  assert.equal(listeningAfter, true, '断开后中继应仍在监听 —— 断开只停 Xray，不动中继')

  st.dispose()
})

test('dispose 是幂等的，连调两次不抛异常', async () => {
  const { createRelayState } = await import('../lib/index.js')
  const st = createRelayState({ log: () => {}, adminPort: 12133, relayPort: 12134, autoBrowser: false })
  assert.doesNotThrow(() => st.dispose())
  assert.doesNotThrow(() => st.dispose())
})

// ─────────────────────────────────────────── 汇总
process.stdout.write(`\n${'─'.repeat(52)}\n`)
process.stdout.write(`通过 ${passed} · 失败 ${failed}\n`)
if (failed) {
  process.stdout.write('\n失败明细：\n')
  for (const [name, e] of failures) process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过。\n')
}
