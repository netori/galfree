/**
 * T19(agent 流程指引)守卫 —— 三个接缝上断言:
 *
 *  1. **注册这一段的公共面**(`registerGalfreePlaybook`):模型真的会看到顺序 / 闸门 /
 *     判据 / 谁来做 / 怎么问现状。
 *     **可红的两个锚点**(各验过一次):把 `registerGalfreePlaybook` 里的 `seat.section(...)`
 *     摘掉 → "注册这一段"整组红;把入口(`src/index.ts`)的 `ctx.inject(['systemPrompt'])`
 *     摘掉 → `src/index.test.ts` 的装配用例红。两层缺一不可:注册函数对、没接上电源,
 *     模型依然什么都看不见。
 *  2. **判据与接缝同源**(真 `ProjectService`):指引里每一条判据都写成**板上的字段路径**,
 *     这里拿一个真项目推导出来的快照逐条解析(字段没了 / 类型不对就红);
 *     指引点名的闸门码,这里**真去撞那道闸门**,拿接缝实际抛出来的码比对;
 *     没有码的那道闸门(发布)则验接缝**真的会拦**(`readiness.ready === false`)。
 *  3. **工具面与注册表同源**:注册出来的工具名要么被某一环认领、要么在查询工具白名单里 ——
 *     指引里写错一个工具名会红,而不是静默变成"没有 agent 入口"。
 *
 * 为什么值得测:这段文本是模型眼里的"流程说明书"。它要是写错一个字段名,新会话就会
 * 拿着一份**看着很像真的**的判据去干活 —— 不会报错,只会安静地走错。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createProjectService, type ProjectService } from './project-service.ts'
import {
  GALFREE_WORKFLOW, WORKFLOW_SECTION, WORKFLOW_SECTION_ORDER, registerGalfreePlaybook,
  toolPresenceProbe, workflowPlaybook, type BoardCriterion,
} from './playbook.ts'
import { GATE } from './gates.ts'
import { registerGalfreeTools } from './tools.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { collectPromptSections, type SectionCollector } from '../testing/prompt-seat.ts'
import type { ProgressSnapshot } from './progress.ts'
import type { PublishPorts } from './publish.ts'

/** 注册一次并把文本取出来 —— 守卫统一走这条路(而不是直接调 `workflowPlaybook`)。 */
function registeredText(options: { hasTool: (name: string) => boolean }): string {
  const registry = collectPromptSections()
  registerGalfreePlaybook(registry.seat, options)
  expect(registry.sections).toHaveLength(1)
  return registry.render()
}

/** 板上字段路径 → 值(`summary.missingSlots` 这种点路径;真快照上解析)。 */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

describe('agent 流程指引(T19)', () => {
  // ── 1. 注册出来的那段文本 ────────────────────────────────────────────

  describe('注册这一段(可红的守卫)', () => {
    it('section 名字与位置:注册在 galfree 名下、有明确排序', () => {
      const registry = collectPromptSections()
      const dispose = registerGalfreePlaybook(registry.seat, { hasTool: () => true })
      expect(registry.sections.map((section) => section.name)).toEqual([WORKFLOW_SECTION])
      expect(registry.sections[0]!.order).toBe(WORKFLOW_SECTION_ORDER)
      // 返回的是接缝给的 disposer(插件卸载要能摘掉这段)。
      expect(typeof dispose).toBe('function')
    })

    it('顺序:环节名按流程出现,且先教会模型"先问现状"', () => {
      const text = registeredText({ hasTool: () => true })
      expect(text).toContain('galfree_project_status')
      // 环节名**在列表里按流程顺序**出现(不是一堆散装工具说明)。
      // 注意:前言里也会提到"试玩与发布"这些词,所以顺序只在"顺序"那一节之后判。
      const listStart = text.indexOf('**顺序**')
      expect(listStart).toBeGreaterThanOrEqual(0)
      let cursor = listStart
      for (const stage of GALFREE_WORKFLOW) {
        const at = text.indexOf(`**${stage.name}**`, cursor)
        expect(at, `「${stage.name}」不在列表里,或顺序不对`).toBeGreaterThan(cursor)
        cursor = at
      }
      // 顺序这件事本身要说出来(否则模型会把"生成场景"当成第一步)。
      expect(text).toMatch(/顺序/)
    })

    it('闸门:**每一环**都写明了挡在前面的是什么,撞上了要做什么', () => {
      const text = registeredText({ hasTool: () => true })
      for (const stage of GALFREE_WORKFLOW) {
        // 每一环都有闸门 —— 包括"建项目"(一部都还没有的时候,工具只会让你先去建一个)。
        expect(stage.gate.what.trim(), `${stage.name} 没有闸门`).not.toBe('')
        expect(text).toContain(stage.gate.what)
        // 有码的那几道:码也要点名(只写码,模型不知道下一步;只写话,模型不知道撞的是哪个)。
        if (stage.gate.code !== undefined) expect(text).toContain(stage.gate.code)
      }
    })

    it('判据:每一条都指到板上的字段,而不是另立一套规则', () => {
      const text = registeredText({ hasTool: () => true })
      for (const stage of GALFREE_WORKFLOW) {
        expect(stage.done.length).toBeGreaterThan(0)
        for (const criterion of stage.done) {
          // **判据写在文本里的是字段路径本身** —— 这是"不复制规则"的形态:
          // 规则住在接缝里,指引只指路。
          expect(text).toContain(criterion.path)
        }
      }
    })

    it('谁来做:审读戳只有人能盖这条红线在文本里', () => {
      const text = registeredText({ hasTool: () => true })
      expect(text).toContain(GATE.stampForbidden)
      expect(text).toMatch(/只有人能盖|只有人/)
      // 每一环里"只有人能做的事"都要说出来(试玩那句、发布那句、设定集那句…)。
      for (const stage of GALFREE_WORKFLOW.filter((candidate) => candidate.human !== undefined)) {
        expect(text).toContain(stage.human!)
      }
      // 至少:定稿戳 / 试玩的"行不行" / 发布取舍 三处必须请人。
      expect(GALFREE_WORKFLOW.filter((stage) => stage.human !== undefined).length).toBeGreaterThanOrEqual(5)
    })

    it('如实呈现的纪律:校验不过要当场改再重生成、ok:false 不能说成完成', () => {
      const text = registeredText({ hasTool: () => true })
      expect(text).toMatch(/重生成|重试/)
      expect(text).toContain('ok: false')
    })

    it('工具面:有的工具就点名,没有的**如实说没有 agent 入口**(不假装有)', () => {
      const withTools = registeredText({ hasTool: () => true })
      const withoutTools = registeredText({ hasTool: () => false })
      // 发布这一步现在就有工具:有席位时必须点名。
      expect(withTools).toContain('galfree_publish')
      // 一个工具席位都没有时,不能凭空报一个不存在的入口,而要如实说"请人来做"。
      expect(withoutTools).not.toContain('galfree_publish')
      expect(withoutTools).toMatch(/没有 agent 入口/)
      // 两边都必须仍然把顺序讲完(工具缺失不改变流程本身)。
      for (const stage of GALFREE_WORKFLOW) expect(withoutTools).toContain(stage.name)
    })

    it('没有 systemPrompt 席位 → 不注册也不崩(懒注入的兜底契约)', () => {
      expect(() => registerGalfreePlaybook(undefined, { hasTool: () => true })).not.toThrow()
      const dispose = registerGalfreePlaybook(undefined, { hasTool: () => true })
      expect(typeof dispose).toBe('function')
      expect(() => dispose()).not.toThrow()
    })
  })

  // ── 2. 判据与闸门码跟接缝同源(真项目 + 真拒绝)─────────────────────

  describe('与接缝同源(真项目 / 真拒绝)', () => {
    let sdkDir: string
    let dataDir: string
    let projectsRoot: string
    let outDir: string
    let service: ProjectService
    let progress: ProgressSnapshot

    beforeEach(async () => {
      sdkDir = await makeFakeSdk()
      dataDir = await makeTempDir('galfree-t19-data-')
      projectsRoot = await makeTempDir('galfree-t19-projects-')
      outDir = await makeTempDir('galfree-t19-out-')
      const publishPorts: PublishPorts = {
        resolveLauncher: async () => join(sdkDir, 'renpy.exe'),
        run: async (input) => {
          await mkdir(input.destination, { recursive: true })
          await writeFile(join(input.destination, 'flow-0.1.0-pc.zip'), Buffer.from('fake'))
          return { code: 0, log: 'ok\n' }
        },
      }
      service = createProjectService({
        dataDir,
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: { resolveLauncher: async () => '/fake/renpy.exe', spawn: async () => ({ code: 0, log: "Ren'Py 8.5.3 starting\n" }) },
        publish: { ports: publishPorts, destination: () => join(outDir, 'dist') },
      })
      await service.createProject({ projectsRoot, name: 'flow', title: '指引' })
      // 跑到"试玩 + 发布都发生过"的状态:板上 `playtest` / `publish` 这两格才有值,
      // 指到它们的判据才**真的**能被解析(空快照上它们本来就是 null)。
      await service.playtestStart('flow')
      await service.publish('flow')
      progress = await service.progress('flow')
    })

    afterEach(async () => {
      await service.dispose()
      await cleanupTempDirs()
    })

    it('每一条判据都能在真快照上解析,且类型与写法对得上', () => {
      const text = registeredText({ hasTool: () => true })
      const checked: string[] = []
      for (const stage of GALFREE_WORKFLOW) {
        for (const criterion of stage.done) {
          const value = resolvePath(progress, criterion.path)
          const at = `${stage.name} → ${criterion.path}`
          expect(value, `${at} 在推导板上不存在`).toBeDefined()
          switch (criterion.op) {
            case 'zero':
              expect(typeof value, `${at} 不是数字,不能拿"为 0"当判据`).toBe('number')
              break
            case 'true':
            case 'false':
              expect(typeof value, `${at} 不是布尔`).toBe('boolean')
              break
            case 'empty':
            case 'nonEmpty':
              expect(Array.isArray(value) || typeof value === 'string', `${at} 不是可判空的东西`).toBe(true)
              break
            case 'equals':
              expect(criterion.value, `${at} 缺 value`).toBeDefined()
              expect(typeof value, `${at} 不是字符串,不能拿字面量比`).toBe('string')
              break
          }
          // 指引里的写法也要能在文本里找到(判据不是说给自己听的)。
          expect(text).toContain(criterion.path)
          checked.push(at)
        }
      }
      expect(checked.length).toBeGreaterThanOrEqual(GALFREE_WORKFLOW.length)
    })

    it('指引点名的闸门码 = 接缝真的会抛的码(真去撞一遍)', async () => {
      const text = registeredText({ hasTool: () => true })
      /** 撞一次,把接缝实际抛出来的码拿回来。 */
      const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          await run()
        } catch (error) {
          return (error as { code?: string }).code ?? '(没有 code)'
        }
        throw new Error('这道闸门没拦住:守卫本身失效了,不能算通过')
      }

      // ① 设定集没定稿 → 下游生成被拒。
      const bible = await codeOf(() => service.generationContext('flow'))
      expect(text).toContain(bible)
      // ② 审读戳只有人能盖。
      const stamp = await codeOf(() => service.stampScene('flow', 'start', { via: 'agent' }))
      expect(text).toContain(stamp)
      // ③ 没配图像渠道 → 出图被拒(这个 service 就没配渠道)。
      const channel = await codeOf(() => service.createGenerationTask('flow', { slot: 'bg roof', model: 'm', prompt: 'p' }))
      expect(text).toContain(channel)
      // ④ SDK 未就绪 → 试玩被拒(换一个"启动器解析不到"的服务,项目注册表共用)。
      const noSdk = createProjectService({
        dataDir,
        uiTemplate: fakeUiTemplate(sdkDir),
        playtest: { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) },
      })
      let sdk = '(没跑到)'
      try {
        sdk = await codeOf(() => noSdk.playtestStart('flow'))
        expect(text).toContain(sdk)
      } finally {
        await noSdk.dispose()
      }

      // 四条都得是接缝自己那套词汇(不是文本里编的码)。
      expect([bible, stamp, channel, sdk]).toEqual([GATE.bibleNotFinal, GATE.stampForbidden, GATE.noImageChannel, GATE.sdkNotReady])
    })

    it('没有码的那道闸门(发布)也是**真的**:接缝真的会拦下来,文本讲的是它给的形状', async () => {
      const text = registeredText({ hasTool: () => true })
      // 造一个"发不了"的局面,而且**只要这一处坏**:把一个不存在的音频接进 prologue 的正文里
      // (池是派生的,文件不在 = 悬空)。小心别顺手制造 lint 错 —— 那样守卫就变成
      // "反正有东西拦住了"的同义反复,验不出这道闸门本身。
      const current = await service.readProjectFile('flow', 'game/script.rpy')
      const patched = current.content.replace(
        'label prologue:\n',
        'label prologue:\n    play music "audio/not-there.ogg"\n',
      )
      expect(patched, '没打到模板的 prologue 上:夹具过期了').not.toBe(current.content)
      await service.writeProjectFiles('flow', [{
        path: 'game/script.rpy',
        content: patched,
        expectVersion: current.version,
      }], { origin: 'agent', reason: 'scenario' })

      const progress = await service.progress('flow')
      // 先把"只坏了这一处"钉死:板上只有这一条 error,而且它就是悬空音频。
      expect(progress.lint.errors, '夹具顺带弄出了别的 lint 错,守卫会变成同义反复').toBe(1)
      expect(progress.problems.map((problem) => problem.code)).toEqual(['missing-audio'])
      expect(progress.audio.missing.map((reference) => reference.ref)).toEqual(['audio/not-there.ogg'])

      const readiness = await service.publishReadiness('flow')
      expect(readiness.ready, '这道闸门没拦住:守卫本身失效了').toBe(false)
      // 拦住它的**必须**包含音频那一条(否则"ready=false"可能来自任何别的原因)。
      // 悬空引用同时也是板上的 error,所以会连带出现 `lint-errors` —— 两条都在是对的。
      expect(readiness.blockers.map((blocker) => blocker.code)).toContain('missing-audio')
      // 指引必须讲到这道闸门的**形状**(逐项列出、照着实修),而不是编一个码。
      const publish = GALFREE_WORKFLOW.find((stage) => stage.name === '发布')!
      expect(publish.gate.code).toBeUndefined()
      expect(text).toContain(publish.gate.what)
      expect(text).toContain('blockers[]')
      // 接缝真给的每一项都带这三样(指引让模型照着修的东西确实在)。
      for (const blocker of readiness.blockers) {
        expect(typeof blocker.code).toBe('string')
        expect(typeof blocker.label).toBe('string')
      }
    })

    it('工具面与注册表同源:注册出来的工具要么是某环的入口,要么是横跨环节的工具', () => {
      // 真注册一次拿**真名**(模型看到的工具面):名字写错一个字母会在这里红,
      // 而不是静默渲染成"目前没有 agent 入口"(那是反方向的谎)。
      const registry = { tools: [] as Array<{ name: string }>, register(tool: unknown) { registry.tools.push(tool as { name: string }); return () => {} } }
      registerGalfreeTools({ tools: registry } as unknown as Parameters<typeof registerGalfreeTools>[0], service)
      const registered = registry.tools.map((tool) => tool.name)
      expect(registered.length).toBeGreaterThan(0)

      const claimed = new Set(GALFREE_WORKFLOW.flatMap((stage) => stage.tools))
      // **横跨所有环节**的工具(读现状 / 查队列 / 查历史、以及回滚这种随时可用的动作):
      // 它们不属于任何一环,所以在这里**显式**列出来 —— 新工具要么被某一环认领,要么进这张表,
      // 两条都不占就红(提醒作者:要不要在指引里给它一个位置?)。
      const crossCutting = new Set([
        'galfree_project_status',
        'galfree_art_queue',
        'galfree_reference_chain',
        'galfree_snapshot',
      ])
      for (const name of registered) {
        expect(claimed.has(name) || crossCutting.has(name), `${name} 既不是任何环节的入口,也不在横跨环节的白名单里`).toBe(true)
      }
      // 反向:已经注册的入口,指引必须点名它(名字写错 → 上面那条先红;这条保证"说有的确实有")。
      const text = registeredText({ hasTool: (name) => registered.includes(name) })
      for (const name of claimed) if (registered.includes(name)) expect(text).toContain(name)
    })

    it('T20 之后:七个环节里除了"发布前的取舍",每一环都真的有 agent 入口了', () => {
      // 这条是 T19 与 T20 的接缝:指引里"目前没有 agent 入口"的环节,应当随工具补齐而变少。
      // 注册全部工具后,除"设定集定稿 / 试玩认读"这类**人的判断**外,流程每一步都有入口。
      const registry = { tools: [] as Array<{ name: string }>, register(tool: unknown) { registry.tools.push(tool as { name: string }); return () => {} } }
      registerGalfreeTools({ tools: registry } as unknown as Parameters<typeof registerGalfreeTools>[0], service)
      const registered = new Set(registry.tools.map((tool) => tool.name))
      const noEntry = GALFREE_WORKFLOW
        .filter((stage) => stage.tools.length > 0 && !stage.tools.some((tool) => registered.has(tool)))
        .map((stage) => stage.name)
      // 每一环都列了工具,而且现在**注册面覆盖了全部环节**。
      expect(noEntry).toEqual([])
      for (const stage of GALFREE_WORKFLOW) expect(stage.tools.length).toBeGreaterThan(0)
      // 渲染出来也就不该再有"目前没有 agent 入口"了(那句是被 T20 兑现掉的)。
      const text = registeredText({ hasTool: (name) => registered.has(name) })
      expect(text).not.toMatch(/没有 agent 入口/)
    })

    it('指引不写死数字:判据只以字段形态出现', () => {
      const text = registeredText({ hasTool: () => true })
      // "8 个槽""5 场戏"这种数会过期;指引里不该有。
      expect(text).not.toMatch(/\d+\s*个(槽|场景|场戏|角色)/)
    })
  })
})

describe('流程数据本身', () => {
  it('环节名唯一,判据都带路径与写法', () => {
    const names = GALFREE_WORKFLOW.map((stage) => stage.name)
    expect(new Set(names).size).toBe(names.length)
    const all: BoardCriterion[] = GALFREE_WORKFLOW.flatMap((stage) => stage.done)
    expect(all.every((criterion) => criterion.path.trim() !== '')).toBe(true)
    expect(all.filter((criterion) => criterion.op === 'equals').every((criterion) => (criterion.value ?? '') !== '')).toBe(true)
    // 没给 hasTool 时:不假装任何工具存在(缺省 = 全部当作没有)。
    expect(workflowPlaybook()).not.toContain('galfree_publish')
  })
})

/**
 * **真宿主装配守卫**(不是假 ctx):真实挂一次 cordis + `dsh-system-prompt` + `dsh-tools`,
 * 用与入口**同一条路**(`ctx.inject(['tools'|'systemPrompt'], …)`)装配,再真组装一次系统提示。
 *
 * 为什么值得留着:这一层坏掉的形态全是"默默坏" —— 段名重了会抛(整段提示装配失败)、
 * 排序没进组装、或者 `ctx.tools.get` 看不见**本插件自己**注册的工具(于是指引导弹成
 * "没有 agent 入口")。假 ctx 一个都测不出来;这里几十毫秒就能钉死。
 */
describe('真宿主装配(cordis 真服务)', () => {
  it('这段指引进得了组装出来的系统提示,且工具面探测看得到本插件自己的工具', async () => {
    const ctx = new Context()
    // ToolRuntime 自己要 systemPrompt(`static inject = ["systemPrompt"]`),所以先挂它。
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    // 与入口同一条路注册一个工具(名字故意不像 galgame 的,只为验探测)。
    await ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(defineTool({
        name: 'galfree_probe',
        description: '探针',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'ok',
      }))
    })
    await ctx.inject(['systemPrompt'], (promptCtx) => {
      registerGalfreePlaybook(promptCtx.systemPrompt, {
        // 用**入口同一个探针**(不是这里另写一个),否则守卫验的是它自己。
        hasTool: toolPresenceProbe(ctx.tools),
      })
    })

    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((candidate) => candidate.name === WORKFLOW_SECTION)
    expect(section, '这段指引没有进组装').toBeDefined()
    // 排在 persona 前缀之后、后缀之前(第一方工具段与工具 SDK 之间的那个位置)。
    const names = assembly.sections.map((candidate) => candidate.name)
    expect(names.indexOf(WORKFLOW_SECTION)).toBeGreaterThan(names.indexOf('deployment:persona-prefix'))
    expect(names.indexOf(WORKFLOW_SECTION)).toBeLessThan(names.indexOf('deployment:persona-suffix'))
    expect(section!.text.length).toBeGreaterThan(0)

    // 真注册的工具:探测**看得见**(看不见的话指引会谎报"没有 agent 入口");
    // 没注册的:看不见。
    expect(ctx.tools.get('galfree_probe')?.name).toBe('galfree_probe')
    expect(ctx.tools.get('galfree_publish')).toBeUndefined()
  })
})
