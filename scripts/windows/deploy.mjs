/**
 * 一键部署 —— **Windows 专用**。
 *
 * 这个文件里没有一行 Linux 代码，也不需要看 Linux 那份。
 * 想部署到 Linux / macOS 请用 scripts/linux/deploy.mjs（或根目录的 setup.sh）。
 *
 * 本平台的形态（与 Linux 的差别就这几条）：
 *   - Xray 核心：Windows 构建，可执行文件叫 xray.exe
 *   - 解压：用 PowerShell 的 Expand-Archive（Windows 自带，不依赖 unzip/python）
 *   - 链接：用目录联接 junction（符号链接要管理员权限，junction 不要）
 *   - 浏览器环境：不需要 Xvfb / x11vnc，Playwright 自带的有头模式直接可用
 *   - 远程画面：没有 noVNC，卡片改用 CDP 截图（/browser/frame）当画面
 *
 * 用法：
 *   node scripts\windows\deploy.mjs
 *   node scripts\windows\deploy.mjs --no-browser
 *   node scripts\windows\deploy.mjs --dry-run
 *
 * 也可以直接双击 / 运行仓库根目录的 setup.bat。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:os'

import {
  say,
  ok,
  warn,
  bad,
  parseArgs,
  detect,
  browserInstalled,
  xrayAsset,
  installCore,
  register,
  finish,
} from '../_shared/deploy-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '../..')
const SHARED = resolve(HERE, '../_shared')

const opts = parseArgs()

if (opts.help) {
  console.log(`
用法: node scripts\\windows\\deploy.mjs [选项]

  --profile <名字>   指定 DSH profile（默认 web）
  --no-core          跳过 Xray 核心
  --no-browser       跳过浏览器环境
  --force-core       即使已存在也重新拉取核心
  --force-browser    即使已存在也重装 Chromium
  --dry-run          只检测与打印，不做任何改动
  --help             显示这份帮助

本脚本是 **Windows 专用**。
Linux / macOS / Android 容器请用 scripts/linux/deploy.mjs。
`)
  process.exit(0)
}

let failures = 0
const fail = (m) => {
  failures += 1
  bad(m)
}

if (platform() !== 'win32') {
  bad(`这是 Windows 专用脚本，但你正跑在 ${platform()} 上。`)
  console.log('    请改用：bash scripts/linux/deploy.sh   或   node scripts/linux/deploy.mjs')
  process.exit(1)
}

const CORE_BIN = join(PLUGIN_DIR, 'core', 'xray.exe')
const BROWSER_HOME = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh-browser')

console.log()
say('GPT Free 中转 · 一键部署（Windows）')
console.log()

// ── 解压：Windows 用自带的 PowerShell ───────────────────────────────────────
function unzip(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true })
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ],
    { stdio: 'inherit' },
  )
  return r.status === 0
}

// ── 3. 浏览器环境 ───────────────────────────────────────────────────────────
async function installBrowser() {
  if (!opts.doBrowser) {
    say('3/5 跳过浏览器环境（--no-browser）')
    warn('没有它就只能用「机场线路」，不能「浏览器作答」')
    return
  }
  say('3/5 浏览器环境')

  // Windows 上不需要 Xvfb / x11vnc —— 有头浏览器直接就能跑
  ok('Windows 不需要 Xvfb / x11vnc，Playwright 原生的有头模式即可')

  // 已装过就别重复下载（重装用 --force-browser）
  if (browserInstalled(BROWSER_HOME) && !opts.forceBrowser) {
    ok('Chromium 已存在，跳过（要强制重装用 --force-browser）')
    return
  }

  if (opts.dryRun) {
    ok('dry-run：会执行 npx playwright install chromium')
    return
  }

  console.log('    安装 Chromium（约 150MB）...')
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: PLUGIN_DIR,
    stdio: 'inherit',
    shell: true, // Windows 上 npx 是 .cmd，必须走 shell
  })
  if (r.status === 0) {
    ok('Chromium 就绪')
  } else {
    warn('Chromium 安装未完成 —— 不影响机场线路，之后可重跑')
    console.log(`      手动装：cd "${PLUGIN_DIR}" && npx playwright install chromium`)
  }

  console.log('    画面说明：本平台没有 noVNC，卡片改用 CDP 截图（/browser/frame）当远程画面')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (
  detect({
    pluginDir: PLUGIN_DIR,
    opts,
    coreBin: CORE_BIN,
    browserHome: BROWSER_HOME,
    platformLabel: `${platform()} / ${arch()}`,
    fail,
  })
) {
  await installCore({
    opts,
    coreDir: join(PLUGIN_DIR, 'core'),
    coreBin: CORE_BIN,
    asset: xrayAsset('win32', arch()),
    unzip,
    exeName: 'xray.exe',
    needsChmod: false, // Windows 不搞可执行位
    fail,
  })

  await installBrowser()

  register({
    pluginDir: PLUGIN_DIR,
    opts,
    registerScript: join(SHARED, 'register-plugin.mjs'),
    linkMode: 'junction', // Windows 用目录联接（符号链接要管理员权限）
    fail,
  })
}

finish({
  failures,
  nextSteps: [
    '重启 DSH（App 里点「重启」，或关掉再开）',
    '打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片',
    '在「普通端」填订阅地址 → 拉取 → 连接',
    '切到「浏览器作答」→ 启动 → 画面是定时刷新的截图，点画面等于点页面',
  ],
})
