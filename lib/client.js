/**
 * dsh-gpt-free-relay 浏览器端：在「插件配置」页注册**一张**卡片。
 *
 * 卡片里同时装下两端，用顶部的模式开关切换：
 *   - 普通端：订阅地址 → 节点列表 → 连接/断开 → 状态
 *   - 网页端：把官网经本机代理渲染进 iframe
 *
 * 机场数据是**保留**的（localStorage + host 端落盘文件双份），
 * 合并规则是"只增不减"——新拉到的节点比旧的少时，保留旧的那份，
 * 这就是「保留最长的数据」。卡片里有「清除数据」把它彻底抹掉。
 *
 * 写法对齐 @opencode2dsh/dsh-plugin：
 *   - inject 用**服务名** ["slots", "locale", "settingsScope"]
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
    /** 网页端 iframe 指向的地址（host 端的网站穿透路由） */
    const WEB_URL = API + '/web/'
    /** 浏览器端的机场数据镜像 */
    const LS_KEY = 'dsh-gpt-free-relay.airport'

    const zh = {
      title: '机场中转',
      desc: '订阅解析 → 本地代理 → 让 DSH 走你的线路；并发强制 1，且不传工具调用。',
      mode: '模式',
      modeNormal: '普通端',
      modeWeb: '网页端',
      sub: '订阅地址',
      fetch: '拉取并解析',
      node: '节点',
      connect: '连接',
      disconnect: '断开',
      refresh: '刷新状态',
      status: '状态',
      hint: '并发：强制 1（必须等上一轮回答写完） · 工具调用：已关闭 · 机场数据默认保留',
      noCore: '核心未运行',
      running: '核心运行中',
      noNodes: '（暂无节点，请先拉取订阅）',
      loading: '读取中…',
      unreachable: '读不到插件服务（host 端未启动，或端口 2083 被占用）',
      ok: '完成',
      working: '处理中…',
      saved: '已保留数据',
      savedNone: '还没有保留任何机场数据',
      keptLonger: '（本次结果更短，已保留原先更长的一份）',
      clear: '清除数据',
      clearAsk: '再点一次确认清除',
      cleared: '已清除数据',
      webReload: '重新加载',
      webOpen: '在新标签打开',
      webNote: '若显示空白或被拒：该站点可能仍禁止嵌入，或需要先登录。也可点「在新标签打开」。',
    }
    const en = {
      title: 'Relay',
      desc: 'Subscription → local proxy → route DSH through your line; concurrency forced to 1, no tool calls.',
      mode: 'Mode',
      modeNormal: 'Direct',
      modeWeb: 'Web',
      sub: 'Subscription URL',
      fetch: 'Fetch & parse',
      node: 'Node',
      connect: 'Connect',
      disconnect: 'Disconnect',
      refresh: 'Refresh',
      status: 'Status',
      hint: 'Concurrency: forced to 1 · Tool calls: disabled · Airport data kept by default',
      noCore: 'Core not running',
      running: 'Core running',
      noNodes: '(no nodes yet — fetch the subscription first)',
      loading: 'Loading…',
      unreachable: 'Cannot reach the plugin service (host half down, or port 2083 taken)',
      ok: 'Done',
      working: 'Working…',
      saved: 'Kept data',
      savedNone: 'No airport data kept yet',
      keptLonger: '(this result was shorter — the longer earlier one was kept)',
      clear: 'Clear data',
      clearAsk: 'Click again to confirm',
      cleared: 'Data cleared',
      webReload: 'Reload',
      webOpen: 'Open in new tab',
      webNote: 'Blank or refused? The site may still block embedding, or needs a sign-in first.',
    }

    /** 必需服务（cordis fiber inject）—— 与 opencode2dsh 一致，用服务名 */
    const inject = ['slots', 'locale', 'settingsScope']

    const BORDER = '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))'

    const S = {
      card: {
        border: BORDER,
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
        border: BORDER,
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
        border: BORDER,
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
        border: BORDER,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        color: 'inherit',
      },
      btnOn: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        padding: '6px 12px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #4f73ff)',
        color: '#fff',
      },
      btnOnIdle: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        padding: '6px 12px',
        borderRadius: '8px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        opacity: 0.7,
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
      btnDanger: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(220,80,80,0.55)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #e05555)',
      },
      sep: { height: '1px', background: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', margin: '2px 0' },
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

    //#region 机场数据的本地镜像 —— 合并规则"只增不减"（保留最长的数据）

    function readLocal() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(LS_KEY) || 'null')
        return raw && typeof raw === 'object' ? raw : null
      } catch {
        return null
      }
    }

    function writeLocal(data) {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(data))
      } catch {
        /* 隐私模式等场景直接放弃镜像 */
      }
    }

    function dropLocal() {
      try {
        window.localStorage.removeItem(LS_KEY)
      } catch {
        /* 忽略 */
      }
    }

    /** 更短的结果不覆盖更长的那份 —— 这就是「保留最长的数据」。 */
    function mergeAirport(prev, next) {
      const a = prev && typeof prev === 'object' ? prev : {}
      const out = { ...a, ...next }
      const oldNodes = Array.isArray(a.nodes) ? a.nodes : []
      const newNodes = Array.isArray(next.nodes) ? next.nodes : []
      if (newNodes.length < oldNodes.length) {
        out.nodes = oldNodes
        out.keptLonger = true
      } else {
        out.keptLonger = false
      }
      if (!next.subscriptionUrl) out.subscriptionUrl = a.subscriptionUrl || ''
      else if (a.subscriptionUrl && next.subscriptionUrl.length < a.subscriptionUrl.length) out.subscriptionUrl = a.subscriptionUrl
      return out
    }

    //#endregion

    function fmtTime(ms) {
      if (!ms) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    /** 唯一的一张卡片：普通端 + 网页端，模式开关切换。 */
    function Card(props) {
      const t = props.t
      const [open, setOpen] = react.useState(false)
      const [mode, setMode] = react.useState('normal')
      const [status, setStatus] = react.useState(null)
      const [url, setUrl] = react.useState('')
      const [nodes, setNodes] = react.useState([])
      const [picked, setPicked] = react.useState('0')
      const [msg, setMsg] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [saved, setSaved] = react.useState(null)
      const [keptLonger, setKeptLonger] = react.useState(false)
      const [askClear, setAskClear] = react.useState(false)
      const [nonce, setNonce] = react.useState(0)

      /** 记住一份数据：本地镜像 + host 端落盘（host 端自己也是只增不减）。 */
      const remember = react.useCallback((patch) => {
        const merged = mergeAirport(readLocal(), patch)
        writeLocal(merged)
        setSaved(merged)
        setKeptLonger(Boolean(merged.keptLonger))
        return merged
      }, [])

      const refresh = react.useCallback(async () => {
        const s = await call('/status')
        if (s && s.__error) {
          setStatus(null)
          setMsg(t('unreachable'))
          // host 读不到时退回本地镜像，界面不至于空着
          const local = readLocal()
          if (local) {
            setSaved(local)
            if (local.subscriptionUrl) setUrl(local.subscriptionUrl)
            if (Array.isArray(local.nodes) && local.nodes.length) setNodes(local.nodes)
          }
          return
        }
        setStatus(s)
        const n = await call('/nodes')
        if (n && Array.isArray(n.nodes)) setNodes(n.nodes)
        if (s && s.store && (s.store.subscriptionUrl || (s.store.nodes || []).length)) {
          const merged = remember({
            subscriptionUrl: s.store.subscriptionUrl || '',
            nodes: s.store.nodes || [],
            savedAt: s.store.savedAt || 0,
          })
          if (merged.subscriptionUrl) setUrl((cur) => cur || merged.subscriptionUrl)
        } else {
          setSaved(readLocal())
        }
      }, [t, remember])

      react.useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      // 展开过一次后，本地镜像先顶上，避免闪烁
      react.useEffect(() => {
        const local = readLocal()
        if (local) {
          setSaved(local)
          if (local.subscriptionUrl) setUrl((cur) => cur || local.subscriptionUrl)
        }
      }, [])

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

      const onFetch = () =>
        run(async () => {
          const r = await call('/subscription', { url: url.trim() })
          if (r && Array.isArray(r.nodes)) {
            remember({ subscriptionUrl: url.trim(), nodes: r.nodes, savedAt: Date.now() })
          }
          return r
        })

      const doClear = async () => {
        if (!askClear) {
          setAskClear(true)
          setMsg(t('clearAsk'))
          window.setTimeout(() => setAskClear(false), 4000)
          return
        }
        setAskClear(false)
        setBusy(true)
        dropLocal()
        setSaved(null)
        setKeptLonger(false)
        setNodes([])
        setPicked('0')
        const r = await call('/clear', {})
        setMsg(r && r.__error ? r.__error : t('cleared'))
        await refresh()
        setBusy(false)
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

      // ---- 模式开关（一张卡片里的两端） ----
      const switcher = h(
        'div',
        { style: S.row, key: 'mode' },
        h('span', { style: S.label }, t('mode')),
        h(
          'button',
          { style: mode === 'normal' ? S.btnOn : S.btnOnIdle, onClick: () => setMode('normal') },
          t('modeNormal'),
        ),
        h('button', { style: mode === 'web' ? S.btnOn : S.btnOnIdle, onClick: () => setMode('web') }, t('modeWeb')),
      )

      const normal = [
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
          h('button', { style: S.btnMain, disabled: busy || !url.trim(), onClick: onFetch }, t('fetch')),
        ),
      ]

      if (nodes.length) {
        normal.push(
          h(
            'div',
            { style: S.row, key: 'nodes' },
            h('span', { style: S.label }, t('node')),
            h(
              'select',
              { style: S.select, value: picked, onChange: (e) => setPicked(e.target.value) },
              nodes.map((n, i) =>
                h(
                  'option',
                  { key: (n.index ?? i) + ':' + (n.server || ''), value: String(n.index ?? i) },
                  `${n.protocol} · ${n.name || n.server}`,
                ),
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
        normal.push(h('div', { style: S.hint, key: 'nonodes' }, t('noNodes')))
      }

      normal.push(
        h(
          'div',
          { style: S.row, key: 'statusrow' },
          h('button', { style: S.btn, disabled: busy, onClick: () => run(async () => (await call('/status')) || {}) }, t('refresh')),
          h(
            'span',
            { style: S.status },
            status
              ? `${t('status')}: ${status.coreRunning ? t('running') : t('noCore')} · 节点 ${status.nodeCount} · 并发 ${status.concurrency} · 工具 ${status.toolsAllowed ? 'on' : 'off'}`
              : t('loading'),
          ),
        ),
      )

      // ---- 保留的数据 + 清除 ----
      const savedLine = saved && (saved.subscriptionUrl || (saved.nodes || []).length)
        ? `${t('saved')}: ${(saved.nodes || []).length} 个节点 · ${fmtTime(saved.savedAt)}${keptLonger ? ' ' + t('keptLonger') : ''}`
        : t('savedNone')

      normal.push(h('div', { style: S.sep, key: 'sep' }))
      normal.push(
        h(
          'div',
          { style: S.row, key: 'saved' },
          h('span', { style: S.status }, savedLine),
          h(
            'button',
            { style: askClear ? S.btnDanger : S.btn, disabled: busy, onClick: doClear },
            askClear ? t('clearAsk') : t('clear'),
          ),
        ),
      )
      normal.push(h('div', { style: S.hint, key: 'hint' }, t('hint')))

      const web = [
        h(
          'div',
          { style: S.row, key: 'webbar' },
          h('button', { style: S.btn, onClick: () => setNonce(Date.now()) }, t('webReload')),
          h(
            'a',
            { style: { ...S.btn, textDecoration: 'none', display: 'inline-block' }, href: WEB_URL, target: '_blank', rel: 'noreferrer' },
            t('webOpen'),
          ),
          h('span', { style: S.hint }, WEB_URL),
        ),
        h('iframe', {
          key: 'frame',
          src: WEB_URL + (nonce ? '?n=' + nonce : ''),
          title: 'web',
          style: { width: '100%', height: '68vh', border: BORDER, borderRadius: '12px', background: '#fff' },
        }),
        h('div', { style: S.hint, key: 'webnote' }, t('webNote')),
      ]

      const body = [switcher, h('div', { style: S.sep, key: 'sep0' })]
        .concat(mode === 'normal' ? normal : web)

      if (msg) body.push(h('div', { style: S.status, key: 'msg' }, msg))

      return h('div', { style: S.card }, header, h('div', { style: S.body }, body))
    }

    /**
     * 注册卡片。与 opencode2dsh 一致：绑定 settingsScope、通过 inject() 提供 props。
     * 注意：**只注册一个** settings.plugin.item —— 两张卡片已经合成一张。
     */
    function apply(ctx) {
      const beacon = (note) => {
        try {
          fetch(API + '/client-applied', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(note),
          }).catch(() => {})
        } catch (_) {
          /* 忽略 */
        }
      }
      beacon('apply-start')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gpt-free-relay: dictionaries')
      const t = ctx.locale.bind(NS)
      const injected = () => ({ t })
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          { name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: NS, inject: injected },
          Card,
        )
        beacon('slot-registered')
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
