#!/usr/bin/env bash
#
# dsh-gpt-free-relay · 一键部署（Unix 总入口）
#
# 这里只是**指路牌**：真正的实现在 scripts/unix/。
# 保留这个根目录入口，是为了让你不用记子目录。
#
#   Windows   →  setup.bat
#   Unix      →  setup.sh   （就是本文件）
#
# 用法：
#   bash setup.sh                    # 完整部署
#   bash setup.sh --no-browser       # 不装浏览器环境（省 660MB）
#   bash setup.sh --profile web      # 指定 profile
#   bash setup.sh --dry-run          # 只看会做什么
#   bash setup.sh --help
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/scripts/unix/deploy.sh" "$@"
