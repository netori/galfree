/**
 * 音频渠道的**自动发现 + 能力推断**(T27 续,2026-09-13)。
 *
 * 与图像那条(`discovery.ts`)同一套路数与同一态度:**人只填端点与密钥,其余能自动的都自动**,
 * 自动不出来的**如实标"待确认"**,绝不凭空许诺能力(上游不认的请求只会失败,而失败本该可避免)。
 *
 * ## 音乐与语音两条渠道共用这一份,但"像什么"不同
 *
 * - **音乐**渠道拉到的 id 多半长成 `V6` / `chirp-v3-5` / `suno*` / `musicgen*` ——
 *   有一半看着完全不像任何东西(聚合站的别名),所以推断格外的保守;
 * - **语音**渠道多半是**本机服务**(IndexTTS 那类):它的 `/models` 往往**根本没有**
 *   (FastAPI 只给了 `/health` `/speakers` `/voices`),所以那条路主要靠**手动添加**,
 *   由人来声明"这台服务能干什么"。
 *
 * 结论:**这条模块的产出永远是候选 + 依据**,人在面板上勾一次才算数(与图像同口径)。
 */
import type { AudioAdapterId, AudioModelCapabilities, AudioPurpose } from './audio-generation.ts'
import type { HttpRequest, HttpResponse } from './images.ts'

/**
 * 出网口(与图像共用的那一个:`ImageHttpClient` 的 `send`)。
 *
 * 这里**只声明用得上的一半**:发现只发 GET,用不到 `download` ——
 * 收窄成"能发一个请求"就够了,于是生产那一个 `createNodeHttpClient()` 两条路都能喂。
 */
export interface AudioDiscoveryHttp {
  send: (request: HttpRequest) => Promise<HttpResponse>
}

/** 六项能力一个都不能少(与图像同口径:目录里写的是一份**全量快照**)。 */
export const NO_AUDIO_CAPS: AudioModelCapabilities = {
  textToMusic: false,
  instrumental: false,
  lyrics: false,
  audioReference: false,
  textToSpeech: false,
  voiceCloning: false,
  voiceId: false,
}

export interface AudioModelInference {
  capabilities: AudioModelCapabilities
  /** 推断出来的协议(按协议收,不按厂商收;认不出时给该用途的默认)。 */
  adapter: AudioAdapterId
  /** 命中的家族名(没认出来 = undefined)。 */
  family?: string
  /** 一句话说明依据(面板直接显示给人看)。 */
  basis: string
  /** true = 保守默认,请人到面板上确认;false = 已知家族给的。 */
  needsConfirmation: boolean
}

interface Family {
  /** 匹配模型 id(小写)。 */
  match: RegExp
  name: string
  /** 这条家族属于哪个用途(认错用途比认不出更坏:会让模型出现在错的那条渠道里)。 */
  purpose: AudioPurpose
  adapter: AudioAdapterId
  capabilities: AudioModelCapabilities
  basis: string
}

/**
 * 已知家族。**只写有把握的**:音乐那几个名字来自公开文档与聚合站的常见别名,
 * 语音这边只有 IndexTTS / GPT-SoVITS / fish-speech 这几个确实见过的。
 *
 * 为什么按"用途"分家族:渠道已经拆开了(音乐一条、语音一条),所以
 * "这条 id 属于哪个用途"是**第一层判断** —— 认不出来时按渠道的用途兜底。
 */
const FAMILIES: Family[] = [
  // ── 音乐 ────────────────────────────────────────────────────────────
  {
    match: /(suno|chirp|^v[0-9]+(\.[0-9]+)?$|sunoapi)/,
    name: 'suno',
    purpose: 'music',
    adapter: 'async-task',
    capabilities: { ...NO_AUDIO_CAPS, textToMusic: true, instrumental: true, lyrics: true, urlResult: true },
    basis: 'Suno 类聚合站:**提交 → 轮询 → 拿音频 URL**,支持纯音乐与带唱(所以是异步任务制)',
  },
  {
    match: /(musicgen|music-gen|audiocraft|stable-audio|ace-?step)/,
    name: 'musicgen',
    purpose: 'music',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToMusic: true, instrumental: true },
    basis: 'MusicGen / Stable Audio 一类:一次调用直接回音频,以**纯音乐**为主(不收歌词)',
  },
  {
    match: /(minimax.*music|music-01|music_generation)/,
    name: 'minimax-music',
    purpose: 'music',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToMusic: true, instrumental: true, lyrics: true },
    basis: 'MiniMax 音乐:`music_generation` 一次拿回(base64),可带唱',
  },
  // ── 语音 ────────────────────────────────────────────────────────────
  {
    match: /(indextts|index-tts|index_tts)/,
    name: 'indextts',
    purpose: 'voice',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true, voiceCloning: true, voiceId: true, audioReference: true },
    basis: 'IndexTTS:**零样本音色克隆**(给一段参考音频)+ 服务端预置嗓子(`speaker`);一次 POST 拿回音频',
  },
  {
    match: /(gpt-?sovits|sovits)/,
    name: 'gpt-sovits',
    purpose: 'voice',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true, voiceCloning: true, audioReference: true },
    basis: 'GPT-SoVITS:参考音频克隆音色,本地服务一次拿回',
  },
  {
    match: /(fish-?speech|fishspeech|fish-?audio)/,
    name: 'fish-speech',
    purpose: 'voice',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true, voiceCloning: true, audioReference: true },
    basis: 'fish-speech:参考音频克隆,本地服务一次拿回',
  },
  {
    match: /(cosyvoice|edge-?tts|azure.*tts|tts-1|gpt-4o-mini-tts)/,
    name: 'tts-by-voice-id',
    purpose: 'voice',
    adapter: 'sync-http',
    capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true, voiceId: true },
    basis: '按**音色 id** 合成的 TTS(预置嗓子),不做零样本克隆 —— 一致性靠固定的 voice id',
  },
]

/**
 * 从一个模型 id 推断**能力 + 协议**。
 *
 * 认不出来时给**该用途的保守默认**:能力基本全关(只留最基础的那一件),
 * 并标 `needsConfirmation` —— 请人到面板上勾准它真实支持的。
 */
export function inferAudioCapabilities(modelId: string, purpose: AudioPurpose): AudioModelInference {
  const id = modelId.trim().toLowerCase()
  for (const family of FAMILIES) {
    if (!family.match.test(id)) continue
    // 家族与渠道的用途不一致时**不采用**这条家族(宁可退回保守默认):
    // 把一条音乐模型的家族能力按在语音渠道上,只会让人看到一份骗人的能力表。
    if (family.purpose !== purpose) {
      return {
        ...conservative(purpose),
        basis: `「${modelId}」看着像${family.purpose === 'music' ? '音乐' : '语音'}那类(${family.name}),`
          + `而这条渠道是${purpose === 'music' ? '音乐' : '语音'} —— 不按另一条的能力填,请人确认它到底支持什么`,
      }
    }
    return { capabilities: { ...family.capabilities }, adapter: family.adapter, family: family.name, basis: family.basis, needsConfirmation: false }
  }
  return conservative(purpose)
}

/** 保守默认:认不出来的模型只许它最基础的那一件事。 */
function conservative(purpose: AudioPurpose): AudioModelInference {
  return purpose === 'music'
    ? {
      capabilities: { ...NO_AUDIO_CAPS, textToMusic: true },
      // 音乐这边**默认异步**:聚合站多为"提交 → 轮询",而猜成同步会让一次调用拿不到产物。
      adapter: 'async-task',
      basis: '没认出来的音乐模型:按最保守的口径填(只当它能文生音乐),协议默认异步 —— 请到下面勾准它真实支持的',
      needsConfirmation: true,
    }
    : {
      capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true },
      // 语音这边**默认同步**:本机服务基本都是一次 POST 拿回。
      adapter: 'sync-http',
      basis: '没认出来的语音模型:按最保守的口径填(只当它能合成语音),协议默认同步 —— 请到下面勾准它真实支持的',
      needsConfirmation: true,
    }
}

/** 上游明确不是音频模型的那一类(聊天 / 嵌入 / 图像)—— 排在后面,但**不隐藏**(人还能手选)。 */
const NON_AUDIO = /(embed|rerank|whisper|moderation|^gpt-[45]|^gpt-3|^o[13]|^claude|^deepseek|^qwen[0-9]|^gemini-|dall-e|gpt-image|flux|sd[x3]|stable-diffusion|image)/

/** 拉取结果里的一项(给面板渲染用;**不含密钥**)。 */
export interface DiscoveredAudioModel {
  id: string
  label?: string
  /** 像不像这个用途的模型:只影响排序与默认勾选,**不隐藏**。 */
  likely: boolean
  inference: AudioModelInference
}

export interface DiscoverAudioModelsResult {
  models: DiscoveredAudioModel[]
  /** 上游一共回了多少个 id(含明显不是音频模型的)。 */
  total: number
  /** 实际请求的 URL(排障用;不含密钥)。 */
  endpoint: string
}

/** 去掉末尾斜杠与多余空白,得到规范的基址。 */
export function normalizeAudioBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 拉模型清单 —— **走注入的出网端口**(生产 fetch / 快带假上游;协议形状不因测试而变)。
 *
 * 与图像那条同一口径:错误**如实抛**,面板把上游原话显示出来(401 就是密钥不对、
 * 404 就是端点不对),不吞成"拉取失败"让人瞎猜。
 *
 * **一条本机服务常有的真实情况**:IndexTTS 那类 `app_api.py` 只有 `/health`
 * `/speakers` `/voices`,**没有 `/models`** —— 那时这里会如实报"没有 data 数组(不是
 * OpenAI 兼容的 /models 形状)",人改成**手动添加**即可。这一点写在契约里,不是缺陷。
 */
export async function discoverAudioModels(
  http: AudioDiscoveryHttp,
  input: { baseUrl: string; apiKey?: string; purpose: AudioPurpose },
): Promise<DiscoverAudioModelsResult> {
  const base = normalizeAudioBaseUrl(input.baseUrl)
  const endpoint = `${base}/models`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.apiKey !== undefined && input.apiKey !== '') headers.authorization = `Bearer ${input.apiKey}`

  const response = await http.send({ method: 'GET', url: endpoint, headers })
  if (response.status < 200 || response.status >= 300) {
    // 404 在这条路上**最常见**,而且它的意思很具体:本机 TTS 服务(IndexTTS 那类)
    // 只注册了 `/health` `/speakers` `/voices`,**没有 `/models`** —— 那不是故障,
    // 是"这条路在这类服务上不存在"。所以措辞里要说清下一步(手动添加)。
    throw new Error(
      `拉模型清单失败:${endpoint} 返回 ${response.status} —— ${summarize(response.text)}`
      + '。本机 TTS 服务(IndexTTS 那类)往往只有 /health /speakers /voices —— 那样请用「手动添加模型」。',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new Error(`拉模型清单失败:${endpoint} 返回的不是 JSON —— ${summarize(response.text)}。这条路要的是 OpenAI 兼容的 /models;没有就用「手动添加模型」。`)
  }

  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error(
      `拉模型清单失败:${endpoint} 的响应里没有 data 数组(不是 OpenAI 兼容的 /models 形状)。`
      + '本机 TTS 服务(IndexTTS 那类)往往只有 /health /speakers /voices —— 那样请用「手动添加模型」。',
    )
  }

  const seen = new Set<string>()
  const models: DiscoveredAudioModel[] = []
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; name?: unknown }
    if (typeof record.id !== 'string' || record.id.trim() === '') continue
    const id = record.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    const inference = inferAudioCapabilities(id, input.purpose)
    models.push({
      id,
      ...(typeof record.name === 'string' && record.name !== '' ? { label: record.name } : {}),
      likely: inference.family !== undefined || !NON_AUDIO.test(id.toLowerCase()),
      inference,
    })
  }

  const ordered = [...models].sort((a, b) => Number(b.likely) - Number(a.likely))
  return { models: ordered, total: models.length, endpoint }
}

/**
 * 勾选结果 → `musicModels` / `voiceModels` 设置项要的 JSON。
 *
 * **`purpose` 一定写进去**:拼渠道时会按它过滤(音乐渠道只收 `purpose:"music"`),
 * 少了这一栏那条模型会被静默滤掉 —— 那正是"配置看着生效了、跑起来说不认识"的形状。
 */
export function audioModelsToCatalogJson(
  purpose: AudioPurpose,
  adapterOf: (id: string) => AudioAdapterId,
  selected: Array<{ id: string; label?: string; note?: string; capabilities: AudioModelCapabilities }>,
): string {
  return JSON.stringify(selected.map((model) => ({
    id: model.id,
    purpose,
    adapter: adapterOf(model.id),
    ...(model.label === undefined || model.label === '' ? {} : { label: model.label }),
    ...(model.note === undefined || model.note === '' ? {} : { note: model.note }),
    capabilities: { ...model.capabilities },
  })), null, 2)
}

function summarize(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

// ─── 音色库(T32):那台语音服务有哪些"嗓子"────────────────────────────

/**
 * 读音色库用的出网口。
 *
 * 为什么与上面那个 `AudioDiscoveryHttp` 分开写:那一个是**图像渠道**的口(`body` 可省),
 * 而读音色库要问的是**语音渠道** —— 它的口就是音频子系统那一份(`body: string`,
 * GET 时生产实现自己不带上它)。两处形状本来就不同,硬合成一个只会让某一侧要放宽类型。
 */
export interface VoiceLibraryHttp {
  send: (request: { url: string; method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>
}

/**
 * 读音色库的结果。
 *
 * **每个端点各报各的**:本机 TTS 服务各不相同 —— IndexTTS 那类有 `/health` `/speakers`
 * `/voices`,别家可能一个都没有。所以"没答上来的端点"进 `problems`(人话),不整体抛:
 * 拉不到 `/speakers` 不等于这条路走不通(音色档案要的是 `/voices` 那份文件名清单)。
 */
export interface VoiceLibraryReading {
  /** 服务活着吗(`GET /health` 答了吗)。 */
  reachable: boolean
  /** `GET /health` 的原话(有的服务会顺带回 `model_loaded` / `qwen_emo`)。 */
  health?: { status?: string; modelLoaded?: boolean; qwenEmo?: boolean }
  /** `GET /speakers`:**LoRA 适配器名**(恒含 `default`)。`undefined` = 这个端点没答上来。 */
  speakers?: string[]
  /** `GET /voices`:音色库里的文件名。`undefined` = 这个端点没答上来。 */
  voices?: string[]
  /** 音色库目录(服务端给的绝对路径)—— "把参考音频丢进这里"。 */
  voiceDir?: string
  /** 逐个端点的实情(没答上来的原因原话;人照着它决定下一步)。 */
  problems: string[]
  /** 实际请求过的端点(排障用;不含密钥)。 */
  endpoints: string[]
}

/**
 * 读音色库(`/health` + `/speakers` + `/voices`)—— **走注入的出网端口**。
 *
 * 三条来自实测的硬事实(调研 §2.4)决定了它的形状:
 *  1. `/speakers` 是 **LoRA 名清单**、**不是音色清单**(本机 `runs/` 空 ⇒ 恒只有 `default`)
 *     —— 所以它只作参考,不做"可选音色"渲染;
 *  2. `/voices` 才是**音色**(参考样本文件名),`dir` 告诉你该把文件丢哪;
 *  3. `/health` **不加载模型就立即返回**,所以拿它探活是安全的。
 *
 * 认领一个前提:**没有上传接口**(调研 §7.4)—— `voices/` 只能丢文件。所以这个读法的用处是
 * "告诉你库在哪、里面有什么",不是"帮你把文件放进去"。
 */
export async function readVoiceLibrary(
  http: VoiceLibraryHttp,
  input: { baseUrl: string; apiKey?: string },
): Promise<VoiceLibraryReading> {
  const base = normalizeAudioBaseUrl(input.baseUrl)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.apiKey !== undefined && input.apiKey !== '') headers.authorization = `Bearer ${input.apiKey}`

  const problems: string[] = []
  const endpoints: string[] = []
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    const url = `${base}${path}`
    endpoints.push(url)
    let response: { status: number; text: string }
    try {
      // GET 不带 body:生产那份出网口按方法决定带不带(无脑 `body: ''` 会让 GET 整个失败)。
      response = await http.send({ method: 'GET', url, headers, body: '' })
    } catch (error) {
      problems.push(`${path} 发不出去(${error instanceof Error ? error.message : String(error)})—— 端点填对了吗?服务在跑吗?`)
      return null
    }
    if (response.status < 200 || response.status >= 300) {
      problems.push(`${path} 返回 ${response.status} —— ${summarize(response.text)}`)
      return null
    }
    try {
      const parsed = JSON.parse(response.text) as unknown
      return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      problems.push(`${path} 回的不是 JSON —— ${summarize(response.text)}`)
      return null
    }
  }

  const healthRaw = await get('/health')
  const reading: VoiceLibraryReading = { reachable: healthRaw !== null, problems, endpoints }
  if (healthRaw !== null) {
    reading.health = {
      ...(typeof healthRaw.status === 'string' ? { status: healthRaw.status } : {}),
      ...(typeof healthRaw.model_loaded === 'boolean' ? { modelLoaded: healthRaw.model_loaded } : {}),
      ...(typeof healthRaw.qwen_emo === 'boolean' ? { qwenEmo: healthRaw.qwen_emo } : {}),
    }
  }

  const speakersRaw = await get('/speakers')
  if (speakersRaw !== null) {
    const list = Array.isArray(speakersRaw.speakers) ? speakersRaw.speakers.filter((name): name is string => typeof name === 'string') : null
    if (list === null) problems.push('/speakers 的响应里没有 speakers 数组(不是这台服务的形状?)')
    else reading.speakers = list
  }

  const voicesRaw = await get('/voices')
  if (voicesRaw !== null) {
    const list = Array.isArray(voicesRaw.voices) ? voicesRaw.voices.filter((name): name is string => typeof name === 'string') : null
    if (list === null) problems.push('/voices 的响应里没有 voices 数组(不是这台服务的形状?)')
    else {
      reading.voices = list
      if (typeof voicesRaw.dir === 'string' && voicesRaw.dir !== '') reading.voiceDir = voicesRaw.dir
    }
  }

  return reading
}
