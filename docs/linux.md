# Linux 部署（Linux / macOS / Android 容器）

本页只管 Linux。Windows 看 [`windows.md`](windows.md)。
给 AI 的总入口是 [`../AGENTS.md`](../AGENTS.md)。

---

## 一条命令

```bash
bash setup.sh
```

这就是全部。根目录的 `setup.sh` 只是指路牌，实际实现是
`scripts/linux/deploy.mjs`（平台无关的部分在 `scripts/_shared/`）。

```bash
bash setup.sh --dry-run        # 先看会做什么，不改动任何东西
bash setup.sh --no-browser     # 只装机场线路，省约 660MB
bash setup.sh --profile web    # 指定 DSH profile（默认 web）
bash setup.sh --force-core     # 即使核心已存在也重新拉
bash setup.sh --help
```

装完重启 DSH，打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片。

---

## 脚本做四件事

| 步骤 | 做什么 | 能不能跳过 |
|---|---|---|
| 1/5 检测 | 系统、Node 版本、profile 是否存在、已装到哪一步 | — |
| 2/5 Xray 核心 | 按架构拉 Linux/macOS 构建到 `core/xray`，`chmod +x` | `--no-core` |
| 3/5 浏览器环境 | Linux：跑 `scripts/linux/setup-browser.sh`（660MB） | `--no-browser` |
| 4/5 注册 | 写 profile 的 `dependencies` + `bundles`，建软链 | — |
| 5/5 收尾 | 打印后续步骤 | — |

**拉核心失败不会中断部署。** 国内访问 GitHub 不稳，那是网络问题不是脚本问题；
插件注册不依赖核心。

---

## 手动安装（不想用脚本）

```bash
# 1) 拉 Xray 核心（Linux 或 macOS 构建，按 uname 自动选）
bash scripts/linux/fetch-core.sh

# 2) 装进某个 profile
node scripts/_shared/register-plugin.mjs \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web" \
  "$(pwd)"
```

---

## 平台差异

|  | Linux（含 Android 容器） | macOS |
|---|---|---|
| 远程画面 | **noVNC**（卡片内嵌虚拟屏） | 无内嵌画面 |
| 浏览器环境 | Xvfb + x11vnc + Chromium（`setup-browser.sh`） | `npx playwright install chromium` |
| 登录方式 | 卡片里的画面，右下角「键盘」唤软键盘 | 桌面会话里直接操作 |

macOS 不是不能用「浏览器作答」，是**卡片里没有内嵌画面** ——
浏览器在桌面会话里跑，你在那个窗口里登录。

---

## Linux 容器特有的两个坑

都写在 `scripts/linux/setup-browser.sh` 里了，这里说明为什么：

1. **apt 架构。** 机器是 aarch64，但 `dpkg` 里登记了外来架构 `amd64`，
   apt 于是去 ubuntu-ports 找 `binary-amd64`，全 404。
   脚本写 `/etc/apt/apt.conf.d/99-arch-arm64-only` 限定只取 arm64。

2. **x11vnc 启动即退。** 它默认监听 IPv6 并用 SysV 共享内存，容器里两样都没有。
   必须加 `-no6 -noshm`。另外**不要**同时给 `-localhost` 和 `-listen 127.0.0.1` ——
   实测 x11vnc 会打印「Listening on TCP port 5900」但实际不服务，
   表现是画面永远卡在加载。

---

## 排错

```bash
# 插件整体状态（核心、节点、并发、浏览器）
curl -s 127.0.0.1:2083/status

# 浏览器状态
curl -s 127.0.0.1:2083/browser

# 实际生成的 Xray 配置 + 核心错误日志
curl -s 127.0.0.1:2083/config
```

| 症状 | 多半是 |
|---|---|
| 卡片没出现 | profile 没注册成功，或 DSH 没重启 |
| `Connection refused` on 2082 | 插件没加载（中继在插件启动时就监听） |
| 页面永远卡在加载 | x11vnc 没起来，见上面第 2 个坑 |
| 核心启动即退出 | 看 `/config` 的 log 段 |
| 直连 chatgpt.com 被 Cloudflare 拦 | 需要走机场；卡片里先「连接」 |

---

## 自检

```bash
node scripts/test-core.mjs          # 57 项核心逻辑回归
node scripts/test-client-render.mjs # 卡片渲染回归
```
