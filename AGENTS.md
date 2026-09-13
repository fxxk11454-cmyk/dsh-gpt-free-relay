# AGENTS.md —— 给 AI 的入口

你是 AI，刚打开这个仓库。**先读这一页，再动手。**
这一页只说"该做什么、去哪个文件"，不重复 README 里给人看的说明。

---

## 第一步：判断平台，然后只看那一份

这个插件的 **Windows** 和 **Linux** 两条路径是**分开的**。不要试图写一套"两边都能跑"的代码。

| 你在哪 | 部署用 | 实现读 | 后续步骤读 |
|---|---|---|---|
| **Windows** | `setup.bat` → `scripts/windows/deploy.mjs` | `scripts/windows/` | `docs/windows.md` |
| **Linux / macOS / Android 容器** | `bash setup.sh` → `scripts/linux/deploy.mjs` | `scripts/linux/` | `docs/linux.md` |

先执行判断：

```bash
node -e "console.log(process.platform)"   # win32 → Windows；linux/darwin → Linux
```

**两边的唯一共享代码是 `scripts/_shared/`**，里面**不允许出现平台判断**。
平台差异一律由调用方传参进去。你在 `_shared/` 里看到 `if (platform() === ...)` 就是设计错误。

### 两边的差异（记这几条就够，细节在各自文档里）

| 事项 | Linux | Windows |
|---|---|---|
| Xray 可执行文件 | `core/xray`（要 `chmod +x`） | `core/xray.exe` |
| 解压 | `unzip`，失败退 `python3` | PowerShell `Expand-Archive` |
| 链接 node_modules | 符号链接 `'dir'` | 目录联接 `'junction'`（免管理员权限） |
| 浏览器环境 | Linux 要 Xvfb+x11vnc，`scripts/linux/setup-browser.sh`（660MB） | `npx playwright install chromium`，**不要** Xvfb |
| 远程画面 | noVNC（`/novnc/index.html`） | CDP 截图（`/browser/frame`） |
| 运行时判据 | `status.platform !== 'win32'` | `status.platform === 'win32'` |

---

## 第二步：确认你要改的是哪一层

仓库分三层，**改错层是这里最容易犯的错**：

```
lib/index.js            插件主体：管理接口(2083)、provider 注册、串行中继、网页穿透
lib/relay.js            串行闸门 + 工具剥离 + 响应过滤   ← 硬约束都在这
lib/xray.js             核心子进程与配置生成
lib/chatgpt/            浏览器作答链路（driver/browser/webchat/session/bridge）
lib/client.js           浏览器端卡片（在 DSH 的「插件配置」页里渲染）
lib/vnc.js              远程画面（Linux 专用）
scripts/                部署脚本（见上面那张表）
core/                   Xray 二进制，不进仓库
```

### 两条硬约束 —— 改之前必须知道

这两个是本插件的存在理由，破坏它们等于改坏了：

1. **并发强制为 1**（`lib/relay.js` 的 `SerialGate`）。所有请求串行，
   必须等上一轮响应体**彻底写回**才放行下一个。
2. **不允许工具调用**（`lib/relay.js` 的 `stripTools` / `filterToolCalls`）。
   请求里的工具字段要剥掉，响应里的 `tool_calls` 也要过滤。

> 这里踩过一次坑：`stripTools` 原本**只删顶层 5 个键**，而 DSH 发多轮对话时
> 历史里带着 `assistant.tool_calls` 和 `role:"tool"` 的消息 —— 这些会原样透传，
> 模型于是看得见工具调用记录。现在改成了全键递归，见下面的测试。

---

## 第三步：改完必须验证

```bash
# 核心逻辑回归（57 项：工具剥离 / 串行闸门 / 响应过滤 / 订阅解析 /
#   配置生成 / 仓库结构 / provider 注册契约 / 生命周期）
node scripts/test-core.mjs

# 客户端卡片渲染回归（卡片是展开时才渲染的，里面有未定义变量会整张消失且不报错）
node scripts/test-client-render.mjs

# 语法
node --check lib/index.js
```

**改动碰上这两处时，测试是必须跑的**：`stripTools` / `filterToolCalls`、
以及任何动 `.ts` 文件的事（`lib/chatgpt/pow.ts` 等是 vendored 的，见下）。

---

## 几条硬规矩

1. **`lib/chatgpt/*.ts` 是 vendored 的，别改。**
   `pow.ts` / `turnstile.ts` / `sentinel.ts` 里的指纹数组会被哈希进 proof，
   改一个字符就校验失败。它们来自 pi-gpt v0.4.3（MIT），与上游保持一字不差
   是为了将来 diff 升级。Node 24 的类型剥离让你能直接 `import './pow.ts'` ——
   **必须带 `.ts` 后缀**，Node 的 ESM 解析不会自动补。

2. **不要自己起服务器验证 Web 改动。**
   本插件的卡片跑在 DSH 现有的 Web GUI 里。改了 `lib/client.js` 之后，
   该重启的是 DSH，不是另开一个端口。

3. **端口是固定的，别随手改**：2080 SOCKS / 2081 HTTP 入站 / 2082 串行中继 / 2083 管理接口。
   `lib/xray.js` 顶部是唯一出处。

4. **部署脚本不做网络假设。** 拉核心失败（国内访问 GitHub 不稳）只 warn，
   不能中断整个部署 —— 注册插件不依赖核心。

5. **别把 secrets 写进仓库。** 订阅地址、cookie、accessToken 都在
   `.runtime/` 与凭据库里，`.gitignore` 已经盖住。

---

## 快速自检

装好之后，管理接口可以问出全部状态：

```bash
curl -s 127.0.0.1:2083/status     # 核心是否在跑、节点数、并发、浏览器状态
curl -s 127.0.0.1:2083/browser    # 浏览器是否在跑、当前地址
curl -s 127.0.0.1:2083/config     # 实际生成的 Xray 配置 + 错误日志
```

完整端点清单在 README 的「命令行 / agent 驱动」一节。

---

## 给人看的文档在哪

- `README.md` —— 使用条件、免责声明、功能说明、端点清单
- `docs/linux.md` —— Linux 部署与排错
- `docs/windows.md` —— Windows 部署与排错

本页（`AGENTS.md`）只管"AI 该怎么做"。
