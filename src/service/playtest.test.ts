/**
 * T7 seam tests — 试玩控制(钉版 SDK 启动/退出/日志回传)。
 * 快带用假 spawn(不起真 GUI);真 SDK 启动冒烟在 *.slow.test.ts。
 * 技术通过 = 推导(日志干净/退出码),不是人盖;"玩过了、行"才是审读戳。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import type { SpawnResult } from './playtest.ts'
import { realSpawn, waitForExit } from './playtest.ts'

describe('试玩控制(T7,假 spawn)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t7-data-')
    projectsRoot = await makeTempDir('galfree-t7-projects-')
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      playtest: {
        resolveLauncher: async () => '/fake/renpy.exe',
        spawn: async () => ({ code: 0, log: "Ren'Py 8.5.3 starting\n" }),
      },
    })
    await service.createProject({ projectsRoot, name: 'play', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it("空模板从接缝启动试玩,正常退出后状态『技术通过』", async () => {
    const run = await service.playtestStart('play')
    expect(run).toMatchObject({ exitCode: 0, technicalPass: true })
    const progress = await service.progress('play')
    expect(progress.playtest).toMatchObject({ state: 'pass', exitCode: 0 })
    // 无手写入口:服务上不暴露任何 setPlaytest / writePlaytest。
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
    expect(proto.filter((k) => /^(set|write|patch|store)Playtest/i.test(k))).toEqual([])
  })

  it('工作台路由同链路:launch 走同一控制器与同一记录(单一真相)', async () => {
    const first = await service.playtestStart('play')
    const second = await service.playtestStart('play')
    expect(second.at >= first.at).toBe(true)
    const progress = await service.progress('play')
    // 板上只呈现最近一次运行事实(同源推导),不是两条手写记录。
    expect(progress.playtest?.at).toBe(second.at)
  })

  it('注入坏脚本(子集内语义错,运行期 traceback)→ 摘要回传状态对象', async () => {
    service = createProjectService({
      dataDir: dataDir + '-2',
      uiTemplate: fakeUiTemplate(sdkDir),
      playtest: {
        resolveLauncher: async () => '/fake/renpy.exe',
        spawn: async () => ({
          code: 1,
          log: [
            'Full traceback:',
            '  script.rpy:3 in unknown',
            "    raise Exception('boom')",
            'Exception: boom',
          ].join('\n'),
        } satisfies SpawnResult),
      },
    })
    await service.createProject({ projectsRoot, name: 'bad-play', title: undefined })
    const run = await service.playtestStart('bad-play')
    expect(run.technicalPass).toBe(false)
    expect(run.traceback).toContain('Exception: boom')
    const progress = await service.progress('bad-play')
    expect(progress.playtest).toMatchObject({ state: 'fail', exitCode: 1 })
    expect(progress.playtest?.traceback).toContain('Exception')
    expect(progress.summary.playtestFail).toBe(1)
  })

  it('SDK 未就绪 → 试玩如实失败并报告原因(不静默)', async () => {
    service = createProjectService({
      dataDir: dataDir + '-3',
      uiTemplate: fakeUiTemplate(sdkDir),
      playtest: { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) },
    })
    await service.createProject({ projectsRoot, name: 'nosdk', title: undefined })
    await expect(service.playtestStart('nosdk')).rejects.toMatchObject({ code: 'sdk-not-ready' })
    const progress = await service.progress('nosdk')
    expect(progress.playtest).toBeNull() // 从未成功跑过 → 板上"试玩未跑"
    expect(progress.summary.playtestNotRun).toBe(1)
  })

  it('试玩后又改了内容 → 试玩态推导为 stale(过期),如实呈现', async () => {
    await service.playtestStart('play')
    const v = (await service.readProjectFile('play', 'game/script.rpy')).version
    await service.writeProjectFiles('play', [{ path: 'game/script.rpy', content: 'label start:\n    "改了一句。"\n    return\n', expectVersion: v }], { reason: 'edit', origin: 'workbench' })
    const progress = await service.progress('play')
    expect(progress.playtest?.state).toBe('stale')
  })

  // ─── 真 spawn 的两个实测教训(用户点"试玩"没反应换来的)───────────────

  it('真 spawn:**不隐藏窗口**(windowsHide 不能开,否则用户以为点了没反应)', async () => {
    // 用一个真进程当替身:让它立刻打印并退出,验证"能起来 → 拿到输出 → 退出码回传"。
    // (脚本走环境变量传,免得被附加的项目路径参数顶掉 -e 的位置。)
    process.env.GALFREE_TEST_SRC = 'console.log("game started")'
    const result = await realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 10_000 })
    delete process.env.GALFREE_TEST_SRC
    expect(result.code).toBe(0)
    expect(result.log).toContain('game started')
  })

  it('真 spawn:**到点必须中止**,不无限期挂着(僵进程就是这么来的)', async () => {
    const started = Date.now()
    process.env.GALFREE_TEST_SRC = 'setTimeout(() => {}, 60000)'
    const result = await realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 800 })
    delete process.env.GALFREE_TEST_SRC
    expect(result.code).toBe(-1)
    expect(result.log).toContain('等待超时')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('真 spawn:启动器不存在时如实抛错(不静默)', async () => {
    await expect(realSpawn('/definitely/not/here/renpy.exe', 'x', { timeoutMs: 2000 })).rejects.toBeTruthy()
  })

  it('真 spawn:**已经取消过就一个进程都不起**(不是"起了再杀")', async () => {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = await realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 10_000, signal: controller.signal })
    expect(result.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('真 spawn:**取消要立刻杀掉子进程并回传"被取消"**(不是等它自己退出)', async () => {
    process.env.GALFREE_TEST_SRC = 'setTimeout(() => {}, 60000)'
    const controller = new AbortController()
    const started = Date.now()
    const pending = realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 600_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    const result = await pending
    delete process.env.GALFREE_TEST_SRC
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    // "确认"那一半:进程真退了才叫 killed(替身进程对 SIGTERM 是有反应的)。
    expect(result.killed).toBe(true)
    // 关键:不是"等到 10 分钟超时才回来"。
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  // ─── 一次试玩"停了多久 / 为什么停"要能断言(T24)──────────────────────

  it('超时回报带**等了多久 / 为什么停**(可断言,不是一句没法核的话)', async () => {
    process.env.GALFREE_TEST_SRC = 'setTimeout(() => {}, 60000)'
    const result = await realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 600 })
    delete process.env.GALFREE_TEST_SRC
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.killed).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400)
    expect(result.elapsedMs).toBeLessThan(10_000)
  })

  it('正常退出时 elapsedMs 照旧有(好让面板与账本说得出"跑了多久")', async () => {
    process.env.GALFREE_TEST_SRC = 'console.log("done")'
    const result = await realSpawn(process.execPath, '', { omitProjectArg: true, timeoutMs: 10_000 })
    delete process.env.GALFREE_TEST_SRC
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  // ─── 接缝:取消是**协作式**的,试玩这条必须自己观察信号(T24 / #32)───

  describe('取消契约(协作式取消:谁等谁就得自己观察信号)', () => {
    it('已经取消过 → 起步前就停:不 spawn、记账本里不留一条"假试玩"', async () => {
      let spawned = 0
      service = createProjectService({
        dataDir: dataDir + '-aborted',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async () => {
            spawned += 1
            return { code: 0, log: '' }
          },
        },
      })
      await service.createProject({ projectsRoot, name: 'aborted', title: undefined })
      const controller = new AbortController()
      controller.abort()
      await expect(service.playtestStart('aborted', null, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
      expect(spawned).toBe(0)
      // "被取消"是一次没发生的试玩:板上照旧"试玩未跑"(不留下一条技术通过/失败)。
      const progress = await service.progress('aborted')
      expect(progress.playtest).toBeNull()
      expect(progress.summary.playtestNotRun).toBe(1)
    })

    it('跑起来之后取消 → 子进程收到中止,接缝如实报被取消', async () => {
      let sawAbort = false
      const controller = new AbortController()
      service = createProjectService({
        dataDir: dataDir + '-during',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async (_launcher, _root, options) => await new Promise<SpawnResult>((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              sawAbort = true
              resolve({ code: -1, log: 'killed', aborted: true, timedOut: false, elapsedMs: 5 })
            })
            setTimeout(() => controller.abort(), 20)
          }),
        },
      })
      await service.createProject({ projectsRoot, name: 'during', title: undefined })
      await expect(service.playtestStart('during', null, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
      expect(sawAbort).toBe(true)
      expect((await service.progress('during')).playtest).toBeNull()
    })

    it('面板那条路:运行中能取消(cancelPlaytest → 工具体当场回来,不等到 15 分钟)', async () => {
      service = createProjectService({
        dataDir: dataDir + '-cancel',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async (_launcher, _root, options) => await new Promise<SpawnResult>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve({ code: -1, log: 'killed', aborted: true, timedOut: false, elapsedMs: 1 }))
          }),
        },
      })
      await service.createProject({ projectsRoot, name: 'cancel', title: undefined })
      const running = service.playtestStart('cancel')
      await new Promise((resolve) => setTimeout(resolve, 30))
      const stopped = await service.cancelPlaytest()
      expect(stopped).toBe(true)
      await expect(running).rejects.toMatchObject({ code: 'aborted' })
      // 没有在跑 → 取消本身如实说"没有可取消的"(不假装杀掉了一个进程)。
      expect(await service.cancelPlaytest()).toBe(false)
    })

    it('一次只跑一个:第二个调用排在后面(同时开两个游戏窗口没有意义)', async () => {
      let concurrent = 0
      let peak = 0
      service = createProjectService({
        dataDir: dataDir + '-serial',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async () => {
            concurrent += 1
            peak = Math.max(peak, concurrent)
            await new Promise((resolve) => setTimeout(resolve, 60))
            concurrent -= 1
            return { code: 0, log: "Ren'Py 8.5.3 starting\n", timedOut: false, aborted: false, elapsedMs: 60 }
          },
        },
      })
      await service.createProject({ projectsRoot, name: 'serial', title: undefined })
      const [first, second] = await Promise.all([service.playtestStart('serial'), service.playtestStart('serial')])
      expect(peak).toBe(1)
      expect(first.technicalPass).toBe(true)
      expect(second.technicalPass).toBe(true)
      // 两条都落了账本(排队,不是丢掉一条)。
      expect((await service.progress('serial')).playtest?.at).toBe(second.at)
    })

    it('排队中的第二个调用:不算"在跑",而且取消它当场生效(不白等前一个)', async () => {
      // 两个真缺陷的守卫:① 排队中的调用不该让 `playtestRunning()` 说"在跑"
      // (面板会对着一个还没开始的调用显示"取消",还声称杀掉了一个进程);
      // ② 它在排队期间被取消要**立刻**退出,而不是"等前一个跑完再照跑一遍"。
      let spawned = 0
      service = createProjectService({
        dataDir: dataDir + '-queued',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          // 超时 0 → 第一个调用一进来就"等满上限",于是它占着位子待一会儿。
          spawn: async (_launcher, _root, options) => await new Promise<SpawnResult>((resolve) => {
            spawned += 1
            setTimeout(() => resolve({ code: -1, log: 'timeout', timedOut: true, aborted: false, elapsedMs: options?.timeoutMs ?? 0 }), 120)
          }),
        },
      })
      await service.createProject({ projectsRoot, name: 'queued', title: undefined })
      const first = service.playtestStart('queued', null, { timeoutMs: 0 })
      const deadline = Date.now() + 3_000
      while (!service.playtestRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
      expect(service.playtestRunning()).toBe(true)

      const controller = new AbortController()
      const queued = service.playtestStart('queued', null, { signal: controller.signal })
      expect(service.playtestRunning()).toBe(true) // 是**第一个**在跑,不是排队的这个
      controller.abort()
      const started = Date.now()
      await expect(queued).rejects.toMatchObject({ code: 'aborted' })
      expect(Date.now() - started).toBeLessThan(1_000) // 等了前一个才回来 = 红
      expect(spawned).toBe(1) // 排队那个**一个进程都没起**
      await first
    })

    it('中止了但进程没停 → 如实说 `killed: false`(不替它宣布"已杀掉")', async () => {
      // "确认"那一半(Windows 上 SIGTERM 对 GUI 子树是尽力而为)没法在真进程上量 ——
      // `child.kill()` 一定能让替身退掉。所以直接验那条判据的两个出口(`waitForExit`)。
      const neverClosed = await waitForExit({
        hasExited: () => false,
        onClosed: () => { /* 永远不会有 close */ },
        graceMs: 50,
      })
      expect(neverClosed).toBe(false)

      const closedLater = await waitForExit({
        hasExited: () => false,
        onClosed: (callback) => setTimeout(callback, 20),
        graceMs: 500,
      })
      expect(closedLater).toBe(true)

      // 已经退了的:不用等,立刻 true(那条路是"正常退出",不该白等一个宽限期)。
      const started = Date.now()
      expect(await waitForExit({ hasExited: () => true, onClosed: () => {}, graceMs: 5_000 })).toBe(true)
      expect(Date.now() - started).toBeLessThan(500)
    })

    it('超时不再默认静默等 15 分钟:有界、且回报里带"等了多久 / 为什么停"', async () => {
      service = createProjectService({
        dataDir: dataDir + '-timeout',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async (_launcher, _root, options) => {
            options?.signal?.addEventListener('abort', () => { /* 只是别让监听器泄漏 */ })
            await new Promise((resolve) => setTimeout(resolve, options?.timeoutMs ?? 0))
            return { code: -1, log: 'timeout', timedOut: true, aborted: false, elapsedMs: options?.timeoutMs ?? 0 }
          },
        },
      })
      await service.createProject({ projectsRoot, name: 'slow', title: undefined })
      const run = await service.playtestStart('slow', null, { timeoutMs: 40 })
      expect(run.timedOut).toBe(true)
      expect(run.elapsedMs).toBe(40)
      expect(run.exitCode).toBe(-1)
      // 超时是一次**没跑成**的试玩:记进账本,但不冒充技术通过。
      const progress = await service.progress('slow')
      expect(progress.playtest?.state).toBe('fail')
      expect(progress.playtest?.timedOut).toBe(true)
      // 「下一步」要指对方向:等满上限不是"照 traceback 修",而是"请人把窗口关掉"(T24)。
      const action = progress.nextActions.find((candidate) => candidate.code.startsWith('playtest'))
      expect(action?.code).toBe('playtest-timed-out')
      expect(action?.actor).toBe('human')
    })
  })
})
