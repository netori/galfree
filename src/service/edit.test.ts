/**
 * T11 seam tests — 对话流结构化编辑器。
 *
 * 契约来源(T11 票面):
 *  - 逐行表单(说话人 / 文本 / 图像引用 / 选择项)编辑 → **网关翻译成最小化写批
 *    (不重排无关文本)**;
 *  - 源文本模式并存(直接看改 `.rpy`,同走网关);
 *  - 两路修改后,解析 / 进度 / 槽位全部跟随(双向同一性);
 *  - 子集外场景 → 编辑器降级只读并报告。
 *
 * "最小化"是本票的硬 AC:改一句对白,git diff 里**只能有那一行**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

const exec = promisify(execFile)

/** 场景源文本:夹着注释、空行、非对白语句 —— 编辑之后这些都必须原样。 */
const SCENE = [
  'label scene_one:',
  '    # 这一行的注释不许被动',
  '    scene bg school',
  '    show xiao_tang smile',
  '    xiao_tang "你来啦。"',
  '',
  '    "（沉默）"',
  '    jump scene_two',
  '',
].join('\n')

const SCENE_TWO = [
  'label scene_two:',
  '    alice "第二场。"',
  '    return',
  '',
].join('\n')

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repo })
  return stdout
}

describe('对话流结构化编辑器(T11)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let root: string

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t11-data-')
    projectsRoot = await makeTempDir('galfree-t11-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'edit', title: '编辑器' })
    const project = await service.getActiveProject()
    root = project!.root
    // 先建续接目标(scene_one 会跳它),再建 scene_one —— 续接目标必须是已存在的 label。
    await service.generateScene('edit', { label: 'scene_two', source: SCENE_TWO, outline: undefined })
    await service.generateScene('edit', { label: 'scene_one', source: SCENE, outline: undefined, nextLabel: 'scene_two' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('读出表单:逐行给出可编辑行(说话人/文本/图像引用/结构),带行号与原文', async () => {
    const form = await service.sceneForm('edit', 'scene_one')
    expect(form.path).toBe('game/scenes/scene_one.rpy')
    expect(form.readOnly).toBe(false)

    const dialogue = form.rows.find((row) => row.kind === 'dialogue' && row.speaker === 'xiao_tang')!
    expect(dialogue.text).toBe('你来啦。')
    expect(dialogue.line).toBeGreaterThan(0)
    expect(dialogue.raw).toContain('xiao_tang "你来啦。"')

    // 图像引用进表单(素材槽的可编辑入口)。
    const image = form.rows.find((row) => row.kind === 'image' && row.tag === 'bg')!
    expect(image.attributes).toEqual(['school'])

    // 结构与注释如实列出(表单不许"看不见"它们,否则编辑会意外丢掉)。
    expect(form.rows.some((row) => row.kind === 'comment')).toBe(true)
    expect(form.rows.some((row) => row.kind === 'jump')).toBe(true)
    expect(form.rows.some((row) => row.kind === 'blank')).toBe(true)
  })

  it('编辑指令本身不合法 → 带业务码的拒绝(不是 500 服务端故障)', async () => {
    // 行号越界 / 锚点找不到:是**请求方**的错(400),不是服务端故障。
    await expect(service.editScene('edit', {
      label: 'scene_one', edit: { kind: 'setDialogue', line: 9999, speaker: null, text: 'x' },
    })).rejects.toMatchObject({ code: 'invalid-edit' })
    await expect(service.editScene('edit', {
      label: 'scene_one', edit: { kind: 'insertStatement', anchor: '    这一行不存在', source: 'x' },
    })).rejects.toMatchObject({ code: 'invalid-edit' })
  })

  it('枚举字段的闸门在**接缝**上:坏声道 / 坏 role / 坏行号一律拒(不落一行坏语法)', async () => {
    // 为什么在接缝上:`.rpy` 是唯一真相,写进去的每一行都要是引擎认的语法。
    // 工具面与面板都可能把自由 JSON 送进来(面板路由就是 `body as never`),
    // 规则只住在某一个适配器里 = 另一条路能把坏行写进项目。
    await expect(service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 3, action: 'play', channel: 'bgm' as never, file: 'audio/x.ogg', loop: false },
    })).rejects.toMatchObject({ code: 'invalid-audio' })
    await expect(service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'setAudio', line: 3, action: 'fade' as never, channel: 'music', file: 'audio/x.ogg', loop: false },
    })).rejects.toMatchObject({ code: 'invalid-audio' })
    await expect(service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'setImage', line: 3, role: 'fadein' as never, tag: 'bg', attributes: [] },
    })).rejects.toMatchObject({ code: 'invalid-edit' })
    // 行号:缺失 / 不是正整数也当场拒(NaN 会让"越界"检查整个空过)。
    for (const line of [0, -1, 2.5, Number.NaN]) {
      await expect(service.editScene('edit', {
        label: 'scene_one', edit: { kind: 'deleteStatement', line },
      })).rejects.toMatchObject({ code: 'invalid-edit' })
    }
    // 坏指令一个字节都没写进去。
    expect(await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')).not.toContain('bgm')
  })

  it('改一句对白 → git diff 只有那一行(不断言全文件重写)', async () => {    const before = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    const form = await service.sceneForm('edit', 'scene_one')
    const row = form.rows.find((entry) => entry.kind === 'dialogue' && entry.speaker === 'xiao_tang')!

    await service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'setDialogue', line: row.line, speaker: 'xiao_tang', text: '你也是来看雨的哦。' },
    })

    // 磁盘上只有那一行变了(其余逐字相同)。
    const after = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    expect(after).toBe(before.replace('xiao_tang "你来啦。"', 'xiao_tang "你也是来看雨的哦。"'))
    // 注释 / 空行 / 其余语句都在原位。
    expect(after).toContain('# 这一行的注释不许被动')

    // git diff:一次写批 = 一个快照;这一批的 diff 只有一行增删。
    // 注意行尾那个 `id scene_one_0000`(T26 / ADR-0013):**它必须还在** ——
    // 表单改台词时那一行是重建出来的,而 id 是语音文件名的锚,丢了这一句就永远没声音。
    // 下面这两条断言同时也在守这件事:谁要是把 id 弄丢了,这里立刻红。
    const history = await service.snapshotHistory('edit', 'game/scenes/scene_one.rpy')
    const diff = await service.snapshotDiff('edit', 'game/scenes/scene_one.rpy', history[1]!.commit, history[0]!.commit)
    const changed = diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    expect(changed.filter((line) => line.startsWith('-'))).toEqual(['-    xiao_tang "你来啦。" id scene_one_0000'])
    expect(changed.filter((line) => line.startsWith('+'))).toEqual(['+    xiao_tang "你也是来看雨的哦。" id scene_one_0000'])

    // 改完照常判定:把新的事实交回(与 T10 同一形状)。
    const report = await service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'setDialogue', line: form.rows.find((e) => e.kind === 'dialogue' && e.speaker === 'xiao_tang')!.line, speaker: 'xiao_tang', text: '再看一次。' },
    })
    expect(report.validation.ok).toBe(true)
    expect(report.progress.scenes.find((scene) => scene.label === 'scene_one')!.stamp).toBe('none')
  })

  it('表单加图像引用 → 素材板立见新槽', async () => {
    const before = await service.progress('edit')
    expect(before.slots.map((slot) => slot.slot)).not.toContain('bg rooftop')

    const form = await service.sceneForm('edit', 'scene_one')
    // 用**语义锚点**(那一行的原文)插:调用方不必知道文件头占了哪几行。
    const anchor = form.rows.find((row) => row.kind === 'image' && row.tag === 'bg')!.raw
    await service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'insertStatement', anchor, source: '    scene bg rooftop' },
    })

    const after = await service.progress('edit')
    const added = after.slots.find((slot) => slot.slot === 'bg rooftop')
    expect(added).toBeDefined()
    expect(added!.filled).toBe(false)
    expect(added!.origin.scenes).toContain('scene_one')
    expect(added!.assetPath).toBe('game/images/bg-rooftop.png')
  })

  it('源文本模式:直接改 .rpy 也走网关,且表单重解析一致(双向同一性)', async () => {
    const form = await service.sceneForm('edit', 'scene_one')
    const edited = {
      kind: 'replaceSource' as const,
      source: form.source.replace('xiao_tang "你来啦。"', 'xiao_tang "从源文本改的。"'),
    }
    await service.editScene('edit', { label: 'scene_one', edit: edited })

    // 源 → 表单:重解析必须反映这次改动(不是缓存)。
    const after = await service.sceneForm('edit', 'scene_one')
    expect(after.rows.find((row) => row.kind === 'dialogue' && row.speaker === 'xiao_tang')!.text).toBe('从源文本改的。')
    // 表单 → 源:表单读出来的 source 与磁盘逐字一致。
    expect(after.source).toBe(await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8'))

    // 源文本模式的写同样是一个写批一个快照。
    const history = await service.snapshotHistory('edit', 'game/scenes/scene_one.rpy')
    expect(history.length).toBeGreaterThanOrEqual(2)
  })

  it('源文本改坏了:如实报告(解析/校验问题当场回传),不假装成功', async () => {
    const report = await service.editScene('edit', {
      label: 'scene_one',
      edit: { kind: 'replaceSource', source: 'label scene_one:\n    jump nowhere\n' },
    })
    expect(report.validation.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'dangling-jump')).toBe(true)
    // 问题也进板(与 T10 同源)。
    expect(report.progress.problems.some((problem) => problem.code === 'dangling-jump')).toBe(true)
  })

  it('子集外场景:编辑器降级只读并报告原因', async () => {
    await service.generateScene('edit', {
      label: 'scene_odd',
      source: 'label scene_odd:\n    if flag:\n        "子集外的分支。"\n    return\n',
      outline: undefined,
    })

    const form = await service.sceneForm('edit', 'scene_odd')
    expect(form.readOnly).toBe(true)
    expect(form.readOnlyReason).toContain('子集外')

    // 只读就是只读:任何编辑都被拒绝,并说明为什么。
    await expect(service.editScene('edit', {
      label: 'scene_odd',
      edit: { kind: 'setDialogue', line: 3, speaker: null, text: '改一下。' },
    })).rejects.toThrow(/只读|子集外/)
  })

  it('重生成不吞内容(回归):第二次写同一场时,上一版的正文必须还在文件里', async () => {
    const before = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    // 上一版里这些行都在:注释、图像、对白、空行、跳转。重生成后除了被替换的那一段,其余都得在。
    await service.generateScene('edit', {
      label: 'scene_one',
      source: 'label scene_one:\n    "重生成后的新正文。"\n    return\n',
      outline: undefined,
    })
    void before
    const rewritten = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
    expect(rewritten).toContain('重生成后的新正文。')
    // 生成器自己的头只出现一次(不越写越多)。
    expect(rewritten.split('# GALFree 生成场景:').length - 1).toBe(1)
  })

  it('编辑也守归属与边界:手写文件的场景可通过源文本模式改,但表单编辑要它先搬家', async () => {
    // 模板的 start 住在 script.rpy(手写文件)。
    const form = await service.sceneForm('edit', 'start')
    expect(form.path).toBe('game/script.rpy')
    // 表单编辑只对生成目录里的场景开放(结构编辑的前提是这一场归生成器管);
    // 源文本模式是"直接改我自己的文件",不受这条限制。
    await expect(service.editScene('edit', {
      label: 'start',
      edit: { kind: 'setDialogue', line: 7, speaker: null, text: 'x' },
    })).rejects.toThrow(/生成目录|搬家/)
    const report = await service.editScene('edit', {
      label: 'start',
      edit: { kind: 'replaceSource', source: 'label start:\n    "直接改手写文件。"\n    return\n' },
    })
    expect(report.validation.ok).toBe(true)
  })
})
