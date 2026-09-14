/**
 * 渠道设置的解析(T14)——纯函数,断言"配置文档 → 渠道对象"这一步。
 *
 * 这一步值得单独测:它是**密钥与项目之间的唯一闸门**(密钥只能留在设置里),
 * 也是"能力声明"进入系统的入口(参考链支不支持由它决定,而不是运行时猜)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, channelFromSettings, parseModelCatalog, type Config } from './index.ts'
import { clearAudioAdapters, registeredAudioAdapters } from './service/audio-generation.ts'
import { WORKFLOW_SECTION, type SystemPromptSeat } from './service/playbook.ts'
import { cleanupTempDirs, makeTempDir } from './testing/tmp.ts'
import { collectPromptSections, type CollectedSection } from './testing/prompt-seat.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 一份填齐的设置文档(密钥明文,这是 ADR-0010 的知情选择)。 */
function settings(overrides: Partial<Required<Config>> = {}): Required<Config> {
  return {
    enabled: true,
    defaultProjectsRoot: 'D:\\galgame',
    sdkPath: '',
    imageBaseUrl: 'https://api.example.com/v1',
    imageApiKey: 'sk-plaintext-in-settings',
    imageChannelName: '主渠道',
    imageModels: '',
    // 音乐 / 语音两条渠道(T27 / ADR-0012:三条生成线各自一条)缺省**都不配**:
    // 于是那几条路如实拒绝(`no-music-channel` / `no-voice-channel`),与图像"没配渠道"同一态度。
    musicBaseUrl: '',
    musicApiKey: '',
    musicChannelName: '',
    musicModels: '',
    voiceBaseUrl: '',
    voiceApiKey: '',
    voiceChannelName: '',
    voiceModels: '',
    publishDir: '',
    ...overrides,
  }
}

describe('图像渠道设置(T14)', () => {
  it('没填端点 = 没渠道(出图动作在接缝上如实拒绝,不假装有)', () => {
    expect(channelFromSettings(settings({ imageBaseUrl: '' }))).toBeNull()
    expect(channelFromSettings(settings({ imageBaseUrl: '   ' }))).toBeNull()
  })

  it('端点带不带尾斜杠都能用;密钥原样带给适配器(它只在出网时用)', () => {
    const channel = channelFromSettings(settings())
    expect(channel?.baseUrl).toBe('https://api.example.com/v1')
    expect(channel?.apiKey).toBe('sk-plaintext-in-settings')
    expect(channel?.name).toBe('主渠道')
  })

  it('模型目录:能力按声明解析;参考链/图生图**缺省为假**(不能凭空许诺)', () => {
    const models = parseModelCatalog(JSON.stringify([
      { id: 'full', label: '全能力', capabilities: { referenceChain: true, imageToImage: true } },
      { id: 'plain' },
    ]))
    expect(models.map((model) => model.id)).toEqual(['full', 'plain'])
    const full = models[0]!
    expect(full.capabilities).toMatchObject({ textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true })
    // 没声明 = 不给许诺。
    expect(models[1]!.capabilities).toMatchObject({ textToImage: true, imageToImage: false, referenceChain: false })
  })

  it('模型目录是坏 JSON / 不是数组 → 空目录(面板显示"没模型",不静默兜底)', () => {
    expect(parseModelCatalog('{ 这不是 JSON')).toEqual([])
    expect(parseModelCatalog('"一个字符串"')).toEqual([])
    expect(parseModelCatalog('[{"没有 id":true},{"id":""}]')).toEqual([])
  })

  it('密钥不出现在渠道能力视图里(接缝只回报"配没配")', async () => {
    // 这一条在接缝上断言(imageChannel 的形状),不在这里重复实现;
    // 此处只钉住设置这一侧的边界:渠道对象**确实**带着密钥(它要用来出网),
    // 所以"不回传"必须由接缝负责,不能靠运气。
    const channel = channelFromSettings(settings())
    expect(channel?.apiKey).toBe('sk-plaintext-in-settings')
  })

  it('协议按目录声明分流:adapter/paths/async 都解析得出来(默认同步)', () => {
    const models = parseModelCatalog(JSON.stringify([
      { id: 'sync-model' },
      {
        id: 'async-model',
        adapter: 'async-task',
        paths: { submit: '/image/generations' },
        async: { submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 1500, pollMaxAttempts: 30 },
        capabilities: { urlResult: true },
      },
    ]))
    // 没声明的走默认(同步 OpenAI 兼容)。
    expect(models[0]!.adapter).toBe('openai-compatible')
    expect(models[0]!.paths).toBeUndefined()
    expect(models[0]!.async).toBeUndefined()

    // 声明的按声明走:单数路径 + 轮询参数 + "结果是 URL"。
    const async = models[1]!
    expect(async.adapter).toBe('async-task')
    expect(async.paths?.submit).toBe('/image/generations')
    expect(async.async).toMatchObject({ submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 1500, pollMaxAttempts: 30 })
    expect(async.capabilities.urlResult).toBe(true)
  })

  it('认不出来的 adapter 值退回默认(不静默用一个不存在的协议)', () => {
    const models = parseModelCatalog(JSON.stringify([{ id: 'x', adapter: '不认识的协议' }]))
    expect(models[0]!.adapter).toBe('openai-compatible')
  })
})

/**
 * 入口装配(T19 / #27):流程指引是**可选席位**上的一段提示。
 *
 * 这一组守的是"懒注入"这条契约:宿主有 `systemPrompt` 就多一段 playbook,
 * 没有就少一段 —— **插件照常起来、工具照常注册**(与工具席位、目录选择席位同一个态度)。
 * 假 ctx 只实现 `apply()` 真正碰到的那几个面;工具/提示词席位按需装上。
 */
describe('插件入口装配(T19)', () => {
  let home: string | undefined

  beforeEach(async () => {
    home = process.env.DSH_HOME
    process.env.DSH_HOME = await makeTempDir('galfree-t19-home-')
  })

  afterEach(async () => {
    if (home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = home
    await cleanupTempDirs()
  })

  interface FakeSeats {
    systemPrompt?: SystemPromptSeat
    tools?: { register: (tool: unknown) => () => void }
  }

  /** 收下 apply() 装配出来的东西(路由 / 提示词段 / 工具)。 */
  function fakeHost(seats: FakeSeats): {
    ctx: Context
    routes: unknown[]
    sections: CollectedSection[]
    tools: Array<{ name: string }>
  } {
    const routes: unknown[] = []
    const tools: Array<{ name: string }> = []
    // 提示词席位的收集形状与 playbook.test.ts 共用一份夹具(宿主改了形状,两边一起改)。
    const collector = collectPromptSections()
    const ctx = {
      settings: {
        register: () => ({
          get: () => ({
            enabled: true, defaultProjectsRoot: '', sdkPath: '',
            imageBaseUrl: '', imageApiKey: '', imageChannelName: '', imageModels: '', publishDir: '',
          }),
        }),
      },
      webServer: { register: (route: unknown) => { routes.push(route); return () => {} } },
      // cordis 的 effect 是"立刻执行、返回 disposer";这里照做,装配行为才被测到。
      effect: (callback: () => unknown) => { callback(); return () => {} },
      // cordis 的 inject 是"席位齐了才跑回调";缺席位就永远不跑(这正是懒注入)。
      inject: (deps: string[], callback: (inner: unknown) => void) => {
        if (deps.every((dep) => (seats as Record<string, unknown>)[dep] !== undefined)) callback(ctx)
        return undefined
      },
      ...(seats.systemPrompt === undefined ? {} : { systemPrompt: collector.seat }),
      ...(seats.tools === undefined ? {} : {
        tools: {
          register: (tool: unknown) => { tools.push(tool as { name: string }); return seats.tools!.register(tool) },
          // 真宿主的工具注册表两边都有(`ToolRuntime.register` / `.get`):
          // 指引的 `hasTool` 走的就是 `get`。
          get: (toolName: string) => tools.find((tool) => tool.name === toolName),
        },
      }),
    }
    // 真 cordis 的 `ctx.get(name)` 是**不要求 inject** 的取用口 —— 插件靠它读可选席位
    // (`tools` / `directoryPicker`)。假宿主必须照实现:少了它,插件会走进"席位缺席"那条
    // 兜底分支,于是测出来的是假象(实测:T35 加了这个口子,这条假 ctx 立刻暴露出来)。
    ;(ctx as Record<string, unknown>).get = (name: string) => (ctx as Record<string, unknown>)[name]
    return { ctx: ctx as unknown as Context, routes, sections: collector.sections, tools }
  }

  const seats = (withSystemPrompt: boolean): FakeSeats => ({
    ...(withSystemPrompt ? { systemPrompt: { section: () => () => {} } } : {}),
    tools: { register: () => () => {} },
  })

  it('宿主有 systemPrompt 席位 → 会话里多一段 galfree-workflow', () => {
    const host = fakeHost(seats(true))
    apply(host.ctx)
    expect(host.sections.map((section) => section.name)).toEqual([WORKFLOW_SECTION])
    const section = host.sections[0]!
    expect(typeof section.order).toBe('number')
    // 文本是**每次组装现算**的:工具面可能晚于这段就位,固化下来就会报一个不存在的入口。
    const text = typeof section.text === 'function' ? section.text() : section.text
    expect(text).toContain('GALFree')
    // 有工具席位时,真的注册了的工具会被点名(装配出来的那 10 个里有发布)。
    expect(text).toContain('galfree_publish')
  })

  it('宿主没有 systemPrompt 席位 → 插件照常起、工具照常注册(少一段提示而已)', () => {
    const host = fakeHost(seats(false))
    expect(() => apply(host.ctx)).not.toThrow()
    expect(host.sections).toEqual([])
    // "照常工作"的可观察形态:路由装配了、agent 工具一个不少。
    expect(host.routes.length).toBeGreaterThan(0)
    expect(host.tools.map((tool) => tool.name)).toContain('galfree_project_status')
  })

  /**
   * 适配器**在真入口里注册了没有**。
   *
   * 为什么必须有这一条:适配器是"注册了才认"的(T27 起的显式设计)——
   * 写了但没注册,跑任务只会得到一句"这个协议的适配器还没实现",
   * 而单测(自己注册一个假适配器)照样全绿。也就是说:**这条缺了,整条生成链路可能静默哑火**。
   */
  it('真入口注册了音频适配器:三个协议(本地 TTS + 两种音乐异步形状)都在', () => {
    const host = fakeHost(seats(true))
    clearAudioAdapters()
    try {
      expect(registeredAudioAdapters()).toEqual([])
      apply(host.ctx)
      // `sync-http` = IndexTTS(本地 TTS 服务);
      // `async-task` = sunoapi 那套(查询串轮询);`async-task-rest` = 网关自己的资源式 REST
      // (路径里带任务 id,T34)—— 后两条**不是同一个协议**,少注册一个就会在有人的机器上哑火。
      expect(registeredAudioAdapters().sort()).toEqual(['async-task', 'async-task-rest', 'sync-http'])
    } finally {
      // 注册表是**模块级**的:这条测完得清掉,否则污染别的用例(它们假设自己从零注册)。
      clearAudioAdapters()
    }
  })
})

/**
 * 可选席位的读法(T35 · 宿主错误日志里那条反复出现的报错)。
 *
 * **症状**:宿主日志反复出现 `Error: cannot get property "tools" without inject`
 * (来自 `lib/index.js`)。它**不是**偶发 —— 是读法错了。
 *
 * **机制**(在真 cordis 上实测出来,不是推理):`ctx` 是代理,读一个**没写进本插件
 * `inject`** 的服务会**抛**,不是返回 `undefined`。而"可选席位"的定义恰恰是"不依赖它"。
 * 以前那两处接缝写的是 `(ctx as { tools?: X }).tools` —— 类型上盖住了,运行时照抛。
 *
 * **一条容易上当的边界**:在**非运行态** fiber 上随手读一下**碰巧不抛**(返回 undefined)。
 * 所以"我试了一下没报错"不能当它对;真宿主里那段跑在**嵌套 `inject` 回调**中,那里就是抛。
 * 这一组因此在**真 Context + 真嵌套 inject** 里复现,而不是拿假 ctx 糊过去。
 *
 * 席位用 `provide` 装(而不是 `ctx.plugin(Settings)`):`SettingsProvider` 是**抽象基类**,
 * 直接当插件挂会抛 `this.load is not a function`(`load` 由具体 provider 实现)。
 * 这里要验的是**读法**,席位给个形状对的最小实现即可。
 */
describe('可选席位的读法(T35 · 不能直接读 ctx.tools)', () => {
  let home: string | undefined

  beforeEach(async () => {
    home = process.env.DSH_HOME
    process.env.DSH_HOME = await makeTempDir('galfree-t35-home-')
  })

  afterEach(async () => {
    if (home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = home
    await cleanupTempDirs()
  })

  /** 装齐插件**声明**的两个席位(settings / webServer),否则 fiber 不激活、apply 根本不跑。 */
  function provideDeclaredSeats(ctx: {
    provide: (name: string, value: unknown) => unknown
  }): void {
    ctx.provide('settings', {
      register: () => ({ get: () => ({ enabled: true, defaultProjectsRoot: '', sdkPath: '', imageBaseUrl: '', imageApiKey: '', imageChannelName: '', imageModels: '', publishDir: '' }) }),
    })
    ctx.provide('webServer', { register: () => () => {} })
  }

  it('真 cordis:嵌套 inject 里直接读 ctx.tools **会抛**(把这条机制记成事实,别照感觉写)', async () => {
    // 这条**不测插件**,测的是"为什么必须用 ctx.get"这条机制本身 ——
    // 顺带钉住宿主日志里那句原话,以后有人想改回属性读法时,这条会告诉他代价。
    const { Context } = await import('@deepseek-ai/cordis')
    const root = new Context()
    root.provide('settings', { register: () => ({ get: () => ({}) }) })
    root.provide('systemPrompt', { assemble: async () => ({ sections: [] }), section: () => () => {} })

    let thrown = ''
    await root.plugin({
      name: 'probe-direct-read',
      inject: ['settings'],
      apply(probeCtx: unknown) {
        const c = probeCtx as Context
        // 与 src/index.ts 同形:在**嵌套** inject 回调里读外层 ctx 的可选席位。
        c.inject(['systemPrompt'], () => {
          try { void (c as unknown as { tools?: unknown }).tools } catch (error) { thrown = (error as Error).message }
        })
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 宿主错误日志里那条原话(消息由 cordis 给出)。
    expect(thrown).toContain('cannot get property "tools" without inject')
    // 对照:`ctx.get` 是 cordis 给的正路 —— 同样的位置,缺席返回 undefined 而不是抛。
    expect(root.get('tools')).toBeUndefined()
  })

  it('插件在**只有 systemPrompt、没有 tools** 的真宿主上照样起得来(可选席位真的可选)', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')

    const ctx = new Context()
    provideDeclaredSeats(ctx as never)
    await ctx.plugin(SystemPrompt)
    // **故意不装 ToolRuntime**:这正是"宿主没有工具席位"的形态。

    const plugin = await import('./index.ts')
    // 传 `apply` 本身(cordis 支持函数式插件):`ctx.plugin(模块命名空间)` 不行 ——
    // 这个模块没有 default export,命名空间对象不是合法 plugin。
    // 以前这一步会因为读 ctx.tools 而抛 `cannot get property "tools" without inject`。
    await ctx.plugin(Object.assign(plugin.apply, { inject: plugin.inject }))
    // 指引段仍然进得了组装(工具探针缺席 → 保守地说"请人在工作台做",不是崩)。
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((section) => section.name)).toContain('galfree-workflow')
    // 而且**如实**保守:没有工具席位时,不该点名一个调不通的工具。
    // 真宿主的 `assemble()` 已经把 `text` 解析成字符串(注册时那个函数在这里被调用过),
    // 所以这里直接读字符串,不要照假宿主那把 `text` 当函数用。
    const section = assembly.sections.find((candidate) => candidate.name === 'galfree-workflow')!
    expect(section.text).not.toContain('`galfree_publish`')
  })

  it('真宿主**有** tools 时,探针照样探得到(修完没把"有"读成"没有")', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')

    const ctx = new Context()
    provideDeclaredSeats(ctx as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const plugin = await import('./index.ts')
    await ctx.plugin(Object.assign(plugin.apply, { inject: plugin.inject }))
    // 工具真的注册进去了。
    expect(ctx.tools.get('galfree_project_status')).toBeDefined()
    // 指引段里那条"这个入口在不在"的探测走的是 `ctx.get('tools')` ——
    // 修成可选取用之后,它必须仍然**看得见**已注册的工具(否则指引会退化成"请人做")。
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((candidate) => candidate.name === 'galfree-workflow')
    expect(section).toBeDefined()
    expect(section!.text).toContain('galfree_publish')
  })
})
