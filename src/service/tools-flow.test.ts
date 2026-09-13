/**
 * T20(工具面补齐)守卫 —— 两个层面:
 *
 *  1. **每一组新工具都是接缝的搬运工**:同一个动作从工具走与从面板走,落到**同一份
 *     账本/推导**(AC2 的结构保证:工具只调接缝,不另立真相源)。断言面 = 工具返回的文本
 *     + `ProjectService` 公共接口读出来的事实。
 *  2. **端到端:只凭工具面走完全流程**(AC1):建项目 → 写设定集 →(请人盖定稿戳)→
 *     逐场生成 → 补素材 → 接线音频 → 试玩 → 发布。中间**只有盖章**那一步是人做的,
 *     其余全部经工具调用 —— 这正是"新会话能不能自己跑完"的可回放证据。
 *
 * 夹具全部是注入端口(假 SDK / 假图像上游 / 假试玩 / 假构建),不碰真 SDK、不花钱。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { registerGalfreeTools, type GalfreeToolPorts } from './tools.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageHttpClient } from './images.ts'
import { PLAYTEST_DEFAULT_WAIT_MINUTES } from './playtest.ts'
import type { SpawnResult } from './playtest.ts'
import type { PublishPorts } from './publish.ts'

interface FakeTool {
  name: string
  description: string
  parameters: { properties: Record<string, { type: string; description?: string }>; required?: string[] }
  /** `exec` 可选:直接调工具的那些用例不给它(真宿主一定会给,取消那条路才有信号)。 */
  execute: (args: Record<string, unknown>, exec?: { signal?: AbortSignal }) => Promise<string>
}

/** 一张 1×1 的最小 PNG(假上游回它,产物落盘能过"文件存在"这条判据)。 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 假图像上游(不出网):同步 OpenAI 兼容应答,直接给 base64。 */
function fakeImageHttp(): ImageHttpClient {
  return {
    send: async () => ({ status: 200, text: JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }) }),
    download: async () => ({ status: 200, bytes: new Uint8Array(), contentType: '' }),
  }
}

describe('全流程工具面(T20)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let outDir: string
  let service: ProjectService
  let tools: FakeTool[]

  const find = (name: string): FakeTool => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (tool === undefined) throw new Error(`工具面里没有 ${name}(注册了:${tools.map((t) => t.name).join(', ')})`)
    return tool
  }

  /** 造一个工具面(与入口同一条路:懒注入的席位在这里换成一个收集器)。 */
  function register(ports: GalfreeToolPorts = { defaultProjectsRoot: () => projectsRoot, sdkDir: () => sdkDir }): FakeTool[] {
    const collected: FakeTool[] = []
    registerGalfreeTools(
      { tools: { register: (tool: unknown) => { collected.push(tool as FakeTool); return () => {} } } } as unknown as Context & { tools: { register: (tool: unknown) => () => void } },
      service,
      ports,
    )
    return collected
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t20-data-')
    projectsRoot = await makeTempDir('galfree-t20-projects-')
    outDir = await makeTempDir('galfree-t20-out-')
    const publishPorts: PublishPorts = {
      resolveLauncher: async () => join(sdkDir, 'renpy.exe'),
      run: async (input) => {
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(input.destination, { recursive: true })
        await writeFile(join(input.destination, 'flow-0.1.0-pc.zip'), Buffer.from('fake-dist'))
        return { code: 0, log: 'built\n' }
      },
    }
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: fakeImageHttp(),
        channel: () => ({
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-test',
          models: [{
            id: 'fake-image',
            adapter: 'openai-compatible',
            capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
          }],
        }),
      },
      playtest: { resolveLauncher: async () => '/fake/renpy.exe', spawn: async () => ({ code: 0, log: "Ren'Py 8.5.3 starting\n" }) },
      publish: { ports: publishPorts, destination: () => join(outDir, 'dist') },
    })
    tools = register()
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ── 切片 A:建项目 / 设定集(全流程的入口两步)─────────────────────

  describe('建项目(galfree_create_project)', () => {
    it('create:建在默认父目录下、立刻成为激活项目(与面板同一条路)', async () => {
      const out = JSON.parse(await find('galfree_create_project').execute({ action: 'create', name: 'rainy', title: '雨天天台' })) as {
        ok: boolean
        project: { id: string; name: string; root: string }
        next: string
      }
      expect(out.ok).toBe(true)
      expect(out.project.name).toBe('rainy')
      // 与接缝同一份注册表:列表里看得到,激活位也切过去了。
      expect((await service.listProjects()).map((project) => project.name)).toContain('rainy')
      expect((await service.getActiveProject())?.name).toBe('rainy')
      // 项目真的在磁盘上(模板落盘 + 界面文件拷进去了)。
      await expect(readFile(join(out.project.root, 'game', 'script.rpy'), 'utf8')).resolves.toContain('label start:')
      await expect(readFile(join(out.project.root, 'game', 'screens.rpy'), 'utf8')).resolves.toContain('_galfree_fake_ui_start')
      // 立刻能用:板读得出来(模板自带入口场)。
      expect((await service.progress('rainy')).summary.scenes).toBeGreaterThanOrEqual(1)
    })

    it('create:没给父目录、设置里也没默认 → 如实拒绝并说清怎么补(不猜一个目录)', async () => {
      tools = register({ sdkDir: () => sdkDir })
      const out = await find('galfree_create_project').execute({ action: 'create', name: 'nowhere' })
      expect(out).toContain('no-projects-root')
      expect(out).toMatch(/父目录|projects_root/)
      expect(await service.listProjects()).toEqual([])
    })

    it('create:显式给 projects_root 就按它建(工具参数优先于设置)', async () => {
      const other = await makeTempDir('galfree-t20-other-')
      const out = JSON.parse(await find('galfree_create_project').execute({ action: 'create', name: 'elsewhere', projects_root: other })) as {
        project: { root: string }
      }
      expect(out.project.root).toBe(join(other, 'elsewhere'))
    })

    it('create:没有 SDK 界面模板 → 如实拒绝(不假装拷到了界面文件)', async () => {
      // 生产里没有 `uiTemplate` 端口:界面文件只能从 SDK 拷(缺了项目连关窗都崩)。
      service = createProjectService({ dataDir: dataDir + '-nodb' })
      tools = register({ defaultProjectsRoot: () => projectsRoot })
      const out = await find('galfree_create_project').execute({ action: 'create', name: 'nodb' })
      expect(out).toContain('sdk-ui-missing')
      expect(await service.listProjects()).toEqual([])
    })

    it('list / activate:列出全部项目、切激活位(同一个注册表)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'one' })
      await find('galfree_create_project').execute({ action: 'create', name: 'two' })
      const listed = JSON.parse(await find('galfree_create_project').execute({ action: 'list' })) as {
        projects: Array<{ name: string; active: boolean }>
      }
      expect(listed.projects.map((project) => project.name).sort()).toEqual(['one', 'two'])
      expect(listed.projects.filter((project) => project.active).map((project) => project.name)).toEqual(['two'])

      const first = (await service.listProjects()).find((project) => project.name === 'one')!
      const activated = JSON.parse(await find('galfree_create_project').execute({ action: 'activate', project: first.id })) as {
        active: { name: string }
      }
      expect(activated.active.name).toBe('one')
      expect((await service.getActiveProject())?.name).toBe('one')
    })

    it('没有删除这个动作(建了就建了:删项目不在这一票里)', () => {
      const tool = find('galfree_create_project')
      expect(tool.description).toMatch(/不.*删|删除不做/)
    })
  })

  describe('设定集(galfree_story_bible)', () => {
    it('write:主题/世界观/章节落盘 + 角色同步进登记簿(同一个家)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible' })
      const out = JSON.parse(await find('galfree_story_bible').execute({
        action: 'write',
        theme: '雨天的天台',
        world: '只有两个人的放学后。',
        chapters: [{ id: 'ch1', title: '第一场雨', scenes: [] }],
        characters: [{
          id: 'xiao_tang',
          name: '小棠',
          voice: 'xiao_tang',
          // 外观是**结构化字段**(不是散文):它要被图像子系统当一致性锚用。
          appearance: { hair: '黑色短发', outfit: '夏季校服' },
          style_anchor: '日系赛璐璐,柔光',
        }],
      })) as { ok: boolean; bible: { stamp: string; chapters: number; characters: number }; characters: string[]; next: string }

      expect(out.ok).toBe(true)
      // 与接缝同一份账本:读出来的就是刚写的。
      const doc = await service.bible('bible')
      expect(doc.theme).toBe('雨天的天台')
      expect(doc.chapters.map((chapter) => chapter.id)).toEqual(['ch1'])
      // 角色设定落**登记簿**(设定集里只有引用) —— 与面板「设定集」卡同一条路。
      expect((await service.characters('bible')).map((record) => record.id)).toEqual(['xiao_tang'])
      expect((await service.bible('bible')).characters.map((ref) => ref.id)).toEqual(['xiao_tang'])
      // 外观卡与画风锚真的进登记簿了(不是只记了个名字)。
      const record = (await service.characters('bible'))[0]!
      expect(record.appearance.hair).toBe('黑色短发')
      expect(record.styleAnchor).toBe('日系赛璐璐,柔光')
      expect(out.characters).toEqual(['xiao_tang'])
      // 没盖章:如实说 stamp = none,并把"请人盖"写成下一步。
      expect(out.bible.stamp).toBe('none')
      expect(out.next).toMatch(/定稿|盖/)
    })

    it('write:外观卡是**结构化**的 —— 塞一段散文会被参数契约当场拒绝', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible-prose' })
      // 这条不是"工具自己判的":schema 就写死了 appearance 是对象(散文塞不出稳定的画风)。
      await expect(find('galfree_story_bible').execute({
        action: 'write',
        characters: [{ id: 'x', name: 'X', appearance: '一个短发的女孩,穿着校服' }],
      })).rejects.toThrow(/appearance/)
    })

    it('write:改了已定稿的设定集 → 定稿戳自动待复审(不静默当没事)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible2' })
      await find('galfree_story_bible').execute({ action: 'write', theme: '第一版' })
      await service.stampBible('bible2', { via: 'human' })
      expect((await service.bible('bible2')).theme).toBe('第一版')

      const out = JSON.parse(await find('galfree_story_bible').execute({ action: 'write', theme: '第二版' })) as {
        bible: { stamp: string }
      }
      expect(out.bible.stamp).toBe('stale')
      // 下游生成据此被拒(同一道闸门,不是工具自己判的)。
      await expect(service.generationContext('bible2')).rejects.toMatchObject({ code: 'bible-not-final' })
    })

    it('write:越界内容被接缝拦下(设定集存意图,不存正文),原话带回', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible3' })
      const out = await find('galfree_story_bible').execute({ action: 'write', world: 'x'.repeat(4100) })
      expect(out).toContain('bible-invalid')
      expect(out).toMatch(/太长/)
    })

    it('write:改角色设定卡**不会**抹掉参考链(链归 galfree_reference_chain)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'chain' })
      await find('galfree_story_bible').execute({
        action: 'write',
        characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '黑色短发' } }],
      })
      // 先经**另一个工具**把链写上(那是链的唯一入口)。
      await service.writeProjectFiles('chain', [{ path: 'game/images/xiao_tang-base.png', content: Buffer.from([0x89, 0x50]), expectVersion: 'absent' }], { origin: 'workbench', reason: 'asset' })
      await find('galfree_reference_chain').execute({
        project: 'chain', character: 'xiao_tang',
        references: [{ path: 'game/images/xiao_tang-base.png', note: '主视觉' }],
      })
      expect((await service.characters('chain'))[0]!.references.map((reference) => reference.path)).toEqual(['game/images/xiao_tang-base.png'])

      // 再改设定卡(登记簿是**整条替换**的语义,所以适配器必须把链带回去)。
      const out = await find('galfree_story_bible').execute({
        action: 'write',
        characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '改成银色短发' } }],
      })
      expect(out).toContain('"ok": true')
      const record = (await service.characters('chain'))[0]!
      expect(record.appearance.hair).toBe('改成银色短发')
      // 链还在(契约:「不给空链入口」—— 更新设定卡不是清链的手段)。
      expect(record.references.map((reference) => reference.path)).toEqual(['game/images/xiao_tang-base.png'])
    })

    it('write:章节形状不对 → 参数契约当场拒绝(不是写下去之后内部 TypeError)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible-shape' })
      // `scenes` 在接缝那边是必填数组,所以工具契约也要求它 —— 模型在**参数**这一层就拿到
      // 拒绝(而不是写进盘、之后每次读板都炸)。两种坏形状都拒:
      await expect(find('galfree_story_bible').execute({ action: 'write', chapters: [{ id: 'c1', title: '缺 scenes' }] }))
        .rejects.toThrow(/scenes/)
      await expect(find('galfree_story_bible').execute({ action: 'write', chapters: [{ id: 'c1', title: 'x', scenes: 'start' }] }))
        .rejects.toThrow(/scenes/)
      // 一个字节都没写进去。
      expect((await service.bible('bible-shape')).chapters).toEqual([])
      // 接缝那一侧的领域规则仍在(别的调用方 —— 面板路由 —— 可以绕过工具契约)。
      await expect(service.writeBible('bible-shape', { chapters: [{ id: 'c2', title: 'x', scenes: [] }, { id: 'c2', title: 'y', scenes: [] }] }, { via: 'agent' }))
        .rejects.toMatchObject({ code: 'bible-invalid' })
    })

    it('read:给主题/世界观/章节/角色引用/大纲原文,以及板上的定稿处境', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible4' })
      const written = await find('galfree_story_bible').execute({ action: 'write', theme: '主题', chapters: [{ id: 'ch1', title: '一章', scenes: [] }] })
      expect(written, 'write 就没成,后面读的当然也成不了').toContain('"ok": true')
      const out = JSON.parse(await find('galfree_story_bible').execute({ action: 'read' })) as {
        bible: { theme?: string; chapters: Array<{ id: string }> }
        outline: string | null
        board: { stamp: string }
      }
      expect(out.bible.theme).toBe('主题')
      expect(out.bible.chapters.map((chapter) => chapter.id)).toEqual(['ch1'])
      expect(out.outline).toBeNull()
      expect(out.board.stamp).toBe('none')
    })

    it('import_outline:人写的原文**逐字**落盘(工具不是改写器)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible5' })
      const text = '# 我写的大纲\n\n第一场:雨。\n第二场:天台风很大。\n'
      const out = JSON.parse(await find('galfree_story_bible').execute({ action: 'import_outline', text })) as {
        ok: boolean
        chars: number
      }
      expect(out.ok).toBe(true)
      expect(out.chars).toBe(text.length)
      // 逐字:与接缝读到的一模一样。
      expect(await service.bibleOutline('bible5')).toBe(text)
      expect((await service.progress('bible5')).bible.hasOutline).toBe(true)
    })

    it('import_outline:空原文被拒(要么给人写的原文,要么别导)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'bible6' })
      const out = await find('galfree_story_bible').execute({ action: 'import_outline', text: '   \n' })
      expect(out).toContain('bible-invalid')
    })
  })

  // ── 切片 B:场景编辑 / 音频接线 / 快照 ──────────────────────────────

  /** 备一个「能编辑」的项目:建项目 → 写设定集 →(人盖章)→ 生成一场戏。 */
  async function seedScene(name = 'flow', label = 'scene_one'): Promise<void> {
    await find('galfree_create_project').execute({ action: 'create', name })
    await find('galfree_story_bible').execute({ action: 'write', theme: '雨天的天台' })
    await service.stampBible(name, { via: 'human' }) // ← 只有人能盖的那一步
    const out = await find('galfree_generate_scene').execute({
      project: name,
      label,
      source: `label ${label}:\n    "（开场）雨声很大。"\n    return\n`,
    })
    expect(out).toContain('"ok": true')
  }

  /** 读行模型(编辑前先看它 —— 生成物头部有 4 行注释,行号不能猜)。 */
  async function readScene(project: string, label: string): Promise<{
    path: string
    source: string
    readOnly: boolean
    rows: Array<{ kind: string; line: number; raw: string }>
  }> {
    return JSON.parse(await find('galfree_edit_scene').execute({ project, action: 'read', label })) as never
  }

  describe('场景编辑(galfree_edit_scene)', () => {
    it('read:给行模型与源文本(与面板「场景」卡同一份视图)', async () => {
      await seedScene()
      const form = await readScene('flow', 'scene_one')
      expect(form.path).toBe('game/scenes/scene_one.rpy')
      expect(form.source).toContain('雨声很大')
      expect(form.readOnly).toBe(false)
      expect(form.rows.some((row) => row.kind === 'dialogue')).toBe(true)
      // 行号是**文件里的真行号**(头部有 4 行注释)—— 所以编辑前必须先 read。
      const dialogue = form.rows.find((row) => row.kind === 'dialogue')!
      expect(dialogue.line).toBeGreaterThan(4)
      expect(form.source.split('\n')[dialogue.line - 1]).toBe(dialogue.raw)
    })

    it('edit(setDialogue):改一行 → 落盘 + 快照 + 板立刻一致(与面板同一条写路)', async () => {
      await seedScene()
      const dialogue = (await readScene('flow', 'scene_one')).rows.find((row) => row.kind === 'dialogue')!
      const before = await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy')
      const out = JSON.parse(await find('galfree_edit_scene').execute({
        project: 'flow',
        action: 'edit',
        label: 'scene_one',
        edit: { kind: 'setDialogue', line: dialogue.line, speaker: '', text: '（开场）雨停了。' },
      })) as { ok: boolean; path: string; lint: { ok: boolean }; next: string }

      expect(out.ok).toBe(true)
      const text = (await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content
      expect(text).toContain('雨停了')
      expect(text).not.toContain('雨声很大')
      // 只有那一行变了(其余逐字保留 —— 注释与空行都在)。
      expect(text).toContain('# GALFree 生成场景:scene_one')
      // 与面板同一条写路:经网关 → 自动快照(不是绕过网关直接改文件)。
      const after = await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy')
      expect(after.length).toBeGreaterThan(before.length)
      expect(after[0]!.author).toBe('GALFree')
      expect(out.next).toMatch(/盖场景戳|人/)
    })

    it('edit(insertStatement):给锚点就插在那一行之后(行号会被生成器的头改掉,锚点更稳)', async () => {
      await seedScene()
      const rows = (await readScene('flow', 'scene_one')).rows
      const dialogueRow = rows.find((row) => row.kind === 'dialogue')!
      const out = JSON.parse(await find('galfree_edit_scene').execute({
        project: 'flow',
        action: 'edit',
        label: 'scene_one',
        edit: { kind: 'insertStatement', anchor: dialogueRow.raw, source: 'with dissolve' },
      })) as { ok: boolean }
      expect(out.ok).toBe(true)
      const text = (await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content
      const lines = text.split('\n')
      expect(lines[dialogueRow.line - 1]).toBe(dialogueRow.raw)
      expect(lines[dialogueRow.line]).toBe('    with dissolve')
      // 新行跟着上下文缩进(不是塞个固定宽度)。
      expect(text).toContain('    with dissolve')
    })

    it('edit:手写文件里的场景 → 如实拒绝并给出两条可行路(不静默不改)', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'hand' })
      const out = await find('galfree_edit_scene').execute({
        project: 'hand',
        action: 'edit',
        label: 'start',
        edit: { kind: 'setDialogue', line: 2, speaker: '', text: '改一下' },
      })
      expect(out).toContain('scene-not-editable')
      expect(out).toMatch(/搬|源文本/)
      // 真的一个字节都没动。
      expect((await service.readProjectFile('hand', 'game/script.rpy')).content).toContain('从这里开始你的故事')
    })

    it('edit(replaceSource):源文本模式对手写文件也开放(它就是"直接改我自己的文件")', async () => {
      await find('galfree_create_project').execute({ action: 'create', name: 'raw' })
      const current = await service.readProjectFile('raw', 'game/script.rpy')
      const out = JSON.parse(await find('galfree_edit_scene').execute({
        project: 'raw',
        action: 'edit',
        label: 'prologue',
        edit: { kind: 'replaceSource', source: current.content.replace('序章位置', '序章已改') },
      })) as { ok: boolean }
      expect(out.ok).toBe(true)
      expect((await service.readProjectFile('raw', 'game/script.rpy')).content).toContain('序章已改')
    })

    it('edit:坏编辑指令(行号越界)原样带回可执行的拒绝', async () => {
      await seedScene()
      const out = await find('galfree_edit_scene').execute({
        project: 'flow',
        action: 'edit',
        label: 'scene_one',
        edit: { kind: 'deleteStatement', line: 999 },
      })
      expect(out).toContain('invalid-edit')
      expect(out).toMatch(/越界/)
    })

    it('没有 relocate 这个动作(搬家只能由人发起:它重写的是人的手写文件)', async () => {
      const tool = find('galfree_edit_scene')
      expect(tool.description).toMatch(/搬家|搬进生成目录/)
      expect(tool.parameters.properties.action?.description ?? '').not.toContain('relocate')
      // **行为**上也不放行:传 relocate 会被当成不认识的 action,而且真的什么都没搬。
      await seedScene()
      const out = await find('galfree_edit_scene').execute({ project: 'flow', action: 'relocate', label: 'start' })
      expect(out).toMatch(/不认识的 action/)
      expect((await service.progress('flow')).scenes.find((scene) => scene.label === 'start')!.file).toBe('script.rpy')
      expect((await service.progress('flow')).scenes.find((scene) => scene.label === 'scene_one')!.file).toBe('scenes/scene_one.rpy')
    })

    it('audio 那一行不在这里改 → 指到 galfree_wire_audio(同一个动作不给两条入口)', async () => {
      await seedScene()
      const out = await find('galfree_edit_scene').execute({
        project: 'flow', action: 'edit', label: 'scene_one',
        edit: { kind: 'setAudio', line: 6 },
      })
      expect(out).toContain('galfree_wire_audio')
      // 认不出来的 kind 也给出可用清单。
      const bogus = await find('galfree_edit_scene').execute({
        project: 'flow', action: 'edit', label: 'scene_one', edit: { kind: 'setMusic' },
      })
      expect(bogus).toMatch(/不认识的 edit.kind/)
    })
  })

  describe('音频接线(galfree_wire_audio)', () => {
    /** 往项目里丢一个音频文件(池是派生的:丢进去就有)。 */
    async function dropAudio(project: string, relPath: string): Promise<void> {
      await service.writeProjectFiles(project, [{ path: `game/${relPath}`, content: Buffer.from('OggS-fake'), expectVersion: 'absent' }], { origin: 'workbench', reason: 'asset' })
    }

    /** 播放行原本不存在:先插一行(真实用法),再交给 wire 改。 */
    async function insertPlayRow(project: string, label: string, file: string): Promise<number> {
      const dialogueRow = (await readScene(project, label)).rows.find((row) => row.kind === 'dialogue')!
      await find('galfree_edit_scene').execute({
        project, action: 'edit', label,
        edit: { kind: 'insertStatement', anchor: dialogueRow.raw, source: `play music "${file}"` },
      })
      return (await readScene(project, label)).rows.find((row) => row.kind === 'audio')!.line
    }

    it('pool:列出池里的文件与引用处境(池是派生的,没有手工登记)', async () => {
      await seedScene()
      await dropAudio('flow', 'audio/rain.ogg')
      const out = JSON.parse(await find('galfree_wire_audio').execute({ project: 'flow', action: 'pool' })) as {
        files: string[]
        references: unknown[]
        unused: string[]
      }
      expect(out.files).toEqual(['audio/rain.ogg'])
      expect(out.references).toEqual([])
      expect(out.unused).toEqual(['audio/rain.ogg'])
    })

    it('wire:接一行 → `.rpy` 里就是那一行 + 板上的引用处境立刻一致', async () => {
      await seedScene()
      await dropAudio('flow', 'audio/rain.ogg')
      const line = await insertPlayRow('flow', 'scene_one', 'audio/rain.ogg')
      const out = JSON.parse(await find('galfree_wire_audio').execute({
        project: 'flow',
        action: 'wire',
        label: 'scene_one',
        line,
        channel: 'music',
        file: 'audio/rain.ogg',
        loop: true,
      })) as { ok: boolean; audio: { references: Array<{ ref: string }>; missing: unknown[] }; next: string }

      expect(out.ok).toBe(true)
      // 写的是**相对 game/ 的路径**(Ren'Py 的口径),不是绝对路径、不是别的说法。
      expect((await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content).toContain('play music "audio/rain.ogg" loop')
      expect(out.audio.references.map((reference) => reference.ref)).toEqual(['audio/rain.ogg'])
      expect(out.audio.missing).toEqual([])
      expect(out.next).toMatch(/试玩|场景戳/)
    })

    it('wire:指向池里没有的文件 → 接线照样写,但**当场如实报悬空**(不静默留个哑巴声道)', async () => {
      await seedScene()
      await dropAudio('flow', 'audio/rain.ogg')
      const line = await insertPlayRow('flow', 'scene_one', 'audio/rain.ogg')

      const out = JSON.parse(await find('galfree_wire_audio').execute({
        project: 'flow',
        action: 'wire',
        label: 'scene_one',
        line,
        channel: 'music',
        file: 'audio/not-there.ogg',
      })) as { audio: { missing: Array<{ ref: string }> }; next: string }
      expect(out.audio.missing.map((reference) => reference.ref)).toEqual(['audio/not-there.ogg'])
      expect(out.next).toMatch(/悬空/)
      // 板上也确实是一条 error(与工具报的是同一个判断)。
      expect((await service.progress('flow')).problems.some((problem) => problem.code === 'missing-audio')).toBe(true)
    })

    it('stop:停声道写 `stop music`(play 才需要文件)', async () => {
      await seedScene()
      await dropAudio('flow', 'audio/rain.ogg')
      const line = await insertPlayRow('flow', 'scene_one', 'audio/rain.ogg')

      const out = JSON.parse(await find('galfree_wire_audio').execute({
        project: 'flow', action: 'stop', label: 'scene_one', line, channel: 'music',
      })) as { ok: boolean }
      expect(out.ok).toBe(true)
      expect((await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content).toContain('stop music')
    })

    it('wire:play 没给文件 → 接缝拒绝,不落半行坏语法', async () => {
      await seedScene()
      const line = await insertPlayRow('flow', 'scene_one', 'audio/rain.ogg')
      const out = await find('galfree_wire_audio').execute({ project: 'flow', action: 'wire', label: 'scene_one', line, channel: 'music' })
      expect(out).toContain('invalid-audio')
    })

    it('wire:声道 / 行号给错 → 接缝当场拒,原话带回(不猜一个声道写下去)', async () => {
      await seedScene()
      await dropAudio('flow', 'audio/rain.ogg')
      // 声道是枚举:闸门在接缝上(别的适配器也吃同一套判断)。
      const badChannel = await find('galfree_wire_audio').execute({
        project: 'flow', action: 'wire', label: 'scene_one', line: 6, channel: 'bgm', file: 'audio/rain.ogg',
      })
      expect(badChannel).toContain('invalid-audio')
      expect(badChannel).toMatch(/music \/ sound \/ voice/)
      // 行号:缺了 / 不是正整数 → 不能"改了个不存在的位置还说成功"。
      const badLine = await find('galfree_wire_audio').execute({
        project: 'flow', action: 'wire', label: 'scene_one', channel: 'music', file: 'audio/rain.ogg',
      })
      expect(badLine).toMatch(/行号/)
      // 一个字节都没落盘。
      expect((await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content).not.toContain('play music')
    })
  })

  describe('快照(galfree_snapshot)', () => {
    it('history:每次写批都有记录,作者是 GALFree(与面板「历史」同一份 git)', async () => {
      await seedScene()
      const out = JSON.parse(await find('galfree_snapshot').execute({
        project: 'flow', action: 'history', path: 'game/scenes/scene_one.rpy',
      })) as { entries: Array<{ commit: string; subject: string; author: string; at: string }> }
      expect(out.entries.length).toBeGreaterThan(0)
      expect(out.entries[0]!.author).toBe('GALFree')
      expect(out.entries[0]!.subject).toContain('snapshot(galfree)')
      // 与接缝读到的是同一份(工具不另立历史)。
      expect(out.entries.map((entry) => entry.commit)).toEqual((await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy')).map((entry) => entry.commit))
    })

    it('diff:两个版本之间改了什么,原样给出', async () => {
      await seedScene()
      const dialogue = (await readScene('flow', 'scene_one')).rows.find((row) => row.kind === 'dialogue')!
      await find('galfree_edit_scene').execute({
        project: 'flow', action: 'edit', label: 'scene_one',
        edit: { kind: 'setDialogue', line: dialogue.line, speaker: '', text: '（开场）雨停了。' },
      })
      const history = await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy')
      const out = JSON.parse(await find('galfree_snapshot').execute({
        project: 'flow', action: 'diff', path: 'game/scenes/scene_one.rpy',
        from: history[0]!.commit, to: history[1]!.commit,
      })) as { diff: string }
      expect(out.diff).toContain('雨停了')
      expect(out.diff).toContain('雨声很大')
    })

    it('rollback:回滚一个文件 → 内容回到那一版,而且**回滚本身也留下快照**', async () => {
      await seedScene()
      const first = (await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy'))[0]!
      const dialogue = (await readScene('flow', 'scene_one')).rows.find((row) => row.kind === 'dialogue')!
      await find('galfree_edit_scene').execute({
        project: 'flow', action: 'edit', label: 'scene_one',
        edit: { kind: 'setDialogue', line: dialogue.line, speaker: '', text: '（开场）雨停了。' },
      })
      expect((await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content).toContain('雨停了')

      const out = JSON.parse(await find('galfree_snapshot').execute({
        project: 'flow', action: 'rollback', path: 'game/scenes/scene_one.rpy', to: first.commit,
      })) as { ok: boolean; path: string; next: string }
      expect(out.ok).toBe(true)
      expect((await service.readProjectFile('flow', 'game/scenes/scene_one.rpy')).content).toContain('雨声很大')
      // 回滚也是写:它经网关,于是也有一条新快照(可再回滚回去)。
      const history = await service.snapshotHistory('flow', 'game/scenes/scene_one.rpy')
      expect(history.length).toBeGreaterThanOrEqual(3)
      expect(history[0]!.commit).not.toBe(first.commit)
      expect(out.next).toMatch(/回滚/)
    })

    it('rollback:目标版本里没有这个文件 → 如实拒绝(不是"回滚成功但文件没了")', async () => {
      await seedScene()
      const out = await find('galfree_snapshot').execute({
        project: 'flow', action: 'rollback', path: 'game/nope.rpy', to: 'HEAD',
      })
      expect(out).toMatch(/rollback-target-missing|没有|不存在/)
    })

    it('history:没写过的路径 → 空列表 + 一句人话(不是一串报错)', async () => {
      await seedScene()
      const out = JSON.parse(await find('galfree_snapshot').execute({
        project: 'flow', action: 'history', path: 'game/never-written.rpy',
      })) as { entries: unknown[]; note: string }
      expect(out.entries).toEqual([])
      expect(out.note).toMatch(/没有快照|没写过/)
    })
  })

  // ── 切片 C:试玩 + 端到端 ────────────────────────────────────────────

  describe('试玩(galfree_playtest)', () => {
    it('跑一次:退出码 / 技术通过 / traceback 如实回传,并进板(与面板按钮同一份账本)', async () => {
      await seedScene()
      const out = JSON.parse(await find('galfree_playtest').execute({ project: 'flow' })) as {
        ok: boolean
        exitCode: number
        traceback: string | null
        board: { state: string; technicalPass: boolean }
        next: string
      }
      expect(out.ok).toBe(true)
      expect(out.exitCode).toBe(0)
      expect(out.traceback).toBeNull()
      // 与接缝同一份事实:板上的试玩格就是这一次。
      const progress = await service.progress('flow')
      expect(progress.playtest?.state).toBe('pass')
      expect(out.board.state).toBe('pass')
      // "玩过了、行"不是工具能说的。
      expect(out.next).toMatch(/人|盖场景戳/)
    })

    it('跑出 traceback → 如实报失败(不吞成"失败了",也不假装通过)', async () => {
      service = createProjectService({
        dataDir: dataDir + '-bad',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async () => ({ code: 1, log: 'Full traceback:\n  script.rpy:9 in unknown\nException: boom\n' }),
        },
      })
      tools = register()
      await seedScene()
      const out = JSON.parse(await find('galfree_playtest').execute({ project: 'flow' })) as {
        ok: boolean
        exitCode: number
        traceback: string
        board: { state: string }
        next: string
      }
      expect(out.ok).toBe(false)
      expect(out.exitCode).toBe(1)
      expect(out.traceback).toContain('Exception: boom')
      expect(out.board.state).toBe('fail')
      expect(out.next).toMatch(/traceback|修/)
    })

    it('SDK 没就绪 → 如实拒绝并说清去哪儿补(不静默当"跑过了")', async () => {
      service = createProjectService({
        dataDir: dataDir + '-nosdk',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) },
      })
      tools = register()
      await seedScene()
      const out = await find('galfree_playtest').execute({ project: 'flow' })
      expect(out).toContain('sdk-not-ready')
      expect(out).toMatch(/SDK/)
    })

    it('from:从某一场开始(副本里覆写 start,用户项目一个字节都不动)', async () => {
      await seedScene()
      const before = (await service.readProjectFile('flow', 'game/script.rpy')).version
      const out = JSON.parse(await find('galfree_playtest').execute({ project: 'flow', from: 'scene_one' })) as {
        from: string | null
        board: { from: string | null }
      }
      expect(out.from).toBe('scene_one')
      expect(out.board.from).toBe('scene_one')
      expect((await service.readProjectFile('flow', 'game/script.rpy')).version).toBe(before)
    })

    it('from 给了一个不存在的场景 → 如实拒绝', async () => {
      await seedScene()
      const out = await find('galfree_playtest').execute({ project: 'flow', from: 'nope' })
      expect(out).toContain('unknown-scene')
    })
  })

  // ── 切片 D:试玩"卡住"这件事(#32 / T24)─────────────────────────────
  //
  // 用户报的现象:点了试玩(或 agent 调了)**长时间没回音** —— 因为工具体在
  // `await playtestStart` 上**同步等游戏窗口被关掉**,而取消这一轮对话**不会**让它停
  // (工具没观察 `exec.signal`;宿主注册表只声明 `timeoutMs`、不执行期限)。
  //
  // 这里的假 spawn **永不退出**,正是那个形状:它模仿"人没关窗口"。
  // 断言的是**工具体自己**的行为 —— 它必须观察取消信号、必须有界,而不是等 15 分钟。

  describe('试玩不会把人绊住(#32 取消契约)', () => {
    /** 造一个"窗口永远开着"的服务:spawn 回来的唯一出路就是收到中止信号。 */
    const neverClosingService = (config: Parameters<typeof createProjectService>[0]): ProjectService =>
      createProjectService(config)

    it('取消已经发生 → 工具体**立刻**回来(不去起游戏、不写账本)', async () => {
      let spawned = 0
      service = neverClosingService({
        dataDir: dataDir + '-abort',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async () => {
            spawned += 1
            return { code: 0, log: '' }
          },
        },
      })
      tools = register()
      await seedScene()
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()
      const out = await find('galfree_playtest').execute({ project: 'flow' }, { signal: controller.signal })
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(2_000) // 红了就是"等到 15 分钟"
      expect(spawned).toBe(0)
      expect(out).toMatch(/取消|中止/)
      expect(out).not.toContain('technicalPass')
      expect((await service.progress('flow')).playtest).toBeNull()
    })

    it('跑到一半被取消 → 当场回来并如实说"被取消"(不假装通过、也不留一条假账本)', async () => {
      service = neverClosingService({
        dataDir: dataDir + '-during',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          // 窗口永不关闭:唯一的出路是收到**工具转发下去**的中止信号
          // (工具不转发它 → 这条测试自己超时红 —— 那正是"卡住"的形状)。
          spawn: async (_launcher, _root, options) => await new Promise<SpawnResult>((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              resolve({ code: -1, log: 'killed', aborted: true, timedOut: false, elapsedMs: 1 })
            })
          }),
        },
      })
      tools = register()
      await seedScene()
      const controller = new AbortController()
      const started = Date.now()
      const pending = find('galfree_playtest').execute({ project: 'flow' }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 60)
      const out = await pending
      expect(Date.now() - started).toBeLessThan(5_000) // 红了就是"一直等到超时上限"
      expect(out).toMatch(/取消|中止/)
      expect((await service.progress('flow')).playtest).toBeNull()
    })

    it('人没关窗口 → 有界的等待,回报里写明"等到多久、为什么停"(可断言)', async () => {
      service = neverClosingService({
        dataDir: dataDir + '-slow',
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: {
          resolveLauncher: async () => '/fake/renpy.exe',
          spawn: async (_launcher, _root, options) => {
            await new Promise((resolve) => setTimeout(resolve, options?.timeoutMs ?? 0))
            return { code: -1, log: 'timeout', timedOut: true, aborted: false, elapsedMs: options?.timeoutMs ?? 0 }
          },
        },
      })
      tools = register()
      await seedScene()
      const out = JSON.parse(await find('galfree_playtest').execute({ project: 'flow', timeout_seconds: 1 })) as {
        ok: boolean
        exitCode: number
        timedOut: boolean
        waitedSeconds: number
        processStopped: boolean
        next: string
      }
      expect(out.timedOut).toBe(true)
      expect(out.ok).toBe(false)
      expect(out.exitCode).toBe(-1)
      // "等到多久、为什么停"是可断言的字段,不是一句没法核的话。
      expect(out.waitedSeconds).toBeGreaterThanOrEqual(1)
      expect(out.next).toMatch(/窗口|关/)
      // "进程真停了没有"也照实给(端口说 true,工具不该自己改口)。
      expect(out.processStopped).toBe(true)
      // 板那一侧也不许把它说成"有报错"(T24:等满上限 ≠ 剧本有 traceback)。
      const board = await service.progress('flow')
      expect(board.playtest?.timedOut).toBe(true)
      expect(board.nextActions.find((action) => action.code.startsWith('playtest'))?.code).toBe('playtest-timed-out')
    })

    it('默认等待是**有界的**(不是 15 分钟),而且工具描述如实写明"要人关窗口"', async () => {
      const tool = find('galfree_playtest')
      // 描述里那两句话是**契约**(用户报的"卡住"就出在没人知道它会等):一条说"它在等谁",
      // 一条说"等多久算久"。措辞不锁死,锁的是"这两件事写没写"。同一个信号:人话里的
      // 分钟数与常量同源(`PLAYTEST_DEFAULT_WAIT_MINUTES`),所以这里断言的是它真的写了。
      expect(tool.description).toMatch(/等/)
      expect(tool.description).toMatch(/关/)
      expect(tool.description).toMatch(/窗口/)
      expect(tool.description).toContain(`${PLAYTEST_DEFAULT_WAIT_MINUTES} 分钟`)
      expect(tool.parameters.properties.timeout_seconds).toBeDefined()
    })
  })

  // ── AC1:只凭工具面走完全流程(脚本化会话回放)───────────────────────

  describe('AC1 端到端:只凭工具面走完全流程', () => {
    it('建项目 → 写设定集 →(人盖定稿戳)→ 逐场生成 → 补素材 → 接线音频 → 试玩 → 发布', async () => {
      // 全程只经**工具调用**收场;不经工具的东西只有三类,每一类都在下面显式标出来:
      //  ① **人的两步**(盖定稿戳、把音频文件丢进 game/)—— 它们本来就不该有 agent 入口(ADR-0008);
      //  ② 测试自己的**读盘核对**(fs 直接看磁盘终态)—— 那是断言,不是干活;
      //  ③ 断言用的 `service.*` 读方法(板 / 列表)—— 与工具读的是同一份推导。
      const out = {} as Record<string, unknown>

      // ① 建项目
      out.create = JSON.parse(await find('galfree_create_project').execute({ action: 'create', name: 'e2e', title: '雨天天台' })) as never
      // ② 写设定集(世界观 + 章节 + 角色卡)
      out.bible = JSON.parse(await find('galfree_story_bible').execute({
        action: 'write',
        theme: '雨天的天台',
        world: '只有两个人的放学后,雨一直没停。',
        chapters: [{ id: 'ch1', title: '第一场雨', outline: '小棠在天台遇到转学生。', scenes: ['scene_one'] }],
        characters: [{ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: { hair: '黑色短发', outfit: '夏季校服' }, style_anchor: '日系赛璐璐' }],
      })) as never
      // ③ 生成先要定稿戳 —— **人**盖(这里就是人那一步)。
      await service.stampBible('e2e', { via: 'human' })
      // ④ 让这一场可达:把模板的 start 接到它(源文本模式,手写文件也开放)。
      //    源文本本身也是经**工具**读的(edit_scene 的 read 给的就是那一份)。
      const startSource = (await readScene('e2e', 'start')).source
      out.wireStart = JSON.parse(await find('galfree_edit_scene').execute({
        project: 'e2e', action: 'edit', label: 'start',
        edit: { kind: 'replaceSource', source: `label start:\n    jump scene_one\n\n${startSource.slice(startSource.indexOf('label prologue:'))}` },
      })) as never
      // ⑤ 逐场生成(这一场引用了一个立绘槽 → 板上会出现待填槽)
      out.scene = JSON.parse(await find('galfree_generate_scene').execute({
        project: 'e2e',
        label: 'scene_one',
        source: 'label scene_one:\n    show xiao_tang smile\n    xiao_tang "雨还没停。"\n    jump prologue\n',
      })) as never
      // ⑥ 补素材(渠道是注入的假上游)
      out.channel = JSON.parse(await find('galfree_image_channel').execute({})) as never
      out.art = JSON.parse(await find('galfree_fill_missing_art').execute({ project: 'e2e', model: 'fake-image' })) as never
      // ⑦ 音频:**人**把文件丢进 game/(池是派生的 —— 这一步没有、也不该有工具)
      await service.writeProjectFiles('e2e', [{ path: 'game/audio/rain.ogg', content: Buffer.from('OggS-fake'), expectVersion: 'absent' }], { origin: 'workbench', reason: 'asset' })
      const dialogueRow = (await readScene('e2e', 'scene_one')).rows.find((row) => row.kind === 'dialogue')!
      await find('galfree_edit_scene').execute({
        project: 'e2e', action: 'edit', label: 'scene_one',
        edit: { kind: 'insertStatement', anchor: dialogueRow.raw, source: 'play music "audio/rain.ogg" loop' },
      })
      const audioLine = (await readScene('e2e', 'scene_one')).rows.find((row) => row.kind === 'audio')!.line
      out.audio = JSON.parse(await find('galfree_wire_audio').execute({
        project: 'e2e', action: 'wire', label: 'scene_one', line: audioLine, channel: 'music', file: 'audio/rain.ogg', loop: true,
      })) as never
      // ⑧ 试玩(假 spawn:真实现会开窗口、退出回传)
      out.playtest = JSON.parse(await find('galfree_playtest').execute({ project: 'e2e' })) as never
      // ⑨ 发布
      const published = JSON.parse(await find('galfree_publish').execute({ project: 'e2e' })) as {
        ok: boolean
        run: { artifacts: Array<{ name: string; path: string }> } | null
      }
      out.publish = published

      // ── 终态:板上全绿(每一步的判据就是板上那些字段,与指引同源)──
      const progress = await service.progress('e2e')
      expect(progress.lint.ok, JSON.stringify(progress.problems)).toBe(true)
      expect(progress.completeness.orphans).toEqual([])
      expect(progress.summary.missingSlots).toBe(0)
      expect(progress.audio.missing).toEqual([])
      expect(progress.playtest?.state).toBe('pass')
      expect(progress.bible.stamp).toBe('approved')
      expect(published.ok).toBe(true)
      expect(progress.publish?.ok).toBe(true)
      expect(progress.publish?.stale).toBe(false)

      // 产物在项目源树之外,而且真的打出来了。
      expect(published.run?.artifacts.length).toBeGreaterThan(0)
      const artifact = published.run!.artifacts[0]!
      expect(artifact.path.startsWith(outDir)).toBe(true)

      // 素材真的落在槽位的约定路径上(不是"任务建了就算完")。
      const slot = progress.slots.find((candidate) => candidate.slot === 'xiao_tang smile')!
      expect(slot.filled).toBe(true)
      const root = (await service.listProjects()).find((project) => project.name === 'e2e')!.root
      await expect(readFile(join(root, ...slot.assetPath.split('/')))).resolves.toBeTruthy()

      // 该请人的地方仍然等着人:素材槽与场景都还没盖戳(agent 盖不了)。
      // 注意 `summary.awaitingReview` 数的是**盖过又被改**的(stale),不是"还没盖" ——
      // 这里要的是槽上那个 `awaitingReview` 布尔(有图、但没人认可)。
      expect(slot.stamp).toBe('pending')
      expect(slot.awaitingReview).toBe(true)
      expect(progress.scenes.find((scene) => scene.label === 'scene_one')!.stamp).toBe('none')
    })
  })
})
