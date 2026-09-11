/**
 * T8 seam tests — 角色登记簿 + 素材槽账本。
 *
 * 契约来源(T8 票面):
 *  - `.studio` 角色登记簿(外观设定卡 / 画风锚 / 参考图链字段)接缝 CRUD,写走网关;
 *  - **素材槽**从 `.rpy` 图像引用派生 + `.studio` 挂制作状态(待填/已填/待复审/已过审);
 *  - 悬空引用 = 校验错误进板,**在板上定位到场景与语句**(ADR-0009 铁律第一次兑现);
 *  - 素材板纯渲染派生对象;登记簿**不含叙述内容副本**(铁律:`.studio/` 只放引用与制作信息)。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

/** 两个场景:一个引用已有素材的槽,一个引用缺素材的槽;有对白与角色。 */
const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    scene bg school',
  '    show xiao_tang smile',
  '    xiao_tang "你来啦。"',
  '    jump rooftop',
  '',
  'label rooftop:',
  '    scene bg rooftop',
  '    show xiao_tang angry',
  '    xiao_tang "……你迟到了。"',
  '    return',
  '',
].join('\n')

describe('角色登记簿 + 素材槽账本(T8)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t8-data-')
    projectsRoot = await makeTempDir('galfree-t8-projects-')
    service = createProjectService({ dataDir })
    await service.createProject({ projectsRoot, name: 'cast', title: '选角' })
    const project = await service.getActiveProject()
    const snap = await service.readProjectFile('cast', 'game/script.rpy')
    await service.writeProjectFiles('cast', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'agent', reason: 'scenario' })
    void project
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('新增角色 → 登记簿经写批落盘,并被快照覆盖', async () => {
    const project = await service.getActiveProject()
    await service.upsertCharacter('cast', {
      id: 'xiao_tang',
      name: '小棠',
      voice: 'xiao_tang',
      appearance: { hair: '黑色长直发', eyes: '琥珀色', outfit: '深蓝水手服' },
      styleAnchor: 'clean anime lineart, soft cel shading, muted palette',
      references: [],
    })

    // 磁盘终态:登记簿在 .studio/ 下,不是别处。
    const doc = JSON.parse(await readFile(join(project!.root, '.studio', 'characters.json'), 'utf8')) as {
      schemaVersion: number
      characters: Array<{ id: string; appearance: Record<string, string> }>
    }
    expect(doc.schemaVersion).toBe(1)
    expect(doc.characters.map((c) => c.id)).toEqual(['xiao_tang'])
    expect(doc.characters[0]!.appearance.hair).toBe('黑色长直发')

    // 走网关 → 自动产生快照(T3)。
    const history = await service.snapshotHistory('cast', '.studio/characters.json')
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[0]!.subject).toContain('cast')
  })

  it('登记簿不含叙述内容副本(铁律:.studio/ 只放引用与制作信息)', async () => {
    const project = await service.getActiveProject()
    await service.upsertCharacter('cast', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang',
      appearance: { hair: '黑色长直发' }, styleAnchor: 'clean anime lineart', references: [],
    })
    const raw = await readFile(join(project!.root, '.studio', 'characters.json'), 'utf8')
    // 台词原文一个字都不许出现在登记簿里。
    for (const line of ['你来啦', '你迟到了']) {
      expect(raw).not.toContain(line)
    }
  })

  it('改 .rpy 图像引用(外部编辑器)→ 槽清单自动更新,无需第二上报入口', async () => {
    const project = await service.getActiveProject()
    const before = await service.progress('cast')
    expect(before.slots.map((slot) => slot.slot).sort()).toEqual([
      'bg rooftop', 'bg school', 'xiao_tang angry', 'xiao_tang smile',
    ])
    // 每个槽都知道自己在哪几场被引用(板的定位能力)。
    expect(before.slots.find((slot) => slot.slot === 'xiao_tang smile')!.origin.scenes).toContain('start')
    expect(before.slots.find((slot) => slot.slot === 'xiao_tang angry')!.origin.scenes).toContain('rooftop')

    // 外部编辑器直接改文件(不经网关 —— 这正是"外部修改=观察"的场景)。
    await writeFile(join(project!.root, 'game', 'script.rpy'), `${SCRIPT}    show xiao_tang cry\n`, 'utf8')

    const after = await service.progress('cast')
    expect(after.slots.map((slot) => slot.slot)).toContain('xiao_tang cry')
    // 没有任何"上报槽"的入口:接缝只暴露推导。
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
    expect(surface.filter((name) => /^(add|register|report).*slot/i.test(name))).toEqual([])
  })

  it('槽账本给推导挂制作信息(人怎么画的),但状态仍是推导的', async () => {
    const project = await service.getActiveProject()
    await service.upsertSlot('cast', {
      slot: 'xiao_tang smile',
      requiresCharacters: ['xiao_tang'],
      prompt: '小棠微笑,半身,校服,柔和逆光',
      artStyleAnchor: 'clean anime lineart, soft cel shading',
    })

    // 账本落盘在 .studio/(经网关 → 有快照)。
    const raw = JSON.parse(await readFile(join(project!.root, '.studio', 'slots.json'), 'utf8')) as {
      slots: Array<{ slot: string; prompt: string }>
    }
    expect(raw.slots[0]!.slot).toBe('xiao_tang smile')
    expect(await service.snapshotHistory('cast', '.studio/slots.json')).not.toHaveLength(0)

    // 推导把账本挂上去;而 filled/stamp 依然是推导出来的(文件在不在 + 指纹比对)。
    const progress = await service.progress('cast')
    const slot = progress.slots.find((s) => s.slot === 'xiao_tang smile')!
    expect(slot.ledger?.prompt).toBe('小棠微笑,半身,校服,柔和逆光')
    expect(slot.filled).toBe(false)
    expect(slot.stamp).toBe('missing')
  })

  it('悬空引用在板上定位到场景与语句(ADR-0009 铁律)', async () => {
    const project = await service.getActiveProject()
    // 1) 账本挂给一个 .rpy 里根本不存在的槽。
    await service.upsertSlot('cast', { slot: 'bg moon', requiresCharacters: [], prompt: '月光下的操场' })
    // 2) 账本要求一个登记簿里没有的角色。
    await service.upsertSlot('cast', { slot: 'xiao_tang smile', requiresCharacters: ['ghost'] })

    const progress = await service.progress('cast')
    const dangling = progress.problems.filter((problem) => problem.severity === 'error')

    const ghostSlot = dangling.find((problem) => problem.code === 'dangling-slot-ref')
    expect(ghostSlot).toBeDefined()
    expect(ghostSlot!.file).toBe('.studio/slots.json')
    expect(ghostSlot!.message).toContain('bg moon')

    const ghostCharacter = dangling.find((problem) => problem.code === 'dangling-character-ref')
    expect(ghostCharacter).toBeDefined()
    expect(ghostCharacter!.message).toContain('ghost')
    // 定位:指回**引用这个槽的 .rpy 语句**(人是在剧本里用它的,问题也会在那咬人)。
    expect(ghostCharacter!.file).toBe('script.rpy')
    expect(ghostCharacter!.line).toBeGreaterThan(0)
    expect(ghostCharacter!.snippet).toContain('xiao_tang smile')

    // 悬空引用进 lint 汇总(error 级),并且进舞台板那一场的显示。
    expect(progress.lint.ok).toBe(false)
    expect(progress.scenes.find((scene) => scene.label === 'start')!.lintErrors).toBeGreaterThan(0)

    // 定位能力:槽自己带着"第一次被引用的地方"(文件:行 + 原始语句)。
    const referenced = progress.slots.find((slot) => slot.slot === 'xiao_tang smile')!
    expect(referenced.origin.file).toBe('script.rpy')
    expect(referenced.origin.snippet).toContain('xiao_tang smile')
    expect(referenced.origin.scenes).toContain('start')
  })

  it('登记的角色对账:.rpy 里出现但登记簿没有 → 如实提示(不是 error)', async () => {
    const progress = await service.progress('cast')
    // 剧本里有 `define xiao_tang = Character("小棠")`,但登记簿还是空的。
    const unregistered = progress.problems.find((problem) => problem.code === 'unregistered-character')
    expect(unregistered).toBeDefined()
    expect(unregistered!.severity).toBe('warning')
    expect(unregistered!.message).toContain('xiao_tang')

    // 登记之后提示消失。
    await service.upsertCharacter('cast', { id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [] })
    const after = await service.progress('cast')
    expect(after.problems.find((problem) => problem.code === 'unregistered-character')).toBeUndefined()
  })
})
