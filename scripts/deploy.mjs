/**
 * 一键部署 —— 跨平台核心。
 *
 * Windows 与 Unix 共用**同一套逻辑**，区别只在少数几处平台差异，全部收敛在这里：
 *   - Xray 核心的 asset 名字（linux / windows / darwin × arm64 / x64）
 *   - 解压方式（Windows 用 PowerShell，其余用 unzip/python）
 *   - 链接方式（Windows 用目录联接，Unix 用软链）
 *   - 浏览器环境（Linux 需要 Xvfb+x11vnc；Windows/macOS 原生有头即可）
 *
 * 外壳脚本只做"检测 + 转调"：
 *   scripts/deploy.sh   （Unix）
 *   scripts/deploy.bat  （Windows）
 *
 * 用法：
 *   node scripts/deploy.mjs [--profile web] [--no-core] [--no-browser] [--dry-run]
 *
 * 本脚本不接触任何账号、订阅或密钥。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, readdirSync } from 'node:fs'
import { homedir, tmpdir, platform, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(SCRIPT_DIR, '..')
const IS_WIN = platform() === 'win32'

// ── 输出 ────────────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (n) => (s) => (useColor ? `\u001b[${n}m${s}\u001b[0m` : String(s))
const cyan = c(36), green = c(32), yellow = c(33), red = c(31)
const say = (m) => console.log(`${cyan('==>')} ${m}`)
const ok = (m) => console.log(`  ${green('✓')} ${m}`)
const warn = (m) => console.log(`  ${yellow('!')} ${m}`)
const bad = (m) => console.log(`  ${red('✗')} ${m}`)

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def
}
const has = (name) => args.includes(name)

if (has('--help') || has('-h')) {
  console.log(`
用法: node scripts/deploy.mjs [选项]

  --profile <名字>   指定 DSH profile（默认 web）
  --no-core          跳过 Xray 核心
  --no-browser       跳过浏览器环境
  --force-core       即使已存在也重新拉取核心
  --dry-run          只检测与打印，不做任何改动

本脚本跨平台，Windows 与 Unix 共用同一套逻辑。
`)
  process.exit(0)
}

const PROFILE = String(opt('--profile', 'web'))
const DO_CORE = !has('--no-core')
const DO_BROWSER = !has('--no-browser')
const FORCE_CORE = has('--force-core')
const DRY = has('--dry-run')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const XRAY_VERSION = process.env.XRAY_VERSION || 'v26.3.27'
const CORE_DIR = join(PLUGIN_DIR, 'core')
const CORE_BIN = join(CORE_DIR, IS_WIN ? 'xray.exe' : 'xray')

let failures = 0
const fail = (m) => {
  failures += 1
  bad(m)
}

// ── 1. 检测 ─────────────────────────────────────────────────────────────────
function detect() {
  say('1/5 检测环境')
  console.log(`    系统    : ${platform()} / ${arch()}`)
  console.log(`    Node    : ${process.version}`)
  console.log(`    插件目录: ${PLUGIN_DIR}`)
  console.log(`    DSH 目录: ${DSH_HOME}`)
  console.log(`    Profile : ${PROFILE}${DRY ? '（dry-run，不会改动任何东西）' : ''}`)
  console.log()

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) fail(`Node 版本过低（${process.version}），需要 >=20`)
  else ok(`Node ${process.version}`)

  if (!existsSync(PROFILE_DIR)) {
    fail(`profile 不存在：${PROFILE_DIR}`)
    const profilesRoot = join(DSH_HOME, 'profiles')
    if (existsSync(profilesRoot)) {
      const list = readdirSafe(profilesRoot)
      if (list.length) console.log(`      可用 profile：${list.join(', ')}`)
      console.log(`      用 --profile <名字> 指定，或先启动一次 DSH 让它创建。`)
    } else {
      console.log('      还没装过 DSH？先启动一次 DSH 再回来跑这个脚本。')
    }
    return false
  }
  const pkgPath = join(PROFILE_DIR, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`profile 里没有 package.json：${pkgPath}`)
    return false
  }
  ok('profile 就绪')

  // 顺带看看已经装到哪一步了
  const already = {
    core: existsSync(CORE_BIN),
    browser: existsSync(join(homedir(), '.dsh-browser', 'browsers')) || browserInstalled(),
    registered: (() => {
      try {
        const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
        return Boolean(p?.dependencies?.['dsh-gpt-free-relay'])
      } catch {
        return false
      }
    })(),
  }
  ok(`已装情况：核心=${already.core ? '有' : '无'} 浏览器=${already.browser ? '有' : '无'} 注册=${already.registered ? '已注册' : '未注册'}`)
  console.log()
  return true
}

function readdirSafe(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function browserInstalled() {
  const p = join(homedir(), '.dsh-browser', 'browsers')
  if (!existsSync(p)) return false
  try {
    return readdirSync(p).some((n) => n.startsWith('chromium'))
  } catch {
    return false
  }
}

// ── 2. Xray 核心 ────────────────────────────────────────────────────────────
function xrayAsset() {
  const a = arch()
  if (platform() === 'win32') {
    if (a === 'arm64') return 'Xray-windows-arm64-v8a.zip'
    return 'Xray-windows-64.zip'
  }
  if (platform() === 'darwin') {
    if (a === 'arm64') return 'Xray-macos-arm64-v8a.zip'
    return 'Xray-macos-64.zip'
  }
  // linux 及其它
  if (a === 'arm64' || a === 'aarch64') return 'Xray-linux-arm64-v8a.zip'
  if (a === 'arm') return 'Xray-linux-arm32-v7a.zip'
  return 'Xray-linux-64.zip'
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return buf.length
}

function unzip(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true })
  // Windows 走 PowerShell；其余优先 unzip，再退到 python3
  if (IS_WIN) {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
      { stdio: 'inherit' },
    )
    return r.status === 0
  }
  let r = spawnSync('unzip', ['-oq', zipPath, '-d', outDir], { stdio: 'ignore' })
  if (r.status === 0) return true
  r = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, outDir], { stdio: 'ignore' })
  return r.status === 0
}

async function installCore() {
  if (!DO_CORE) {
    say('2/5 跳过 Xray 核心（--no-core）')
    return
  }
  say('2/5 安装 Xray 核心')
  if (existsSync(CORE_BIN) && !FORCE_CORE) {
    ok('已存在，跳过（要强制更新用 --force-core）')
    return
  }
  if (DRY) {
    ok('dry-run：会下载核心')
    return
  }

  const asset = xrayAsset()
  const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset}`
  console.log(`    下载 ${asset} ...`)
  const tmp = join(tmpdir(), `xray-${Date.now()}.zip`)
  try {
    const size = await download(url, tmp)
    ok(`下载完成（${Math.round(size / 1024 / 1024)}MB）`)
    const out = join(tmpdir(), `xray-out-${Date.now()}`)
    if (!unzip(tmp, out)) throw new Error('解压失败')
    mkdirSync(CORE_DIR, { recursive: true })
    const src = join(out, IS_WIN ? 'xray.exe' : 'xray')
    if (!existsSync(src)) throw new Error('压缩包里没有找到可执行文件')
    writeFileSync(CORE_BIN, readFileSync(src))
    if (!IS_WIN) {
      try {
        spawnSync('chmod', ['+x', CORE_BIN])
      } catch {
        /* 忽略 */
      }
    }
    rmSync(tmp, { force: true })
    rmSync(out, { recursive: true, force: true })
    ok(`核心已就位：${CORE_BIN}`)
  } catch (e) {
    // 网络不通是常见情况（国内访问 GitHub 不稳），不要让它中断整个部署
    warn(`拉取核心失败：${e.message}`)
    warn('不影响注册插件；之后可单独重跑，或设 XRAY_VERSION 换版本。')
    warn('（这是网络问题，不是脚本问题）')
  }
}

// ── 3. 浏览器环境 ───────────────────────────────────────────────────────────
async function installBrowser() {
  if (!DO_BROWSER) {
    say('3/5 跳过浏览器环境（--no-browser）')
    warn('没有它就只能用「机场线路」，不能「浏览器作答」')
    return
  }
  say('3/5 安装浏览器环境')

  if (platform() === 'linux') {
    // Linux 上有两个容器特有的坑（apt 架构、x11vnc 的 IPv6/共享内存），
    // 都写在 setup-browser.sh 里了，直接调它。
    const sh = join(SCRIPT_DIR, 'setup-browser.sh')
    if (!existsSync(sh)) {
      warn('找不到 setup-browser.sh，跳过')
      return
    }
    if (DRY) {
      ok('dry-run：会执行 setup-browser.sh（约 660MB）')
      return
    }
    console.log('    执行 setup-browser.sh（约 660MB，慢是正常的）...')
    const r = spawnSync('bash', [sh], { stdio: 'inherit' })
    if (r.status === 0) ok('浏览器环境就绪')
    else warn('安装未完成 —— 不影响机场线路，之后可重跑')
    return
  }

  // Windows / macOS：不需要 Xvfb，Playwright 自带的有头模式直接可用
  warn(`${platform()} 上不需要 Xvfb；如需「浏览器作答」，请用桌面会话运行`)
  console.log('    若要安装 Chromium：')
  console.log(`      cd "${PLUGIN_DIR}" && npx playwright install chromium`)
  console.log('    注意：本平台的「浏览器作答」没有远程画面，只有机场线路是完整可用的。')
}

// ── 4. 注册进 DSH ───────────────────────────────────────────────────────────
function linkIntoNodeModules() {
  const nm = join(PROFILE_DIR, 'node_modules')
  const link = join(nm, 'dsh-gpt-free-relay')
  mkdirSync(nm, { recursive: true })

  let exists = false
  try {
    lstatSync(link)
    exists = true
  } catch {
    exists = false
  }

  if (exists) {
    // 已经是链接且指向正确就跳过
    try {
      const real = resolve(link)
      if (real === PLUGIN_DIR) {
        ok('node_modules 里的链接已正确')
        return
      }
    } catch {
      /* 继续处理 */
    }
    warn('已存在但指向不对，正在重设')
    rmSync(link, { recursive: true, force: true })
  }

  if (DRY) {
    ok('dry-run：会创建链接')
    return
  }

  try {
    // Windows 上符号链接要权限，目录联接（junction）不需要
    symlinkSync(PLUGIN_DIR, link, IS_WIN ? 'junction' : 'dir')
    ok(`已创建${IS_WIN ? '目录联接' : '软链'}`)
  } catch (e) {
    warn(`创建链接失败：${e.message}`)
    warn('影响不大 —— DSH 会按 package.json 里的 link: 路径解析；')
    if (IS_WIN) warn('若启动后插件没出现，请以管理员身份重跑本脚本。')
  }
}

function register() {
  say('4/5 把插件注册进 profile')
  if (DRY) {
    ok('dry-run：会写入 dependencies 与 bundles')
    return
  }
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, 'register-plugin.mjs'), PROFILE_DIR, PLUGIN_DIR], {
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    fail('注册失败')
    return
  }
  linkIntoNodeModules()
}

// ── 5. 收尾 ─────────────────────────────────────────────────────────────────
function finish() {
  say('5/5 完成')
  console.log()
  if (failures) {
    console.log(`  ${red(`有 ${failures} 项失败`)}，先解决上面的问题再重启 DSH。`)
    console.log()
  }
  console.log('  接下来：')
  console.log('    1. 重启 DSH（App 里点「重启」，或关掉再开）')
  console.log('    2. 打开「通用设置 → 插件 → 插件配置」，应看到「机场中转」卡片')
  if (DO_BROWSER && platform() === 'linux') {
    console.log('    3. 卡片切到「浏览器作答」→ 启动 → 右下角「键盘」登录一次')
  } else {
    console.log('    3. 卡片「普通端」里填订阅地址 → 拉取 → 连接')
  }
  console.log()
  console.log('  自检：curl -s 127.0.0.1:2083/status')
  console.log()
  console.log(`  ${yellow('注意')}：需自备 ChatGPT 账号与网络线路；自动化操作网页可能违反`)
  console.log('        OpenAI 服务条款（账号有被封风险）。详见 README 的使用条件与免责声明。')
  console.log()
  process.exit(failures ? 1 : 0)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log()
say(`GPT Free 中转 · 一键部署（${platform() === 'win32' ? 'Windows' : platform() === 'darwin' ? 'macOS' : 'Linux'}）`)
console.log()

if (detect()) {
  await installCore()
  await installBrowser()
  register()
}
finish()
