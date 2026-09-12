/**
 * T9 seam tests — 设定集工作周期(主题 / 大纲双模式)。
 *
 * 契约来源(T9 票面):
 *  - 设定集 = 项目第一记忆源:世界观、章节大纲、分支骨架;角色设定以**登记簿为家**,
 *    设定集只引用(T8 已就位);
 *  - **主题模式**:给主题 → agent 产设定集(同步写登记簿),人编辑;
 *  - **大纲模式**:人导入大纲,**原文即权威**,agent 只补登记簿与派生骨架;
 *  - "设定定稿"戳由人盖;设定集后续修改**清定稿戳**;agent 无权限;
 *  - 生成下游动作读取"定稿版"为上下文(接缝可断言上下文快照)。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    scene bg school',
  '    show xiao_tang smile',
  '    xiao_tang "你来啦。"',
  '    return',
  '',
].join('\n')

/** 人写的大纲原文 —— 里面故意带"agent 很可能会想改写"的东西(口语、错别字、方言)。 */
const HUMAN_OUTLINE = `第一章 天台的雨
主角小棠在放学后的天台遇到转学生。她说"你也是来看雨的哦",语气很冲。
第二章 图书馆
两个人在图书馆吵起来,因为一本书。小棠其实是想道歉。

（备注给自己:第三章先别写,等我想清楚结局。）`

describe('设定集工作周期(T9)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t9-data-')
    projectsRoot = await makeTempDir('galfree-t9-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'bible', title: '设定集' })
    const snap = await service.readProjectFile('bible', 'game/script.rpy')
    await service.writeProjectFiles('bible', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'agent', reason: 'scenario' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('主题模式:给主题 → 设定集与登记簿角色一起经写批落盘(agent 可写,因为它不是人的主观认可)', async () => {
    const project = await service.getActiveProject()
    await service.writeBible('bible', {
      theme: '雨天的重逢',
      world: '现代都市,梅雨季;天台与图书馆是两个反复出现的场所。',
      chapters: [
        { id: 'c1', title: '天台的雨', outline: '小棠在天台遇到转学生。', scenes: ['start'] },
      ],
      characters: [
        { id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '黑色长直发' }, styleAnchor: 'clean anime lineart', references: [] },
      ],
    }, { via: 'agent' })

    // 设定集落盘(.studio/bible/),经网关 → 有快照。
    const doc = JSON.parse(await readFile(join(project!.root, '.studio', 'bible', 'bible.json'), 'utf8')) as {
      schemaVersion: number
      theme: string
      chapters: Array<{ id: string }>
      characters: Array<{ id: string }>
    }
    expect(doc.schemaVersion).toBe(1)
    expect(doc.theme).toBe('雨天的重逢')
    expect(doc.chapters.map((chapter) => chapter.id)).toEqual(['c1'])
    // 角色设定**不在设定集里复制一份**,只在登记簿:设定集只带引用。
    const registry = await service.characters('bible')
    expect(registry.map((character) => character.id)).toEqual(['xiao_tang'])
    expect(JSON.stringify(doc.characters)).toBe(JSON.stringify([{ id: 'xiao_tang' }]))
    expect(await service.snapshotHistory('bible', '.studio/bible/bible.json')).not.toHaveLength(0)
  })

  it('大纲模式:人给的原文逐字保留(负例:不被 agent 改写),派生物另存', async () => {
    const project = await service.getActiveProject()
    await service.importOutline('bible', HUMAN_OUTLINE)

    const raw = await readFile(join(project!.root, '.studio', 'bible', 'outline.md'), 'utf8')
    // 逐字:一个字符都不许动(口语、错别字、括注、空行全保留)。
    expect(raw).toBe(HUMAN_OUTLINE)

    // 设定集里存的是**引用**(路径 + 指纹),不是第二份正文副本。
    const doc = JSON.parse(await readFile(join(project!.root, '.studio', 'bible', 'bible.json'), 'utf8')) as {
      outline: { path: string; fingerprint: string } | null
    }
    expect(doc.outline?.path).toBe('.studio/bible/outline.md')
    expect(doc.outline?.fingerprint).toBeTruthy()
    expect(JSON.stringify(doc)).not.toContain('你也是来看雨的哦')

    // 派生:agent 只补登记簿与骨架(不去改写原文)。
    await service.writeBible('bible', {
      chapters: [{ id: 'c1', title: '天台的雨', outline: '小棠在天台遇到转学生。', scenes: ['start'] }],
      characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, styleAnchor: 'clean anime lineart', references: [] }],
    }, { via: 'agent' })

    const after = await service.bible('bible')
    expect(after.outline?.path).toBe('.studio/bible/outline.md')
    expect(after.chapters.map((chapter) => chapter.id)).toEqual(['c1'])
    // 原文仍未被动过。
    expect(await readFile(join(project!.root, '.studio', 'bible', 'outline.md'), 'utf8')).toBe(HUMAN_OUTLINE)

    // 外部把原文改坏了(与指纹不符)→ 推导如实报,不假装它还是那份权威原文。
    await writeFile(join(project!.root, '.studio', 'bible', 'outline.md'), '被改过的大纲', 'utf8')
    const progress = await service.progress('bible')
    expect(progress.problems.some((problem) => problem.code === 'outline-fingerprint-mismatch')).toBe(true)
  })

  it('章节形状坏掉 → 如实拒绝(bible-invalid),不是一句内部 TypeError', async () => {
    // 这条是 T20 的工具面揭出来的:agent(以及面板的 `/bible/patch`)可以把章节当自由 JSON 送进来,
    // 而 `scenes` 缺了会让指纹计算抛 `chapter.scenes is not iterable` —— 那是**内部错误**,
    // 人看到的是 500 与一句莫名其妙的话。写之前就该按形状拦下。
    await expect(service.writeBible('bible', {
      chapters: [{ id: 'c1', title: '缺 scenes' } as never],
    }, { via: 'agent' })).rejects.toMatchObject({ code: 'bible-invalid' })
    await expect(service.writeBible('bible', {
      chapters: [{ id: 'c2', title: 'scenes 不是数组', scenes: 'start' } as never],
    }, { via: 'agent' })).rejects.toMatchObject({ code: 'bible-invalid' })
    await expect(service.writeBible('bible', {
      chapters: [{ id: 'c3', scenes: [] } as never],
    }, { via: 'agent' })).rejects.toMatchObject({ code: 'bible-invalid' })
  })

  it('定稿戳:人盖 / 设定集改动清戳(待复审)/ agent 无权限', async () => {
    await service.writeBible('bible', { theme: '雨天的重逢', world: '现代都市。', chapters: [], characters: [] }, { via: 'agent' })

    // 没盖之前:待审读。
    let progress = await service.progress('bible')
    expect(progress.bible.stamp).toBe('none')

    // agent 无权盖定稿戳(与场景戳同一条守卫)。
    await expect(service.stampBible('bible', { via: 'agent' })).rejects.toThrow(/只能由人/)

    // 人盖 → 已定稿。
    await service.stampBible('bible', { via: 'human' })
    progress = await service.progress('bible')
    expect(progress.bible.stamp).toBe('approved')

    // 设定集后续修改 → 自动清戳(待复审),不改写历史戳记录。
    await service.writeBible('bible', { world: '现代都市,梅雨季。' }, { via: 'agent' })
    progress = await service.progress('bible')
    expect(progress.bible.stamp).toBe('stale')
    const records = await service.stampRecords('bible')
    expect(records.some((record) => record.target === 'bible' && record.fingerprint !== '')).toBe(true)
  })

  it('下游动作读"定稿版"为上下文:未定稿时如实拒绝,定稿后给出可断言的上下文快照', async () => {
    await service.writeBible('bible', {
      theme: '雨天的重逢',
      world: '现代都市,梅雨季。',
      chapters: [{ id: 'c1', title: '天台的雨', outline: '小棠在天台遇到转学生。', scenes: ['start'] }],
      characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '黑色长直发' }, styleAnchor: 'clean anime lineart', references: [] }],
    }, { via: 'agent' })

    // 未盖定稿戳 → 生成上下文如实报"没有定稿版"(不偷偷用草稿)。
    await expect(service.generationContext('bible')).rejects.toThrow(/定稿/)

    await service.stampBible('bible', { via: 'human' })
    const context = await service.generationContext('bible')
    expect(context.theme).toBe('雨天的重逢')
    expect(context.chapters.map((chapter) => chapter.id)).toEqual(['c1'])
    // 上下文里的角色来自**登记簿**(单一真相),不是设定集的复制品。
    expect(context.characters.map((character) => character.id)).toEqual(['xiao_tang'])
    expect(context.characters[0]!.appearance.hair).toBe('黑色长直发')
    // 定了稿的上下文带指纹:内容再变就会对不上(下游据此知道要重取)。
    expect(context.fingerprint).toBeTruthy()

    // 定稿后又被改 → 上下文拒绝给出(戳已 stale)。
    await service.writeBible('bible', { theme: '改了主题' }, { via: 'agent' })
    await expect(service.generationContext('bible')).rejects.toThrow(/定稿/)
  })

  it('设定集不复制叙述内容:章节只放引用与制作信息,正文永远在 .rpy', async () => {
    await service.writeBible('bible', {
      theme: '雨天的重逢',
      chapters: [{ id: 'c1', title: '天台的雨', outline: '小棠在天台遇到转学生。', scenes: ['start'] }],
      characters: [],
    }, { via: 'agent' })
    const project = await service.getActiveProject()
    const raw = await readFile(join(project!.root, '.studio', 'bible', 'bible.json'), 'utf8')
    // 剧本正文(台词)不许出现在设定集里。
    expect(raw).not.toContain('你来啦')
  })
})
