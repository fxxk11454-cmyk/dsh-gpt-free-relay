# Windows 部署

本页只管 Windows。Unix 看 [`unix.md`](unix.md)。
给 AI 的总入口是 [`../AGENTS.md`](../AGENTS.md)。

---

## 一条命令

```bat
setup.bat
```

根目录的 `setup.bat` 只是指路牌，实际实现是
`scripts\windows\deploy.mjs`（平台无关的部分在 `scripts\_shared\`）。

```bat
setup.bat --dry-run        rem 先看会做什么，不改动任何东西
setup.bat --no-browser     rem 只装机场线路
setup.bat --profile web    rem 指定 DSH profile（默认 web）
setup.bat --force-core     rem 即使核心已存在也重新拉
setup.bat --help
```

装完重启 DSH，打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片。

> 也可以在 Git Bash / WSL 里跑 `node scripts\windows\deploy.mjs`，
> 但**不要**在 Windows 上跑 `setup.sh` —— 它会检测出来并拒绝。

---

## 与 Unix 的差别（就这四条）

| 事项 | Windows 的做法 | 为什么 |
|---|---|---|
| 可执行文件 | `core\xray.exe` | 平台惯例 |
| 解压 | PowerShell `Expand-Archive` | Windows 自带，不依赖 `unzip`/`python3` |
| 链接 node_modules | 目录联接 `junction` | 符号链接要管理员权限，junction 不要 |
| 浏览器环境 | `npx playwright install chromium` | **不需要** Xvfb / x11vnc |

Windows 上**没有** noVNC，这是平台限制不是偷懒：那套（Xvfb 虚拟屏 +
x11vnc + WebSocket 桥）在 Windows 上没有对应物。

---

## 远程画面：CDP 截图

卡片里的「浏览器作答」在 Windows 上改用 **CDP 截图**当画面：

```
GET  /browser/frame?q=55      → 一张 JPEG（当前视口）
POST /browser/tap   {x,y}     → 在页面 (x,y) 点一下
POST /browser/scroll {dy}     → 滚轮
POST /browser/keys  {text}    → 敲字；{key:"Enter"} 按特殊键
```

前端按显示尺寸把点击坐标等比换算成**视口坐标**（默认 1280×900）再发回来。
两套画面按 `status.platform` 分流，互不干扰：

```js
const isWin = (status && status.platform) === 'win32'
// isWin → CDP 截图面板；否则 → noVNC iframe
```

---

## 排错

```bat
curl -s 127.0.0.1:2083/status
curl -s 127.0.0.1:2083/browser
curl -s 127.0.0.1:2083/config
```

| 症状 | 多半是 |
|---|---|
| 插件没出现 | 链接没建成功 —— 以管理员身份重跑 `setup.bat` |
| 画面一直空白 | 浏览器没启动，点「启动并打开 ChatGPT」 |
| 点画面没反应 | 视口尺寸不是 1280×900，或页面在 iframe 里 |
| `Expand-Archive` 报错 | 用 `--force-core` 重试；或手动解压到 `core\` |

---

## 自检

```bat
node scripts\test-core.mjs
node scripts\test-client-render.mjs
```
