/**
 * 慢带:**真产物能不能跑起来**(T18 AC3)—— 用钉版 SDK 的 `build_dists` 打一个 pc 包,
 * 解出来,启动里面的主程序。
 *
 * 为什么必须是"真启动":这一票最容易自欺的地方就是"构建命令退出码 0 = 能发".
 * 实测过的那一类坑(lint/compile 对启动期错误都返回 0)在这里同样成立 ——
 * **构建成功 ≠ 打出来的东西能跑**。所以这条慢带做完整条链:
 *
 *   建项目 → 前置检查通过 → `publish()`(真 SDK 真构建)→ 产物在项目源树之外 →
 *   解压 → 启动包里的主程序 → 进程活着、没有 traceback → 杀掉。
 *
 * 它很慢(zip 里是完整的运行时,几百 MB),所以只住在慢带里,**发版前必跑**。
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extract from 'extract-zip'
import { createProjectService } from './project-service.ts'
import { realDistribute } from './publish.ts'
import { findLauncher, platformLauncherName } from './hash.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

/** 钉版 SDK(与别的慢带同一口径;`GALFREE_SDK_DIR` 跳过 155MB 下载)。 */
async function sdkDirFor(): Promise<string> {
  const dir = process.env.GALFREE_SDK_DIR !== undefined && process.env.GALFREE_SDK_DIR !== ''
    ? process.env.GALFREE_SDK_DIR
    : join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-galfree', 'sdk')
  if ((await findLauncher(dir)) === null) throw new Error(`慢带需要真 SDK,但在 ${dir} 找不到启动器(设 GALFREE_SDK_DIR 或先完成 SDK 供给)`)
  return dir
}

/** 顶层两层目录(失败时把现场交出来用)。 */
async function describeTree(dir: string, depth = 0): Promise<string> {
  const lines: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '[dir] ' : ''}${entry.name}`)
    if (entry.isDirectory() && depth < 1) lines.push(await describeTree(join(dir, entry.name), depth + 1))
  }
  return lines.join('\n')
}

/** 在目录里找主程序:pc 包里是 `<名字>.exe`(Windows),不是 lib/ 下的运行时。 */
async function findExecutable(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findExecutable(abs, depth + 1)
      if (nested !== null) return nested
      continue
    }
    // 排除运行时自带的 exe(它们在 lib/ 里,是引擎本体,不是我们的游戏)。
    if (!entry.name.toLowerCase().endsWith('.exe')) continue
    if (abs.split(/[\\/]/).includes('lib')) continue
    return abs
  }
  return null
}

describe('本地发布(慢带,真 SDK 真构建)', () => {
  it('build_dists 打出 pc 包 → 产物在项目之外 → 解压后主程序真能启动', async () => {
    const sdkDir = await sdkDirFor()
    const base = await makeTempDir('galfree-slow-publish-')
    const projectsRoot = join(base, 'projects')
    const outRoot = await mkdtemp(join(tmpdir(), 'galfree-slow-dist-'))
    await mkdir(projectsRoot, { recursive: true })

    const service = createProjectService({
      dataDir: join(base, 'data'),
      publish: {
        ports: {
          resolveLauncher: async () => await findLauncher(sdkDir),
          run: realDistribute,
        },
        destination: () => join(outRoot, 'dist'),
      },
    })

    try {
      const project = await service.createProject({ projectsRoot, name: 'pubslow', title: '发布慢带', sdkDir })
      const root = project.root

      // 内容干净:一场可达的戏 + 一句对白(否则前置就会拦下来 —— 那本身也是正确行为)。
      await service.writeProjectFiles('pubslow', [{
        path: 'game/scenes/scene_one.rpy',
        content: 'label scene_one:\n    "（开场）"\n    return\n',
        expectVersion: 'absent',
      }], { origin: 'agent', reason: 'scenario' })
      const snap = await service.readProjectFile('pubslow', 'game/script.rpy')
      await service.writeProjectFiles('pubslow', [{
        path: 'game/script.rpy',
        content: snap.content.replace(/^label start:\n/m, 'label start:\n    jump scene_one\n'),
        expectVersion: snap.version,
      }], { origin: 'agent', reason: 'scenario' })

      // 前置:一个**从没跑过**的项目应当被如实拦下 —— 界面图还没生成(T18 实测:
      // 那是 Ren'Py 首次运行时干的事,发行版里没有那个生成器)。
      const fresh = await service.publishReadiness('pubslow')
      expect(fresh.ready).toBe(false)
      expect(fresh.blockers.map((entry) => entry.code)).toEqual(['gui-images-missing'])

      // 先跑一次游戏(现实里就是点一下「试玩」):界面图会落进项目。
      const launcher = (await findLauncher(sdkDir))!
      await new Promise<void>((resolvePromise) => {
        const child = spawn(launcher, [root], { windowsHide: false })
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* 已经没了 */ }
          resolvePromise()
        }, 20_000)
        timer.unref?.()
        child.on('error', () => { clearTimeout(timer); resolvePromise() })
        child.on('close', () => { clearTimeout(timer); resolvePromise() })
      })
      if (!existsSync(join(root, 'game', 'gui', 'textbox.png'))) {
        // 失败时把现场交出来(与主程序那条一样:守卫要说得出"为什么")。
        console.log(`[publish] game/gui 里有什么:\n${await describeTree(join(root, 'game', 'gui'))}`)
        for (const name of ['game/log.txt', 'game/traceback.txt', 'log.txt', 'traceback.txt', 'game/errors.txt']) {
          const text = await readFile(join(root, ...name.split('/')), 'utf8').catch(() => null)
          if (text !== null && text.trim() !== '') console.log(`[publish] ${name}:\n${text.slice(-2500)}`)
        }
      }
      expect(existsSync(join(root, 'game', 'gui', 'textbox.png')), '跑了一次之后界面图应当生成进项目').toBe(true)
      const readiness = await service.publishReadiness('pubslow')
      expect(readiness.blockers, `前置没过:${JSON.stringify(readiness.blockers)}`).toEqual([])

      // 真构建(默认 pc 包;这一步很慢)。

      // 真构建(默认 pc 包;这一步很慢)。
      const report = await service.publish('pubslow', { packages: ['pc'] })
      console.log(`[publish] ok=${report.ok} exit=${report.run?.exitCode ?? '-'} artifacts=${report.run?.artifacts.length ?? 0}`)
      if (!report.ok) console.log(`[publish] 构建日志尾部:\n${report.run?.logTail ?? '(无)'}`)
      expect(report.ok, `构建没成功(exit=${report.run?.exitCode})`).toBe(true)

      const run = report.run!
      expect(run.artifacts.length).toBeGreaterThan(0)
      const artifact = run.artifacts.find((entry) => entry.name.endsWith('.zip'))!
      expect(artifact).toBeDefined()
      expect(artifact.bytes).toBeGreaterThan(1_000_000) // 真包里有完整运行时,不可能只有几 KB
      // 包名里必须有项目名:没有 build.name 时 Ren'Py 会打出 `-pc.zip` / `.exe`(实测过)——
      // 这条断言就是那次实测的守卫。
      expect(artifact.name, `包名里没有项目名(模板的 build.name 丢了?):${artifact.name}`).toContain('pubslow')
      // AC4:产物在项目源树之外。
      expect(artifact.path.startsWith(root)).toBe(false)

      // 解压 → 找主程序。
      const unpacked = join(outRoot, 'unpacked')
      await mkdir(unpacked, { recursive: true })
      await extract(artifact.path, { dir: unpacked })
      const executable = await findExecutable(unpacked)
      expect(executable, `解出来的包里没找到主程序:${(await readdir(unpacked)).join(', ')}`).not.toBeNull()
      expect((await stat(executable!)).size).toBeGreaterThan(1000)
      expect(executable!, '主程序名是空的 = build.name 没生效').toMatch(/pubslow\.exe$/i)

      // 真启动:进程活着 = 打出来的东西真能跑(不是"构建退出码 0"就算数)。
      // 失败时**把现场交出来**(子进程输出 + 包里的 log/traceback/errors)——
      // 一条只会说"挂了"的守卫,等于让人再去猜一遍。
      const cwd = join(executable!, '..')
      const alive = await new Promise<{ ok: boolean; note: string }>((resolvePromise) => {
        const child = spawn(executable!, [], { cwd, windowsHide: false })
        let output = ''
        let settled = false
        const finish = (ok: boolean, note: string): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { child.kill() } catch { /* 已经没了 */ }
          resolvePromise({ ok, note })
        }
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
        // 启动期就崩的话,进程会在这段时间内退出(退出码非 0 或直接结束)。
        const timer = setTimeout(() => finish(true, '存活到超时(按预期)'), 12_000)
        timer.unref?.()
        child.on('error', (error) => finish(false, `启动失败:${String(error)}`))
        child.on('close', (code) => finish(false, `进程自己退出了(退出码 ${code ?? 'null'})`))
      })
      console.log(`[publish] 产物主程序:${alive.ok ? '活着' : '挂了'}(${alive.note})`)
      if (!alive.ok) {
        console.log(`[publish] 解出来的包(前两层):\n${await describeTree(unpacked)}`)
        for (const name of ['log.txt', 'traceback.txt', 'errors.txt']) {
          for (const candidate of [join(cwd, name), join(unpacked, name)]) {
            const text = await readFile(candidate, 'utf8').catch(() => null)
            if (text !== null && text.trim() !== '') console.log(`[publish] ${name}(${candidate}):\n${text.slice(-3000)}`)
          }
        }
      }
      expect(alive.ok, alive.note).toBe(true)

      // 包里/项目里都不能有 traceback:真崩过会留下痕迹(Ren'Py 写在 game/ 下,
      // 早期版本也可能落在根目录 —— 两处都看)。
      for (const candidate of [
        join(unpacked, 'traceback.txt'),
        join(unpacked, 'game', 'traceback.txt'),
        join(cwd, 'traceback.txt'),
        join(cwd, 'game', 'traceback.txt'),
      ]) {
        const text = await readFile(candidate, 'utf8').catch(() => '')
        // 失败时把原文交出来(守卫要说得出"为什么"),再断言。
        if (text.trim() !== '') console.log(`[publish] traceback(${candidate}):\n${text.slice(0, 3000)}`)
        expect(text, `产物里留下了 traceback:${candidate}`).toBe('')
      }

      // 项目源树仍然干净:构建没往项目里塞东西(AC4)。
      const dists = join(root, 'dists')
      expect(existsSync(dists), 'Ren\'Py 默认会往项目里写 dists/ —— 我们要求产物在源树之外').toBe(false)
    } finally {
      await service.dispose()
      await cleanupTempDirs()
      await rm(outRoot, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
    }
  })
})
