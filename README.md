# dsh-gpt-free-relay

DSH 插件。把机场订阅解析出来，在本地起一个串行反向代理，让 DSH 的模型请求走你的线路。从 Android 版 [GPT Free 代理](https://github.com/fxxk11454-cmyk/gpt-free-relay) 移植。

当前版本：`v1.1.0-beta`

> 本项目由 AI 直接产出：代码、文档与提交信息都是 AI 写的。测试做过，但疏漏难免，用之前请自己看一遍源码。

**你要装它？** 看[一键部署](#一键部署)：Linux 用 `bash setup.sh`，Windows 用 `setup.bat`。
**你是 AI/在改这个仓库？** 先读 [`AGENTS.md`](AGENTS.md) —— 那一页只说该做什么、去哪个文件。

---

## 先说清楚

1. 它不提供任何服务。没有代理服务器、没有机场订阅、没有 ChatGPT 账号、没有 API Key，全部自备。
2. "Free" 说的是软件免费开源，不表示用 GPT 免费。
3. 它会自动化操作 ChatGPT 网页。这可能违反 OpenAI 的服务条款，账号有被封的风险。
4. 用之前请读[使用条件](#使用条件)和[免责声明](#免责声明)。

---

## 使用条件

下面七条缺一条就跑不起来。

1. 自备 ChatGPT 账号。插件不含账号，默认那条链路完全依赖你在浏览器里登录的那个号。
2. 网络能到 chatgpt.com。要么你自己能直连，要么有可用的代理或机场订阅。插件不提供线路。
3. 自备 Xray 核心。走机场线路时需要，仓库不分发，见[手动安装](#手动安装)。
4. 装浏览器环境，约 660MB：`bash setup.sh`（Linux）或 `setup.bat`（Windows）。
5. 能跑带界面的 Linux。依赖 Xvfb、Chromium、x11vnc。纯容器或无 X 环境得自己想办法。
6. 接受它随时失效。靠的是 ChatGPT 网页版，上游一改版就坏。
7. 只限个人自用。别拿去多账号分发、转卖，或对外提供接口。

如果你的场景要求 7×24 稳定可用、要上生产、要给他人提供 API，或者你无法承担账号风险，那不适合用这个。

---

## 它做什么

两条出网链路，默认走第二条。

### 链路一：机场线路

```
DSH 请求 ──► 本地串行反向代理(127.0.0.1:2082) ──► Xray(HTTP 入站 2081)
                                                    ──► 你的机场线路 ──► 上游 API
```

需要你自己有上游 API 和 Key。Android 版的 `core/ChatClient.kt` 走的就是这条，一共 110 行，做的就是"经 SOCKS 代理 POST 到 `baseUrl/chat/completions`"。

### 链路二：浏览器作答（默认，不需要 API Key）

中转像人一样操作 ChatGPT 页面：把消息打进输入框、点发送、把回答读回来。

```
DSH 请求 ──► 串行闸门(并发 1) ──► 真 Chromium：打字 → 发送 → 读回答 ──► OpenAI chunk ──► DSH
```

不走后端接口，原因是实测下来走不通：直接调 `/backend-api/*` 需要 accessToken 和 Sentinel proof，而且 Node 的 fetch 访问 chatgpt.com 一律被 Cloudflare 回 `cf-mitigated: challenge`。补全套浏览器特征头也没用，因为被判定的是连接本身。

| 请求方 | 结果 |
|---|---|
| Node fetch | `403` + `cf-mitigated: challenge` |
| 真 Chromium（有头） | `200`，无挑战，页面完整渲染 |

这条链路的结构：

```
容器
 ├─ Xvfb（虚拟屏 :99）
 ├─ Chromium（headless: false，直连真域名，不做本地 MITM）
 └─ x11vnc ──► WebSocket 桥 ──► 卡片里的 noVNC
```

几个取舍：

- 用有头模式而非 headless。两者的指纹不同，Cloudflare 分得出来。
- 不做本地 MITM，浏览器的 TLS/HTTP2 指纹都是真的。
- 默认直连，不挂出口代理，少一层就少一类故障。要走出网代理的话，把 `lib/chatgpt/browser.js` 里的 `AIRPORT_PROXY` 传给 `proxy`。
- 自带登录态，不需要 accessToken，也不碰 Sentinel。
- 手机上登录用画面右下角的「键盘」按钮唤出软键盘。

Xray 那边本来就是全局的：生成的配置里 `routing.rules` 是空的，所有流量都走 `proxy` 出站，没有分流规则要关。

装浏览器环境时踩过两个这个 Android 容器特有的坑：

- `dpkg` 里登记了外来架构 `amd64`，apt 于是去 ubuntu-ports 找 `binary-amd64`，全 404。
- `x11vnc` 默认监听 IPv6，还用 SysV 共享内存，容器里两样都没有，启动就退出。必须加 `-no6 -noshm`。

### 两条硬约束

**并发强制为 1。** 所有请求进同一条串行队列，必须等上一轮回答彻底写回客户端，下一个才放行。不是"排队发出"，是同一时刻只有一个在跑。两条链路都过这道闸门。

**不允许工具调用。** 链路一把请求体里的 `tools`、`tool_choice`、`functions`、`function_call`、`parallel_tool_calls` 全剥掉，响应流里的 `tool_calls` 也过滤。链路二的输出是本插件自己拼的 OpenAI chunk，本来就不含 `tool_calls`，不靠过滤。

---

## 一键部署

Windows 与 Linux 是**两套分开的脚本**，各自独立，互不牵连。

| 系统 | 入口 | 实现 | 说明 |
|---|---|---|---|
| Linux / macOS / Android 容器 | `bash setup.sh` | `scripts/linux/` | [docs/linux.md](docs/linux.md) |
| Windows | `setup.bat` | `scripts/windows/` | [docs/windows.md](docs/windows.md) |

两边只共享 `scripts/_shared/`（注册逻辑与无平台判断的公共能力）。
拿着 Linux 脚本去 Windows 跑（或反过来）会**明确报错并告诉你去用哪个**，不会静默跑歪。

```bash
# Linux 完整部署
bash setup.sh

# 不装浏览器环境（只用机场线路，省 660MB）
bash setup.sh --no-browser

# 指定 profile
bash setup.sh --profile web

# 只看会做什么，不改动任何东西
bash setup.sh --dry-run
```

```bat
rem Windows
setup.bat
setup.bat --no-browser
setup.bat --dry-run
```

Windows 的远程画面是另一套实现。那上面没有 Xvfb 和 x11vnc，VNC 起不来，所以改用 CDP 截图加输入注入，走 Playwright 原生能力：画面是一张定时刷新的图，点它会换算成视口坐标发回去点击，另有输入框敲字。Linux 和 macOS 不受影响，仍然走 Xvfb + x11vnc + noVNC。两套按 `status.platform` 分流，互不干扰。

脚本依次做四件事：检测环境（系统、Node 版本、profile、已装内容），拉取 Xray 核心（按平台自动选包），安装浏览器环境，注册进 DSH profile。

部署完重启 DSH，打开「通用设置 → 插件 → 插件配置」，应该能看到「机场中转」卡片。

---

## 手动安装

不想用脚本就手动来：

```bash
# 1) 拉取核心（不随仓库分发）
bash scripts/linux/fetch-core.sh          # Linux
# Windows 用 scripts\windows\deploy.mjs，它会自动拉 Windows 构建

# 2) 装进 DSH 的某个 profile
node scripts/_shared/register-plugin.mjs \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web" \
  "$(pwd)"
```

## 使用

### 图形界面

装好后在「通用设置 → 插件 → 插件配置」里会多出一张可展开的「机场中转」卡片。就这一张，两端用卡片顶部的模式开关切换。

普通端里是订阅地址和节点：填地址、拉取并解析、选节点、连接或断开，状态行显示核心是否在跑、节点数、并发（恒为 1）、工具调用（off），以及登录态和「刷新登录态」。

浏览器作答里是那块虚拟屏的画面（noVNC）、「键盘」按钮（手机上唤软键盘），还有表单面板（刷新表单、填入、点击）。

登录态取自浏览器。启动浏览器后在画面里登录一次，回普通端点「刷新登录态」，插件会直接从浏览器读会话 cookie 换 accessToken。

插件启动时会自动把反代和浏览器一并拉起，并同步一次登录态，不用每次手动点。想关掉自动启浏览器，配 `autoBrowser: false`。

#### 机场数据是保留的

订阅地址和节点列表不会因为刷新页面或重启 DSH 就丢。浏览器端存一份镜像（localStorage），host 端存一份落盘文件（插件目录下 `.runtime/airport.json`）。

两份都遵守同一条合并规则：只增不减。某次拉取只拿到 3 个节点、上次拿到了 30 个的时候，会保留更长的那 30 个，界面上提示「本次结果更短，已保留原先更长的一份」。避免一次抽风的订阅把节点列表冲掉。

要彻底抹掉就在卡片里点「清除数据」，需连点两次确认。它会断开连接、清空节点、删掉落盘文件，并清掉浏览器镜像。

### 命令行 / agent 驱动

插件提供本地管理接口，agent 可以直接 curl 驱动：

```bash
# 状态
curl -s 127.0.0.1:2083/status

# 拉取并解析订阅
curl -s -X POST 127.0.0.1:2083/subscription -d '{"url":"你的订阅地址"}'

# 查看节点
curl -s 127.0.0.1:2083/nodes

# 连接（按序号或节点名；不传则用第一个）
curl -s -X POST 127.0.0.1:2083/connect -d '{"index":0}'

# 断开
curl -s -X POST 127.0.0.1:2083/disconnect

# 当前保留的机场数据（含落盘路径与保存时间）
curl -s 127.0.0.1:2083/airport

# 清除保留的数据
curl -s -X POST 127.0.0.1:2083/clear

# 浏览器：状态 / 启动 / 停止 / 截图
curl -s 127.0.0.1:2083/browser
curl -s -X POST 127.0.0.1:2083/browser/start
curl -s 127.0.0.1:2083/browser/session      # 浏览器里是否已登录

# 浏览器表单：列出输入框与按钮 / 代填 / 点击
curl -s 127.0.0.1:2083/browser/inputs
curl -s -X POST 127.0.0.1:2083/browser/fill  -d '{"idx":0,"text":"你好"}'
curl -s -X POST 127.0.0.1:2083/browser/click -d '{"idx":3}'

# 登录态：从浏览器取 cookie 并换 accessToken
curl -s 127.0.0.1:2083/chatgpt
curl -s -X POST 127.0.0.1:2083/chatgpt/refresh -d '{"force":true}'

# 本地处理开关（关掉就回到走机场线路的老路径）
curl -s -X POST 127.0.0.1:2083/chatgpt/toggle -d '{"useWebSession":false}'

# 拿一句话试跑浏览器作答，直接看通不通
curl -s -X POST 127.0.0.1:2083/chatgpt/test -d '{"prompt":"只回复两个字：正常"}'

# 查看实际生成的 Xray 配置与错误日志
curl -s 127.0.0.1:2083/config
```

### 让 DSH 的模型走这条线路

插件启动时会自动把一个叫 `gpt-free-relay` 的 provider 写进 `llm-pi-ai`，「模型」区据此显示。它指向的 baseURL 是本地串行代理：

```yaml
llm-pi-ai:
  providers:
    gpt-free-relay:
      displayName: Free Chat
      api: openai-completions
      baseURL: http://127.0.0.1:2082/v1
      apiKeyEnv: GPT_FREE_RELAY_API_KEY   # 凭据名，值由插件写进凭据库
      models:
        - id: free-chat                   # 只暴露这一个统一入口
```

#### 为什么只留一个 `free-chat`

网页版的型号一直在变，今天叫 gpt-4o，明天可能就换别的。把 `gpt-4o`、`gpt-4.1-mini` 这种列表写进配置，上游一更新列表就成了过期信息。

所以这里收敛成一个稳定的别名 `free-chat`，真型号在整个链路里只出现一次：

```
DSH 发 model=free-chat ──► 中转改写 ──► 上游收到 model=gpt-4o-mini
```

要换上游型号只改一处，插件配置里的 `upstreamModel`，默认 `gpt-4o-mini`。中转只替换完全相等的别名，客户端如果直接点名真实型号（比如 `gpt-4o`），会原样透传。

卡片状态行会实时显示当前映射，比如 `模型 free-chat → gpt-4o-mini`。

写 provider 配置时有两个坑：

1. provider profile 没有 `apiKey` 字段，只有 `apiKeyEnv`，那是个凭据引用名。写明文 `apiKey` 属于未知键，整条 profile 落不了盘，表现就是「模型区里什么都没有」。
2. `apiKeyEnv` 指向的凭据必须存在且非空，空值会被当成"未配置"。插件会自动写入这个凭据，值只是占位，真正的上游 Key 由代理链路注入。

需要临时换入口名，或者一次给多个：

```bash
curl -s -X POST 127.0.0.1:2083/publish-provider -d '{"models":["free-chat"]}'
```

转发时序：

```
DSH ──► 127.0.0.1:2082（串行，并发 1）──► Xray ──► 机场 ──► 上游
```

并发被强制为 1，DSH 侧的多路请求会自然排队，不会把上游打爆。

---

## 验证

```bash
# 核心逻辑回归 —— 56 项
node scripts/test-core.mjs
```

覆盖五块：工具调用剥离（含嵌套）、串行闸门、响应过滤、订阅解析、
Xray 配置生成（本机有核心时会真的跑一次 `xray -test`）。

```bash
# 订阅解析单独跑
node --input-type=module -e "import('./lib/subscription.js').then(m => console.log(m.parseSubscription(process.argv[1])))" "proxies:
  - {name: n, type: vmess, server: 1.2.3.4, port: 443, uuid: 11111111-2222-3333-4444-555555555555}"
```

实测结果：

| 项 | 结果 |
|---|---|
| 核心逻辑回归 | 56/56 通过 |
| Clash 区块 + 缩进 + 流式解析 | 通过 |
| base64 → URI / vmess JSON | 通过 |
| 配置生成 → `xray -test` | `Configuration OK.` |
| 串行闸门峰值并发 | 1 |
| 嵌套工具字段剥离 | 请求里 `tool_calls` / `role:tool` / `tool_result` 全部清除 |

客户端卡片另有一份渲染回归，跑 `node scripts/test-client-render.mjs`，覆盖折叠态与 5 种展开场景。写它是因为卡片是展开时才渲染主体的，里面一旦有未定义变量，React 会把整张卡卸载，界面上还不报错，只看到卡片消失。

---

## 与 Android 版的差异

Android 版的 `core/ChatClient.kt` 只有 110 行，经 `127.0.0.1:<port>` 的 SOCKS 代理 POST 到 `baseUrl/chat/completions`，与本插件的链路一思路一致。浏览器作答是本插件新增的，Android 版没有。

| 能力 | Android 版 | 本插件 |
|---|---|---|
| 订阅解析（Clash / base64 / URI） | 有 | 完整移植 |
| 协议：vmess / vless(REALITY) / trojan / ss | 有 | 有 |
| 本地代理（Xray 子进程） | 有 | 有 |
| 接口模式（OpenAI 兼容流式） | 有 | 由串行反向代理承担 |
| 诊断（配置 + 日志） | 有 | `/config` |
| 网页模式（WebView + DOM 转发） | 有 | 换成了「浏览器作答」：容器里真跑的 Chromium（Xvfb + noVNC），不是 WebView |
| 安卓 UI（极光玻璃） | 有 | 没有对应物，改为本地管理接口 |

---

## 已知限制

- 浏览器链路依赖 ChatGPT 的前端结构，上游改版会导致选择器失效，得跟着改。
- 浏览器链路慢，要等页面渲染和打字，比直接调接口慢得多。
- 需要浏览器环境，约 660MB。Linux 还要 Xvfb 和 x11vnc；Windows 不用（走 CDP 截图）。
- 手机上的 VNC 画面只能看，输入要靠右下角「键盘」按钮唤出的软键盘，或者用表单面板在原生输入框里打字。
- Xray 不支持 hysteria2 和 tuic，选中这类节点时接口会明确报错。
- 吞吐只有 1，这是需求方明确要求的约束，不是性能缺陷。
- 浏览器默认直连，不挂出口代理（见 `lib/chatgpt/browser.js` 顶部说明）。要挂就配 `browserProxy`。

### 已知 bug 的状态

这一轮把积累的 bug 基本清掉了，下面是修过的几条：

- **浏览器作答一直打不进字**：`keyboard.type` 遇到 `\n` 会按 Enter，而 ChatGPT 里 Enter 就是发送。每次带 system 提示的请求都因此被拆成两条提前发出去，真正要问的留在框里没动。改用 Shift+Enter。
- **断开按钮没作用**：`disconnect` 只关了中继，没真正停 Xray；而且关中继会把 `closed` 置真，导致再也连不上。现在断开只停 Xray、保留中继，并刷新浏览器页面。
- **dispose 之后中继自己复活**：开机自启的定时器没被取消，卸载后照常触发、重新 listen，端口一直占着。
- **Windows 运行时路径写死 `/root`**：安装脚本分平台了，运行时没分，Windows 的 CDP 画面起不来。
- **安装每次白删白建链接**：链接检查用 `path.resolve`，它不跟随符号链接，于是永远判"指向不对"。
- **重装重下 660MB**：`detect` 算了浏览器已装，安装函数没用这个结果。
- **测试框架的异步测试空转**：`test(name, fn)` 同步执行，async 测试的返回值被丢掉，5 条测试等于没跑。

回归测试 56 + 40 + 9 全过。剩下的限制是结构性的（吞吐 1、依赖前端结构、需要浏览器环境），不是 bug。

---

## 免责声明

下载、安装、运行或以任何方式使用本项目，即视为你已阅读、理解并不可撤销地同意以下全部内容。若不同意其中任何一条，请立即停止使用并删除本项目。

### 一、用途与性质

1. 仅供个人学习、技术研究与交流。不得用于商业用途，不得对外提供接口或服务，不得用于多账号分发、转卖、代充或任何形式的牟利。
2. 本项目不提供任何服务。不含、不提供、不售卖、不推荐任何代理服务器、机场订阅、ChatGPT 账号或 API Key。全部能力依赖使用者自行提供的资源。
3. "Free" 仅指软件本身免费开源，不代表可以免费使用 GPT，也不代表使用 GPT 是免费的。

### 二、账号与第三方条款风险

4. 本项目会自动化操作 ChatGPT 网页界面（自动输入、点击发送、读取回答），并驱动一个真实浏览器。此类自动化行为可能违反 OpenAI 的服务条款。
5. 你的账号可能被限流、警告或封禁，后果由你自行承担。请自行评估风险，建议不要使用主力账号。
6. 你与任何第三方服务（OpenAI、机场服务商等）之间的权利义务，受该第三方的条款约束，与本项目无关。本项目不代你接受任何条款，也不为你违反条款的行为负责。

### 三、可用性与技术风险

7. 本项目不保证可用。它依赖 ChatGPT 网页版的前端结构与风控策略，上游随时可能改版导致功能失效，且不另行通知。
8. 不适合用于生产环境，不应用于任何要求 7×24 稳定可用的场景。
9. 涉及自动化浏览器、本地代理、网络转发等技术手段，需要一定的技术能力才能部署与排错。因操作不当导致的系统异常、数据损坏、设备故障，本项目不承担责任。

### 四、合规责任

10. 使用者应自行确认并遵守其所在国家或地区的全部适用法律法规，包括但不限于网络通信、计算机信息系统安全、数据保护与出口管制相关规定。
11. 严禁用于任何违法用途。因使用或分发本项目产生的一切后果，由使用者自行承担；作者与贡献者不承担任何直接或间接责任。
12. 若你所在地区禁止使用此类工具，请不要使用。

### 五、数据与隐私

13. 订阅地址、账号、密钥等均由使用者自行提供，仅在本机内存与本地文件中使用。本项目不收集、不上传、不转发任何用户信息到作者或任何第三方服务器。
14. 浏览器环境会保存你的登录态，用户目录在插件目录之外，请自行妥善保管，不要在共享环境中使用。
15. 你与本插件之间的所有通信均在本机回环地址（`127.0.0.1`）内完成。

### 六、担保与责任限制

16. 本项目按「原样」（AS IS）提供，不附带任何明示或暗示的担保，包括但不限于适销性、特定用途适用性与不侵权的担保。
17. 在适用法律允许的最大范围内，作者与贡献者不对任何直接、间接、偶然、特殊、惩罚性或后果性损害（包括但不限于利润损失、数据丢失、账号封禁、业务中断）承担责任，无论其如何引起、基于何种责任理论，也无论是否已被告知该等损害的可能性。
18. 若部分司法辖区不允许排除默示担保或限制责任，则上述限制在该辖区范围内不适用，其余条款仍然有效。

### 七、第三方组件

19. [Xray-core](https://github.com/XTLS/Xray-core)（MPL-2.0）不随仓库分发，由使用者自行获取，其使用须遵守其自身许可证。
20. 浏览器环境使用 [Playwright](https://github.com/microsoft/playwright)（Apache-2.0）、Chromium（BSD 类）、[noVNC](https://github.com/novnc/noVNC)（MPL-2.0）、x11vnc（GPL）等第三方组件，均不随仓库分发，由安装脚本从官方或镜像源获取，其使用须遵守各自许可证。
21. 部分初始化代码 vendor 自 [pi-gpt](https://www.npmjs.com/package/pi-gpt)（MIT），其源头为 [chat2api](https://github.com/lanqian528/chat2api)（MIT），已保留出处声明。

### 八、其他

22. 本项目由 AI 直接产出（代码、文档、提交信息），虽经测试，仍可能存在疏漏。请自行审阅源码后再决定是否使用。
23. 作者保留随时修改本声明、变更功能或停止维护的权利。
24. 使用本项目即表示你已完整阅读并同意以上全部条款。

---

## 许可证

MIT（见 [LICENSE](LICENSE)）。
