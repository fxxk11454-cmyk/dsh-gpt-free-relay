#!/bin/bash
# 下载 Xray 核心（**Linux 专用**：Linux / macOS）。
# 仓库不包含第三方核心二进制（体积与许可证原因），由使用者自行获取。
# Xray-core 使用 MPL-2.0 许可证。
#
# Windows 请用 scripts\windows\deploy.mjs —— 它会自动拉 Windows 构建。
set -eu

VERSION="${XRAY_VERSION:-v26.3.27}"
# 本文件在 scripts/linux/ 下，插件根目录要往上两级
DEST="$(cd "$(dirname "$0")/../.." && pwd)/core"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64)        ASSET="Xray-macos-arm64-v8a.zip" ;;
      x86_64)       ASSET="Xray-macos-64.zip" ;;
      *) echo "不支持的架构: $(uname -m)"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      aarch64|arm64) ASSET="Xray-linux-arm64-v8a.zip" ;;
      armv7l|arm)    ASSET="Xray-linux-arm32-v7a.zip" ;;
      x86_64|amd64)  ASSET="Xray-linux-64.zip" ;;
      *) echo "不支持的架构: $(uname -m)"; exit 1 ;;
    esac
    ;;
  *)
    echo "这是 Linux 专用脚本，当前系统是 $(uname -s)"
    echo "Windows 请用 scripts\\windows\\deploy.mjs"
    exit 1
    ;;
esac

echo "==> 下载 Xray-core ${VERSION} (${ASSET})"
curl -fL --retry 3 -o "$TMP/xray.zip" \
  "https://github.com/XTLS/Xray-core/releases/download/${VERSION}/${ASSET}"

mkdir -p "$TMP/out" "$DEST"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/xray.zip" "$TMP/out"
cp "$TMP/out/xray" "$DEST/xray"
chmod +x "$DEST/xray"

echo "==> 完成: $DEST/xray"
"$DEST/xray" version 2>/dev/null | head -2 || true
