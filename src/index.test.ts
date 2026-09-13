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
  it('真入口注册了音频适配器:两个协议(本地 TTS 与 Suno 类音乐)都在', () => {
    const host = fakeHost(seats(true))
    clearAudioAdapters()
    try {
      expect(registeredAudioAdapters()).toEqual([])
      apply(host.ctx)
      // `sync-http` 是 IndexTTS(本地 TTS 服务);`async-task` 是 Suno 类聚合站(音乐)。
      expect(registeredAudioAdapters().sort()).toEqual(['async-task', 'sync-http'])
    } finally {
      // 注册表是**模块级**的:这条测完得清掉,否则污染别的用例(它们假设自己从零注册)。
      clearAudioAdapters()
    }
  })
})
