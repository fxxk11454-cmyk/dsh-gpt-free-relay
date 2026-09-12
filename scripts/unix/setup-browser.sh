#!/usr/bin/env bash
# 安装「有头浏览器」模式需要的环境。**Linux 专用。**
#
# macOS / Windows 不需要这个脚本 —— 它们原生就有有头浏览器，
# 只要 npx playwright install chromium 即可（Windows 见 scripts/windows/deploy.mjs）。
#
# 装完后的布局（全部在插件目录之外，不进仓库）：
#   ~/.dsh-browser/xvfb        —— Xvfb（虚拟屏）
#   ~/.dsh-browser/x11vnc      —— 系统包 x11vnc
#   ~/.dsh-browser/node_modules —— playwright-core / ws / @novnc/novnc
#   ~/.dsh-browser/browsers     —— Chromium 本体（约 660MB）
#   ~/.dsh-browser/profile      —— 浏览器用户目录（登录态存在这里）
#
# 用法：bash scripts/unix/setup-browser.sh
# 想换安装位置就设 BROWSER_HOME（运行时也要设同样的值）。
set -euo pipefail

# 默认 /root/.dsh-browser（Android 容器里的惯例）。允许覆盖是为了
# 非 root 环境：以前这里写死 /root，非 root 用户一跑就 permission denied。
HOME_DIR="${BROWSER_HOME:-${HOME:-/root}/.dsh-browser}"
mkdir -p "$HOME_DIR"

echo "==> 1/5 修正 apt 架构"
# 这台机器是 aarch64，但 dpkg 里登记了外来架构 amd64，apt 会去 ubuntu-ports
# 找 binary-amd64（镜像没有）→ 全 404。限定只取 arm64，不动已装的包。
if ! grep -q "Architectures" /etc/apt/apt.conf.d/99-arch-arm64-only 2>/dev/null; then
  cat > /etc/apt/apt.conf.d/99-arch-arm64-only <<'CONF'
APT::Architecture "arm64";
APT::Architectures { "arm64"; };
CONF
fi
cat > /etc/apt/apt.conf.d/99-parallel <<'CONF'
Acquire::Retries "3";
Acquire::http::Pipeline-Depth "10";
Acquire::Languages "none";
CONF

echo "==> 2/5 安装 Xvfb / x11vnc / 浏览器运行库"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq --no-install-recommends \
  xvfb x11vnc x11-utils fonts-liberation \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
  libx11-xcb1 libxcursor1 libxi6 libxtst6

echo "==> 3/5 安装 playwright-core / ws / noVNC"
cd "$HOME_DIR"
[ -f package.json ] || npm init -y >/dev/null
npm i --silent playwright-core ws @novnc/novnc

echo "==> 4/5 下载 Chromium"
# 官方 CDN 在国内基本下不动（实测 0 B/s 卡死）。npmmirror 有完整镜像，
# 实测 16MB/s。
export PLAYWRIGHT_BROWSERS_PATH="$HOME_DIR/browsers"
export PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
# --no-shell：跳过 headless shell（我们用不到，省 116MB）
npx --yes playwright@latest install chromium --no-shell

echo "==> 5/5 自检"
command -v Xvfb >/dev/null && echo "  Xvfb    ✓"
command -v x11vnc >/dev/null && echo "  x11vnc  ✓"
find "$PLAYWRIGHT_BROWSERS_PATH" -name chrome -type f | head -1 | sed 's/^/  Chromium ✓ /'
node -e "import('playwright-core').then(()=>console.log('  playwright-core ✓'))" 2>/dev/null || true
echo "完成。"
