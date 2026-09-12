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
import type { SpawnResult } from './playtest.ts'
import { realSpawn } from './playtest.ts'

describe('试玩控制(T7,假 spawn)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t7-data-')
    projectsRoot = await makeTempDir('galfree-t7-projects-')
    service = createProjectService({
      dataDir,
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
    service = createProjectService({ dataDir: dataDir + '-3', playtest: { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) } })
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
})
