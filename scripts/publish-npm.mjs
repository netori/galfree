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

/* 探测用的 npm 参数:每次探测都必须**有界且快**。
 *
 * 不加这两条时,`npm view` 对一个不存在的包自己会重试到 ~42 秒才返回
 * (实测:4 次探测 = 228 秒)—— 外层的轮询预算因此完全失真。
 * 探测是"读一眼",不是"一定要读到",所以把 npm 自己的重试压到 1 次、超时 15 秒。 */
const PROBE_ARGS = ['--fetch-retries=1', '--fetch-retry-maxtimeout=5000', '--fetch-timeout=15000']

/**
 * 轮询读一次 registry 视图,直到**这个版本**读得到为止。
 *
 * 为什么要轮询(两次都是现场教出来的):
 *   ① 刚发完的几秒,registry 的读可能还是 404 —— 发布成功却判失败;
 *   ② 也可能读得到包、但 `version` 还是**上一版** —— 而脚本立刻断言"版本不一致"
 *      就报失败(0.1.1 的实际经历:写入成功,读回来了 0.1.0)。
 * 所以判据是"读到的 version 等于我要发的那个",直到预算用完;
 * "读到了但一直是旧版"与"根本没读到"分开报。
 */
async function readBackUntilVersion(name, want, budgetMs = 180_000) {
  const started = Date.now()
  let attempts = 0
  let last = ''
  let saw = null
  while (Date.now() - started < budgetMs) {
    attempts += 1
    try {
      const info = JSON.parse(npm(['view', name, 'version', 'dist.tarball', '--json', ...PROBE_ARGS]))
      saw = info
      if (info.version === want) {
        readBackUntilVersion.attempts = attempts
        readBackUntilVersion.saw = info
        return info
      }
      console.log(`… registry 读到的还是 ${info.version}(要的是 ${want}),第 ${attempts} 次`)
    } catch (error) {
      last = npmErrorText(error)
      console.log(`… registry 还没读到(第 ${attempts} 次,传播延迟)`)
    }
    const remaining = budgetMs - (Date.now() - started)
    if (remaining <= 0) break
    const waitMs = Math.min(3000 * attempts, 15_000, remaining)
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  readBackUntilVersion.lastError = last
  readBackUntilVersion.attempts = attempts
  readBackUntilVersion.saw = saw
  return null
}

// 自测:轮询这条路要能被单独测到(否则"刚发完读不到"只能在现场碰运气)。
// 放在发布守卫之前 —— 自测不改动任何东西,不该被"工作区干净"挡下。
// 断言的是**重试预算真的花完了**(不是"最终返回 null"):只重试一次就放弃
// 是 v2 的真缺陷,而那种情况同样会返回 null —— 只断言 null 会漏掉它。
if (args.includes('--selftest-readback')) {
  const bogus = 'dsh-galfree-this-package-should-never-exist'
  console.log(`\n自测 A:对一个不存在的包名轮询(应当耗掉预算,如实报"读不到")\n包名:${bogus}\n`)
  const t0 = Date.now()
  const missing = await readBackUntilVersion(bogus, pkg.version, 60_000)
  const secA = Math.round((Date.now() - t0) / 1000)
  const triesA = readBackUntilVersion.attempts
  const passA = missing === null && triesA >= 3
  console.log(`结果A:${missing === null ? '读不到(预期)' : '竟然读到了 —— 自测失效'}  用时 ${secA} 秒,尝试 ${triesA} 次`)

  console.log(`\n自测 B:对**真实存在但我们不要那个版本**的包轮询(应当一直重试到预算用完)\n包名:${pkg.name},要的版本:9.9.9(永不存在)\n`)
  const t1 = Date.now()
  const wrong = await readBackUntilVersion(pkg.name, '9.9.9', 45_000)
  const secB = Math.round((Date.now() - t1) / 1000)
  const triesB = readBackUntilVersion.attempts
  const sawB = readBackUntilVersion.saw?.version
  const passB = wrong === null && triesB >= 2 && typeof sawB === 'string' && sawB !== '9.9.9'
  console.log(`结果B:${wrong === null ? '未拿到目标版本(预期)' : '竟然拿到了 —— 自测失效'}  用时 ${secB} 秒,尝试 ${triesB} 次,读到的版本=${sawB}`)
  console.log(passB ? '  ✓ 自测 B 通过:读到了旧版本也没有立刻放弃,而是重试到预算用完' : '  ✗ 自测 B 失败:期望"读到旧版本后继续重试"')

  console.log(passA && passB ? '\n✓ 自测通过(A 与 B)' : '\n✗ 自测失败')
  process.exit(passA && passB ? 0 : 1)
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
  // npm 对"这个版本已经发过了"报的是 E403 + "cannot publish over the previously
  // published versions"。它可能是**同一次发布的第二次尝试**(上一次写成功了、只是读还没跟上),
  // 也可能真的是重复发布 —— 两种都不该在此时判死,交给下面的读回轮询去定论。
  if (/previously published versions/i.test(stdout + stderr)) {
    console.log(`\n… npm 说 ${pkg.version} 已经在 registry 上了 —— 可能是上一次已经写成功(读延迟)。继续读回核对。`)
  } else {
    console.error(`\n✗ npm publish 失败(status=${error?.status ?? 'unknown'})—— 上面是它的原话`)
    if (/EOTP|one-time pass/i.test(stdout + stderr)) {
      console.error('  这是两步验证:把当时的 6 位验证码给我,用 --otp=<code> 重发')
    }
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(stdout + stderr)) {
      console.error('  这是网络到不了官方 registry。若本机有代理:npm 支持 HTTPS_PROXY,例如')
      console.error('    $env:HTTPS_PROXY=\'http://127.0.0.1:7897\'; npm run release:npm')
    }
    process.exit(1)
  }
}

if (dryRun) {
  console.log('\n(dry-run:到此为止)')
  process.exit(0)
}

// ── 3. 从 registry 读回来核对(轮询到"这个版本"出现为止)──────────────
const info = await readBackUntilVersion(pkg.name, pkg.version)
if (info === null) {
  const saw = readBackUntilVersion.saw
  console.error('\n✗ 发布命令没报错,但 registry 上读不到这个版本 —— 两种可能:')
  if (saw !== null) console.error(`  ① 读延迟:目前读到的是 ${saw.version}(要的是 ${pkg.version})—— 过几分钟再核对`)
  else console.error(`  ① 读延迟:连包都还没读到(${readBackUntilVersion.lastError})`)
  console.error('  ② 发布其实没落地 —— 去 https://www.npmjs.com/package/' + pkg.name + '?activeTab=versions 看一眼')
  process.exit(1)
}
console.log('\nregistry 上现在是这样:')
console.log(JSON.stringify(info))
console.log(`\n✓ 发布成功:${pkg.name}@${pkg.version}`)
console.log(`  用户装法:dsh plugin --profile web add ${pkg.name}`)
console.log('  市场:awesome-dsh-plugin 会从 registry 自动采集 npm 映射(条目里不要写 npm: 字段)')
console.log('  还差:同一版挂一份到 GitHub Release(见 docs/release-to-npm.md —— 本机传不上去)')
