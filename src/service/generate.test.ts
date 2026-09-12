/**
 * T10 seam tests — 逐场剧本生成(agent → 写批 → 校验闭环)。
 *
 * 契约来源(T10 票面):
 *  - 上下文 = 定稿设定集 + 前情 + 该场大纲位(T9 的 `generationContext`);
 *  - 经网关写该场 `.rpy` → **校验回路当场判定** → 推导板更新 → 进入"待审读";
 *  - 重生成该场自动清其戳(T6 机制的剧本侧应用);
 *  - 每次生成 **一个写批 = 一个快照**(批次粒度到场)。
 *
 * 归属规则(本票必须钉死的):一个 label 只归一个文件。
 *  - `game/script.rpy` 是**手写/模板**的家,生成器不动它;
 *  - `game/scenes/<label>.rpy` 是**生成**的家;
 *  - 想生成一个还活在 script.rpy 里的 label(如模板的 start)→ 如实拒绝,提示先搬走。
 *    否则同一个 label 会同时定义两处,真正的运行时会死在重复定义上。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const START_SCENE = [
  'label scene_one:',
  '    scene bg school',
  '    show xiao_tang smile',
  '    xiao_tang "你来啦。"',
  '    return',
  '',
].join('\n')

describe('逐场剧本生成(T10)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t10-data-')
    projectsRoot = await makeTempDir('galfree-t10-projects-')
    service = createProjectService({ dataDir })
    await service.createProject({ projectsRoot, name: 'gen', title: '生成' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('生成一场 → 落到 game/scenes/<label>.rpy,可解析、lint 当场回传、板显示"待审读"', async () => {
    const project = await service.getActiveProject()
    const result = await service.generateScene('gen', {
      label: 'scene_one',
      source: START_SCENE,
      outline: '第一幕:小棠在天台遇到转学生。',
    })

    // 落盘位置:生成物有自己的家,手写的 script.rpy 不动。
    const written = await readFile(join(project!.root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    expect(written).toContain('label scene_one:')
    expect(result.path).toBe('game/scenes/scene_one.rpy')

    // 校验当场回传(快带 = 假验证器;慢带同一形状由真 SDK 产出)。
    expect(result.validation.validator).toBe('fake')
    expect(result.validation.ok).toBe(true)
    expect(result.parseOk).toBe(true)
    expect(result.issues).toEqual([])

    // 板立刻反映:场景存在、待审读(还没人盖戳)。
    expect(result.progress.scenes.map((scene) => scene.label)).toContain('scene_one')
    expect(result.progress.scenes.find((scene) => scene.label === 'scene_one')!.stamp).toBe('none')

    // 槽也派生出来了(剧本引用了 bg school 与 xiao_tang smile)。
    expect(result.progress.slots.map((slot) => slot.slot)).toEqual(
      expect.arrayContaining(['bg school', 'xiao_tang smile']),
    )
  })

  it('归属规则:一个 label 只归一个文件;想生成还活在 script.rpy 里的 label → 如实拒绝', async () => {
    // 模板的 start 住在 game/script.rpy,不在生成目录里 → 不抢。
    await expect(service.generateScene('gen', {
      label: 'start', source: 'label start:\n    "另一版。"\n', outline: undefined,
    })).rejects.toThrow(/script\.rpy/)

    // 反向:生成目录里已有的 label,不能被写到别处去(单一归属)。
    await service.generateScene('gen', { label: 'scene_one', source: START_SCENE, outline: undefined })
    await expect(service.generateScene('gen', {
      label: 'scene_one', source: START_SCENE, targetPath: 'game/other.rpy', outline: undefined,
    })).rejects.toThrow(/scenes\//)
  })

  it('重生成 → 该场戳清除(待复审),且历史不改写', async () => {
    await service.generateScene('gen', { label: 'scene_one', source: START_SCENE, outline: undefined })
    // 人认可这一场。
    await service.stampScene('gen', 'scene_one', { via: 'human' })
    let progress = await service.progress('gen')
    expect(progress.scenes.find((scene) => scene.label === 'scene_one')!.stamp).toBe('approved')

    // 重生成(改一句台词)→ 指纹变 → 待复审。
    await service.generateScene('gen', {
      label: 'scene_one',
      source: START_SCENE.replace('你来啦。', '你也是来看雨的哦。'),
      outline: undefined,
    })
    progress = await service.progress('gen')
    const scene = progress.scenes.find((entry) => entry.label === 'scene_one')!
    expect(scene.stamp).toBe('stale')
    expect(progress.summary.awaitingReview).toBe(1)

    // 戳账本的历史记录还在(不被改写,只多一条)。
    const records = await service.stampRecords('gen')
    expect(records.filter((record) => record.target === 'scene:scene_one').length).toBeGreaterThanOrEqual(1)
  })

  it('生成致 lint 失败 → 如实报失败并呈现问题,不谎称成功', async () => {
    // 悬空跳转(子集内语义错):跑起来才会炸,正是最该当场暴露的那类。
    const result = await service.generateScene('gen', {
      label: 'scene_bad',
      source: 'label scene_bad:\n    "开场。"\n    jump nowhere\n',
      outline: undefined,
    })
    expect(result.parseOk).toBe(true)
    expect(result.validation.ok).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'dangling-jump')).toBe(true)
    // 失败也如实留在板上(内容进了仓库,快照可回滚),而不是假装没发生。
    expect(result.progress.lint.ok).toBe(false)
    expect(result.progress.problems.some((problem) => problem.code === 'dangling-jump')).toBe(true)
  })

  it('每次生成 = 一个写批 = 一个快照(批次粒度到场)', async () => {
    const before = (await service.snapshotHistory('gen', 'game/scenes/scene_one.rpy')).length
    expect(before).toBe(0)

    await service.generateScene('gen', { label: 'scene_one', source: START_SCENE, outline: undefined })
    const afterFirst = await service.snapshotHistory('gen', 'game/scenes/scene_one.rpy')
    expect(afterFirst.length).toBe(1)
    // commit message 带原因上下文(发起侧/环节/场景)。
    expect(afterFirst[0]!.subject).toContain('scene_one')

    await service.generateScene('gen', { label: 'scene_one', source: `${START_SCENE}    "补一句。"\n`, outline: undefined })
    const afterSecond = await service.snapshotHistory('gen', 'game/scenes/scene_one.rpy')
    expect(afterSecond.length).toBe(2)

    // 生成是插件内写:头部推进,且工作区不脏(全部经网关落盘)。
    expect(await service.writeLog('gen')).not.toHaveLength(0)
  })

  it('上下文来自定稿设定集:没定稿就不给生成(不偷偷用草稿)', async () => {
    await service.writeBible('gen', {
      theme: '雨天的重逢',
      world: '现代都市,梅雨季。',
      chapters: [{ id: 'c1', title: '天台的雨', outline: '小棠在天台遇到转学生。', scenes: ['scene_one'] }],
      characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '黑色长直发' }, styleAnchor: 'clean anime lineart', references: [] }],
    }, { via: 'agent' })

    // 未盖定稿戳 → 生成被拒(与 context 同一条门禁)。
    await expect(service.generateScene('gen', {
      label: 'scene_one', source: START_SCENE, outline: undefined, requireContext: true,
    })).rejects.toThrow(/定稿/)

    await service.stampBible('gen', { via: 'human' })
    const result = await service.generateScene('gen', {
      label: 'scene_one', source: START_SCENE, outline: undefined, requireContext: true,
    })
    // 上下文快照可断言:主题 + 这一章 + 来自登记簿的角色。
    expect(result.context?.theme).toBe('雨天的重逢')
    expect(result.context?.chapters.map((chapter) => chapter.id)).toEqual(['c1'])
    expect(result.context?.characters.map((character) => character.id)).toEqual(['xiao_tang'])
  })

  it('生成目录被板看见(递归读取):真 lint 与假验证器同口径', async () => {
    const project = await service.getActiveProject()
    await service.generateScene('gen', { label: 'scene_one', source: START_SCENE, outline: undefined })

    // 假验证器(经接缝的 validateActiveProject)必须看到 scenes/ 下的文件。
    const report = await service.validateActiveProject()
    expect(report.ok).toBe(true)
    const files = await readdir(join(project!.root, 'game', 'scenes'))
    expect(files).toEqual(['scene_one.rpy'])
  })

  it('搬家:把 script.rpy 里的段原样搬进生成目录,内容逐字不变,且是一次写批', async () => {
    const project = await service.getActiveProject()
    // 模板的 start 住在 script.rpy;先确认生成器拒绝抢它(上一条测试已经验过)。
    const before = await readFile(join(project!.root, 'game', 'script.rpy'), 'utf8')
    const startBlock = before.slice(before.indexOf('label start:'))
    const blockText = startBlock.slice(0, startBlock.indexOf('\n\n') + 1)

    const moved = await service.relocateScene('gen', 'start', { via: 'human' })
    expect(moved).toEqual({ from: 'game/script.rpy', to: 'game/scenes/start.rpy' })

    // 目标文件:段内容逐字在(含缩进与台词原文)。
    const target = await readFile(join(project!.root, 'game', 'scenes', 'start.rpy'), 'utf8')
    expect(target).toContain('label start:')
    for (const line of blockText.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue
      expect(target).toContain(line)
    }
    // 源文件:那段没了,但文件还在(里面其余内容原样)。
    const after = await readFile(join(project!.root, 'game', 'script.rpy'), 'utf8')
    expect(after).not.toContain('label start:')

    // 板上不再重复,且场景现在归生成目录(后续可重生成)。
    const progress = await service.progress('gen')
    expect(progress.scenes.filter((scene) => scene.label === 'start')).toHaveLength(1)
    expect(progress.scenes.find((scene) => scene.label === 'start')!.file).toBe('scenes/start.rpy')
    expect(progress.lint.ok).toBe(true)

    // 搬完就能重生成它了(归属已规范)。
    await service.generateScene('gen', {
      label: 'start',
      source: 'label start:\n    "重写过的开场。"\n    return\n',
      outline: undefined,
    })
    const regenerated = await service.progress('gen')
    expect(regenerated.scenes.find((scene) => scene.label === 'start')!.file).toBe('scenes/start.rpy')
    expect(await readFile(join(project!.root, 'game', 'scenes', 'start.rpy'), 'utf8')).toContain('重写过的开场。')

    // 搬家只能由人发起(它重写的是人的手写文件)。
    await expect(service.relocateScene('gen', 'scene_one', { via: 'agent' })).rejects.toThrow(/只能由人/)
  })
})
