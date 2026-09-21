/**
 * 发一版到 npm GDS(作者用)。做三件事,一件失败就停:
 *
 *   1. 前置:登录了没(官方 registry)、工作区是否干净、版本号是否已存在;
 *   2. `npm publish`(官方 registry、public;走 package.json 的 publishConfig,
 *      但命令行再显式给一次,免得本机用户级 .npmrc 的只读镜像插手);
 *   3. 发完**从 registry 读回来**核对(版本 + dist.tarball),不是"命令退出 0 就算成功"。
 *
 * 用法:
 *   node scripts/publish-npm.mjs                  # 发布当前 package.json 里的版本
 *   node scripts/publish-npm.mjs --otp=123456     # 账号开了两步验证时
 *   node scripts/publish-npm.mjs --dry-run        # 只预演(不发布)
 *
 * 为什么不顺手建 GitHub Release:本机 hosts 里的 GitHub 代理没覆盖
 * `uploads.github.com`,资产传不上去(gh 会 DNS 失败)。那一步见
 * `docs/release-to-npm.md` 的手工命令(或换一台能直连的机器)。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REGISTRY = 'https://registry.npmjs.org/'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otp = args.find(a => a.startsWith('--otp='))?.slice('--otp='.length)

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: options.capture === false ? 'inherit' : 'pipe', ...options })
}

function npm(commandArgs, options) {
  return run('npm', [...commandArgs, '--registry=' + REGISTRY], options)
}

console.log(`包:${pkg.name}@${pkg.version}`)
console.log(`目标:${REGISTRY}(${pkg.publishConfig?.access ?? 'default'} access)`)

// ── 1. 前置 ────────────────────────────────────────────────────────────
let who
try {
  who = npm(['whoami']).trim()
} catch {
  console.error('✗ 没登录官方 registry。先跑:npm login --registry=' + REGISTRY)
  process.exit(1)
}
console.log(`✓ 已登录:${who}`)

const dirty = run('git', ['status', '--porcelain']).trim()
if (dirty !== '' && !dryRun) {
  console.error('✗ 工作区不干净 —— 发布的是磁盘上的内容,先提交(或 stash):\n' + dirty)
  process.exit(1)
}

let published = null
try {
  published = npm(['view', `${pkg.name}@${pkg.version}`, 'version']).trim()
} catch {
  // 404 = 这个版本还没发过,正常
}
if (published !== null && published !== '') {
  console.error(`✗ ${pkg.name}@${pkg.version} 已经在 registry 上了 —— 先改 package.json 的 version`)
  process.exit(1)
}
console.log(`✓ ${pkg.name}@${pkg.version} 尚未发布`)

// ── 2. 发布(prepare 会先跑 tsdown 把 lib/ 打进包)────────────────────
const publishArgs = ['publish', '--access', pkg.publishConfig?.access ?? 'public']
if (otp !== undefined) publishArgs.push(`--otp=${otp}`)
if (dryRun) publishArgs.push('--dry-run')
console.log(`\n$ npm ${publishArgs.join(' ')} --registry=${REGISTRY}\n`)
npm(publishArgs, { capture: false })

if (dryRun) {
  console.log('\n(dry-run:到此为止)')
  process.exit(0)
}

// ── 3. 从 registry 读回来核对 ──────────────────────────────────────────
const back = npm(['view', pkg.name, 'version', 'dist.tarball', '--json'])
console.log('\nregistry 上现在是这样:')
console.log(back.trim())
const info = JSON.parse(back)
if (info.version !== pkg.version) {
  console.error(`✗ 发布后 registry 上的 version 是 ${info.version},与期望的 ${pkg.version} 不一致`)
  process.exit(1)
}
console.log(`\n✓ 发布成功:${pkg.name}@${pkg.version}`)
console.log(`  用户装法:dsh plugin --profile web add ${pkg.name}`)
console.log('  市场:awesome-dsh-plugin 会从 registry 自动采集 npm 映射(条目里不要写 npm: 字段)')
console.log('  还差:同一版挂一份到 GitHub Release(见 docs/release-to-npm.md —— 本机传不上去)')
