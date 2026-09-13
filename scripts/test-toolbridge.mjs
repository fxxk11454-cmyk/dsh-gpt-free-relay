/**
 * 文本工具协议回归测试（toolbridge.js）。
 *
 * 这一层的活是"把结构化 function calling 摊平成文本再收回来"，全是纯函数，
 * 所以测试不需要浏览器。重点保两件事：
 *   1. 模型正经输出工具调用时，必须解析出来
 *   2. 模型输出**普通回答**时，绝不能误判成工具调用（一次误判 = 白跑一轮）
 */
import assert from 'node:assert/strict'

const {
  buildToolPreamble,
  normalizeTools,
  parseToolCall,
  formatToolResult,
  formatToolCallTurn,
  buildTurnText,
  TOOL_CALL_FORMAT,
} = await import('../lib/chatgpt/toolbridge.js')

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

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  { name: 'bash', description: '跑命令', parameters: { type: 'object', properties: {} } },
]

// ─────────────────────────────────────────── 清单
group('工具清单')

test('没有工具时说明为空', () => {
  assert.equal(buildToolPreamble([]), '')
  assert.equal(buildToolPreamble(null), '')
})

test('OpenAI 的 {type,function} 与摊平写法都能认', () => {
  const list = normalizeTools(OPENAI_TOOLS)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, 'read_file')
  assert.equal(list[1].name, 'bash')
})

test('缺名字的条目会被丢掉', () => {
  assert.equal(normalizeTools([{ type: 'function', function: {} }, null, 'x']).length, 0)
})

test('说明里带上工具名、说明和参数 schema', () => {
  const s = buildToolPreamble(OPENAI_TOOLS)
  assert.ok(s.includes('read_file'))
  assert.ok(s.includes('读取文件'))
  assert.ok(s.includes('"path"'), '参数 schema 要写进去，否则模型不知道传什么')
  assert.ok(s.includes(TOOL_CALL_FORMAT))
})

// ─────────────────────────────────────────── 解析
group('解析工具调用')

test('纯 JSON', () => {
  const r = parseToolCall('{"tool_call":{"name":"read_file","arguments":{"path":"/a"}}}')
  assert.deepEqual(r, { name: 'read_file', arguments: { path: '/a' } })
})

test('裹在代码块里', () => {
  const r = parseToolCall('```json\n{"tool_call":{"name":"bash","arguments":{"cmd":"ls"}}}\n```')
  assert.deepEqual(r, { name: 'bash', arguments: { cmd: 'ls' } })
})

test('前后带废话也能捞出来', () => {
  const r = parseToolCall('好的，我需要看一下文件。\n{"tool_call":{"name":"read_file","arguments":{"path":"/b"}}}\n以上。')
  assert.deepEqual(r, { name: 'read_file', arguments: { path: '/b' } })
})

test('arguments 是字符串（各家习惯不同）也能解析', () => {
  const r = parseToolCall('{"tool_call":{"name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}')
  assert.deepEqual(r, { name: 'bash', arguments: { cmd: 'pwd' } })
})

test('OpenAI 原生形态 tool_calls[0].function', () => {
  const r = parseToolCall('{"tool_calls":[{"function":{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}')
  assert.deepEqual(r, { name: 'bash', arguments: { cmd: 'ls' } })
})

test('name + arguments 裸形态（没有 tool_call 外壳）', () => {
  const r = parseToolCall('{"name":"bash","arguments":{"cmd":"ls"}}')
  assert.deepEqual(r, { name: 'bash', arguments: { cmd: 'ls' } })
})

group('解析：绝不能误判')

test('普通中文回答', () => {
  assert.equal(parseToolCall('这是一段普通的回答。'), null)
})

test('回答里带一个不相干的 JSON', () => {
  assert.equal(parseToolCall('配置长这样：{"a":1,"b":[2,3]}'), null)
})

test('只有 name 没有 arguments，不算调用', () => {
  assert.equal(parseToolCall('{"name":"bash"}'), null)
})

test('空输入', () => {
  assert.equal(parseToolCall(''), null)
  assert.equal(parseToolCall(null), null)
})

test('模型把参数写成数组这种非法形态，退化成空参数而不是崩', () => {
  const r = parseToolCall('{"tool_call":{"name":"bash","arguments":[1,2]}}')
  assert.deepEqual(r, { name: 'bash', arguments: {} })
})

// ─────────────────────────────────────────── 渲染
group('工具结果渲染')

test('role:"tool" 渲染成人话', () => {
  const s = formatToolResult({ role: 'tool', name: 'read_file', content: '文件内容' })
  assert.ok(s.includes('read_file'))
  assert.ok(s.includes('文件内容'))
})

test('助手那次调用也留痕（模型看得见自己调过什么）', () => {
  const s = formatToolCallTurn({
    role: 'assistant',
    tool_calls: [{ function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
  })
  assert.ok(s.includes('bash'))
  assert.ok(s.includes('ls'))
})

// ─────────────────────────────────────────── 组装
group('每轮发什么（buildTurnText）')

test('第一次提问：system + user', () => {
  const out = buildTurnText([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ])
  assert.ok(out.includes('你是助手'))
  assert.ok(out.includes('你好'))
})

test('第二轮只发新的那条，不重灌历史（网页会话自己记着）', () => {
  const out = buildTurnText([
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '第一个回答' },
    { role: 'user', content: '第二个问题' },
  ])
  assert.ok(out.includes('第二个问题'))
  assert.ok(!out.includes('第一个问题'), `不该重发历史，实际：${out}`)
  assert.ok(!out.includes('第一个回答'))
})

test('工具那一轮：把工具结果递回去', () => {
  const out = buildTurnText([
    { role: 'user', content: '看下文件' },
    { role: 'assistant', content: '我看一下' },
    { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"/a"}' } }] },
    { role: 'tool', name: 'read_file', content: '文件里写着 42' },
  ])
  assert.ok(out.includes('文件里写着 42'), `工具结果要发出去，实际：${out}`)
  assert.ok(out.includes('read_file'))
  assert.ok(!out.includes('看下文件'), '历史里的老问题不该重发')
})

test('带工具时协议说明在最前面', () => {
  const out = buildTurnText([{ role: 'user', content: '问题' }], { tools: OPENAI_TOOLS })
  assert.ok(out.startsWith('【工具调用协议】'), `实际开头：${JSON.stringify(out.slice(0, 30))}`)
  assert.ok(out.includes('read_file'))
  assert.ok(out.indexOf('问题') > out.indexOf('read_file'), '说明要在提问之前')
})

test('不开工具时没有协议说明', () => {
  const out = buildTurnText([{ role: 'user', content: '问题' }])
  assert.ok(!out.includes('【工具调用协议】'))
})

test('thinking：前缀加在最前，且不重复加', () => {
  const a = buildTurnText([{ role: 'user', content: '问题' }], { thinking: true, prefix: '请你使用thinking模式' })
  assert.ok(a.startsWith('请你使用thinking模式'))
  const b = buildTurnText([{ role: 'user', content: '问题' }], {
    thinking: true,
    prefix: '请你使用thinking模式',
    tools: OPENAI_TOOLS,
  })
  assert.ok(b.startsWith('请你使用thinking模式'), '即使是工具轮，思考前缀也要在最前')
  assert.equal(b.indexOf('请你使用thinking模式'), b.lastIndexOf('请你使用thinking模式'), '前缀只能出现一次')
})

test('没有可发的内容时返回空串（调用方会报错，不会发一条空消息）', () => {
  assert.equal(buildTurnText([]), '')
  assert.equal(buildTurnText([{ role: 'assistant', content: '只有回答' }]), '')
})

// ─────────────────────────────────────────── 端到端（假驱动）
group('bridge：把模型输出翻译回标准 tool_calls')

const { createLocalChatHandler } = await import('../lib/chatgpt/bridge.js')

/** 假的响应对象，把 SSE 写进数组里方便断言 */
function fakeRes() {
  const chunks = []
  return {
    headersSent: false,
    status: null,
    writeHead(code) {
      this.status = code
      this.headersSent = true
    },
    write(s) {
      chunks.push(String(s))
      return true
    },
    end(s) {
      if (s) chunks.push(String(s))
      this.ended = true
    },
    get body() {
      return chunks.join('')
    },
  }
}

/** 假的浏览器驱动：按脚本吐内容，模拟"一次性整段给出" */
function fakeDriver(text) {
  return {
    available: true,
    async answer(messages, onDelta, options) {
      this.seen = { messages, options }
      onDelta(text)
      return text
    },
  }
}

async function runBridge({ answer, tools, allowTools }) {
  const driver = fakeDriver(answer)
  const handler = createLocalChatHandler({ webchat: null, driver, log: () => {}, allowTools: () => allowTools })
  const res = fakeRes()
  const body = { model: 'free-chat', stream: true, messages: [{ role: 'user', content: '看下文件' }] }
  if (tools) body.tools = tools
  await handler(JSON.stringify(body), res)
  return { res, driver }
}

await test('模型吐工具调用 JSON 时，吐的是 tool_calls 而不是正文', async () => {
  const { res } = await runBridge({
    answer: '{"tool_call":{"name":"read_file","arguments":{"path":"/a"}}}',
    tools: OPENAI_TOOLS,
    allowTools: true,
  })
  assert.ok(res.body.includes('"tool_calls"'), `应当有 tool_calls，实际：${res.body.slice(0, 300)}`)
  assert.ok(res.body.includes('"finish_reason":"tool_calls"'), 'finish_reason 要是 tool_calls')
  assert.ok(res.body.includes('read_file'))
  assert.ok(!res.body.includes('delta":{"content":"{"'), 'JSON 不能当成正文流出去')
})

await test('工具调用带 id 和 arguments(字符串)，DSH 才配得上对', async () => {
  const { res } = await runBridge({
    answer: '{"tool_call":{"name":"bash","arguments":{"cmd":"ls"}}}',
    tools: OPENAI_TOOLS,
    allowTools: true,
  })
  assert.match(res.body, /"id":"call_[0-9a-f]{24}"/)
  assert.ok(res.body.includes('\\"cmd\\":\\"ls\\"') || res.body.includes('"arguments":"{\\"cmd\\":\\"ls\\"}"'))
})

await test('模型正常回答时，照常按正文流式输出', async () => {
  const { res } = await runBridge({
    answer: '这是一段正常的回答。',
    tools: OPENAI_TOOLS,
    allowTools: true,
  })
  assert.ok(res.body.includes('这是一段正常的回答。'))
  assert.ok(!res.body.includes('tool_calls'))
  assert.ok(res.body.includes('"finish_reason":"stop"'))
})

await test('工具清单被写进了提问（模型才知道有什么工具）', async () => {
  const { driver } = await runBridge({
    answer: '普通回答',
    tools: OPENAI_TOOLS,
    allowTools: true,
  })
  const sent = driver.seen.options.tools
  assert.equal(sent.length, 2, '工具要传给 driver')
})

await test('开关关着时，即使模型输出像工具调用也当正文（硬约束默认成立）', async () => {
  const { res, driver } = await runBridge({
    answer: '{"tool_call":{"name":"bash","arguments":{"cmd":"ls"}}}',
    tools: OPENAI_TOOLS,
    allowTools: false,
  })
  assert.ok(!res.body.includes('tool_calls'), '关着就绝不能合成 tool_calls')
  assert.ok(res.body.includes('{"tool_call"') || res.body.includes('tool_call'), '应当原样当正文')
  assert.equal(driver.seen.options.tools, null, '工具不该传给 driver')
})

await test('请求里没有 tools 时，一切照旧', async () => {
  const { res } = await runBridge({ answer: '{"tool_call":{"name":"x","arguments":{}}}', tools: null, allowTools: true })
  assert.ok(!res.body.includes('tool_calls'))
})

// ─────────────────────────────────────────── 非流式
group('bridge：非流式响应')

async function runBridgeNoStream(opts) {
  const driver = fakeDriver(opts.answer)
  const handler = createLocalChatHandler({
    webchat: null,
    driver,
    log: () => {},
    allowTools: () => opts.allowTools,
  })
  const res = fakeRes()
  const body = { model: 'free-chat', stream: false, messages: [{ role: 'user', content: 'x' }], tools: OPENAI_TOOLS }
  await handler(JSON.stringify(body), res)
  return JSON.parse(res.body)
}

await test('非流式：工具调用走 message.tool_calls', async () => {
  const out = await runBridgeNoStream({
    answer: '{"tool_call":{"name":"read_file","arguments":{"path":"/b"}}}',
    allowTools: true,
  })
  const choice = out.choices[0]
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(choice.message.content, null)
  assert.equal(choice.message.tool_calls[0].function.name, 'read_file')
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"path":"/b"}')
})

await test('非流式：普通回答走 message.content', async () => {
  const out = await runBridgeNoStream({ answer: '普通回答', allowTools: true })
  assert.equal(out.choices[0].finish_reason, 'stop')
  assert.equal(out.choices[0].message.content, '普通回答')
})

process.stdout.write(`\n${'─'.repeat(52)}\n`)
process.stdout.write(`通过 ${passed} · 失败 ${failed}\n`)
if (failed) {
  process.stdout.write('\n失败明细：\n')
  for (const [name, e] of failures) process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('全部通过。\n')
}
