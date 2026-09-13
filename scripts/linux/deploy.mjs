/**
 * 一键部署 —— **Linux 专用**（Linux / macOS / Android 容器）。
 *
 * 这个文件里没有一行 Windows 代码，也不需要看 Windows 那份。
 * 想部署到 Windows 请用 scripts/windows/deploy.mjs（或根目录的 setup.bat）。
 *
 * 本平台的形态：
 *   - Xray 核心：Linux / macOS 构建
 *   - 浏览器环境：Linux 要 Xvfb + x11vnc + noVNC（约 660MB），
 *                 由同目录的 setup-browser.sh 装
 *   - 远程画面：noVNC（浏览器里的虚拟屏）
 *
 * 用法：
 *   bash scripts/linux/deploy.sh              # 完整部署
 *   bash scripts/linux/deploy.sh --no-browser # 只用机场线路，省 660MB
 *   bash scripts/linux/deploy.sh --dry-run    # 只看会做什么
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:os'

import {
  PLUGIN_NAME,
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
  redText,
} from '../_shared/deploy-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '../..')
const SHARED = resolve(HERE, '../_shared')

const opts = parseArgs()

if (opts.help) {
  console.log(`
用法: node scripts/linux/deploy.mjs [选项]

  --profile <名字>   指定 DSH profile（默认 web）
  --no-core          跳过 Xray 核心
  --no-browser       跳过浏览器环境（省约 660MB）
  --force-core       即使已存在也重新拉取核心
  --force-browser    即使已存在也重装浏览器环境（默认会跳过，省 660MB）
  --dry-run          只检测与打印，不做任何改动
  --help             显示这份帮助

本脚本是 **Linux 专用**（Linux / macOS / Android 容器）。
Windows 请用 scripts\\windows\\deploy.mjs。
`)
  process.exit(0)
}

let failures = 0
const fail = (m) => {
  failures += 1
  bad(m)
}

const IS_LINUX = platform() === 'linux'
const IS_MAC = platform() === 'darwin'

if (platform() === 'win32') {
  bad('这是 Linux 专用脚本，但你正跑在 Windows 上。')
  console.log('    请改用：scripts\\windows\\deploy.mjs   或   setup.bat')
  process.exit(1)
}

const BROWSER_HOME = join(process.env.HOME || '/root', '.dsh-browser')
const CORE_BIN = join(PLUGIN_DIR, 'core', 'xray')

console.log()
say(`GPT Free 中转 · 一键部署（${IS_MAC ? 'macOS' : 'Linux'}）`)
console.log()

// ── 解压：Linux 上优先 unzip，再退到 python3 ─────────────────────────────────
function unzip(zipPath, outDir) {
  let r = spawnSync('unzip', ['-oq', zipPath, '-d', outDir], { stdio: 'ignore' })
  if (r.status === 0) return true
  r = spawnSync(
    'python3',
    ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, outDir],
    { stdio: 'ignore' },
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
  say('3/5 安装浏览器环境')

  /**
   * 已经装过就别再装一遍。
   *
   * 这一步要 apt-get + npm + 下 Chromium，重跑一次是几百 MB 和好几分钟。
   * detect() 本来就算了 `已装情况：浏览器=有`，但这里原先没用它 ——
   * 于是"重跑一遍安装脚本"变成了"重下一遍 660MB"。现在跳过，
   * 要强制重装用 --force-browser。
   */
  if (browserInstalled(BROWSER_HOME) && !opts.forceBrowser) {
    ok('浏览器环境已存在，跳过（要强制重装用 --force-browser）')
    return
  }

  if (!IS_LINUX) {
    // macOS：原生有头浏览器可用，但没有 Xvfb/x11vnc 那套，所以没有内嵌画面
    warn('macOS 上不用 Xvfb；「浏览器作答」要桌面会话，卡片里没有内嵌画面')
    console.log('    若要安装 Chromium：')
    console.log(`      cd "${PLUGIN_DIR}" && npx playwright install chromium`)
    return
  }

  // Linux：两个容器特有的坑（apt 架构、x11vnc 的 IPv6/共享内存）
  // 都写在 setup-browser.sh 里了，直接调它。
  const sh = join(HERE, 'setup-browser.sh')
  if (!existsSync(sh)) {
    warn(`找不到 ${sh}，跳过`)
    return
  }
  if (opts.dryRun) {
    ok('dry-run：会执行 setup-browser.sh（约 660MB）')
    return
  }
  console.log('    执行 setup-browser.sh（约 660MB，慢是正常的）...')
  const r = spawnSync('bash', [sh], { stdio: 'inherit' })
  if (r.status === 0) ok('浏览器环境就绪')
  else warn('安装未完成 —— 不影响机场线路，之后可重跑')
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
    asset: xrayAsset(platform(), arch()),
    unzip,
    exeName: 'xray',
    needsChmod: true,
    fail,
  })

  await installBrowser()

  register({
    pluginDir: PLUGIN_DIR,
    opts,
    registerScript: join(SHARED, 'register-plugin.mjs'),
    linkMode: 'dir', // Linux 用符号链接
    fail,
  })
}

finish({
  failures,
  nextSteps: IS_LINUX
    ? [
        '重启 DSH（App 里点「重启」，或关掉再开）',
        '打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片',
        '卡片切到「浏览器作答」→ 启动 → 右下角「键盘」登录一次',
        '回「普通端」填订阅地址 → 拉取 → 连接',
      ]
    : [
        '重启 DSH',
        '打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片',
        '在「普通端」填订阅地址 → 拉取 → 连接',
      ],
})
