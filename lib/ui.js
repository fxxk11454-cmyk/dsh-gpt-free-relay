/**
 * 插件自带的网页控制台（方便调试）。
 *
 * 打开 http://127.0.0.1:2083/ 即可：看状态、拉订阅、选节点、连接/断开，
 * 全部走同一套管理接口，和 agent 用 curl 驱动的是同一个后端。
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPT Free 中转 · 控制台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #eaf1ff; background: #070a14;
    background-image:
      radial-gradient(60% 50% at 20% 15%, rgba(91,124,250,.28), transparent 70%),
      radial-gradient(55% 45% at 85% 30%, rgba(155,107,255,.24), transparent 70%),
      radial-gradient(60% 50% at 35% 85%, rgba(47,212,198,.18), transparent 70%);
    background-attachment: fixed;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { opacity: .62; font-size: 12.5px; margin-bottom: 18px; }
  .card {
    border: 1px solid rgba(255,255,255,.14);
    background: linear-gradient(160deg, rgba(255,255,255,.10), rgba(255,255,255,.04));
    border-radius: 16px; padding: 16px; margin-bottom: 14px;
    backdrop-filter: blur(14px);
  }
  .card h2 { font-size: 13px; font-weight: 600; opacity: .8; margin: 0 0 12px; letter-spacing: .02em; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .row:last-child { margin-bottom: 0; }
  label { font-size: 12px; opacity: .68; min-width: 60px; }
  input, select {
    flex: 1 1 220px; min-width: 0; font: inherit; font-size: 13px;
    padding: 9px 11px; border-radius: 10px; color: inherit;
    border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06);
  }
  input:focus, select:focus { outline: 2px solid rgba(122,162,255,.5); outline-offset: 1px; }
  button {
    font: inherit; font-size: 13px; cursor: pointer;
    padding: 9px 15px; border-radius: 10px; color: #eaf1ff;
    border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08);
    transition: filter .15s, background .15s;
  }
  button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  button.primary {
    font-weight: 600; color: #0b1020; border-color: transparent;
    background: linear-gradient(90deg, #7aa2ff, #a98bff);
  }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .pill { font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); }
  .ok { color: #7ee2a8; border-color: rgba(126,226,168,.4); }
  .off { color: #ffb4b4; border-color: rgba(255,180,180,.35); }
  pre {
    margin: 8px 0 0; padding: 12px; border-radius: 10px; overflow: auto; max-height: 320px;
    font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
    background: rgba(0,0,0,.34); border: 1px solid rgba(255,255,255,.10);
  }
  .hint { font-size: 11.5px; opacity: .55; margin-top: 10px; }
  .msg { font-size: 12.5px; min-height: 18px; margin-top: 8px; opacity: .85; }
</style>
</head>
<body>
<div class="wrap">
  <h1>GPT Free 中转 · 控制台</h1>
  <div class="sub">本地调试面板 · 与 agent 的 curl 驱动同一套接口 · <a style="color:#9fb0cc" href="/status">/status</a></div>

  <div class="card">
    <h2>运行状态</h2>
    <div class="row" id="pills"></div>
    <button onclick="refresh()">刷新状态</button>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <h2>机场订阅</h2>
    <div class="row">
      <label>订阅地址</label>
      <input id="url" placeholder="https://…/api/v1/client/subscribe?token=…">
      <button class="primary" onclick="fetchSub()">拉取并解析</button>
    </div>
    <div class="row">
      <label>节点</label>
      <select id="node"></select>
      <button class="primary" onclick="connect()">连接</button>
      <button onclick="disconnect()">断开</button>
    </div>
    <div class="hint">拉取失败时状态里会给出识别到的格式与响应开头，便于判断订阅是否受支持。</div>
  </div>

  <div class="card">
    <h2>模型注册</h2>
    <div class="row">
      <button onclick="publish()">重新发布 provider 到「模型」区</button>
    </div>
    <div class="hint">把本地串行代理注册成 llm-pi-ai 的 provider（baseURL 指向本机 2082），模型区即可选用。</div>
  </div>

  <div class="card">
    <h2>原始状态</h2>
    <pre id="raw">…</pre>
  </div>
</div>

<script>
let nodes = [];
const $ = (id) => document.getElementById(id);
const msg = (s) => { $('msg').textContent = s; };

async function api(path, body) {
  try {
    const r = await fetch(path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    } : undefined);
    return await r.json();
  } catch (e) { return { error: String(e && e.message || e) }; }
}

function pills(s) {
  const box = $('pills'); box.innerHTML = '';
  const add = (text, cls) => {
    const el = document.createElement('span');
    el.className = 'pill ' + (cls || ''); el.textContent = text; box.appendChild(el);
  };
  add(s.coreRunning ? '核心运行中' : '核心未运行', s.coreRunning ? 'ok' : 'off');
  add('节点 ' + s.nodeCount);
  add('并发 ' + s.concurrency + '（强制）', 'ok');
  add('工具调用 ' + (s.toolsAllowed ? 'on' : 'off'), s.toolsAllowed ? 'off' : 'ok');
  add('设置命名空间 ' + (s.settingsRegistered ? '已注册' : '未注册'), s.settingsRegistered ? 'ok' : 'off');
  add('provider: ' + s.providerId);
  if (s.selected) add('当前 ' + s.selected.protocol + ' · ' + (s.selected.name || s.selected.server));
}

async function refresh() {
  const s = await api('/status');
  if (s && s.error) { msg('读不到服务: ' + s.error); return; }
  pills(s);
  $('raw').textContent = JSON.stringify(s, null, 2);
  const n = await api('/nodes');
  if (n && Array.isArray(n.nodes)) {
    nodes = n.nodes;
    const sel = $('node'); const keep = sel.value; sel.innerHTML = '';
    if (!nodes.length) {
      const o = document.createElement('option'); o.textContent = '（暂无节点，请先拉取订阅）'; sel.appendChild(o);
    } else {
      nodes.forEach((x) => {
        const o = document.createElement('option');
        o.value = String(x.index);
        o.textContent = x.protocol + ' · ' + (x.name || x.server);
        sel.appendChild(o);
      });
      if (keep) sel.value = keep;
    }
  }
}

async function fetchSub() {
  const url = $('url').value.trim();
  if (!url) { msg('请先填订阅地址'); return; }
  msg('拉取中…');
  const r = await api('/subscription', { url });
  msg(r.error ? ('失败：' + r.error) : ('成功：' + (r.detail || '') ));
  await refresh();
}

async function connect() {
  msg('连接中…');
  const r = await api('/connect', { index: Number($('node').value || 0) });
  msg(r.error ? ('失败：' + r.error) : ('已连接 ' + JSON.stringify(r.node || {})));
  await refresh();
}

async function disconnect() {
  await api('/disconnect');
  msg('已断开');
  await refresh();
}

async function publish() {
  msg('发布中…');
  const r = await api('/publish-provider', {});
  msg(r.error ? ('失败：' + r.error) : ('已发布 provider: ' + r.providerId));
  await refresh();
}

refresh();
</script>
</body>
</html>`
