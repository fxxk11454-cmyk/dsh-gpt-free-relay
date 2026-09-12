/**
 * dsh-gpt-free-relay 浏览器端：在「插件配置」页注册一张可展开的卡片。
 *
 * 写法完全对齐 @opencode2dsh/dsh-plugin：
 *   - inject 用**服务名** ["slots", "locale", "settingsScope"]
 *   - 通过 settingsScope 绑定本插件的设置命名空间
 *   - 卡片 props 由 slots.register 的 inject() 显式提供（t）
 */
window.__ModuleLoader__.load({
  id: 'dsh-gpt-free-relay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement

    /** 词典命名空间 */
    const NS = 'settings.gpt-free-relay'
    /** 本插件读写的设置命名空间（与 host 端一致） */
    const SETTINGS_NAMESPACE = 'gpt-free-relay'
    /** 本地管理接口 */
    const API = 'http://127.0.0.1:2083'

    const zh = {
      title: '机场中转',
      desc: '订阅解析 → 本地代理 → 让 DSH 走你的线路；并发强制 1，且不传工具调用。',
      sub: '订阅地址',
      fetch: '拉取并解析',
      node: '节点',
      connect: '连接',
      disconnect: '断开',
      refresh: '刷新状态',
      status: '状态',
      hint: '并发：强制 1（必须等上一轮回答写完） · 工具调用：已关闭',
      noCore: '核心未运行',
      running: '核心运行中',
      noNodes: '（暂无节点，请先拉取订阅）',
      loading: '读取中…',
      unreachable: '读不到插件服务（host 端未启动，或端口 2083 被占用）',
      ok: '完成',
      working: '处理中…',
    }
    const en = {
      title: 'Relay',
      desc: 'Subscription → local proxy → route DSH through your line; concurrency forced to 1, no tool calls.',
      sub: 'Subscription URL',
      fetch: 'Fetch & parse',
      node: 'Node',
      connect: 'Connect',
      disconnect: 'Disconnect',
      refresh: 'Refresh',
      status: 'Status',
      hint: 'Concurrency: forced to 1 · Tool calls: disabled',
      noCore: 'Core not running',
      running: 'Core running',
      noNodes: '(no nodes yet — fetch the subscription first)',
      loading: 'Loading…',
      unreachable: 'Cannot reach the plugin service (host half down, or port 2083 taken)',
      ok: 'Done',
      working: 'Working…',
    }

    /** 必需服务（cordis fiber inject）—— 与 opencode2dsh 一致，用服务名 */
    const inject = ['slots', 'locale', 'settingsScope']

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
      label: { fontSize: '12px', opacity: 0.7 },
      input: {
        flex: '1 1 180px',
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
        flex: '1 1 180px',
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
        return { __error: (e && e.message) || String(e) }
      }
    }

    function Card(props) {
      const t = props.t
      const [open, setOpen] = react.useState(false)
      const [status, setStatus] = react.useState(null)
      const [url, setUrl] = react.useState('')
      const [nodes, setNodes] = react.useState([])
      const [picked, setPicked] = react.useState('0')
      const [msg, setMsg] = react.useState('')
      const [busy, setBusy] = react.useState(false)

      const refresh = react.useCallback(async () => {
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

      react.useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      const run = async (fn) => {
        setBusy(true)
        setMsg(t('working'))
        try {
          const r = await fn()
          if (r && r.__error) setMsg(r.__error)
          else if (r && r.error) setMsg(String(r.error))
          else setMsg(t('ok'))
          await refresh()
        } catch (e) {
          setMsg((e && e.message) || String(e))
        } finally {
          setBusy(false)
        }
      }

      const header = h(
        'button',
        { type: 'button', 'aria-expanded': open, style: S.head, onClick: () => setOpen((v) => !v) },
        h(
          'span',
          { style: { flex: '1 1 0%', minWidth: 0 } },
          h('div', { style: { fontSize: '14px', fontWeight: 500 } }, t('title')),
          h('div', { style: { marginTop: '3px', fontSize: '12px', opacity: 0.7, lineHeight: 1.5 } }, t('desc')),
        ),
        h('span', { style: { flex: 'none', opacity: 0.5, fontSize: '12px' } }, open ? '▾' : '▸'),
      )

      if (!open) return h('div', { style: S.card }, header)

      const rows = [
        h(
          'div',
          { style: S.row, key: 'sub' },
          h('span', { style: S.label }, t('sub')),
          h('input', {
            style: S.input,
            value: url,
            placeholder: 'https://…/api/v1/client/subscribe?token=…',
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
      ]

      if (nodes.length) {
        rows.push(
          h(
            'div',
            { style: S.row, key: 'nodes' },
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
              { style: S.btnMain, disabled: busy, onClick: () => run(() => call('/connect', { index: Number(picked) })) },
              t('connect'),
            ),
            h('button', { style: S.btn, disabled: busy, onClick: () => run(() => call('/disconnect')) }, t('disconnect')),
          ),
        )
      } else {
        rows.push(h('div', { style: S.hint, key: 'nonodes' }, t('noNodes')))
      }

      rows.push(
        h(
          'div',
          { style: S.row, key: 'status' },
          h(
            'button',
            { style: S.btn, disabled: busy, onClick: () => run(async () => (await call('/status')) || {}) },
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
      )
      if (msg) rows.push(h('div', { style: S.status, key: 'msg' }, msg))
      rows.push(h('div', { style: S.hint, key: 'hint' }, t('hint')))

      return h('div', { style: S.card }, header, h('div', { style: S.body }, rows))
    }

    /**
     * 注册卡片。与 opencode2dsh 一致：绑定 settingsScope、通过 inject() 提供 props。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gpt-free-relay: dictionaries')
      const t = ctx.locale.bind(NS)
      const injected = () => ({ t })
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: SETTINGS_NAMESPACE,
            locale: NS,
            inject: injected,
          },
          Card,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
