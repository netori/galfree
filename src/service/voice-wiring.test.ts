/**
 * 语音接线(T35 补的入口)—— ADR-0013 那两条前提。
 *
 * ## 这一组守卫的来历(2026-09-19 实测)
 *
 * 作者试玩时"听不到语音"。查出来**两个前提都没落地**,而且两种情况都是**静默无声**
 * (引擎不报错、试玩技术上也照过):
 *
 *  1. 项目里**没有** `define config.auto_voice = "voice/{id}.ogg"` —— 模板会写这一行,
 *     但这项目建得比那行早 ⇒ **老项目永远缺**;
 *  2. 剧本里**一句显式 `id` 都没有** —— 而 `stampDialogueIds` **只在测试里被调用过**
 *     (`generateScene` 从来没盖过章)。没有显式 id 时 Ren'Py 用的标识符是**内容哈希**
 *     (`renpy/translation/__init__.py:337-357`),`auto_voice` 于是去格式化一个
 *     不存在的文件名(`renpy/common/00voice.rpy:364-372`)。
 *
 * 当年 T26 的慢带验的是"`stampDialogueIds` 这个函数对",**没验"生成那条路调了它"** ——
 * 典型的"接缝已备、入口缺失"。这一组把那一步补上。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { upgradeAutoVoice } from './voice-batch.ts'

const SCENE = [
  'label scene_one:',
  '    "第一句旁白。"',
  '    xiao_tang "第二句对白。"',
  '    return',
  '',
].join('\n')

/** 老项目的形状:一场**没有 id** 的戏(这条就是 2026-09-19 那个项目的处境)。 */
const UNSTAMPED_SCENE = [
  'label scene_one:',
  '    "第一句旁白。"',
  '    xiao_tang "第二句对白。"',
  '    return',
  '',
].join('\n')

describe('语音接线(ADR-0013 的两条前提)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t35v-data-')
    projectsRoot = await makeTempDir('galfree-t35v-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'wire', title: '接线' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  const sceneFile = (): string => join(projectsRoot, 'wire', 'game', 'scenes', 'scene_one.rpy')
  const optionsFile = (): string => join(projectsRoot, 'wire', 'game', 'options.rpy')

  it('新建项目就带 `config.auto_voice`(模板那一行)', async () => {
    expect(await readFile(optionsFile(), 'utf8')).toContain('config.auto_voice')
  })

  // ─── T39:两种形态 —— 字符串钉死后缀会**静默**够不着文件 ──────────────────

  it('新模板写的是**函数形态**(字符串形态只能钉一个后缀,钉错了引擎不报错也找不到)', async () => {
    const options = await readFile(optionsFile(), 'utf8')
    const report = await service.voiceWiring('wire')
    expect(report.autoVoice.present).toBe(true)
    expect(report.autoVoice.form).toBe('function')
    expect(options).toContain('config.auto_voice = _galfree_voice')
    expect(options).toContain('renpy.loadable')
    // 老那一行**不该**再出现(两份形态同时在 = 最后一个生效,谁读谁糊涂)。
    expect(options).not.toMatch(/define\s+config\.auto_voice\s*=\s*"/)
  })

  it('盯着字符串形态:磁盘上是 mp3 而它钉的是 ogg ⇒ 如实报"引擎够不着这几个"', async () => {
    // 把项目改成老形态(字符串)
    const options = await service.readProjectFile('wire', 'game/options.rpy')
    await service.writeProjectFiles('wire', [{
      path: 'game/options.rpy',
      content: `${options.content.replace(/\s*$/, '')}\n\ndefine config.auto_voice = "voice/{id}.ogg"\n`,
      expectVersion: options.version,
    }], { origin: 'agent', reason: 'edit' })
    // 磁盘上放两个 **mp3**(小米 MiMo 给的就是 mp3)与一个 ogg
    await mkdir(join(projectsRoot, 'wire', 'game', 'voice'), { recursive: true })
    await writeFile(join(projectsRoot, 'wire', 'game', 'voice', 'a.mp3'), Buffer.from([0xff, 0xf3, 0x84, 0xc4]))
    await writeFile(join(projectsRoot, 'wire', 'game', 'voice', 'b.mp3'), Buffer.from([0xff, 0xf3, 0x84, 0xc4]))
    await writeFile(join(projectsRoot, 'wire', 'game', 'voice', 'c.ogg'), Buffer.from('OggS'))

    const report = await service.voiceWiring('wire')
    expect(report.autoVoice.form).toBe('string')
    expect(report.autoVoice.extension).toBe('ogg')
    expect(report.voiceFiles.count).toBe(3)
    expect(report.unreachable.count).toBe(2)
    expect(report.unreachable.extensions).toEqual(['mp3'])
    expect(report.unreachable.hint).toContain('不报错也找不到')
    expect(report.needsWiring).toBe(true)
  })

  it('apply 只在**真够不着**的时候升级那一行;后缀对得上就一个字都不动', async () => {
    const options = await service.readProjectFile('wire', 'game/options.rpy')
    const stringForm = `${options.content.replace(/\s*$/, '')}\n\ndefine config.auto_voice = "voice/{id}.ogg"\n`
    await service.writeProjectFiles('wire', [{ path: 'game/options.rpy', content: stringForm, expectVersion: options.version }], { origin: 'agent', reason: 'edit' })

    // ① 后缀对得上(磁盘上是 ogg)⇒ 不动它 —— `options.rpy` 是人的文件,能不动就不动
    await mkdir(join(projectsRoot, 'wire', 'game', 'voice'), { recursive: true })
    await writeFile(join(projectsRoot, 'wire', 'game', 'voice', 'x.ogg'), Buffer.from('OggS'))
    const same = await service.voiceWiring('wire', { apply: true })
    expect(same.changed).not.toContain('game/options.rpy')
    let after = await readFile(optionsFile(), 'utf8')
    expect(after).toContain('define config.auto_voice = "voice/{id}.ogg"')

    // ② 磁盘上多了一个 mp3 ⇒ 那一行升级成函数形态(其余内容逐字保留)
    await writeFile(join(projectsRoot, 'wire', 'game', 'voice', 'y.mp3'), Buffer.from([0xff, 0xf3, 0x84, 0xc4]))
    const upgraded = await service.voiceWiring('wire', { apply: true })
    expect(upgraded.changed).toContain('game/options.rpy')
    expect(upgraded.autoVoice.form).toBe('function')
    expect(upgraded.unreachable.count).toBe(0)
    expect(upgraded.needsWiring).toBe(false)
    after = await readFile(optionsFile(), 'utf8')
    expect(after).toContain('config.auto_voice = _galfree_voice')
    expect(after).not.toMatch(/define\s+config\.auto_voice\s*=\s*"/)
    // 只换了那一行:文件里别的东西一个都没少
    expect(after).toContain('define config.has_music = True')
    expect(after).toContain('define build.name = "wire"')

    // ③ 再跑一次是幂等的:什么都不用改了
    const again = await service.voiceWiring('wire', { apply: true })
    expect(again.changed).toEqual([])
  })

  it('升级是**纯函数**、只换那一行(找不到那一行就原样退回,不硬来)', () => {
    const text = [
      '# 注释',
      'define config.has_music = True',
      'define config.auto_voice = "voice/{id}.ogg"',
      'define build.name = "x"',
      '',
    ].join('\n')
    const { text: next, upgraded } = upgradeAutoVoice(text)
    expect(upgraded).toBe(true)
    expect(next).toContain('define config.has_music = True')
    expect(next).toContain('define build.name = "x"')
    expect(next).toContain('config.auto_voice = _galfree_voice')
    expect(upgradeAutoVoice('没有那一行\n').upgraded).toBe(false)
  })

  it('**生成侧盖章**:generateScene 写出来的每一句对白都带显式 id', async () => {
    // 这条就是漏掉的那一步。T26 只验了函数本身,没验生成这条路调了它。
    await service.generateScene('wire', { label: 'scene_one', source: SCENE })

    const written = await readFile(sceneFile(), 'utf8')
    expect(written).toContain('"第一句旁白。" id scene_one_0000')
    expect(written).toContain('xiao_tang "第二句对白。" id scene_one_0001')

    // 而且与清单口径一致:派生的 id 与写进 `.rpy` 的是同一个。
    const batch = await service.voiceBatch('wire')
    const mine = batch.rows.filter((row) => row.scene === 'scene_one')
    expect(mine.map((row) => row.dialogueId)).toEqual(['scene_one_0000', 'scene_one_0001'])
    expect(mine.every((row) => row.stamped)).toBe(true)
  })

  it('read:没盖过的场景被如实指出来(dialogueId 有值 ≠ 引擎认它)', async () => {
    // 造出"老项目"的样子:先把生成的场景换成没有 id 的版本,再抹掉那行配置。
    await service.generateScene('wire', { label: 'scene_one', source: SCENE })
    const gateway = await service.readProjectFile('wire', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('wire', [
      { path: 'game/scenes/scene_one.rpy', content: UNSTAMPED_SCENE, expectVersion: gateway.version },
    ], { origin: 'agent', reason: 'scenario' })

    const report = await service.voiceWiring('wire')
    expect(report.needsWiring).toBe(true)
    const scene = report.scenes.find((candidate) => candidate.label === 'scene_one')!
    expect(scene.needsStamp).toBe(true)
    expect(scene.stampedCount).toBe(0)
    expect(scene.dialogueCount).toBe(2)

    // 关键:清单里**照样有 id**(派生出来的)—— 所以光看清单发现不了这个坑。
    // 要分开看的是 `stamped`:它是"引擎认不认这个名字"。
    const batch = await service.voiceBatch('wire')
    const mine = batch.rows.filter((row) => row.scene === 'scene_one')
    expect(mine.map((row) => row.dialogueId)).toEqual(['scene_one_0000', 'scene_one_0001'])
    expect(mine.every((row) => !row.stamped)).toBe(true)
  })

  it('apply:补上配置 + 逐条盖章(一个写批 = 一个快照)', async () => {
    await service.generateScene('wire', { label: 'scene_one', source: SCENE })
    // 抹掉配置那一行,模拟老项目
    const options = await service.readProjectFile('wire', 'game/options.rpy')
    await service.writeProjectFiles('wire', [{
      path: 'game/options.rpy',
      content: options.content.split('\n').filter((line) => !line.includes('config.auto_voice')).join('\n'),
      expectVersion: options.version,
    }], { origin: 'agent', reason: 'edit' })
    const scene = await service.readProjectFile('wire', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('wire', [
      { path: 'game/scenes/scene_one.rpy', content: UNSTAMPED_SCENE, expectVersion: scene.version },
    ], { origin: 'agent', reason: 'scenario' })

    const before = await service.voiceWiring('wire')
    expect(before.autoVoice.present).toBe(false)
    expect(before.needsWiring).toBe(true)
    const historyBefore = (await service.snapshotHistory('wire', 'game/scenes/scene_one.rpy')).length

    const after = await service.voiceWiring('wire', { apply: true })

    // 配置补上了 —— 而且补的是**函数形态**(T39:字符串形态只能钉一个后缀,
    // 小米 MiMo 给 mp3、本地 IndexTTS 给 ogg,钉错了就是"引擎不报错、就是没声音")。
    expect(after.autoVoice.present).toBe(true)
    expect(after.autoVoice.form).toBe('function')
    expect(await readFile(optionsFile(), 'utf8')).toContain('config.auto_voice = _galfree_voice')
    // 场景盖章了
    expect(await readFile(sceneFile(), 'utf8')).toContain('id scene_one_0000')
    // 干净了
    expect(after.needsWiring).toBe(false)
    // 走了网关 ⇒ 留下快照(一个写批一个快照)
    const historyAfter = (await service.snapshotHistory('wire', 'game/scenes/scene_one.rpy')).length
    expect(historyAfter).toBeGreaterThan(historyBefore)
    // 而且回报的是**写完重新读的**事实,不是推断
    expect(after.changed.length).toBeGreaterThan(0)
  })

  it('幂等:再 apply 一次什么都不动(盖章按序号重写,同一个 label + 同序号 = 同一个 id)', async () => {
    await service.generateScene('wire', { label: 'scene_one', source: SCENE })
    const first = await service.voiceWiring('wire', { apply: true })
    expect(first.changed).toEqual([])
    const once = await readFile(sceneFile(), 'utf8')
    await service.voiceWiring('wire', { apply: true })
    expect(await readFile(sceneFile(), 'utf8')).toBe(once)
  })

  it('手写文件只报不改(生成器不越界)', async () => {
    // script.rpy 是手写/模板文件,里头也有对白 —— 但不能被盖章。
    const script = await service.readProjectFile('wire', 'game/script.rpy')
    await service.writeProjectFiles('wire', [{
      path: 'game/script.rpy',
      content: `${script.content}\nlabel hand_written:\n    "手写的一句。"\n    return\n`,
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })

    const report = await service.voiceWiring('wire')
    const hand = report.scenes.find((candidate) => candidate.label === 'hand_written')
    expect(hand?.handWritten).toBe(true)
    expect(hand?.needsStamp).toBe(false)

    await service.voiceWiring('wire', { apply: true })
    // 手写文件**一个字节都不该变**
    expect(await readFile(join(projectsRoot, 'wire', 'game', 'script.rpy'), 'utf8')).not.toContain('id hand_written')
  })
})
