/**
 * 舞台层端到端(T39)—— 接缝上的守卫,对着**用户报的两个 bug**写:
 *
 *  1. "自动化创作完后打开报错":`show 角色 表情` 在真引擎上抛
 *     `Image '…' does not accept attributes '…'`。修法是生成物把素材图的
 *     `image <tag> 属性… = "…"` 逐条写出来 —— 这里验的是**它真被写出来了**,
 *     而且**只为磁盘上真有的图写**(还没有的槽不写,免得变成引擎的报错屏)。
 *  2. "两个立绘同时出现时重叠":修法是整备按在场人数补 `at` 子句 ——
 *     这里验的是**一场里两个立绘真被分开**,以及反复整备是**幂等**的。
 *
 * 还钉三件容易悄悄坏掉的事:整备**与生成同一个写批**(一条快照,不是两条)、
 * 已经是最新时**一个字节都不写**、以及 `with dissolve` 这类子句不会被吃掉。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from '../service/project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

/** 最小的 1×1 PNG(只为让"文件真在磁盘上"成立;舞台层只读文件头的高)。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('舞台层(T39)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-stage-data-')
    projectsRoot = await makeTempDir('galfree-stage-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(await makeFakeSdk()) })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  /**
   * 建项目 + 写一场有两个立绘的戏 —— **直接经网关写文件**,不走 `generateScene`。
   *
   * 为什么要这么造:那是**老项目**的真实现场(迎神就是),剧本早就写好了、
   * 而 `zz_galfree_stage.rpy` 这东西在 T39 之前根本不存在的。整备要能在这种项目上跑起来,
   * 而不是只在"由本版本的生成器写出来的剧本"上成立。
   */
  async function projectWithTwoSprites(): Promise<{ id: string; root: string }> {
    const project = await service.createProject({ projectsRoot, name: 'stage-story', title: '舞台' })
    await service.writeProjectFiles(project.id, [{
      path: 'game/scenes/s01_meeting.rpy',
      content: [
        'label s01_meeting:',
        '    scene bg hall',
        '    show a_tang',
        '    "她先到了。"',
        '    show lin_bo worried',
        '    "后面又来了一个。"',
        '',
      ].join('\n'),
      expectVersion: 'absent',
    }], { origin: 'agent', reason: 'scene', scene: 's01_meeting' })
    return { id: project.id, root: project.root }
  }

  it('素材图落盘之后:生成物里逐条写出图片定义(否则游戏打开即报错)', async () => {
    const { id, root } = await projectWithTwoSprites()
    await mkdir(join(root, 'game', 'images'), { recursive: true })
    await writeFile(join(root, 'game', 'images', 'bg-hall.png'), PNG_1x1)
    await writeFile(join(root, 'game', 'images', 'a_tang.png'), PNG_1x1)
    // `lin_bo worried` 的图**故意不放** —— 它必须**不**出现在定义里。

    const report = await service.stageSync(id, { via: 'human' })
    const stage = await readFile(join(root, 'game', 'zz_galfree_stage.rpy'), 'utf8')

    expect(report.definitions).toBe(2)
    expect(stage).toContain('image bg hall = "images/bg-hall.png"')
    // 这一行的形状是关键:名字必须是 `tag 属性`(空格分隔),不是文件名的字面。
    expect(stage).toContain('image a_tang = "images/a_tang.png"')
    expect(stage).not.toContain('lin_bo')
    expect(stage).toContain('transform gf_duo_left:')
  })

  it('两个立绘同时在场:一个写批里就被分到左右(不是"打补丁"式的第二刀)', async () => {
    const { id, root } = await projectWithTwoSprites()

    const report = await service.stageSync(id, { via: 'human' })
    const scene = await readFile(join(root, 'game', 'scenes', 's01_meeting.rpy'), 'utf8')
    const lines = scene.split('\n')

    // 先上场的那位被重排到左,后上场的在右 —— 这就是"不重叠"。
    expect(lines.find((line) => line.includes('show a_tang'))).toContain('at gf_duo_left')
    expect(lines.find((line) => line.includes('show lin_bo'))).toContain('at gf_duo_right')
    expect(report.report.overlaps).toEqual([])
    expect(report.files).toContain('game/zz_galfree_stage.rpy')
  })

  it('反复整备是幂等的:第二次什么都没写(changed=false,不产生空快照)', async () => {
    const { id } = await projectWithTwoSprites()
    const first = await service.stageSync(id, { via: 'human' })
    expect(first.changed).toBe(true)

    const second = await service.stageSync(id, { via: 'human' })
    expect(second.changed).toBe(false)
    expect(second.files).toEqual([])
    expect(second.outOfSync).toBe(false)
  })

  it('`with dissolve` 不会被"补站位"吃掉(那是生成侧真写过的形状)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'stage-with', title: '转场' })
    await service.generateScene(project.id, {
      label: 's01',
      outline: undefined,
      source: 'label s01:\n    scene bg room\n    show a_tang with dissolve\n    "……"\n',
    })
    await service.stageSync(project.id, { via: 'human' })
    const scene = await readFile(join(project.root, 'game', 'scenes', 's01.rpy'), 'utf8')
    expect(scene).toContain('show a_tang at gf_solo with dissolve')
  })

  it('生成一场戏就顺带整备(同一个写批:一条快照,项目不会在中间那一刻是坏的)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'stage-auto', title: '顺带' })
    const report = await service.generateScene(project.id, {
      label: 's01',
      outline: undefined,
      source: 'label s01:\n    scene bg room\n    show a_tang\n    show lin_bo\n    "两个人。"\n',
    })
    // 生成这一笔就已经把舞台层写好了 —— 不需要人再点一次。
    expect(report.progress.stage.outOfSync).toBe(false)
    const scene = await readFile(join(project.root, 'game', 'scenes', 's01.rpy'), 'utf8')
    const lines = scene.split('\n')
    expect(lines.find((line) => line.includes('show a_tang'))).toContain('at gf_duo_left')
    expect(lines.find((line) => line.includes('show lin_bo'))).toContain('at gf_duo_right')
    // 一条快照,不是两条:这条守的是"git 历史里别出现两个看不出关系的提交"。
    const log = await service.writeLog(project.id)
    expect(log.filter((entry) => entry.batchId === log.at(-1)!.batchId).map((entry) => entry.path).sort())
      .toEqual(['game/scenes/s01.rpy', 'game/zz_galfree_stage.rpy'])
  })

  it('板子说得出来:没整备时是 stage-needs-sync;立绘会叠时是 sprite-overlap', async () => {
    const project = await service.createProject({ projectsRoot, name: 'stage-board', title: '板' })
    await service.generateScene(project.id, {
      label: 's01',
      outline: undefined,
      source: 'label s01:\n    scene bg room\n    show a_tang\n    show lin_bo\n    "……"\n',
    })
    // 生成侧已整备过一次 ⇒ 板上不该有舞台动作。
    let progress = await service.progress(project.id)
    expect(progress.nextActions.some((action) => action.code === 'stage-needs-sync')).toBe(false)
    expect(progress.stage.outOfSync).toBe(false)

    // 人把生成物删了(或这是老项目:从来没有过它)⇒ 板上立刻说得出来,且带跳转目标。
    await writeFile(join(project.root, 'game', 'zz_galfree_stage.rpy'), '')
    progress = await service.progress(project.id)
    const action = progress.nextActions.find((entry) => entry.code === 'stage-needs-sync')
    expect(action?.target).toEqual({ kind: 'stage' })
    expect(action?.actor).toBe('agent')
    expect(progress.stage.outOfSync).toBe(true)
  })

  it('手写的歧义位置与自动位撞上时报 sprite-overlap(人写的位置也要看得见)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'stage-clash', title: '撞' })
    await service.generateScene(project.id, {
      label: 's01',
      outline: undefined,
      source: 'label s01:\n    scene bg room\n    show a_tang at right\n    show lin_bo\n    "……"\n',
    })
    // 自动布局不把人写死的位算进人数(不猜 `at right` 占了哪一格),
    // 但"同位"这件事要在板上说出来:自动位是 solo(居中),与 `right` 不撞 ⇒ 干净。
    const clean = await service.progress(project.id)
    expect(clean.stage.report.overlaps).toEqual([])
    expect(clean.stage.outOfSync).toBe(false)

    // 再补第三个人:自动那两位排成左右,而人写死的 `right` 与自动的右位同档 ⇒ 撞。
    // 锚点用**当前**那一行的原文(整备已经把 `at` 补上去了)。
    const now = await readFile(join(project.root, 'game', 'scenes', 's01.rpy'), 'utf8')
    const anchor = now.split('\n').find((line) => line.includes('show lin_bo'))!
    await service.editScene(project.id, {
      label: 's01',
      edit: { kind: 'insertStatement', anchor, source: 'show san_shen' },
    })
    const busy = await service.progress(project.id)
    expect(busy.stage.report.overlaps.length).toBeGreaterThan(0)
    expect(busy.nextActions.some((action) => action.code === 'sprite-overlap')).toBe(true)
  })

  it('只为真有的图写定义:出图之后整备一次,定义就出现(不必重生成剧本)', async () => {
    const { id, root } = await projectWithTwoSprites()
    await mkdir(join(root, 'game', 'images'), { recursive: true })
    await writeFile(join(root, 'game', 'images', 'bg-hall.png'), PNG_1x1)
    await service.stageSync(id, { via: 'human' })
    const before = await readFile(join(root, 'game', 'zz_galfree_stage.rpy'), 'utf8')
    expect(before).not.toContain('image a_tang')

    // 图出来了(人丢进来 / 出图任务落盘),整备一次就够。
    await writeFile(join(root, 'game', 'images', 'a_tang.png'), PNG_1x1)
    const report = await service.stageSync(id, { via: 'human' })
    expect(report.changed).toBe(true)
    expect(await readFile(join(root, 'game', 'zz_galfree_stage.rpy'), 'utf8')).toContain('image a_tang = "images/a_tang.png"')
  })

  it('舞台层是**推导**:报告与"新不新"与文件内容一致(可全量重算)', async () => {
    const { id, root } = await projectWithTwoSprites()
    const status = await service.stageStatus(id)
    expect(status.slots).toBe(3) // bg hall + a_tang + lin_bo worried
    expect(status.definitions).toBe(0) // 一张图都还没有
    expect(status.outOfSync).toBe(true)
    // 老项目:剧本从没被整备过 ⇒ 两行立绘都没有站位(那就是"重叠"的前身)。
    expect(status.report.unplaced).toBe(2)
    // 生成物此刻**还不存在**(整备是写,得有人发起;板子只管把它说出来)。
    expect(await exists(join(root, 'game', 'zz_galfree_stage.rpy'))).toBe(false)
    await service.stageSync(id, { via: 'human' })
    expect(await exists(join(root, 'game', 'zz_galfree_stage.rpy'))).toBe(true)
    expect((await service.stageStatus(id)).outOfSync).toBe(false)
  })
})
