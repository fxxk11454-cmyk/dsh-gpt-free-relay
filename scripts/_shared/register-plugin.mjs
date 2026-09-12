/**
 * 把本插件注册进一个 DSH profile。
 *
 * Unix 与 Windows 两套部署脚本**都调用它** —— 免得同一段 JSON 改两遍还改歪。
 * 它本身不含任何平台判断（那是调用方的事），只做两件事：
 * 往 profile 的 package.json 里写 link 依赖、把包名加进 bundle 列表。
 *
 * 位置：scripts/_shared/register-plugin.mjs
 *   调用方：scripts/unix/deploy.mjs 与 scripts/windows/deploy.mjs
 *
 * 用法：
 *   node scripts/_shared/register-plugin.mjs <profile目录> <插件目录>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NAME = 'dsh-gpt-free-relay'

const [profileDirArg, pluginDirArg] = process.argv.slice(2)
if (!profileDirArg || !pluginDirArg) {
  console.error('用法: node scripts/_shared/register-plugin.mjs <profile目录> <插件目录>')
  process.exit(1)
}

const profileDir = resolve(profileDirArg)
const pluginDir = resolve(pluginDirArg)
const pkgPath = join(profileDir, 'package.json')

if (!existsSync(pkgPath)) {
  console.error(`  ✗ 找不到 ${pkgPath}`)
  console.error('    请先启动一次 DSH 让它创建 profile，或用 --profile 指定正确的名字。')
  process.exit(1)
}

let pkg
try {
  // profile 的 package.json 可能是 pnpm 生成的，保留原格式再写回
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (e) {
  console.error(`  ✗ 解析 ${pkgPath} 失败：${e.message}`)
  process.exit(1)
}

pkg.dependencies ||= {}
pkg.dsh ||= {}
pkg.dsh.profile ||= {}
pkg.dsh.profile.bundles ||= []

// Windows 上路径是反斜杠，pnpm 解析 link: 时要求正斜杠
const dir = pluginDir.replace(/\\/g, '/')
const spec = `link:${dir}`

const before = pkg.dependencies[NAME]
pkg.dependencies[NAME] = spec
const added = !pkg.dsh.profile.bundles.includes(NAME)
if (added) pkg.dsh.profile.bundles.push(NAME)

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

console.log(`  ✓ dependencies["${NAME}"] = ${spec}${before && before !== spec ? `（原为 ${before}）` : ''}`)
console.log(added ? `  ✓ bundles 已加入 ${NAME}` : `  ✓ bundles 中已存在 ${NAME}`)
