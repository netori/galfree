/**
 * T13 seam tests — 整线组装试玩。
 *
 * 契约来源(T13 票面):
 *  - 项目级完整性推导:全场景引用完整、开场到结局可达、**无孤立场景**,缺项**定位到场景**;
 *  - **从当前场景开始的试玩**;
 *  - 运行日志 traceback **结构化回传入板**,agent 可读、板可见。
 *
 * "素材填齐前的组装验收"由本票收口:所以这里断言的是"这条线走不走得通 + 玩得到不到",
 * 而不是美术有没有齐(那是 T14 之后的事)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const SCRIPT = [
  'label start:',
  '    "开场。"',
  '    jump middle',
  '',
  'label middle:',
  '    "中段。"',
  '    jump ending',
  '',
  'label ending:',
  '    "结局。"',
  '    return',
  '',
].join('\n')

describe('整线组装试玩(T13)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t13-data-')
    projectsRoot = await makeTempDir('galfree-t13-projects-')
    service = createProjectService({ dataDir })
    await service.createProject({ projectsRoot, name: 'flow', title: '整线' })
    const snap = await service.readProjectFile('flow', 'game/script.rpy')
    await service.writeProjectFiles('flow', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'agent', reason: 'scenario' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('完整性推导:入口 / 可达 / 结局可达;孤立场景上板并定位到它自己的 label', async () => {
    // 先看一条健康的线。
    let report = await service.completeness('flow')
    expect(report.entry).toBe('start')
    expect(report.orphans).toEqual([])
    expect(report.endingReachable).toBe(true)
    expect(report.reachable.sort()).toEqual(['ending', 'middle', 'start'])

    // 加一场没人跳过去的戏 → 孤立场景。
    await service.generateScene('flow', {
      label: 'lonely',
      source: 'label lonely:\n    "没人走得到这里。"\n    return\n',
      outline: undefined,
    })
    report = await service.completeness('flow')
    expect(report.orphans).toEqual(['lonely'])
    const orphan = report.problems.find((problem) => problem.code === 'orphan-scene')!
    expect(orphan.severity).toBe('error')
    expect(orphan.file).toBe('scenes/lonely.rpy')
    expect(orphan.line).toBeGreaterThan(0)
    expect(orphan.message).toContain('lonely')

    // 板也看得到(与完整性同源,不是两处判断)。
    const progress = await service.progress('flow')
    expect(progress.completeness.orphans).toEqual(['lonely'])
    expect(progress.problems.some((problem) => problem.code === 'orphan-scene')).toBe(true)
    expect(progress.lint.ok).toBe(false)
  })

  it('注入悬空跳转 → 完整性错误上板,并定位到所在场景', async () => {
    // 用**生成目录**里的三场链(不与模板的 start 重名,避免重复 label 把问题搅浑)。
    const active = await service.getActiveProject()
    const blank = await service.readProjectFile('flow', 'game/script.rpy')
    await service.writeProjectFiles('flow', [{ path: 'game/script.rpy', content: '# 空\n', expectVersion: blank.version }], { origin: 'agent', reason: 'scenario' })
    await service.generateScene('flow', { label: 'c_end', source: 'label c_end:\n    "结局。"\n    return\n', outline: undefined })
    await service.generateScene('flow', { label: 'b_middle', source: 'label b_middle:\n    "中段。"\n    jump c_end\n', outline: undefined, nextLabel: 'c_end' })
    await service.generateScene('flow', { label: 'a_start', source: 'label a_start:\n    "开场。"\n    jump b_middle\n', outline: undefined, nextLabel: 'b_middle' })
    // 新链的入口不是 start(那是主菜单入口),所以补一个 start 指向它。
    await service.editScene('flow', {
      label: 'a_start',
      edit: { kind: 'replaceSource', source: 'label a_start:\n    "开场。"\n    jump b_middle\n\nlabel start:\n    jump a_start\n' },
    })

    expect((await service.completeness('flow')).endingReachable).toBe(true)

    // 把中段的跳转指向不存在的 label。
    await service.editScene('flow', {
      label: 'b_middle',
      edit: { kind: 'replaceSource', source: 'label b_middle:\n    "中段。"\n    jump nowhere\n' },
    })

    const report = await service.completeness('flow')
    const dangling = report.problems.find((problem) => problem.code === 'dangling-jump')!
    expect(dangling).toBeDefined()
    expect(dangling.file).toBe('scenes/b_middle.rpy')
    // 关键:不只是"项目里有个悬空跳转",而是"在场景 b_middle 里" —— 板要能带人去那一行。
    expect(dangling.message).toContain('b_middle')

    const progress = await service.progress('flow')
    const scene = progress.scenes.find((entry) => entry.label === 'b_middle')!
    expect(scene.lintErrors).toBeGreaterThan(0)
    expect(progress.lint.ok).toBe(false)
    // 原来那条路断了:结局再也到不了。
    expect(progress.completeness.endingReachable).toBe(false)
    expect(progress.problems.some((problem) => problem.code === 'no-ending-reachable')).toBe(true)
  })

  it('从某场开始的试玩:把入口指向那一场,且目标不存在时如实拒绝', async () => {
    const calls: Array<{ root: string; from: string | null }> = []
    const withPorts = createProjectService({
      dataDir: `${dataDir}-ports`,
      // 假启动器端口:快带不碰真 SDK,但把"用什么参数启动"如实记下来。
      playtest: {
        resolveLauncher: async () => '/fake/renpy',
        spawn: async (_launcher, root, options) => {
          calls.push({ root, from: options?.fromLabel ?? null })
          return { code: 0, log: '' }
        },
      },
    })
    try {
      await withPorts.createProject({ projectsRoot: `${projectsRoot}-ports`, name: 'flow2', title: '整线2' })
      const snap = await withPorts.readProjectFile('flow2', 'game/script.rpy')
      await withPorts.writeProjectFiles('flow2', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'agent', reason: 'scenario' })

      const run = await withPorts.playtestStart('flow2', 'middle')
      expect(run.from).toBe('middle')
      expect(run.technicalPass).toBe(true)
      expect(calls).toHaveLength(1)
      // 跑的是**副本**,且副本里入口被指向 middle(用户项目不动)。
      expect(calls[0]!.from).toBe('middle')
      expect(calls[0]!.root).not.toBe(projectsRoot)

      // 目标场不存在 → 拒绝(不静默地从 start 跑一遍糊弄过去)。
      await expect(withPorts.playtestStart('flow2', 'no_such_scene')).rejects.toThrow(/不存在/)

      // 账本记下"从哪一场(start)跑的",板读得出来。
      const progress = await withPorts.progress('flow2')
      expect(progress.playtest?.from).toBe('middle')
    } finally {
      await withPorts.dispose()
    }
  })

  it('运行期错误 → traceback 摘要入状态、板可见、agent 可读', async () => {
    const withPorts = createProjectService({
      dataDir: `${dataDir}-crash`,
      playtest: {
        resolveLauncher: async () => '/fake/renpy',
        spawn: async () => ({
          code: 1,
          log: [
            'I am sorry, but an uncaught exception occurred.',
            '',
            'While running game code:',
            '  File "game/script.rpy", line 8, in script',
            '    jump nowhere',
            'Exception: label nowhere not defined',
            '',
            'Full traceback:',
            'Traceback (most recent call last):',
            '  File "renpy/main.py", line 1, in <module>',
            'Exception: label nowhere not defined',
          ].join('\n'),
        }),
      },
    })
    try {
      await withPorts.createProject({ projectsRoot: `${projectsRoot}-crash`, name: 'boom', title: '崩' })
      const snap = await withPorts.readProjectFile('boom', 'game/script.rpy')
      await withPorts.writeProjectFiles('boom', [{ path: 'game/script.rpy', content: SCRIPT.replace('jump ending', 'jump nowhere'), expectVersion: snap.version }], { origin: 'agent', reason: 'scenario' })

      const run = await withPorts.playtestStart('boom')
      expect(run.technicalPass).toBe(false)
      expect(run.traceback).toContain('label nowhere not defined')

      // 入板:状态可见 + 摘要可读(agent 读的是同一份推导)。
      const progress = await withPorts.progress('boom')
      expect(progress.playtest?.state).toBe('fail')
      expect(progress.playtest?.traceback).toContain('label nowhere not defined')
      expect(progress.summary.playtestFail).toBe(1)
    } finally {
      await withPorts.dispose()
    }
  })
})
