/**
 * T10 工具适配层测试:agent 实际看到的接口。
 *
 * 为什么值得测:工具名与参数名是**模型看到的契约**,打错一个字不会报错,只会在真实
 * 对话里静默失效("写第 1 幕"没反应,却看不出为什么)。工具体本身很薄,判断都在接缝里
 * (见 generate.test.ts),所以这里只钉两件事:
 *  1. 注册出来的定义形状正确(名字、必填参数、输出声明);
 *  2. 执行时把接缝的事实**如实**带回去(成功带 lint 与板;接缝拒绝带可执行的指令)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { registerGalfreeTools } from './tools.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import type { Context } from '@deepseek-ai/cordis'

interface FakeTool {
  name: string
  description: string
  /** defineTool 把它编译成 JSON Schema(模型看到的就是这份)。 */
  parameters: { type: string; properties: Record<string, { type: string }>; required?: string[] }
  output: { schema: unknown }
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 假工具注册表:把 defineTool 的产物收下来(工具体是纯函数,不需要真 Context)。 */
function fakeTools(): { tools: FakeTool[]; register: (tool: unknown) => () => void } {
  const tools: FakeTool[] = []
  return {
    tools,
    register(tool: unknown) {
      tools.push(tool as FakeTool)
      return () => { /* disposer */ }
    },
  }
}

// 这一场要**可达**(跳进模板的 prologue),否则完整性推导会如实报孤立场景 —— 那是 T13 的
// 正确行为,但会让这条"生成机制"的断言被别的问题干扰。
const SCENE = 'label scene_one:\n    "开场。"\n    jump prologue\n'

describe('agent 工具(T10)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t10tools-data-')
    projectsRoot = await makeTempDir('galfree-t10tools-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'tools', title: '工具' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  function register(): FakeTool[] {
    const registry = fakeTools()
    registerGalfreeTools(
      { tools: registry } as unknown as Context & { tools: { register: (tool: unknown) => () => void } },
      service,
    )
    return registry.tools
  }

  it('注册出模型看到的契约:十四个工具,参数与输出声明齐备', () => {
    const tools = register()
    // 剧本环节两个 + 美术环节(T15)五个 + 参考链回路(T16)两个 + 发布(T18)一个
    // + 项目工作周期 / 设定集 / 场景编辑 / 音频接线 / 试玩 / 快照(T20)六个。
    // **这份清单是显式的**:新增一个工具必须在这里露面,漏一个就红 ——
    // 于是"某个动作悄悄多了个 agent 入口"不可能没人看见(审读戳那条红线靠的就是它)。
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'galfree_art_queue',
      'galfree_character_art',
      'galfree_create_project',
      'galfree_edit_scene',
      'galfree_fill_missing_art',
      'galfree_generate_image',
      'galfree_generate_scene',
      'galfree_image_channel',
      'galfree_playtest',
      'galfree_project_status',
      'galfree_publish',
      'galfree_reference_chain',
      'galfree_reroll_image',
      'galfree_snapshot',
      'galfree_story_bible',
      'galfree_wire_audio',
    ])

    // T18:发布可以先只看前置检查(readiness_only),构建是可选的动作。
    const publish = tools.find((tool) => tool.name === 'galfree_publish')!
    expect(publish.parameters.properties.readiness_only?.type).toBe('boolean')
    expect(publish.parameters.properties.packages?.type).toBe('array')
    expect(publish.parameters.required).toBeUndefined()
    expect(publish.description).toContain('源树之外')

    // T16:拒收注记是**可选**参数(人没给理由就不记),差分批量必须给角色与模型。
    const reroll = tools.find((tool) => tool.name === 'galfree_reroll_image')!
    expect(reroll.parameters.properties.note?.type).toBe('string')
    expect(reroll.parameters.required).toBeUndefined()
    const batch = tools.find((tool) => tool.name === 'galfree_character_art')!
    expect(batch.parameters.required?.sort()).toEqual(['character', 'model'])
    expect(batch.description).toContain('参考链')
    const chain = tools.find((tool) => tool.name === 'galfree_reference_chain')!
    expect(chain.parameters.properties.character?.type).toBe('string')
    // 链写入口(T16):`references` 是可选的数组参数 —— 不给就只读。
    expect(chain.parameters.properties.references?.type).toBe('array')
    expect(chain.description).toContain('设定改动')

    const generate = tools.find((tool) => tool.name === 'galfree_generate_scene')!
    // 模型看到的参数契约:两个必填,其余可选。
    expect(generate.parameters.type).toBe('object')
    expect(generate.parameters.required?.sort()).toEqual(['label', 'source'])
    expect(generate.parameters.properties.label?.type).toBe('string')
    expect(generate.parameters.properties.source?.type).toBe('string')
    expect(generate.parameters.properties.project?.type).toBe('string')
    expect(generate.parameters.properties.require_final_bible?.type).toBe('boolean')
    expect(generate.output.schema).toEqual({ type: 'string' })
    // 描述要说清"校验不过会如实返回、请据此重生成",否则模型会以为一步就能成。
    expect(generate.description).toContain('重生成')
    expect(generate.description).toContain('方言子集')

    // 注册返回 disposer(插件卸载要能摘掉席位)。
    const registry = fakeTools()
    const dispose = registerGalfreeTools(
      { tools: registry } as unknown as Context & { tools: { register: (tool: unknown) => () => void } },
      service,
    )
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })

  it('生成工具:把落盘路径、校验结果、问题与板快照如实带回', async () => {
    // 先备好定稿设定集(工具默认要求它)。
    await service.writeBible('tools', { theme: '雨天的重逢', chapters: [], characters: [] }, { via: 'agent' })
    await service.stampBible('tools', { via: 'human' })
    // 让生成的这一场**可达**:在模板 start 的块体最前面插一句 `jump scene_one`。
    // 不这么做,完整性推导会如实报孤立场景 —— 那是 T13 的正确行为,但会盖住这条测试要验的东西。
    // 注意锚点:必须匹配行首的 `label start:`,否则会命中别的 label 名里的子串。
    const snap = await service.readProjectFile('tools', 'game/script.rpy')
    expect(snap.content).toContain('label start:')
    await service.writeProjectFiles('tools', [{
      path: 'game/script.rpy',
      content: snap.content.replace(/^label start:\n/m, 'label start:\n    jump scene_one\n'),
      expectVersion: snap.version,
    }], { origin: 'agent', reason: 'scenario' })

    const generate = register().find((tool) => tool.name === 'galfree_generate_scene')!
    const report = JSON.parse(await generate.execute({ label: 'scene_one', source: SCENE })) as {
      ok: boolean
      path: string
      action: string
      parseOk: boolean
      issues: unknown[]
      lint: { ok: boolean }
      scene: { stamp: string } | null
      bibleTheme: string | null
    }
    expect(report.ok).toBe(true)
    expect(report.path).toBe('game/scenes/scene_one.rpy')
    expect(report.action).toBe('created')
    expect(report.parseOk).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.lint.ok).toBe(true)
    expect(report.scene?.stamp).toBe('none') // 待审读:戳只能由人盖
    expect(report.bibleTheme).toBe('雨天的重逢')
  })

  it('生成工具:lint 不过不抛错,而是把问题交回来让模型当场修', async () => {
    await service.writeBible('tools', { theme: 'x', chapters: [], characters: [] }, { via: 'agent' })
    await service.stampBible('tools', { via: 'human' })
    const generate = register().find((tool) => tool.name === 'galfree_generate_scene')!

    const report = JSON.parse(await generate.execute({
      label: 'scene_bad',
      source: 'label scene_bad:\n    "开场。"\n    jump nowhere\n',
    })) as { ok: boolean; issues: Array<{ code: string; severity: string }>; lint: { ok: boolean } }
    expect(report.ok).toBe(false)
    expect(report.lint.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'dangling-jump')).toBe(true)
  })

  it('生成工具:接缝的拒绝原样交回(可执行的指令,不是"失败了")', async () => {
    const generate = register().find((tool) => tool.name === 'galfree_generate_scene')!

    // 1) 默认要求定稿设定集 → 没定稿时拒绝理由要能照着做。
    const noBible = await generate.execute({ label: 'scene_one', source: SCENE })
    expect(noBible).toContain('定稿')

    // 2) 抢手写文件的 label → 指出它在哪、要先搬走。
    await service.writeBible('tools', { theme: 'x', chapters: [], characters: [] }, { via: 'agent' })
    await service.stampBible('tools', { via: 'human' })
    const stolen = await generate.execute({ label: 'start', source: 'label start:\n    "另一版。"\n' })
    expect(stolen).toContain('script.rpy')
  })

  it('状态工具:与工作台阶段板同源(场景/槽/角色/设定集/lint)', async () => {
    // 这一场是孤立的(没人跳进去)—— T13 的完整性推导会如实报 orphan-scene,所以这里
    // 不假设 lint 通过,只断言**工具与接缝读的是同一份判断**(那才是这条测试要验的东西)。
    await service.generateScene('tools', { label: 'scene_one', source: SCENE, outline: undefined })
    const status = JSON.parse(await register().find((tool) => tool.name === 'galfree_project_status')!.execute({})) as {
      scenes: Array<{ label: string; stamp: string }>
      slots: Array<{ slot: string; scenes: string[] }>
      bible: { stamp: string }
      lint: { ok: boolean; errors: number }
      summary: { scenes: number }
    }
    expect(status.scenes.map((scene) => scene.label)).toContain('scene_one')
    expect(status.summary.scenes).toBeGreaterThanOrEqual(1)
    expect(status.bible.stamp).toBe('none')
    // 与接缝读出来的同一份判断(不是工具自己算的)。
    const progress = await service.progress('tools')
    expect(status.summary.scenes).toBe(progress.summary.scenes)
    expect(status.lint.ok).toBe(progress.lint.ok)
    expect(status.lint.errors).toBe(progress.lint.errors)
    // 孤立场景照旧被如实带出来(工具不美化)。
    expect(progress.completeness.orphans).toContain('scene_one')
  })

  // ─── T15:美术指导工具面 ─────────────────────────────────────────────

  it('T15 美术工具的参数契约:出图工具必填 slot/model/prompt;重 roll 只要 id 或槽', () => {
    const tools = register()
    const generate = tools.find((tool) => tool.name === 'galfree_generate_image')!
    expect(generate.parameters.required?.sort()).toEqual(['model', 'prompt', 'slot'])
    expect(generate.description).toContain('降级')

    const reroll = tools.find((tool) => tool.name === 'galfree_reroll_image')!
    // 重 roll 的两个入口二选一,所以都**不是**必填 —— 由执行期给出可执行的拒绝。
    expect(reroll.parameters.required ?? []).toEqual([])
    expect(reroll.description).toContain('重试历史')
  })

  it('T15 没配渠道:出图工具如实拒绝,并把"去哪配"说清楚(不吞成"失败了")', async () => {
    const tools = register()
    const out = await tools.find((tool) => tool.name === 'galfree_generate_image')!.execute({
      slot: 'bg school', model: 'whatever', prompt: '教室',
    })
    expect(out).toContain('no-image-channel')
    // 渠道工具也会告诉人先配。
    const channel = await tools.find((tool) => tool.name === 'galfree_image_channel')!.execute({})
    expect(channel).toContain('还没有配置图像渠道')
  })

  it('T15 队列工具与接缝同源:读队列读的是同一份账本(没有工具专用的状态)', async () => {
    const tools = register()
    const out = JSON.parse(await tools.find((tool) => tool.name === 'galfree_art_queue')!.execute({})) as {
      pendingSlots: string[]
      tasks: Array<{ id: string }>
    }
    const progress = await service.progress('tools')
    expect(out.pendingSlots).toEqual(progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot))
    expect(out.tasks).toEqual(await service.generationTasks('tools'))
  })

  it('T15 重 roll 找不到任务时给可执行的话(而不是抛异常)', async () => {
    const tools = register()
    const out = await tools.find((tool) => tool.name === 'galfree_reroll_image')!.execute({ slot: '不存在的槽' })
    expect(out).toContain('还没有出图任务')
    const noArgs = await tools.find((tool) => tool.name === 'galfree_reroll_image')!.execute({})
    expect(noArgs).toContain('task_id 或 slot')
  })

  // ─── AC3:审读戳的 agent 入口**不存在**(ADR-0008 的红线)───────────────

  it('AC3 工具面里没有审读戳入口,而且接缝上 agent 也盖不了(两道都要有)', async () => {
    const names = register().map((tool) => tool.name)
    // ① **存在性**:名字里不许有"盖章/认可"这一类动作。
    //    这一条之所以有力,是因为上面那份工具名清单是**显式**的 —— 新增一个工具
    //    不可能不被看见,漏加也红。
    expect(names.filter((name) => /stamp|approve|review|定稿|审读/.test(name))).toEqual([])
    // 也没有把盖戳藏进别的工具的参数里(例如 `galfree_edit_scene` 的 edit 里)。
    const editScene = register().find((tool) => tool.name === 'galfree_edit_scene')!
    expect(JSON.stringify(editScene.parameters)).not.toMatch(/stamp|approve/i)

    // ② **行为**:就算有人接错线,接缝也会拒 —— 三个戳动作对 agent 一律 stamp-forbidden。
    //    这一半才是真的保证:名字清单只能防"看不见的入口",接缝才能防"真的盖上"。
    await expect(service.stampScene('tools', 'start', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })
    await expect(service.stampSlot('tools', 'xiao_tang smile', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })
    await expect(service.stampBible('tools', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })

    // ③ 人盖是通的(不是"谁都盖不了"—— 那只是把功能关了)。
    await service.stampScene('tools', 'start', { via: 'human' })
    expect((await service.progress('tools')).scenes.find((scene) => scene.label === 'start')?.stamp).toBe('approved')
  })

  it('T20 六个新工具的参数契约:必填项与"可选但要解释"的地方都对', () => {
    const tools = register()
    const required = (name: string): string[] | undefined => tools.find((tool) => tool.name === name)!.parameters.required
    // 项目操作:action 必填;名字之类按 action 分,所以不设必填(执行期给可执行的拒绝)。
    expect(required('galfree_create_project')).toEqual(['action'])
    expect(required('galfree_story_bible')).toEqual(['action'])
    expect(required('galfree_edit_scene')).toEqual(['action', 'label'])
    expect(required('galfree_wire_audio')).toEqual(['action'])
    expect(required('galfree_playtest')).toBeUndefined()
    expect(required('galfree_snapshot')).toEqual(['action', 'path'])
    // 编辑指令是结构化对象(不是自由文本),外观卡也是。
    expect(tools.find((tool) => tool.name === 'galfree_edit_scene')!.parameters.properties.edit?.type).toBe('object')
    expect(tools.find((tool) => tool.name === 'galfree_story_bible')!.parameters.properties.characters?.type).toBe('array')
  })
})
