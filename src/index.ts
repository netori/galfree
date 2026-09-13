/**
 * dsh-galfree — Host 半(插件入口)。
 *
 * 把项目服务(seam)挂到 DSH:`/api/galfree` 路由族 + 设置命名空间。
 * 工作台 Client(./client)与 agent 工具是两个薄适配器,消费同一接缝状态。
 * 独占逻辑全部住在 src/service/ 之下,这里只做装配(ADR-0002)。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
// 只为类型:流程指引注册用的 section 形状与宿主那一份对齐(运行时不 import —— 席位按名取用)。
import type {} from '@deepseek-ai/dsh-system-prompt'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProjectService } from './service/project-service.ts'
import { createNodeHttpClient, type ImageChannelSettings, type ImageModelDescriptor } from './service/images.ts'
import type { AudioChannelSettings, AudioModelDescriptor, AudioPurpose } from './service/audio-generation.ts'
import { registerAudioAdapter } from './service/audio-generation.ts'
import { createIndexttsAdapter } from './service/audio-adapter-indextts.ts'
import { createSunoAdapter } from './service/audio-adapter-suno-register.ts'
import { discoverModels } from './service/discovery.ts'
import { discoverAudioModels } from './service/audio-discovery.ts'
import { makeRoutes } from './routes.ts'
import { GalfreeError } from './service/error.ts'
import { SdkProvisioner, probeOverrideSdk } from './service/sdk-provision.ts'
import { extractZip, httpsDownloader } from './service/sdk-real.ts'
import { findLauncher, platformLauncherName, detectSdkVersion } from './service/hash.ts'
import { realSpawn } from './service/playtest.ts'
import { realDistribute } from './service/publish.ts'
import { defaultThemePorts, realThemeRun } from './service/theme-runner.ts'
import { createCompositeValidator } from './service/validation/composite-validator.ts'
import { registerGalfreeTools } from './service/tools.ts'
import { registerGalfreePlaybook, toolPresenceProbe, type ToolRegistrySeat } from './service/playbook.ts'

/** 稳定的 cordis 插件名(与 cordis.patch.yml 的 insert id 对齐)。 */
export const name = 'galfree'

/** 挂载工作台路由与设置所需的服务。 */
export const inject = ['webServer', 'settings']

/**
 * agent 工具席位(可选):`dsh-tools` 在基础组合里总在,但工具是**可选席位** ——
 * 没有它的宿主照样该能跑面板,所以用 cordis 的懒注入按需注册,而不是把它塞进 `inject`
 * 让插件整体依赖它。与目录选择接缝同一种态度:缺能力就少一个入口,不是插件起不来。
 */
const TOOL_INJECT = { tools: false } as const

/**
 * 目录选择接缝(`ctx.directoryPicker`,由 dsh-web-app 的 adapter 装配 backend)。
 *
 * 它刻意**不进 `inject`**:接缝是能力式的(原生 OS 选择器 `native` / 应用内
 * 浏览器 `browse`),缺 backend 时正确行为是"隐藏选择入口"而不是插件加载失败,
 * 所以这里按名取用、容忍缺席。结构按宿主文档的能力约定声明,不引入对宿主包的依赖。
 */
interface DirectoryPickerSeam {
  capability: () => {
    kind: string
    /** `native`:打开宿主屏幕上的 OS 选择器,取消返回 null。 */
    pick?: (signal?: AbortSignal) => Promise<string | null>
    /** `browse`:列举一层目录。 */
    list?: (path?: string, signal?: AbortSignal) => Promise<unknown>
    /** `browse`:在指定父目录下建一个子目录(单段名)。 */
    createDirectory?: (path: string, name: string) => Promise<unknown>
  }
}

function directoryPickerSeam(ctx: Context): DirectoryPickerSeam | undefined {
  return (ctx as unknown as { directoryPicker?: DirectoryPickerSeam }).directoryPicker
}

/**
 * agent 工具注册表的席位(可选,只用到 `get`):流程指引靠它回答"这一步有没有 agent 入口"。
 * 与目录选择同一个态度 —— 按名取用、容忍缺席。
 */
function toolRegistrySeam(ctx: Context): ToolRegistrySeat | undefined {
  return (ctx as unknown as { tools?: ToolRegistrySeat }).tools
}

export interface Config {
  /** 主开关(路由;关闭后仅 /state 可读)。 */
  enabled?: boolean
  /** 新建项目的默认父目录(空 = 每次显式传入)。 */
  defaultProjectsRoot?: string
  /** 既有 Ren'Py SDK 路径覆盖(空 = 用钉版自动供给)。 */
  sdkPath?: string
  /**
   * 图像渠道(T14):OpenAI 兼容端点基址(如 `https://api.example.com/v1`)。
   * 空 = 没配渠道,出图动作如实拒绝(`no-image-channel`)。
   */
  imageBaseUrl?: string
  /**
   * 图像渠道密钥。**明文存在本机设置文档里**(ADR-0010 的知情选择,与 dsh-imagegen
   * 同风险面):它不进项目目录、不进快照、不进任务账本。
   */
  imageApiKey?: string
  /** 渠道名(只为在面板/账本里指认,随便填)。 */
  imageChannelName?: string
  /**
   * 模型目录(JSON 数组)。每个模型要**声明能力**(支不支持参考链/图生图/尺寸参数),
   * 因为"协议不合要如实降级"只能靠声明判断,猜就会静默发错请求。
   *
   * 形如:`[{"id":"gpt-image-1","label":"全能力","capabilities":{"textToImage":true,"imageToImage":true,"referenceChain":true,"aspectRatioParam":true,"b64Json":true}}]`
   */
  imageModels?: string
  /**
   * **音乐生成渠道**(T27 / ADR-0012):音乐与语音**各自一条**。
   *
   * 为什么必须分开(ADR-0012 的原话:三条线各自一条渠道):它们的上游与协议**不重叠** ——
   * 音乐多是"提交 → 轮询 → 拿 URL"(Suno 类聚合),语音那条是本地服务或另一家 API。
   * 合成一条渠道的表现是:人换了音乐上游,语音那半跟着坏;或者干脆配不了两组——
   * 而"音乐与语音共用一个端点"在现实里根本不是一回事。
   *
   * 端点是**可填的**:聚合站 / 自建反代 / 本地服务走同一条路,插件不写死厂商域名。
   */
  musicBaseUrl?: string
  musicApiKey?: string
  musicChannelName?: string
  /**
   * 音乐模型目录(JSON 数组)。
   *
   * 每条要声明**协议**(`sync-http` 一次拿回 / `async-task` 提交后轮询)与**能力**
   * (纯音乐?能收歌词?能收参考音频?)—— 与图像同一态度:上游支不支持由人声明,代码不猜。
   *
   * 形如:`[{"id":"V6","adapter":"async-task","capabilities":{"textToMusic":true,"instrumental":true}}]`
   */
  musicModels?: string
  /**
   * **语音(TTS)生成渠道**(T27 / ADR-0012):与音乐那条**分开配**。
   *
   * 典型形态是**本机服务**(IndexTTS 2.5 那类:`http://127.0.0.1:<端口>`)——
   * 与音乐那条八竿子打不着,共用一组端点只会让人两头都配不对。
   */
  voiceBaseUrl?: string
  voiceApiKey?: string
  voiceChannelName?: string
  /**
   * 语音模型目录(JSON 数组)。
   *
   * 能力那一栏是 TTS 专有的:能不能克隆音色、能不能指定音色 id、收不收参考音频。
   * 本地服务的嗓子写在 `note` 里(如 `speaker=default;audio=参考音频.wav`)。
   */
  voiceModels?: string
  /**
   * 发布输出目录(T18)。**留空 = 数据目录下的 `publish/<项目名>`**。
   * 每个项目在它下面各占一个子目录;配到项目源树里会被如实拒绝(产物不该混进快照)。
   */
  publishDir?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  defaultProjectsRoot: z.string().default(''),
  sdkPath: z.string().default(''),
  imageBaseUrl: z.string().default(''),
  imageApiKey: z.string().default(''),
  imageChannelName: z.string().default(''),
  imageModels: z.string().default(''),
  musicBaseUrl: z.string().default(''),
  musicApiKey: z.string().default(''),
  musicChannelName: z.string().default(''),
  musicModels: z.string().default(''),
  voiceBaseUrl: z.string().default(''),
  voiceApiKey: z.string().default(''),
  voiceChannelName: z.string().default(''),
  voiceModels: z.string().default(''),
  publishDir: z.string().default(''),
})

/** 设置命名空间(与 SDK 路径/渠道覆盖同一真相;spec User Story 25)。 */
export const CONFIG_NAMESPACE = 'dsh-galfree'

export const GalfreeSettingsSchema: z<Required<Config>> = z.object({
  enabled: z.boolean().default(true),
  defaultProjectsRoot: z.string().default(''),
  sdkPath: z.string().default(''),
  imageBaseUrl: z.string().default(''),
  imageApiKey: z.string().default(''),
  imageChannelName: z.string().default(''),
  imageModels: z.string().default(''),
  musicBaseUrl: z.string().default(''),
  musicApiKey: z.string().default(''),
  musicChannelName: z.string().default(''),
  musicModels: z.string().default(''),
  voiceBaseUrl: z.string().default(''),
  voiceApiKey: z.string().default(''),
  voiceChannelName: z.string().default(''),
  voiceModels: z.string().default(''),
  publishDir: z.string().default(''),
})

/** 宿主侧插件数据目录(注册表、钉版 SDK 等)。 */
export function galfreeDataDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-galfree')
}

/**
 * 从设置文档拼出图像渠道(T14)。
 *
 * 三件事在这里定死:
 *  - **没填端点 = 没渠道**(`null`),出图动作在接缝上如实拒绝,不假装有;
 *  - **密钥明文**只留在设置里,拼出的渠道对象会带着它去发请求,但接缝对外
 *    (`imageChannel()`)只说"配没配",不回传密钥;
 *  - **模型目录是 JSON 文本**(能力声明按模型给),解析不了就当成"没配模型"并
 *    在渠道对象里留空 —— 面板会看到 0 个模型,比静默用一个错目录强。
 */
export function channelFromSettings(settings: Required<Config>): ImageChannelSettings | null {
  if (settings.imageBaseUrl.trim() === '') return null
  return {
    baseUrl: settings.imageBaseUrl.trim(),
    apiKey: settings.imageApiKey,
    ...(settings.imageChannelName.trim() === '' ? {} : { name: settings.imageChannelName.trim() }),
    models: parseModelCatalog(settings.imageModels),
  }
}

/** 解析模型目录 JSON;坏输入返回空目录(面板据此显示"没模型",不静默兜底)。 */
export function parseAudioModelCatalog(text: string): AudioModelDescriptor[] {
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const models: AudioModelDescriptor[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as {
      id?: unknown
      label?: unknown
      note?: unknown
      purpose?: unknown
      adapter?: unknown
      capabilities?: Record<string, unknown>
      paths?: { formats?: unknown; sampleRates?: unknown }
    }
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    // **认不出的用途/协议一律跳过该条**:猜一个默认值就等于"配置看着生效了、
    // 实际按错的协议发请求"(图像那条 catalog 也是这个态度)。
    if (candidate.purpose !== 'music' && candidate.purpose !== 'voice') continue
    if (candidate.adapter !== 'sync-http' && candidate.adapter !== 'async-task') continue
    // 能力缺省 = **全 false**(没声明就是不能干,不靠默认值许诺)。
    const caps = candidate.capabilities ?? {}
    const on = (key: string): boolean => caps[key] === true
    const formats = Array.isArray(candidate.paths?.formats) ? candidate.paths.formats.filter((v): v is string => typeof v === 'string') : undefined
    const sampleRates = Array.isArray(candidate.paths?.sampleRates) ? candidate.paths.sampleRates.filter((v): v is number => typeof v === 'number') : undefined
    models.push({
      id: candidate.id,
      ...(typeof candidate.label === 'string' && candidate.label !== '' ? { label: candidate.label } : {}),
      ...(typeof candidate.note === 'string' && candidate.note !== '' ? { note: candidate.note } : {}),
      purpose: candidate.purpose,
      adapter: candidate.adapter,
      capabilities: {
        textToMusic: on('textToMusic'),
        instrumental: on('instrumental'),
        lyrics: on('lyrics'),
        audioReference: on('audioReference'),
        textToSpeech: on('textToSpeech'),
        voiceCloning: on('voiceCloning'),
        voiceId: on('voiceId'),
        ...(on('urlResult') ? { urlResult: true } : {}),
      },
      ...(formats === undefined && sampleRates === undefined
        ? {}
        : { paths: { ...(formats === undefined ? {} : { formats }), ...(sampleRates === undefined ? {} : { sampleRates }) } }),
    })
  }
  return models
}

/**
 * 从设置拼出**一条**音频渠道(T27 / ADR-0012:音乐与语音各自一条)。
 *
 * **没填端点 = 没那条渠道**(`null`),不是"一个空渠道" —— 于是生成动作如实拒绝
 * `no-music-channel` / `no-voice-channel`,与图像那条同一个态度(不假装能生成)。
 *
 * 为什么把"拼渠道"抽成一份而调用两次:两条渠道的**形状完全一样**(端点/密钥/名字/目录),
 * 差别只在读哪四个键与目录里那条模型该声明什么能力。各写一遍的话,将来加一个字段
 * (比如超时)就会漏掉一条线。
 */
export function audioChannelFromSettings(settings: Required<Config>, purpose: AudioPurpose): AudioChannelSettings | null {
  const baseUrl = (purpose === 'music' ? settings.musicBaseUrl : settings.voiceBaseUrl).trim()
  if (baseUrl === '') return null
  const apiKey = purpose === 'music' ? settings.musicApiKey : settings.voiceApiKey
  const name = (purpose === 'music' ? settings.musicChannelName : settings.voiceChannelName).trim()
  const models = parseAudioModelCatalog(purpose === 'music' ? settings.musicModels : settings.voiceModels)
    // 目录里那条模型必须**属于这条渠道**:音乐渠道里混进一条 `purpose: "voice"`,
    // 只会在选模型时被拒(或者更坏:把 TTS 模型递给了音乐上游)。这里按用途过滤,
    // 而且**不静默改它的 purpose** —— 它就不该出现在这条渠道里。
    .filter((model) => model.purpose === purpose)
  return {
    baseUrl,
    apiKey,
    ...(name === '' ? {} : { name }),
    models,
  }
}

/** 解析模型目录 JSON;坏输入返回空目录(面板据此显示"没模型",不静默兜底)。 */
export function parseModelCatalog(text: string): ImageModelDescriptor[] {
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const models: ImageModelDescriptor[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as {
      id?: unknown
      label?: unknown
      note?: unknown
      sizes?: unknown
      adapter?: unknown
      paths?: { submit?: unknown }
      async?: Record<string, unknown>
      referenceField?: unknown
      capabilities?: Record<string, unknown>
    }
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    const caps = candidate.capabilities ?? {}
    // 协议按目录声明分流(默认同步 OpenAI 兼容)。**认不出来的值一律退回默认**并留在
    // 目录里 —— 但那样出图会按默认协议发,所以下面的能力里也不写"urlResult"之类的许诺。
    const adapter: ImageModelDescriptor['adapter'] = candidate.adapter === 'async-task' ? 'async-task' : 'openai-compatible'
    const paths = typeof candidate.paths?.submit === 'string' && candidate.paths.submit !== ''
      ? { submit: candidate.paths.submit }
      : undefined
    const async = candidate.async === undefined || candidate.async === null
      ? undefined
      : {
          ...(typeof candidate.async.submitPath === 'string' ? { submitPath: candidate.async.submitPath } : {}),
          ...(typeof candidate.async.pollPath === 'string' ? { pollPath: candidate.async.pollPath } : {}),
          ...(typeof candidate.async.pollIntervalMs === 'number' && candidate.async.pollIntervalMs >= 0 ? { pollIntervalMs: candidate.async.pollIntervalMs } : {}),
          ...(typeof candidate.async.pollMaxAttempts === 'number' && candidate.async.pollMaxAttempts > 0 ? { pollMaxAttempts: candidate.async.pollMaxAttempts } : {}),
          ...(Array.isArray(candidate.async.successStatuses) ? { successStatuses: candidate.async.successStatuses.filter((s): s is string => typeof s === 'string') } : {}),
          ...(Array.isArray(candidate.async.failureStatuses) ? { failureStatuses: candidate.async.failureStatuses.filter((s): s is string => typeof s === 'string') } : {}),
        }
    models.push({
      id: candidate.id,
      ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      ...(typeof candidate.note === 'string' ? { note: candidate.note } : {}),
      adapter,
      capabilities: {
        // 缺省口径:v1 的目录绝大多数是 OpenAI 兼容的文生图端点 ——
        // 所以"文生图/尺寸参数/b64"缺省为真,"参考链/图生图"缺省为假
        // (能力宁可少说,不能凭空许诺)。
        textToImage: caps.textToImage !== false,
        imageToImage: caps.imageToImage === true,
        referenceChain: caps.referenceChain === true,
        aspectRatioParam: caps.aspectRatioParam !== false,
        b64Json: caps.b64Json !== false,
        ...(caps.urlResult === true ? { urlResult: true } : {}),
      },
      ...(paths === undefined ? {} : { paths }),
      ...(async === undefined ? {} : { async }),
      // 参考图字段形状:**只在声明为 string 时写下来**(缺省 = OpenAI 兼容的数组)。
      ...(candidate.referenceField === 'string' ? { referenceField: 'string' as const } : {}),
      ...(Array.isArray(candidate.sizes) ? { sizes: candidate.sizes.filter((size): size is string => typeof size === 'string') } : {}),
    })
  }
  return models
}

export function apply(ctx: Context, config?: Config): void {
  // 组合里给的 config 值进 `base`(设置页的"尚未覆盖"那一层)。
  // **三族渠道键一个都不能漏**:漏了的表现是"config 里配好了、设置页却显示没配" ——
  // 而那正是拆渠道时最容易忘的地方(T27 那次的音频四键就在这里丢过一半)。
  const base: Partial<Required<Config>> = {
    enabled: config?.enabled ?? true,
    defaultProjectsRoot: config?.defaultProjectsRoot ?? '',
    sdkPath: config?.sdkPath ?? '',
    imageBaseUrl: config?.imageBaseUrl ?? '',
    imageApiKey: config?.imageApiKey ?? '',
    imageChannelName: config?.imageChannelName ?? '',
    imageModels: config?.imageModels ?? '',
    musicBaseUrl: config?.musicBaseUrl ?? '',
    musicApiKey: config?.musicApiKey ?? '',
    musicChannelName: config?.musicChannelName ?? '',
    musicModels: config?.musicModels ?? '',
    voiceBaseUrl: config?.voiceBaseUrl ?? '',
    voiceApiKey: config?.voiceApiKey ?? '',
    voiceChannelName: config?.voiceChannelName ?? '',
    voiceModels: config?.voiceModels ?? '',
    publishDir: config?.publishDir ?? '',
  }
  const settingsScope = ctx.settings.register(CONFIG_NAMESPACE, GalfreeSettingsSchema, { base })
  const current = () => settingsScope.get()

  const dataDir = galfreeDataDir()
  const pinnedSdkDir = join(dataDir, 'sdk')
  const sdkDir = () => current().sdkPath !== '' ? current().sdkPath : pinnedSdkDir

  // 钉版 SDK 供给(首次需要时下载;进度经 /sdk/status 可见)。
  const provisioner = new SdkProvisioner(pinnedSdkDir, {
    download: httpsDownloader,
    extract: extractZip,
    launcherName: platformLauncherName(),
  })

  /**
   * **确保钉版 SDK 就绪并给出启动器**(试玩 / 发布 / 换皮三条路共用这一段)。
   *
   * 覆盖路径直接用;钉版目录未就绪时先供给一次(首次是下载,进度经 `/sdk/status` 可见),
   * 供不出来就返回 null —— 调用方据此如实报 `sdk-not-ready`,不假装有 SDK。
   * 抽成一处是因为三个入口**要的是同一件事**:各写一遍的话,"什么时候允许触发下载"
   * 这条规则就会活三份,迟早有一份漏掉(那条规则本身是刻意的:**不在工具调用里偷偷下载**)。
   */
  const ensureLauncher = async (): Promise<string | null> => {
    if (current().sdkPath !== '') return findLauncher(current().sdkPath)
    const dir = pinnedSdkDir
    if ((await findLauncher(dir)) === null) {
      const status = await provisioner.ensure().catch(() => null)
      if (status === null || status.state !== 'ready') return null
    }
    return findLauncher(dir)
  }

  /** 图像子系统的出网端口(生产 fetch);模型发现与出图共用同一个。 */
  const imageHttp = createNodeHttpClient()

  /**
   * **注册音频协议适配器**(T27/T29)。没注册的协议在跑任务时会**如实报"还没实现"** ——
   * 所以注册是显式的,不是隐式的默认行为。
   *
   * 目前只有一个:**IndexTTS 2.5**(发起人机器上那份整合包的本地 API,
   * `app_api.py`,默认 `127.0.0.1:9005`)。要接别家就在下面按同一个形状加一行。
   */
  registerAudioAdapter(createIndexttsAdapter())
  // Suno 类聚合站(音乐):提交 → taskId → 轮询 → 音频 URL → 下载。
  // 协议事实与出处见 `audio-adapter-suno.ts` 的表格;路径与模型版本可在模型目录的 note 里覆盖。
  registerAudioAdapter(createSunoAdapter())

  /**
   * 音频生成子系统的出网端口(T27)。
   *
   * 形状比图像那条**窄**(只要"POST 一个 JSON、拿回一段文本"):音乐与语音的协议
   * 各家不同,适配器(T28/T29)自己去解释响应 —— 端口不理解协议,只负责把请求发出去。
   */
  const audioHttp = {
    send: async (request: { url: string; method: string; headers: Record<string, string>; body: string }) => {
      // **GET/HEAD 不能带 body**(fetch 直接抛 "Request with GET/HEAD method cannot have body")。
      // 轮询那条路就是 GET,所以这里必须按方法决定带不带 —— 无脑 `body: ''` 会让轮询整个失败。
      const method = request.method.toUpperCase()
      const response = await fetch(request.url, {
        method,
        headers: request.headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body }),
      })
      return { status: response.status, text: await response.text() }
    },
    // 产物是音频 URL 时用它取字节(Suno 类上游就是这样)。
    download: async (url: string) => {
      const response = await fetch(url)
      return {
        status: response.status,
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? '',
      }
    },
  }

  const service = createProjectService({
    dataDir,
    // 合成验证器:假 lint 恒跑,SDK 就绪时叠加真 lint;覆盖路径版本差异警告入状态。
    validator: createCompositeValidator({
      pinnedSdkDir,
      overrideSdkPath: () => current().sdkPath,
    }),
    playtest: {
      // 三条路(试玩 / 发布 / 换皮)共用 `ensureLauncher` —— 同一件事只有一个实现。
      resolveLauncher: ensureLauncher,
      spawn: realSpawn,
    },
    // 图像子系统(T14):出网走真 fetch;渠道现读设置(改了立刻生效)。
    images: {
      http: imageHttp,
      channel: () => channelFromSettings(current()),
    },
    // 音频生成子系统(T27 / ADR-0012):**音乐与语音各一条渠道**(上游与协议不重叠)。
    // 出网那份是共用的(发一个 HTTP 请求没有两条),渠道按用途现读。
    audio: {
      http: audioHttp,
      channel: (purpose: AudioPurpose) => audioChannelFromSettings(current(), purpose),
    },
    // 本地发布(T18):真构建(钉版 SDK 的 launcher 项目跑 distribute)。
    // 输出目录:设置里给了就用它,否则落数据目录下的 publish/<项目名>。
    publish: {
      ports: {
        resolveLauncher: ensureLauncher,
        run: realDistribute,
      },
      destination: (project) => {
        const configured = current().publishDir.trim()
        return join(configured === '' ? join(dataDir, 'publish') : configured, project.name)
      },
    },
    // 界面换皮(T31 / #39):真跑一次钉版 SDK 的界面生成器(在 staging 副本里)。
    theme: defaultThemePorts({
      run: realThemeRun,
      // 生成器住在 SDK 里(`launcher/game/gui7`),所以"SDK 目录"与"启动器"要的是同一件事。
      resolveSdkDir: async () => (await ensureLauncher()) === null ? null : sdkDir(),
      resolveLauncher: ensureLauncher,
      // 版本记进主题账本:将来 SDK 升了,"这套图是哪版画的"有据可查(探测不到就如实 null)。
      sdkVersion: async () => (await detectSdkVersion(sdkDir())) ?? null,
    }),
  })

  ctx.effect(
    () => {
      const disposers = makeRoutes({
        service,
        config: current,
        // 目录选择:每次请求现取接缝(backend 可能晚些激活,能力对象在服务生命周期内稳定)。
        picker: {
          capability: async () => {
            const seam = directoryPickerSeam(ctx)
            if (seam === undefined) return { kind: 'none' as const }
            try {
              return { kind: seam.capability().kind }
            } catch (error) {
              return { kind: 'none' as const, note: String(error) }
            }
          },
          pick: async (signal) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.pick === undefined) throw new GalfreeError('picker-unsupported', '宿主没有原生目录选择器(当前后端为应用内浏览)')
            return await capability.pick(signal)
          },
          list: async (path, signal) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.list === undefined) throw new GalfreeError('picker-unsupported', '宿主没有应用内目录浏览后端')
            return await capability.list(path, signal)
          },
          createDirectory: async (path, name) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.createDirectory === undefined) throw new GalfreeError('picker-unsupported', '宿主没有应用内目录浏览后端')
            return await capability.createDirectory(path, name)
          },
        },
        // 模型发现(T14 续;2026-09-13 起音频渠道也用同一个口子):
        // 按 `purpose` 分流到对应那条的推断 —— 图像是五项能力、音频是六项,推断规则不同,
        // 但"拉 /models → 解析 → 标待确认"这套形状只有一份。
        discoverModels: (input) => input.purpose === undefined
          ? discoverModels(imageHttp, input)
          : discoverAudioModels(imageHttp, { ...input, purpose: input.purpose }),
        sdk: {
          // 新建项目要从这里拷界面模板(screens.rpy / gui.rpy)。
          dir: () => sdkDir(),
          status: async () => {
            const override = current().sdkPath
            const dir = sdkDir()
            const launcher = await findLauncher(dir)
            const probe = launcher === null ? { ready: false } : override !== '' ? await probeOverrideSdk(dir, platformLauncherName()) : { ready: true }
            return {
              requested: override !== '' ? ('override' as const) : ('pinned' as const),
              dir,
              launcherReady: launcher !== null,
              version: probe.version,
              mismatch: probe.mismatch,
              provision: provisioner.status,
            }
          },
          ensure: async () => {
            try {
              await provisioner.ensure()
            } catch { /* 状态对象里如实呈现 failed + error */ }
            return provisioner.status
          },
        },
      }).map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-galfree: routes',
  )

  // agent 工具(T10):接缝能力的薄适配器。懒注入 —— 宿主没有工具席位就少两个入口,
  // 面板与路由照常工作。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () => registerGalfreeTools(
        toolCtx as unknown as Parameters<typeof registerGalfreeTools>[0],
        service,
        {
          // 新建项目要用父目录与 SDK 界面模板 —— 与面板经 `deps.config` / `deps.sdk` 拿的是同一份设置。
          defaultProjectsRoot: () => current().defaultProjectsRoot,
          sdkDir: () => sdkDir(),
        },
      ),
      'dsh-galfree: agent tools',
    )
  })

  // 流程指引(T19 / #27):往会话的 system prompt 注入一段 playbook(顺序 / 闸门 / 判据 /
  // 谁来做)。**与工具面同一个懒注入态度**:宿主没有 systemPrompt 席位就少一段提示,
  // 插件不崩、工具照常。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () => registerGalfreePlaybook(promptCtx.systemPrompt, {
        // 工具面是**可选席位**,而且可能晚于本段就位:每次组装现问一次"这个工具在不在",
        // 于是"还没做的入口"会如实显示成"请人在工作台做",不报一个调不通的工具名。
        hasTool: toolPresenceProbe(toolRegistrySeam(ctx)),
      }),
      'dsh-galfree: workflow playbook',
    )
  })
}
