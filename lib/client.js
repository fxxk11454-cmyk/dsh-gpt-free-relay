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
    /**
     * 「网页端」直接加载**真站**，不经过本地代理。
     *
     * 用户明确要求：不要中转那一层。所以这里不再是 API + '/web/'，
     * 而是真实的 chatgpt.com —— 登录、验证都由浏览器自己处理。
     */
    /** 远程桌面查看页（host 端把容器里那块虚拟屏投过来） */
    const NOVNC_URL = API + '/novnc/index.html'
    /** 浏览器端的机场数据镜像 */
    const LS_KEY = 'dsh-gpt-free-relay.airport'

    const zh = {
      title: '机场中转',
      desc: '订阅解析 → 本地代理 → 让 DSH 走你的线路；并发强制 1，且不传工具调用。',
      mode: '模式',
      modeNormal: '普通端',
      modeVnc: '浏览器作答',
      webOpen: '在新标签打开',
      vncStart: '启动并打开 ChatGPT',
      vncReconnect: '重新连接',
      vncIdle: '浏览器还没启动 —— 点上面的「启动并打开 ChatGPT」，第一次要十几秒',
      formTitle: '表单操作（手机上用这个，画面只能看）',
      formRefresh: '刷新表单',
      formFill: '填入',
      formClick: '点击',
      formEmpty: '页面上没找到可填的输入框或按钮 —— 点「刷新表单」或先等页面加载完',
      formFilled: '已填入',
      formClicked: '已点击',
      formNoRun: '请先启动浏览器',
      vncNote: '这是容器里真实运行的 Chromium。中转会像人一样在里面打字、点发送、读回答 —— 自带登录态，不需要 token，上游怎么改都不影响。先点下面的「键盘」按钮登录一次。',
      sub: '订阅地址',
      fetch: '拉取并解析',
      node: '节点',
      model: '模型',
      connect: '连接',
      disconnect: '断开',
      refresh: '刷新状态',
      status: '状态',
      hint: '并发：强制 1（必须等上一轮回答写完） · 工具调用：已关闭 · 机场数据默认保留 · 型号统一为 free-chat，只在中转里映射一次',
      noCore: '核心未运行',
      running: '核心运行中',
      noNodes: '（暂无节点，请先拉取订阅）',
      loading: '读取中…',
      unreachable: '读不到插件服务（host 端未启动，或端口 2083 被占用）',
      ok: '完成',
      working: '处理中…',
      saved: '已保留数据',
      cgOk: '浏览器已登录',
      cgNo: '浏览器未登录 —— 点「启动并打开 ChatGPT」，再用「键盘」按钮登录',
      cgRefresh: '刷新登录态',
      cgClear: '清空会话',
      cgChallenge: '被 Cloudflare 拦住了 —— 切到「网页端」，按页面提示点一下验证，过后凭证会自动存下来',
      cgGoWeb: '去浏览器里过验证',
      cgRetry: '我过完了，重新检测',
      cgModel: '网页模型',
      cgLocal: '请求本地处理',
      savedNone: '还没有保留任何机场数据',
      keptLonger: '（本次结果更短，已保留原先更长的一份）',
      clear: '清除数据',
      clearAsk: '再点一次确认清除',
      cleared: '已清除数据',
    }
    const en = {
      title: 'Relay',
      desc: 'Subscription → local proxy → route DSH through your line; concurrency forced to 1, no tool calls.',
      mode: 'Mode',
      modeNormal: 'Direct',
      modeVnc: 'Browser',
      webOpen: 'Open in new tab',
      vncStart: 'Start & open ChatGPT',
      vncReconnect: 'Reconnect',
      vncIdle: 'Browser not started yet — hit “Start & open ChatGPT” above; the first run takes ~15s',
      formTitle: 'Form controls (use these on a phone — the screen is view-only)',
      formRefresh: 'Refresh fields',
      formFill: 'Fill',
      formClick: 'Click',
      formEmpty: 'No fields or buttons found — hit “Refresh fields”, or wait for the page to load',
      formFilled: 'Filled',
      formClicked: 'Clicked',
      formNoRun: 'Start the browser first',
      vncNote: 'A real Chromium in the container. The relay types, sends and reads like a human — no token needed. Sign in once with the keyboard button below.',
      sub: 'Subscription URL',
      fetch: 'Fetch & parse',
      node: 'Node',
      model: 'Model',
      connect: 'Connect',
      disconnect: 'Disconnect',
      refresh: 'Refresh',
      status: 'Status',
      hint: 'Concurrency: forced to 1 · Tool calls: disabled · Airport data kept by default · Model unified as free-chat, mapped once in the relay',
      noCore: 'Core not running',
      running: 'Core running',
      noNodes: '(no nodes yet — fetch the subscription first)',
      loading: 'Loading…',
      unreachable: 'Cannot reach the plugin service (host half down, or port 2083 taken)',
      ok: 'Done',
      working: 'Working…',
      saved: 'Kept data',
      cgOk: 'Browser signed in',
      cgNo: 'Browser not signed in — start it, then sign in with the keyboard button',
      cgRefresh: 'Refresh sign-in',
      cgClear: 'Clear session',
      cgChallenge: 'Blocked by Cloudflare — switch to the Web tab, complete the check there, the pass is saved automatically',
      cgGoWeb: 'Open the browser tab',
      cgRetry: 'Done, re-check',
      cgModel: 'Web model',
      cgLocal: 'Requests handled locally',
      savedNone: 'No airport data kept yet',
      keptLonger: '(this result was shorter — the longer earlier one was kept)',
      clear: 'Clear data',
      clearAsk: 'Click again to confirm',
      cleared: 'Data cleared',
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
      const [mode, setMode] = react.useState('vnc')
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
      const [siteInput, setSiteInput] = react.useState('')
      const [vncNonce, setVncNonce] = react.useState(0)
      const [form, setForm] = react.useState(null)
      const [formMsg, setFormMsg] = react.useState('')
      const [drafts, setDrafts] = react.useState({})

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

      // 切到某个模式时也刷一次，否则 running 这类状态是上一次的旧值
      react.useEffect(() => {
        if (open) refresh()
      }, [open, mode, refresh])

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
        h('button', { style: mode === 'vnc' ? S.btnOn : S.btnOnIdle, onClick: () => setMode('vnc') }, t('modeVnc')),
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
              ? `${t('status')}: ${status.coreRunning ? t('running') : t('noCore')} · 节点 ${status.nodeCount} · 并发 ${status.concurrency} · 工具 ${status.toolsAllowed ? 'on' : 'off'}${status.relay && status.relay.modelAlias ? ` · ${t('model')} ${status.relay.modelAlias} → ${status.relay.upstreamModel}` : ''}`
              : t('loading'),
          ),
        ),
      )

      // ---- 网页端登录态：模型请求全靠它，所以要显眼 ----
      const cg = status && status.chatgpt
      const brNow = (status && status.browser) || {}
      // 登录态以浏览器为准 —— 它才是实际作答的那条路
      const loggedIn = Boolean(cg && (cg.browserLoggedIn || cg.loggedIn))
      const email = (cg && (cg.browserEmail || cg.email)) || ''
      normal.push(
        h(
          'div',
          { style: S.row, key: 'chatgpt' },
          h('span', { style: S.label }, t('cgLocal')),
          h(
            'span',
            { style: loggedIn ? S.status : { ...S.status, color: 'var(--dsw-alias-state-warning-primary, #d08700)' } },
            cg
              ? loggedIn
                ? `${t('cgOk')}${email ? `（${email}）` : ''}`
                : brNow.running
                  ? t('cgNo')
                  : t('formNoRun')
              : t('loading'),
          ),
          h(
            'button',
            {
              style: S.btn,
              disabled: busy,
              onClick: () =>
                run(async () => {
                  const r = await call('/chatgpt/refresh', { force: true })
                  if (r && r.error) return r
                  return r
                }),
            },
            t('cgRefresh'),
          ),
          h(
            'button',
            { style: S.btn, disabled: busy, onClick: () => run(() => call('/session/clear', {})) },
            t('cgClear'),
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

      // ---- 站点切换：不同人说的"官方站"不是同一个地方 ----
      // ---- 有头浏览器：容器里真跑的 Chromium，用 noVNC 投到卡片上 ----
      // br 是这张卡片里所有浏览器相关 UI 的数据源（是否在跑、当前地址、查看页地址）
      const br = (status && status.browser) || {}
      const vnc = [
        h(
          'div',
          { style: S.row, key: 'vncbar' },
          h(
            'button',
            {
              style: S.btnMain,
              disabled: busy,
              onClick: () => run(async () => {
                const r = await call('/browser/start', {})
                setVncNonce(Date.now())
                return r
              }),
            },
            t('vncStart'),
          ),
          h('button', { style: S.btn, onClick: () => setVncNonce(Date.now()) }, t('vncReconnect')),
          h(
            'a',
            { style: { ...S.btn, textDecoration: 'none', display: 'inline-block' }, href: br.viewerUrl || NOVNC_URL, target: '_blank', rel: 'noreferrer' },
            t('webOpen'),
          ),
          h(
            'span',
            { style: S.hint },
            br.running ? `运行中 · ${br.url || ''}` : '未启动',
          ),
        ),
        // 只有浏览器真在跑才嵌查看页。
        // 否则 iframe 一展开就连上一个没有画面的 VNC，表现是永远卡在加载 —— 这正是之前的毛病。
        br.running
          ? h('iframe', {
              key: 'vnc',
              src: (br.viewerUrl || NOVNC_URL) + (vncNonce ? '?n=' + vncNonce : ''),
              title: 'vnc',
              style: { width: '100%', height: '68vh', border: BORDER, borderRadius: '12px', background: '#000' },
            })
          : h(
              'div',
              {
                key: 'vncempty',
                style: {
                  height: '26vh',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: BORDER,
                  borderRadius: '12px',
                  background: 'var(--dsw-alias-bg-layer-1, transparent)',
                  fontSize: '13px',
                  opacity: 0.7,
                  textAlign: 'center',
                  padding: '0 16px',
                },
              },
              t('vncIdle'),
            ),
        h('div', { style: S.hint, key: 'vncnote' }, t('vncNote')),
      ]

      // ---- 表单面板：手机上没有键盘，靠这个输入 ----
      const loadForm = () =>
        run(async () => {
          const r = await call('/browser/inputs')
          if (r && !r.__error && !r.error) setForm(r)
          else setForm(null)
          return r
        })

      const formPanel = [
        h(
          'div',
          { style: S.row, key: 'formbar' },
          h('span', { style: S.label }, t('formTitle')),
          h(
            'button',
            { style: S.btn, disabled: busy || !br.running, onClick: loadForm },
            t('formRefresh'),
          ),
        ),
        formMsg ? h('div', { style: S.status, key: 'formmsg' }, formMsg) : null,
      ]

      if (!br.running) {
        formPanel.push(h('div', { style: S.hint, key: 'formoff' }, t('formNoRun')))
      } else if (!form || !Array.isArray(form.items) || !form.items.length) {
        formPanel.push(h('div', { style: S.hint, key: 'formnone' }, t('formEmpty')))
      } else {
        formPanel.push(
          h(
            'div',
            { key: 'formlist', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            ...form.items.map((it) =>
              it.kind === 'input'
                ? h(
                    'div',
                    { style: S.row, key: 'i' + it.idx },
                    h(
                      'span',
                      { style: { ...S.label, minWidth: '88px', flex: '0 0 auto' } },
                      `${it.placeholder || it.name || it.type}`,
                    ),
                    h('input', {
                      style: S.input,
                      type: it.type === 'password' ? 'password' : 'text',
                      value: drafts[it.idx] || '',
                      placeholder: it.placeholder || it.type,
                      onChange: (e) => setDrafts((d) => ({ ...d, [it.idx]: e.target.value })),
                    }),
                    h(
                      'button',
                      {
                        style: S.btnMain,
                        disabled: busy,
                        onClick: () =>
                          run(async () => {
                            const r = await call('/browser/fill', { idx: it.idx, text: drafts[it.idx] || '' })
                            if (r && !r.__error && !r.error) setFormMsg(t('formFilled'))
                            return r
                          }),
                      },
                      t('formFill'),
                    ),
                  )
                : h(
                    'div',
                    { style: S.row, key: 'b' + it.idx },
                    h(
                      'button',
                      {
                        style: S.btn,
                        disabled: busy,
                        onClick: () =>
                          run(async () => {
                            const r = await call('/browser/click', { idx: it.idx })
                            if (r && r.inputs) setForm(r.inputs)
                            if (r && !r.__error && !r.error) setFormMsg(t('formClicked'))
                            return r
                          }),
                      },
                      `${t('formClick')} ${it.label}`,
                    ),
                  ),
            ),
          ),
        )
      }

      /**
       * 被 Cloudflare 挑战时的横幅。
       *
       * 刻意**不做任何自动处理** —— 挑战是给人过的，浏览器里点一下就好。
       * 这里只负责把话说清楚，并一键把你送到能过验证的地方。
       */
      const needClearance = Boolean(cg && (cg.challengedAt || !cg.hasClearance))
      const banner = !needClearance
        ? null
        : h(
            'div',
            {
              key: 'banner',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(208,135,0,0.45)',
                background: 'rgba(208,135,0,0.10)',
              },
            },
            h('span', { style: { fontSize: '13px', lineHeight: 1.5, flex: '1 1 220px' } }, `⚠️ ${t('cgChallenge')}`),
            mode === 'normal'
              ? h('button', { style: S.btnMain, onClick: () => setMode('vnc') }, t('cgGoWeb'))
              : h(
                  'button',
                  { style: S.btn, disabled: busy, onClick: () => run(async () => (await call('/status')) || {}) },
                  t('cgRetry'),
                ),
          )

      const body = [switcher, h('div', { style: S.sep, key: 'sep0' })]
        .concat(banner ? [banner] : [])
        .concat(mode === 'vnc' ? formPanel : [])
        .concat(mode === 'normal' ? normal : vnc)

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
