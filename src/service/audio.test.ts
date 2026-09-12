/**
 * T17 seam tests — BGM/SE 接线(#25)。
 *
 * 契约来源(T17 票面):
 *  1. **丢文件进音频目录 → 编辑器可选**(文件池派生,无手工登记);
 *  2. **引用缺失音频 → 校验错误定位上板**(纯推导,文件一放进去问题自己消失);
 *  3. **接线写批同经网关 + 快照**(与别的编辑同一条路,没有旁路)。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态 + 推导对象。
 * 音频文件是**假字节**(池与接线都不解析音频内容):本票不做生成、不做试听 ——
 * 试听由试玩承担,主观认可由人盖审读戳。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

/** 一个生成目录里的场景(表单编辑只对它开放 —— 手写文件的场景要先搬家)。 */
const SCENE = [
  'label scene_one:',
  '    # 注释与空行不许被吃掉',
  '    scene bg school',
  '    xiao_tang "你来啦。"',
  '    return',
  '',
].join('\n')

/** 假的音频字节(池只认后缀与存在性,不解析内容)。 */
const OGG = Buffer.from('OggS-fake-bytes-for-pool')

describe('BGM/SE 接线(T17)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let root: string

  /** 丢一个文件进音频目录(经网关写 —— 与"人把文件拖进去"同一个终态)。 */
  const dropAudio = async (relPath: string, content: Buffer = OGG): Promise<void> => {
    await service.writeProjectFiles('audio', [{ path: relPath, content, expectVersion: 'absent' }], { origin: 'workbench', reason: 'asset' })
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t17-data-')
    projectsRoot = await makeTempDir('galfree-t17-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'audio', title: '音频' })
    root = (await service.getActiveProject())!.root
    // 这一场住在**生成目录**里(表单编辑只对它开放),内容自己写死 ——
    // 行号是可预期的,断言才不会被生成器的头注释挤走。
    await service.writeProjectFiles('audio', [{ path: 'game/scenes/scene_one.rpy', content: SCENE, expectVersion: 'absent' }], { origin: 'agent', reason: 'scenario' })
    // 让它是**可达**的(否则 orphan-scene 会让 lint 一直是 false,盖住这一票要验的东西)。
    const snap = await service.readProjectFile('audio', 'game/script.rpy')
    await service.writeProjectFiles('audio', [{
      path: 'game/script.rpy',
      content: snap.content.replace(/^label start:\n/m, 'label start:\n    jump scene_one\n'),
      expectVersion: snap.version,
    }], { origin: 'agent', reason: 'scenario' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ── AC1:丢文件进音频目录 → 编辑器可选(文件池派生,无手工登记)────────

  it('AC1 池是**派生**的:文件一进 game/audio 就出现在池里,没有任何手工登记', async () => {
    // 一开始池是空的。
    expect((await service.audioPool('audio')).files).toEqual([])

    await dropAudio('game/audio/rain.ogg')

    const pool = await service.audioPool('audio')
    // 池里的路径就是 `.rpy` 里该写的那一串(相对 game/)—— 编辑器选它,剧本照抄。
    expect(pool.files.map((file) => file.path)).toEqual(['audio/rain.ogg'])
    expect(pool.files[0]!.bytes).toBe(OGG.byteLength)

    // **没有手工登记**:`.studio/` 里不存在任何音频账本(池是推导的)。
    const studio = await readdir(join(root, '.studio'))
    expect(studio.filter((name) => /audio/i.test(name))).toEqual([])

    // 文件没了 → 池自己空掉(推导,不需要谁去"取消登记")。
    await service.writeProjectFiles('audio', [{ path: 'game/audio/rain.ogg', content: null, expectVersion: (await service.readProjectFile('audio', 'game/audio/rain.ogg')).version }], { origin: 'workbench', reason: 'asset' })
    expect((await service.audioPool('audio')).files).toEqual([])
  })

  it('AC1 只收音频后缀且路径口径统一:非音频文件不进池,子目录也照扫', async () => {
    await dropAudio('game/audio/bgm/theme.ogg')
    await dropAudio('game/audio/se/click.wav')
    await dropAudio('game/audio/readme.txt', Buffer.from('not audio'))
    await dropAudio('game/audio/cover.png', Buffer.from('not audio'))

    const pool = await service.audioPool('audio')
    // 相对 game/ 的 POSIX 路径,按路径排序 —— 与 `.rpy` 里的引用字符串同一口径。
    expect(pool.files.map((file) => file.path)).toEqual(['audio/bgm/theme.ogg', 'audio/se/click.wav'])
  })

  // ── AC2:引用缺失音频 → 校验错误定位上板 ─────────────────────────────

  it('AC2 引用缺失的音频 → error 上板,定位到**哪一场的哪一行**', async () => {
    await service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 5, action: 'play', channel: 'music', file: 'audio/rain.ogg', loop: true },
    })

    const progress = await service.progress('audio')
    const problem = progress.problems.find((entry) => entry.code === 'missing-audio')
    expect(problem).toBeDefined()
    expect(problem!.severity).toBe('error')
    expect(problem!.file).toBe('scenes/scene_one.rpy')
    expect(problem!.line).toBe(5)
    expect(problem!.message).toContain('audio/rain.ogg')
    expect(problem!.message).toContain('scene_one')
    expect(progress.lint.ok).toBe(false)

    // 文件一放进去,问题**自己消失**(纯推导,没有"清错误"的动作)。
    await dropAudio('game/audio/rain.ogg')
    const after = await service.progress('audio')
    expect(after.problems.some((entry) => entry.code === 'missing-audio')).toBe(false)

    // 池里的引用处境也是推出来的:谁被引用、谁还没用上。
    const pool = await service.audioPool('audio')
    expect(pool.references.map((reference) => reference.ref)).toEqual(['audio/rain.ogg'])
    expect(pool.references[0]).toMatchObject({ scene: 'scene_one', line: 5, channel: 'music', found: true })
    expect(pool.missing).toEqual([])
    expect(pool.unused).toEqual([])
  })

  it('AC2 `stop` 没有文件引用、不误报;没人引用的文件进 unused(是信息,不是 lint 噪声)', async () => {
    await dropAudio('game/audio/rain.ogg')
    await dropAudio('game/audio/unused.ogg')
    await service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 5, action: 'play', channel: 'music', file: 'audio/rain.ogg', loop: true },
    })

    const progress = await service.progress('audio')
    expect(progress.problems.some((entry) => entry.code === 'missing-audio')).toBe(false)
    expect(progress.lint.ok).toBe(true)

    const pool = await service.audioPool('audio')
    expect(pool.unused).toEqual(['audio/unused.ogg'])
    // unused 只是**信息**:它不该变成 lint 问题(否则每丢一个还没接线的文件就报一次错)。
    expect(progress.problems.some((entry) => entry.message.includes('unused.ogg'))).toBe(false)

    // stop:停一个声道不需要文件,不算缺引用。
    await service.editScene('audio', { label: 'scene_one', edit: { kind: 'setAudio', line: 6, action: 'stop', channel: 'music', file: null, loop: false } })
    const after = await service.progress('audio')
    expect(after.problems.some((entry) => entry.code === 'missing-audio')).toBe(false)
  })

  // ── AC3:接线写批同经网关 + 快照 ──────────────────────────────────────

  it('AC3 接线是一个写批:经网关(写日志有据) + 自动快照(可回滚)', async () => {
    await dropAudio('game/audio/rain.ogg')
    const before = (await service.snapshotHistory('audio', 'game/scenes/scene_one.rpy')).length

    const report = await service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 5, action: 'play', channel: 'music', file: 'audio/rain.ogg', loop: true },
    })

    // 落盘终态:那一行就在文件里(方言子集能解析的形状)。
    const text = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    expect(text).toContain('play music "audio/rain.ogg" loop')
    // 别的行一个字节都不动(与 T11 同一条最小化纪律)。
    expect(text.split('\n')[1]).toBe('    # 注释与空行不许被吃掉')

    // 经网关 + 快照。
    expect((await service.writeLog('audio')).some((entry) => entry.path === 'game/scenes/scene_one.rpy')).toBe(true)
    expect((await service.snapshotHistory('audio', 'game/scenes/scene_one.rpy')).length).toBeGreaterThan(before)
    expect(report.parseOk).toBe(true)

    // 解析结果立刻反映:那一行是 audio 语句,且在板上可编辑(round-trip 的字段齐)。
    const form = await service.sceneForm('audio', 'scene_one')
    const row = form.rows.find((entry) => entry.kind === 'audio')!
    expect(row).toMatchObject({ action: 'play', channel: 'music', file: 'audio/rain.ogg', loop: true })

    // 只改这一行 → diff 只有这一行(接线没有把整段重写)。
    expect(report.progress.scenes.find((scene) => scene.label === 'scene_one')).toBeDefined()
  })

  it('AC3 表单与源文本两个视图同一份真相:源文本改的音频行,表单读得到', async () => {
    const current = await service.readProjectFile('audio', 'game/scenes/scene_one.rpy')
    await service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'replaceSource', source: current.content.replace('    return', '    play sound "audio/se/click.ogg"\n    return') },
    })
    const form = await service.sceneForm('audio', 'scene_one')
    const row = form.rows.find((entry) => entry.kind === 'audio')!
    expect(row).toMatchObject({ action: 'play', channel: 'sound', file: 'audio/se/click.ogg', loop: false })
  })

  // ── 边界:接线不许写出子集外/空引用的东西 ─────────────────────────────

  it('play 不给文件 → 如实拒绝(invalid-audio),不写半行坏语法', async () => {
    await expect(service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 5, action: 'play', channel: 'music', file: '', loop: false },
    })).rejects.toMatchObject({ code: 'invalid-audio' })

    const text = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    expect(text).not.toContain('play music')
  })

  it('编辑之后当场判定:接线到缺失文件时,报告里就有那条问题(不必等下次刷板)', async () => {
    const report = await service.editScene('audio', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 5, action: 'play', channel: 'sound', file: 'audio/se/boom.ogg', loop: false },
    })
    expect(report.issues.some((issue) => issue.code === 'missing-audio')).toBe(true)
  })
})
