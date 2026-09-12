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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { stripTools, filterToolCalls, rewriteModel, SerialGate } from '../lib/relay.js'
import { parseSubscription } from '../lib/subscription.js'
import { buildConfig, findCore } from '../lib/xray.js'
import { rewriteSetCookie, jwtExpiry } from '../lib/chatgpt/session.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
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

test('顶层 tools / tool_choice / functions 全部剥掉', () => {
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

test('消息历史里的 assistant.tool_calls 被剥掉', () => {
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

test('content 数组里的 tool_result 分片被剥掉，普通分片保留', () => {
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

test('深层自定义容器也覆盖', () => {
  const out = P(stripTools(J({ model: 'm', a: { b: { messages: [{ role: 'assistant', tool_calls: [{ id: 'z' }] }] } } })))
  assert.equal('tool_calls' in out.a.b.messages[0], false)
})

test('普通对话一个字节都不改', () => {
  const input = J({ model: 'm', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }] })
  assert.equal(stripTools(input), input, '没有工具字段时应当原样返回')
})

test('正文里出现 tool_calls 这个词不会被误删', () => {
  const input = J({ model: 'm', messages: [{ role: 'user', content: 'tool_calls 是个词' }] })
  assert.equal(P(stripTools(input)).messages[0].content, 'tool_calls 是个词')
})

test('畸形输入不抛异常，原样返回', () => {
  assert.equal(stripTools('not json'), 'not json')
  assert.equal(stripTools(''), '')
  assert.doesNotThrow(() => stripTools(J({ model: 'm', messages: 'not-an-array' })))
  assert.equal(P(stripTools(J({}))).model, undefined)
})

// ─────────────────────────────────────────── 2. 串行闸门
group('串行闸门（并发必须恒为 1）')

test('三个异步任务严格串行，总耗时 = 各自之和', async () => {
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

test('峰值并发恒为 1', async () => {
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

test('任务抛异常不会卡死队列', async () => {
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

test('同步抛出的任务同样不卡队列', async () => {
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

test('delta 里的 tool_calls 被剥掉', () => {
  const out = filterToolCalls({ choices: [{ delta: { tool_calls: [{ id: 1 }] }, finish_reason: null }] })
  assert.equal('tool_calls' in out.choices[0].delta, false)
})

test('message 里的 tool_calls 被剥掉', () => {
  const out = filterToolCalls({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 1 }] }, finish_reason: 'stop' }] })
  assert.equal('tool_calls' in out.choices[0].message, false)
  assert.equal(out.choices[0].message.content, 'hi')
})

test('还有内容要发时，finish_reason=tool_calls 归一化为 null', () => {
  const out = filterToolCalls({
    choices: [{ delta: { content: 'x', tool_calls: [{ id: 1 }] }, finish_reason: 'tool_calls' }],
  })
  assert.equal(out.choices[0].finish_reason, null)
})

test('收尾帧（空 delta）的 finish_reason 归一化为 stop', () => {
  const out = filterToolCalls({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  assert.equal(out.choices[0].finish_reason, 'stop', '收尾帧必须给出明确的结束信号')
})

test('非流式响应归一化为 stop', () => {
  const out = filterToolCalls({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 1 }] }, finish_reason: 'tool_calls' }] })
  assert.equal(out.choices[0].finish_reason, 'stop')
})

test('正常的 stop / length 不被改动', () => {
  assert.equal(filterToolCalls({ choices: [{ message: { content: 'a' }, finish_reason: 'length' }] }).choices[0].finish_reason, 'length')
  assert.equal(filterToolCalls({ choices: [{ delta: { content: 'a' }, finish_reason: null }] }).choices[0].finish_reason, null)
})

test('畸形载荷不抛异常', () => {
  assert.equal(filterToolCalls(null), null)
  assert.doesNotThrow(() => filterToolCalls({}))
  assert.doesNotThrow(() => filterToolCalls({ choices: 'x' }))
})

// ─────────────────────────────────────────── 4. 模型别名
group('模型别名映射')

test('别名被替换成上游型号', () => {
  const out = P(rewriteModel(J({ model: 'free-chat', messages: [] }), 'free-chat', 'gpt-4o-mini'))
  assert.equal(out.model, 'gpt-4o-mini')
})

test('客户端直接点名真实型号时原样透传', () => {
  const input = J({ model: 'gpt-4o', messages: [] })
  assert.equal(rewriteModel(input, 'free-chat', 'gpt-4o-mini'), input)
})

test('别名与目标相同时不做无谓改写', () => {
  const input = J({ model: 'same', messages: [] })
  assert.equal(rewriteModel(input, 'same', 'same'), input)
})

// ─────────────────────────────────────────── 5. 订阅解析
group('订阅解析')

test('Clash 区块风格', () => {
  const r = parseSubscription(
    'proxies:\n  - {name: n1, type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-3333-4444-555555555555}\n  - {name: n2, type: trojan, server: 5.6.7.8, port: 8443, password: pw}\n',
  )
  assert.equal(r.nodes.length, 2)
  assert.equal(r.nodes[0].protocol, 'vmess')
  assert.equal(r.nodes[1].protocol, 'trojan')
})

test('Clash 多行缩进风格', () => {
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

test('base64 编码的 URI 列表', () => {
  const list = 'vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#节点A\n'
  const r = parseSubscription(Buffer.from(list, 'utf8').toString('base64'))
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'vless')
  assert.equal(r.nodes[0].name, '节点A')
})

test('明文 URI 列表', () => {
  const r = parseSubscription('trojan://pw@b.example.com:443#节点B\n')
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'trojan')
})

test('vmess:// 的 base64 JSON', () => {
  const j = { v: '2', ps: 'vm', add: 'c.example.com', port: '443', id: '11111111-2222-3333-4444-555555555555', aid: '0', net: 'ws', tls: 'tls' }
  const r = parseSubscription('vmess://' + Buffer.from(JSON.stringify(j), 'utf8').toString('base64'))
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].protocol, 'vmess')
  assert.equal(r.nodes[0].server, 'c.example.com')
})

test('空内容与无法识别的输入不抛异常', () => {
  assert.equal(parseSubscription('').nodes.length, 0)
  assert.equal(parseSubscription('这不是订阅').nodes.length, 0)
  assert.doesNotThrow(() => parseSubscription(null))
  assert.doesNotThrow(() => parseSubscription(undefined))
})

// ─────────────────────────────────────────── 6. Xray 配置生成
group('Xray 配置生成')

test('vless + ws + tls 生成合法结构', () => {
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

test('trojan 默认走 tls', () => {
  const cfg = buildConfig({ protocol: 'trojan', server: 't.example.com', port: 443, params: { password: 'pw' } })
  assert.equal(cfg.outbounds.find((o) => o.tag === 'proxy').streamSettings.security, 'tls')
})

test('未知协议退化成 freedom 且不带 address/port', () => {
  const cfg = buildConfig({ protocol: '别的东西', server: 'z.example.com', port: 1, params: {} })
  const proxy = cfg.outbounds.find((o) => o.tag === 'proxy')
  assert.equal(proxy.protocol, 'freedom')
  assert.equal('settings' in proxy, false, 'freedom 不接受 settings')
})

test('生成的配置能被真实 Xray 校验（有核心时）', () => {
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

test('Set-Cookie 去掉 Domain 变成 host-only', () => {
  const out = rewriteSetCookie('__Secure-next-auth.session-token=abc; Domain=.chatgpt.com; Path=/; Secure; HttpOnly')
  assert.ok(!/domain=/i.test(out), 'Domain 必须去掉，否则浏览器整条丢弃')
  assert.ok(out.startsWith('__Secure-next-auth.session-token=abc'))
  assert.ok(/Path=\//.test(out))
})

test('SameSite=None 降级成 Lax，Partitioned 去掉', () => {
  const out = rewriteSetCookie('cf_clearance=x; SameSite=None; Partitioned; Secure')
  assert.ok(/SameSite=Lax/i.test(out))
  assert.ok(!/partitioned/i.test(out))
})

test('JWT exp 能正确解出毫秒', () => {
  const payload = Buffer.from(J({ exp: 1700000000 })).toString('base64url')
  const token = `x.${payload}.y`
  assert.equal(jwtExpiry(token), 1700000000000)
})

test('畸形 JWT 返回 0 而不是抛异常', () => {
  assert.equal(jwtExpiry('not-a-jwt'), 0)
  assert.equal(jwtExpiry(''), 0)
  assert.doesNotThrow(() => jwtExpiry(null))
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
