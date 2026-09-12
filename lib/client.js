/**
 * dsh-gpt-free-relay 的浏览器端：在「插件配置」页注册一张可展开的设置卡片。
 *
 * 数据不走 DSH RPC，而是直接打 host 端的本地管理接口（127.0.0.1:2083）——
 * 那个接口就是给 agent 用的同一套，卡片只是薄薄一层 UI。
 */
window.__ModuleLoader__.load({
  id: 'dsh-gpt-free-relay',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    const h = React.createElement

    const NS = 'gpt-free-relay'
    const API = 'http://127.0.0.1:2083'

    const zh = {
      'title': '机场中转',
      'desc': '订阅解析 → 本地代理 → 让 DSH 走你的线路；并发强制 1，且不传工具调用。',
      'sub': '订阅地址',
      'fetch': '拉取并解析',
      'node': '节点',
      'connect': '连接',
      'disconnect': '断开',
      'refresh': '刷新状态',
      'status': '状态',
      'hint': '并发：强制 1（必须等上一轮回答写完） · 工具调用：已关闭',
      'noCore': '核心未运行',
      'running': '核心运行中',
      'noNodes': '（暂无节点，请先拉取订阅）',
      'loading': '读取中…',
      'unreachable': '读不到插件服务（host 端可能未启动或端口被占用）',
    }
    const en = {
      'title': 'Relay',
      'desc': 'Subscription → local proxy → route DSH through your line; concurrency forced to 1, no tool calls.',
      'sub': 'Subscription URL',
      'fetch': 'Fetch & parse',
      'node': 'Node',
      'connect': 'Connect',
      'disconnect': 'Disconnect',
      'refresh': 'Refresh',
      'status': 'Status',
      'hint': 'Concurrency: forced to 1 · Tool calls: disabled',
      'noCore': 'Core not running',
      'running': 'Core running',
      'noNodes': '(no nodes yet — fetch the subscription first)',
      'loading': 'Loading…',
      'unreachable': 'Cannot reach the plugin service (host half not started, or port taken)',
    }

    const inject = ['slots', 'locale']

    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        borderRadius: '12px',
      },
      head: {
        appearance: 'none',
        width: '100%',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'none',
        border: 0,
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
      },
      body: { padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: '12px', opacity: 0.7, minWidth: '64px' },
      input: {
        flex: '1 1 160px',
        minWidth: 0,
        font: 'inherit',
        fontSize: '13px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
      },
      select: {
        flex: '1 1 160px',
        minWidth: 0,
        font: 'inherit',
        fontSize: '13px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
      },
      btn: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        color: 'inherit',
      },
      btnMain: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #4f73ff)',
        color: '#fff',
      },
      status: {
        fontSize: '12px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        opacity: 0.85,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      },
      hint: { fontSize: '11px', opacity: 0.55, lineHeight: 1.5 },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #c83e4d)' },
    }

    async function call(path, body) {
      try {
        const res = await fetch(API + path, {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        })
        return await res.json()
      } catch (e) {
        return { __error: String((e && e.message) || e) }
      }
    }

    function Card(props) {
      const t = typeof props?.t === 'function' ? props.t : (k) => k
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [url, setUrl] = React.useState('')
      const [nodes, setNodes] = React.useState([])
      const [picked, setPicked] = React.useState('0')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(async () => {
        const s = await call('/status')
        if (s && s.__error) {
          setStatus(null)
          setMsg(t('unreachable'))
          return
        }
        setStatus(s)
        const n = await call('/nodes')
        if (n && Array.isArray(n.nodes)) setNodes(n.nodes)
      }, [t])

      React.useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      const run = async (fn) => {
        setBusy(true)
        try {
          const r = await fn()
          if (r && r.__error) setMsg(r.__error)
          else if (r && r.error) setMsg(String(r.error))
          else setMsg('OK')
          await refresh()
        } finally {
          setBusy(false)
        }
      }

      const body = open
        ? h(
            'div',
            { style: S.body },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.label }, t('sub')),
              h('input', {
                style: S.input,
                value: url,
                placeholder: 'https://…/subscribe?token=…',
                onChange: (e) => setUrl(e.target.value),
              }),
              h(
                'button',
                {
                  style: S.btnMain,
                  disabled: busy || !url.trim(),
                  onClick: () => run(() => call('/subscription', { url: url.trim() })),
                },
                t('fetch'),
              ),
            ),
            nodes.length
              ? h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.label }, t('node')),
                  h(
                    'select',
                    { style: S.select, value: picked, onChange: (e) => setPicked(e.target.value) },
                    nodes.map((n) =>
                      h('option', { key: n.index, value: String(n.index) }, `${n.protocol} · ${n.name || n.server}`),
                    ),
                  ),
                  h(
                    'button',
                    {
                      style: S.btnMain,
                      disabled: busy,
                      onClick: () => run(() => call('/connect', { index: Number(picked) })),
                    },
                    t('connect'),
                  ),
                  h(
                    'button',
                    { style: S.btn, disabled: busy, onClick: () => run(() => call('/disconnect')) },
                    t('disconnect'),
                  ),
                )
              : h('div', { style: S.hint }, t('noNodes')),
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { style: S.btn, disabled: busy, onClick: () => run(async () => (await call('/status')) && {}) },
                t('refresh'),
              ),
              h(
                'span',
                { style: S.status },
                status
                  ? `${t('status')}: ${status.coreRunning ? t('running') : t('noCore')} · 节点 ${status.nodeCount} · 并发 ${status.concurrency} · 工具 ${status.toolsAllowed ? 'on' : 'off'}`
                  : t('loading'),
              ),
            ),
            msg ? h('div', { style: S.status }, msg) : null,
            h('div', { style: S.hint }, t('hint')),
          )
        : null

      return h(
        'div',
        { style: S.card },
        h(
          'button',
          { type: 'button', 'aria-expanded': open, style: S.head, onClick: () => setOpen((v) => !v) },
          h(
            'span',
            { style: { flex: '1 1 0%', minWidth: 0 } },
            h('div', { style: { fontSize: '14px', fontWeight: 500 } }, t('title')),
            h('div', { style: { marginTop: '3px', fontSize: '12px', opacity: 0.7, lineHeight: 1.5 } }, t('desc')),
          ),
          h('span', { style: { flex: 'none', opacity: 0.5, fontSize: '12px' } }, open ? '▾' : '▸'),
        ),
        body,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gpt-free-relay: dictionaries')
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          { name: 'settings.plugin.item', id: NS, key: NS, locale: NS },
          Card,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
