#!/usr/bin/env bash
#
# 一键部署（Linux：Linux / macOS / Android 容器）
#
# 这个文件只是**外壳**：检测 node，然后把参数原样转给同目录的 deploy.mjs。
# 真正的逻辑在 scripts/linux/deploy.mjs（平台无关的部分在 scripts/_shared/）。
#
# Windows 请用仓库根目录的 setup.bat。
#
# 用法：
#   bash scripts/linux/deploy.sh                    # 完整部署
#   bash scripts/linux/deploy.sh --no-browser       # 不装浏览器环境（省 660MB）
#   bash scripts/linux/deploy.sh --profile web      # 指定 profile
#   bash scripts/linux/deploy.sh --dry-run          # 只看会做什么
#   bash scripts/linux/deploy.sh --help
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$SCRIPT_DIR/deploy.mjs"

# ── 检测 1：核心脚本在不在 ──────────────────────────────────────────────────
if [ ! -f "$CORE" ]; then
  echo "✗ 找不到核心脚本：$CORE" >&2
  echo "  这个 .sh 只是外壳，逻辑在同目录的 deploy.mjs 里。" >&2
  exit 1
fi

# ── 检测 2：系统别搞错了 ────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux|Darwin) : ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "✗ 检测到你在 Windows（$(uname -s)）上跑 .sh" >&2
    echo "  Windows 请用仓库根目录的 setup.bat" >&2
    exit 1
    ;;
  *) : ;;   # 其它类 Unix（含 Android 容器）照常放行
esac

# ── 检测 3：node ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node，请先安装 Node.js（>=20）" >&2
  echo "  Debian/Ubuntu : sudo apt-get install -y nodejs npm" >&2
  echo "  或从 https://nodejs.org/ 下载安装" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "✗ Node 版本过低（$(node -v)），需要 >=20" >&2
  exit 1
fi

# ── 转调本平台核心 ──────────────────────────────────────────────────────────
exec node "$CORE" "$@"
