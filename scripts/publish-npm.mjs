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
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org/'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otp = args.find(a => a.startsWith('--otp='))?.slice('--otp='.length)

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', ...options })
}

/**
 * 跑一次 npm。
 *
 * 为什么不 `execFileSync('npm', …)` + `shell: true`:Windows 上 npm 是 `npm.cmd`,
 * 不套 shell 起不来;而套了 shell 又会触发 Node 的 DEP0190(`args` 只拼接、不转义 ⇒
 * 命令注入面)。所以这里绕开两头:**用 process.execPath 直接跑 npm 的 CLI 入口**,
 * 无 shell、无 .cmd 解析、跨平台一致,也不依赖 PATH 上的 npm。
 */
const NPM_CLI = join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')

function npm(commandArgs, options = {}) {
  const result = spawnSync(process.execPath, [NPM_CLI, ...commandArgs, '--registry=' + REGISTRY], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const error = new Error(`npm ${commandArgs[0]} exited with ${result.status}`)
    error.status = result.status
    error.stdout = result.stdout
    error.stderr = result.stderr
    throw error
  }
  return result.stdout ?? ''
}

/**
 * 把"命令起不来"和"命令跑失败"分开报 —— 否则同一个"没登录"的结论会把
 * 一个执行环境的故障说成凭据问题(本脚本 v1 就踩过这个坑)。
 * 返回一行摘要(给日志看),同时把完整文本挂在 .full 上 —— 判据不能只看末 4 行:
 * "404 Not Found" 那行在 stderr 的**前面**,截尾巴会让重试判定失效(v2 踩过)。
 */
function npmErrorText(error) {
  const stderr = String(error?.stderr ?? '').trim()
  const stdout = String(error?.stdout ?? '').trim()
  const full = stderr || stdout || error?.message || 'no output'
  const summary = full.split('\n').slice(-4).join(' | ')
  return Object.assign(new String(summary), { full })
}

console.log(`包:${pkg.name}@${pkg.version}`)
console.log(`目标:${REGISTRY}(${pkg.publishConfig?.access ?? 'default'} access)`)

/**
 * 轮询读一次 registry 视图。返回解析好的对象;null = 到点还读不到。
 *
 * 为什么要轮询:刚发完的那几秒 registry 的**读**可能还看不到这个包(E404)——
 * 实测过:发布本身成功、校验却 404,于是脚本把"成功"报成"失败"。
 * 传播延迟不是发布失败,所以这里重试;而"还没看到"与"看到了但版本不对"分开报。
 */
async function readBackWithRetry(name) {
  let last = ''
  let attempts = 0
  for (let attempt = 1; attempt <= 12; attempt++) {
    attempts = attempt
    try {
      const value = JSON.parse(npm(['view', name, 'version', 'dist.tarball', '--json']))
      readBackWithRetry.attempts = attempts
      return value
    } catch (error) {
      const detail = npmErrorText(error)
      last = detail
      // 判据看**完整** stderr,不是摘要:"404 Not Found" 在 stderr 前部。
      if (!/E404|Not found|could not be found|404 /i.test(String(detail.full))) break
      const waitMs = Math.min(2000 * attempt, 10_000)
      console.log(`… registry 还没读到(第 ${attempt} 次,传播延迟),${Math.round(waitMs / 1000)} 秒后再看`)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }
  readBackWithRetry.lastError = last
  readBackWithRetry.attempts = attempts
  return null
}

// 自测:轮询这条路要能被单独测到(否则"刚发完读不到"只能在现场碰运气)。
// 放在发布守卫之前 —— 自测不改动任何东西,不该被"工作区干净"挡下。
// 断言的是**重试预算真的花完了**(不是"最终返回 null"):只重试一次就放弃
// 是 v2 的真缺陷,而那种情况同样会返回 null —— 只断言 null 会漏掉它。
if (args.includes('--selftest-readback')) {
  const name = 'dsh-galfree-this-package-should-never-exist'
  console.log(`\n自测:对一个不存在的包名轮询读回(应当耗掉完整重试预算,然后如实报"读不到")\n包名:${name}\n`)
  const started = Date.now()
  const result = await readBackWithRetry(name)
  const seconds = Math.round((Date.now() - started) / 1000)
  const attempts = readBackWithRetry.attempts
  console.log(`结果:${result === null ? '读不到(预期)' : '竟然读到了 —— 自测失效'}  用时 ${seconds} 秒,尝试 ${attempts} 次`)
  console.log(`最后一次 npm 原话:${readBackWithRetry.lastError}`)
  const pass = result === null && attempts >= 8 && seconds >= 30
  console.log(pass
    ? '✓ 自测通过:确实重试到预算耗尽(不是一次就放弃)'
    : `✗ 自测失败:期望 尝试≥8 且 用时≥30 秒,实际 尝试=${attempts} 用时=${seconds} 秒`)
  process.exit(pass ? 0 : 1)
}

// ── 1. 前置 ────────────────────────────────────────────────────────────
let who
try {
  who = npm(['whoami']).trim()
} catch (error) {
  console.error('✗ 拿不到官方 registry 上的身份。npm 的原话:\n  ' + npmErrorText(error))
  console.error('  是凭据问题就跑:npm login --registry=' + REGISTRY)
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
try {
  // 捕获而不是 inherit:execFileSync 的 inherit 会把子进程输出吞掉,
  // 失败时只剩一句 "Command failed",npm 的原话反而看不到(踩过)。
  const out = npm(publishArgs)
  if (out.trim() !== '') console.log(out.trim())
} catch (error) {
  const stdout = String(error?.stdout ?? '').trim()
  const stderr = String(error?.stderr ?? '').trim()
  if (stdout !== '') console.log(stdout)
  if (stderr !== '') console.error(stderr)
  console.error(`\n✗ npm publish 失败(status=${error?.status ?? 'unknown'})—— 上面是它的原话`)
  if (/EOTP|one-time pass/i.test(stdout + stderr)) {
    console.error('  这是两步验证:把当时的 6 位验证码给我,用 --otp=<code> 重发')
  }
  process.exit(1)
}

if (dryRun) {
  console.log('\n(dry-run:到此为止)')
  process.exit(0)
}

// ── 3. 从 registry 读回来核对 ──────────────────────────────────────────
// ⚠️ 刚发完的那几秒,registry 的**读**可能还看不到这个包(E404)—— 实测过:
// 发布本身成功、校验却 404,于是脚本报"失败"。这只是传播延迟,不是发布失败,
// 所以这里要轮询;而且"还没看到"必须与"看到了但版本不对"分开报。
// ── 3. 从 registry 读回来核对 ──────────────────────────────────────────
const info = await readBackWithRetry(pkg.name)
if (info === null) {
  console.error('\n✗ 发布命令成功了,但 registry 读不到这个包 —— 两种可能:')
  console.error(`  ① 传播还没完(等一下重跑:npm view ${pkg.name} version --registry=${REGISTRY})`)
  console.error('  ② 发布其实没落地。npm 的原话:' + readBackWithRetry.lastError)
  process.exit(1)
}
console.log('\nregistry 上现在是这样:')
console.log(JSON.stringify(info))
if (info.version !== pkg.version) {
  console.error(`✗ 发布后 registry 上的 version 是 ${info.version},与期望的 ${pkg.version} 不一致`)
  process.exit(1)
}
console.log(`\n✓ 发布成功:${pkg.name}@${pkg.version}`)
console.log(`  用户装法:dsh plugin --profile web add ${pkg.name}`)
console.log('  市场:awesome-dsh-plugin 会从 registry 自动采集 npm 映射(条目里不要写 npm: 字段)')
console.log('  还差:同一版挂一份到 GitHub Release(见 docs/release-to-npm.md —— 本机传不上去)')
