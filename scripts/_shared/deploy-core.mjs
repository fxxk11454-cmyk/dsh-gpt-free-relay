/**
 * 部署用的公共能力 —— **与平台无关**的那部分。
 *
 * 这个文件里不允许出现任何 `platform() === 'win32'` 之类的判断。
 * 所有平台差异由调用方（scripts/unix/*.mjs 与 scripts/windows/*.mjs）
 * 通过参数传进来：
 *
 *   - xrayAsset(platform, arch) → 资源包文件名
 *   - unzipWith(cmd)            → 解压命令（各平台自己给）
 *   - linkMode                  → 'dir'（符号链接）或 'junction'（目录联接）
 *
 * 这么分的原因：以前是一个 deploy.mjs 里塞了 6 处平台分支，读的人得在
 * 脑子里同时装着两个平台才能看懂一处改动。现在两边各自成篇。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const PLUGIN_NAME = 'dsh-gpt-free-relay'
export const DEFAULT_XRAY_VERSION = 'v26.3.27'

// ── 输出 ────────────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (n) => (s) => (useColor ? `\u001b[${n}m${s}\u001b[0m` : String(s))
const cyan = c(36)
const green = c(32)
const yellow = c(33)
const red = c(31)

export const say = (m) => console.log(`${cyan('==>')} ${m}`)
export const ok = (m) => console.log(`  ${green('✓')} ${m}`)
export const warn = (m) => console.log(`  ${yellow('!')} ${m}`)
export const bad = (m) => console.log(`  ${red('✗')} ${m}`)
export const redText = red

// ── 参数解析 ────────────────────────────────────────────────────────────────
export function parseArgs(argv = process.argv.slice(2)) {
  const opt = (name, def) => {
    const i = argv.indexOf(name)
    return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def
  }
  const has = (name) => argv.includes(name)
  return {
    profile: String(opt('--profile', 'web')),
    doCore: !has('--no-core'),
    doBrowser: !has('--no-browser'),
    forceCore: has('--force-core'),
    dryRun: has('--dry-run'),
    help: has('--help') || has('-h'),
  }
}

// ── 路径 ────────────────────────────────────────────────────────────────────
export function paths(pluginDir, profileName) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dshHome,
    profileDir: join(dshHome, 'profiles', profileName),
    coreDir: join(pluginDir, 'core'),
    runtimeDir: join(pluginDir, '.runtime'),
  }
}

// ── 检测 ────────────────────────────────────────────────────────────────────
export function readdirSafe(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

export function browserInstalled(homeDir) {
  const p = join(homeDir, 'browsers')
  if (!existsSync(p)) return false
  try {
    return readdirSync(p).some((n) => n.startsWith('chromium'))
  } catch {
    return false
  }
}

/**
 * 环境检测。
 *
 * @param {object} ctx
 * @param {string} ctx.pluginDir
 * @param {object} ctx.opts        parseArgs() 的结果
 * @param {string} ctx.coreBin     本平台的核心可执行文件完整路径
 * @param {string} ctx.browserHome 浏览器环境安装目录
 * @param {(m: string) => void} ctx.fail
 * @returns {boolean} 环境是否可用（false 表示不该继续）
 */
export function detect({ pluginDir, opts, coreBin, browserHome, platformLabel, fail }) {
  say('1/5 检测环境')
  console.log(`    系统    : ${platformLabel}`)
  console.log(`    Node    : ${process.version}`)
  console.log(`    插件目录: ${pluginDir}`)
  const { dshHome, profileDir } = paths(pluginDir, opts.profile)
  console.log(`    DSH 目录: ${dshHome}`)
  console.log(`    Profile : ${opts.profile}${opts.dryRun ? '（dry-run，不会改动任何东西）' : ''}`)
  console.log()

  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) fail(`Node 版本过低（${process.version}），需要 >=20`)
  else ok(`Node ${process.version}`)

  if (!existsSync(profileDir)) {
    fail(`profile 不存在：${profileDir}`)
    const profilesRoot = join(dshHome, 'profiles')
    if (existsSync(profilesRoot)) {
      const list = readdirSafe(profilesRoot)
      if (list.length) console.log(`      可用 profile：${list.join(', ')}`)
      console.log('      用 --profile <名字> 指定，或先启动一次 DSH 让它创建。')
    } else {
      console.log('      还没装过 DSH？先启动一次 DSH 再回来跑这个脚本。')
    }
    return false
  }
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`profile 里没有 package.json：${pkgPath}`)
    return false
  }
  ok('profile 就绪')

  const already = {
    core: existsSync(coreBin),
    browser: browserInstalled(browserHome),
    registered: (() => {
      try {
        const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
        return Boolean(p?.dependencies?.[PLUGIN_NAME])
      } catch {
        return false
      }
    })(),
  }
  ok(
    `已装情况：核心=${already.core ? '有' : '无'} 浏览器=${already.browser ? '有' : '无'} 注册=${
      already.registered ? '已注册' : '未注册'
    }`,
  )
  console.log()
  return true
}

// ── Xray 核心 ───────────────────────────────────────────────────────────────
/**
 * 按平台与架构挑资源包。
 * @param {'win32'|'darwin'|'linux'} plat
 * @param {string} a  arch() 的结果
 */
export function xrayAsset(plat, a) {
  if (plat === 'win32') {
    if (a === 'arm64') return 'Xray-windows-arm64-v8a.zip'
    return 'Xray-windows-64.zip'
  }
  if (plat === 'darwin') {
    if (a === 'arm64') return 'Xray-macos-arm64-v8a.zip'
    return 'Xray-macos-64.zip'
  }
  if (a === 'arm64' || a === 'aarch64') return 'Xray-linux-arm64-v8a.zip'
  if (a === 'arm') return 'Xray-linux-arm32-v7a.zip'
  return 'Xray-linux-64.zip'
}

export async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return buf.length
}

/**
 * 安装 Xray 核心。
 *
 * @param {object} ctx
 * @param {string} ctx.coreDir
 * @param {string} ctx.coreBin
 * @param {string} ctx.asset          平台资源包名（xrayAsset 的结果）
 * @param {(zip: string, out: string) => boolean} ctx.unzip 平台自己的解压实现
 * @param {string} ctx.exeName        压缩包里可执行文件的名字（xray / xray.exe）
 * @param {boolean} ctx.needsChmod    是否要 chmod +x
 */
export async function installCore({ opts, coreDir, coreBin, asset, unzip, exeName, needsChmod, fail }) {
  if (!opts.doCore) {
    say('2/5 跳过 Xray 核心（--no-core）')
    return
  }
  say('2/5 安装 Xray 核心')
  if (existsSync(coreBin) && !opts.forceCore) {
    ok('已存在，跳过（要强制更新用 --force-core）')
    return
  }
  if (opts.dryRun) {
    ok('dry-run：会下载核心')
    return
  }

  const version = process.env.XRAY_VERSION || DEFAULT_XRAY_VERSION
  const url = `https://github.com/XTLS/Xray-core/releases/download/${version}/${asset}`
  console.log(`    下载 ${asset} ...`)
  const tmp = join(tmpdir(), `xray-${Date.now()}.zip`)
  try {
    const size = await download(url, tmp)
    ok(`下载完成（${Math.round(size / 1024 / 1024)}MB）`)
    const out = join(tmpdir(), `xray-out-${Date.now()}`)
    if (!unzip(tmp, out)) throw new Error('解压失败')
    mkdirSync(coreDir, { recursive: true })
    const src = join(out, exeName)
    if (!existsSync(src)) throw new Error('压缩包里没有找到可执行文件')
    writeFileSync(coreBin, readFileSync(src))
    if (needsChmod) {
      try {
        spawnSync('chmod', ['+x', coreBin])
      } catch {
        /* 忽略 */
      }
    }
    rmSync(tmp, { force: true })
    rmSync(out, { recursive: true, force: true })
    ok(`核心已就位：${coreBin}`)
  } catch (e) {
    // 网络不通是常见情况（国内访问 GitHub 不稳），不要让它中断整个部署
    warn(`拉取核心失败：${e.message}`)
    warn('不影响注册插件；之后可单独重跑，或设 XRAY_VERSION 换版本。')
    warn('（这是网络问题，不是脚本问题）')
  }
}

// ── 注册进 DSH ──────────────────────────────────────────────────────────────
/**
 * 在 profile 的 node_modules 里建一个指向插件目录的链接。
 *
 * @param {'dir'|'junction'} linkMode
 *        Unix 用 'dir'（符号链接）；Windows 用 'junction'（目录联接，
 *        不需要管理员权限，而符号链接需要）。
 */
export function linkIntoNodeModules({ pluginDir, opts, linkMode }) {
  const { profileDir } = paths(pluginDir, opts.profile)
  const nm = join(profileDir, 'node_modules')
  const link = join(nm, PLUGIN_NAME)
  mkdirSync(nm, { recursive: true })

  let exists = false
  try {
    lstatSync(link)
    exists = true
  } catch {
    exists = false
  }

  if (exists) {
    try {
      if (resolve(link) === pluginDir) {
        ok('node_modules 里的链接已正确')
        return
      }
    } catch {
      /* 继续处理 */
    }
    warn('已存在但指向不对，正在重设')
    rmSync(link, { recursive: true, force: true })
  }

  if (opts.dryRun) {
    ok('dry-run：会创建链接')
    return
  }

  try {
    symlinkSync(pluginDir, link, linkMode)
    ok(`已创建${linkMode === 'junction' ? '目录联接' : '软链'}`)
  } catch (e) {
    warn(`创建链接失败：${e.message}`)
    warn('影响不大 —— DSH 会按 package.json 里的 link: 路径解析；')
    if (linkMode === 'junction') warn('若启动后插件没出现，请以管理员身份重跑本脚本。')
  }
}

export function register({ pluginDir, opts, registerScript, fail }) {
  const { profileDir } = paths(pluginDir, opts.profile)
  say('4/5 把插件注册进 profile')
  if (opts.dryRun) {
    ok('dry-run：会写入 dependencies 与 bundles')
    return
  }
  const r = spawnSync(process.execPath, [registerScript, profileDir, pluginDir], { stdio: 'inherit' })
  if (r.status !== 0) {
    fail('注册失败')
    return
  }
  linkIntoNodeModules({ pluginDir, opts, linkMode: process.platform === 'win32' ? 'junction' : 'dir' })
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
/**
 * @param {string[]} nextSteps 本平台特有的后续步骤（人话，逐条列）
 */
export function finish({ failures, warnText = warn, nextSteps = [] }) {
  say('5/5 完成')
  console.log()
  if (failures) {
    console.log(`  ${redText(`有 ${failures} 项失败`)}，先解决上面的问题再重启 DSH。`)
    console.log()
  }
  console.log('  接下来：')
  nextSteps.forEach((line, i) => console.log(`    ${i + 1}. ${line}`))
  console.log()
  console.log('  自检：curl -s 127.0.0.1:2083/status')
  console.log()
  console.log(`  ${yellow('注意')}：需自备 ChatGPT 账号与网络线路；自动化操作网页可能违反`)
  console.log('        OpenAI 服务条款（账号有被封风险）。详见 README 的使用条件与免责声明。')
  console.log()
  process.exit(failures ? 1 : 0)
}

export { red }
