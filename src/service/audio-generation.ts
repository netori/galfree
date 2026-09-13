/**
 * 音频生成子系统(T27 / ADR-0012)—— 音乐与语音**各自一条渠道**,共用一套**任务**形状。
 *
 * 与图像子系统(ADR-0010 / `images.ts`)**同构但不共用渠道**:三条生成线各自一条渠道,
 * 因为它们的上游与协议不重叠(图像有事实标准,音乐与语音各家私有)。
 * 落到这一层就是:**音乐一条、语音一条**(音源与 TTS 的上游在现实里从来不是同一家)。
 * 共用的是**纪律与底层**:
 *  - 任务账本的状态机/历史/拒收注记 = `tasks.ts`(同一份代码);
 *  - 密钥只存本机设置,不进项目/快照/账本;
 *  - 上游不支持的参数**如实降级并说明**(ADR-0010 的同一条后果);
 *  - 产物一律经**写网关**落盘(ADR-0004)。
 *
 * **为什么端点可填**(ADR-0012 的硬边界):音乐与语音没有 OpenAI 兼容那样的公共协议,
 * 聚合站、自建反代、本地 TTS 服务各说各的。写死厂商域名 = 用户换个上游就得改插件版本。
 */

import {
  emptyTasksDocument,
  findTask,
  parseTasksDocument,
  TASK_SCHEMA,
  tasksDocument,
  upsertTask,
  type GenerationTaskBase,
  type TaskDocument,
  type TaskKind,
} from './tasks.ts'
import type { VoiceEmotion } from './characters.ts'
import type { GenerationTaskState } from './tasks.ts'

/** 上游协议适配器 id(按**协议**收,不按厂商收)。 */
export type AudioAdapterId =
  /** 同步返回:一次 POST 直接拿回音频(或它的 URL)。MiniMax `music_generation` 是这种。 */
  | 'sync-http'
  /** 异步任务:提交拿任务 id,轮询到终态再取音频。Suno 类聚合多为此(**id 走查询串**)。 */
  | 'async-task'
  /**
   * 异步任务(**资源式 REST**):同样"提交 → 拿 id → 轮询",但两处形状不同 ——
   * **id 放进路径**(`/music/tasks/{id}`),提交体是那家网关自己的字段名
   * (`model` + `version` / `custom` / `instrumental`)。
   *
   * 为什么不并进 `async-task`:那一条写的是 sunoapi.org 的整套形状(查询串 + `sunoData[].audio_url`)。
   * 混成一个适配器就得在里面分叉两套"长得像但处处不同"的东西 —— 而 ADR-0012 的原话是
   * "**适配器按协议收,不按厂商收**"。这个协议是 2026-09-13 的真机验收打出来的
   * (同一家网关的图像走 OpenAI 兼容,音乐却是这套;详见 `audio-adapter-music-rest.ts` 文件头)。
   */
  | 'async-task-rest'

/**
 * 用途:**音乐**还是**语音**。
 *
 * 它不只是任务上的一个标签 —— 每一条都有一份**自己的渠道**(ADR-0012:三条生成线各自一条)。
 * 所以"这条任务该用哪个端点、哪把密钥、哪份模型目录"都由它决定。
 */
export type AudioPurpose = 'music' | 'voice'

/**
 * **模型能力声明**(与图像的 `ImageModelCapabilities` 同一态度):
 * 上游支不支持某件事由人配在目录里,代码不猜 —— 猜错就会静默发出上游看不懂的请求。
 */
export interface AudioModelCapabilities {
  /** 文生音乐(给风格提示词出曲子)。 */
  textToMusic: boolean
  /** **纯音乐**(不给歌词也能出;发起人明确说"大部分音乐只需要纯音乐")。 */
  instrumental: boolean
  /** 能收歌词(需要带唱的话)。 */
  lyrics: boolean
  /** 能收**参考音频**(改风格/翻唱一类)。 */
  audioReference: boolean
  /** 语音合成(TTS)。 */
  textToSpeech: boolean
  /** 能用**参考样本**做零样本音色克隆(与图像参考链同一种"一致性锚")。 */
  voiceCloning: boolean
  /** 能指定**音色 id**(设计好的音色)。 */
  voiceId: boolean
  /** 返回的是音频 **URL**(异步任务制常见;URL 往往有有效期,要立刻下)。 */
  urlResult?: boolean
}

export interface AudioModelPaths {
  /** 支持的输出格式(如 ogg / mp3 / wav);空的 = 不限。 */
  formats?: string[]
  /** 支持的采样率;空的 = 不限。 */
  sampleRates?: number[]
}

/** 渠道里的一条模型(目录条目)。 */
export interface AudioModelDescriptor {
  id: string
  label?: string
  note?: string
  /** 协议(POST 路径与"同步还是异步"的差异走这里)。 */
  adapter: AudioAdapterId
  /**
   * 这条模型干什么用的:**音乐 / 语音**。
   *
   * 渠道已经按用途分开了(音乐渠道里只有音乐模型),所以这里主要是一道**一致性检查**:
   * 拼渠道时会按它过滤(`audioChannelFromSettings`),于是"把 TTS 模型递给了音乐上游"
   * 这件事在配置阶段就不可能发生。
   */
  purpose: AudioPurpose
  capabilities: AudioModelCapabilities
  paths?: AudioModelPaths
}

/** 渠道设置(与图像渠道同形:端点 + 密钥 + 模型目录)。**音乐一条、语音一条。** */
export interface AudioChannelSettings {
  name?: string
  baseUrl: string
  apiKey?: string
  models: AudioModelDescriptor[]
}

/**
 * 音频子系统的**注入端口**(T27):出网 + 渠道读取。
 *
 * 与图像同一态度:**`null` = 那条渠道没配** → 生成动作如实拒绝
 * (`no-music-channel` / `no-voice-channel`),绝不假装能生成。
 * 出网走注入的端口,所以快带能用假上游验完整回路,生产换真 fetch 不改形状。
 *
 * **出网是共用的、渠道是两条**:音乐与语音的协议不同(轮询 vs 同步),但"发一个 HTTP 请求"
 * 这件事没有两条(下载那条同理)。分成两份反而会让"下载接口只装配了一半"变成可能。
 */
export interface AudioPorts {
  /** 出网(生产 fetch / 快带假上游)。形状与图像的 `HttpRequest` 同构,但**各走各的渠道**。 */
  http: {
    send: (request: { url: string; method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }>
    /**
     * **下载产物字节**(T29 / #37)。
     *
     * 为什么单开一条:好几家音乐上游是"先给一个**音频 URL**,过一阵子还不知道什么时候过期"
     * (Suno 类就是),而"把 URL 变成字节"这件事**文本口做不到**。
     * 不提供它就等于"这类上游永远拿不到产物" —— 那是能力缺口,不是风格问题。
     */
    download?: (url: string) => Promise<{ status: number; bytes: Uint8Array; contentType: string }>
  }
  /**
   * 取**某一条**渠道的设置;`null` = 那条还没配。每次现读(设置可能刚被改)。
   *
   * 带 `purpose` 而不是给两个字段,是为了让"这条任务该走哪条渠道"**只有一处判断**:
   * 服务那边是 `channel(task.purpose)`,装配那边是 `(purpose) => audioChannelFromSettings(current(), purpose)`。
   */
  channel: (purpose: AudioPurpose) => AudioChannelSettings | null
}

/** 只要声明了能干这件事的模型(与 `imageModels` 同口径)。 */
export function audioModels(channel: AudioChannelSettings, purpose?: AudioPurpose): AudioModelDescriptor[] {
  const usable = channel.models.filter((model) => purpose === undefined || model.purpose === purpose)
  return usable
}

/** 一个用途的四个计数(面板两张卡各读自己那一份)。 */
export interface AudioTaskCounts {
  queued: number
  running: number
  awaitingReview: number
  failed: number
}

/**
 * 任务 → **按用途分开**的四个计数。
 *
 * 存在的理由:同一个数在三处要用 —— 面板卡上的"排队 N 条"、agent 建任务后报的成本、
 * 以及跑队列前那句"这一跑真发几条"。三处各写一遍迟早分叉,而分叉的后果是
 * **面板上说的条数不是真会发出去的条数**(那正是 T27 踩过的那个坑:替另一条渠道花了钱)。
 * 所以这里是唯一实现,面板与工具都调它。
 */
export function countAudioTasks(
  tasks: ReadonlyArray<{ purpose: AudioPurpose; state: GenerationTaskState }>,
): Record<AudioPurpose, AudioTaskCounts> {
  const counts: Record<AudioPurpose, AudioTaskCounts> = {
    music: { queued: 0, running: 0, awaitingReview: 0, failed: 0 },
    voice: { queued: 0, running: 0, awaitingReview: 0, failed: 0 },
  }
  for (const task of tasks) {
    const bucket = counts[task.purpose]
    if (task.state === 'queued') bucket.queued += 1
    else if (task.state === 'running') bucket.running += 1
    else if (task.state === 'awaiting-review') bucket.awaitingReview += 1
    else bucket.failed += 1
  }
  return counts
}

// ─── 任务(与图像任务同底层,字段按音频的用途)──────────────────────

/** 音频任务的产物类型 discriminator。 */
export type AudioTaskKind = AudioPurpose

export interface AudioTask extends GenerationTaskBase {
  kind: AudioTaskKind
  /** 用途:音乐(BGM/SE)还是语音(对白配音)。**它决定这条任务走哪条渠道。** */
  purpose: AudioPurpose
  /**
   * 语音任务的**对话 id**(ADR-0013 的那根锚 = 文件名)。
   * 音乐任务为 null(它没有"哪一句"这回事)。
   */
  dialogueId: string | null
  /** 输出格式(模型不支持的会被降级并说明)。 */
  format?: string
  /** 采样率(同上)。 */
  sampleRate?: number
  /** 循环(BGM 常见;它只是**建议**,真循环由 `.rpy` 的 `loop` 决定)。 */
  loop?: boolean
  /** 参考音频(改风格 / 音色克隆;模型不支持会被降级并说明)。 */
  referenceAudio: Array<{ path: string; note?: string }>
  /**
   * 音色档案 id(语音任务;来自登记簿)。
   *
   * **它不再是服务端的 `speaker`**(T32 修掉的那处语义错位):`speaker` 在 IndexTTS 那边
   * 是 **LoRA 适配器名**,而这里是"**哪把嗓子**"(登记簿里的那个角色)。
   * 拿它去当 `speaker` 发,只会得到一个必然 400 的值(本机 `runs/` 是空的)。
   */
  voiceId?: string
  /**
   * **参考样本**(T32):服务端**音色库里的文件名**(如 `xiao_tang.wav`)—— 音色的真正来源。
   *
   * 与 `referenceAudio`(**项目内相对路径**)是两个命名空间,刻意分开:
   * 服务端只在它自己的 `voices/` 目录里按名解析,一个项目路径送过去**必然**被拒。
   */
  voiceSample?: string
  /** LoRA 适配器名(缺省 `default`)。**它不是音色**。 */
  voiceSpeaker?: string
  /** 语言(缺省由适配器给)。 */
  voiceLang?: string
  /** 情感输入(缺省 = 不给,用服务端自己的缺省)。 */
  voiceEmotion?: VoiceEmotion
  /**
   * **上游那一次的 id**(异步任务制;T34)。纯制作信息 —— 但它救得了"产物还在上游"那种局面:
   * 轮询到了终态却认不出产物地址(或下载失败)时,那个 id 就是**唯一的补救线索**
   * (那家网关的文档写着"任务完成后 48 小时内可取")。失败原因里也会带上它。
   */
  upstreamTaskId?: string
}

/** 音频任务账本(落 `.studio/audio-tasks.json`;只放制作信息,不复制叙述内容)。 */
export type AudioTaskDocument = TaskDocument<AudioTask>

export const AUDIO_TASKS_FILE = '.studio/audio-tasks.json'
export const AUDIO_TASKS_SCHEMA = TASK_SCHEMA

const AUDIO_TASK_KIND: TaskKind<AudioTask> = {
  file: AUDIO_TASKS_FILE,
  label: '音频生成任务',
  normalize: (raw) => ({
    schemaVersion: TASK_SCHEMA,
    // 老账本(理论上不会有,但纪律与图像一致):缺字段一律在这里归一,不逼人改历史文件。
    tasks: (raw.tasks ?? []).map((task) => ({
      ...task,
      rejections: task.rejections ?? [],
      referenceAudio: task.referenceAudio ?? [],
      dialogueId: task.dialogueId ?? null,
    })),
  }),
}

/** 账本工厂要的那点差异(接缝装配时用;`file` / `label` / 形状归一都在这里)。 */
export const AUDIO_TASK_KIND_DESCRIPTOR: TaskKind<AudioTask> = AUDIO_TASK_KIND

export function emptyAudioTasksDocument(): AudioTaskDocument {
  return emptyTasksDocument<AudioTask>()
}

export function parseAudioTasksDocument(text: string): AudioTaskDocument {
  return parseTasksDocument(AUDIO_TASK_KIND, text)
}

export function audioTasksDocument(document: AudioTaskDocument): string {
  return tasksDocument(document)
}

export function findAudioTask(document: AudioTaskDocument, id: string): AudioTask | undefined {
  return findTask(document, id)
}

export function upsertAudioTask(document: AudioTaskDocument, task: AudioTask): AudioTaskDocument {
  return upsertTask(document, task)
}

/** 新建音频任务的输入。 */
export interface CreateAudioTaskInput {
  /** 产物目标路径(项目内相对路径,如 `game/audio/bgm/rain.ogg`)。 */
  outputPath: string
  /** 模型 id(必须在当前渠道的目录里)。 */
  model: string
  /** 制作指令(风格/情绪/场景;音乐是提示词,语音是"用什么语气读")。 */
  prompt: string
  /** 用途;缺省按目标路径推(`voice/` 下 = 语音,其余 = 音乐)。 */
  purpose?: AudioPurpose
  /** 语音任务的对话 id(ADR-0013)。 */
  dialogueId?: string
  format?: string
  sampleRate?: number
  loop?: boolean
  referenceAudio?: Array<{ path: string; note?: string }>
  /** 音色档案 id(登记簿 id;缺省 = 按 `dialogueId` 派生的说话人反查)。 */
  voiceId?: string
  /** 参考样本(**服务端音色库里的文件名**;缺省 = 取该角色音色档案里的那一段)。 */
  voiceSample?: string
  voiceSpeaker?: string
  voiceLang?: string
  voiceEmotion?: VoiceEmotion
  /** 建完立刻跑。 */
  run?: boolean
}

/** 路径归一化(`\` → `/`)**唯一一处**:别处的形状判断与落盘都调它,不各自 replace 一遍。 */
export function normalizeAudioOutputPath(outputPath: string): string {
  return outputPath.replace(/\\/g, '/')
}

/**
 * 目标路径 → 用途的**唯一口径**。
 *
 * 为什么按路径推:`game/voice/` 是 ADR-0013 定下的语音目录(`config.auto_voice = "voice/{id}.ogg"`),
 * 而"这句话是对白配音还是 BGM"在路径上就已经说清了。让调用方每次显式声明反而容易漏
 * —— 而"漏了就按错的渠道发"的代价是**真金**(两条渠道的端点与目录都不通用)。
 *
 * 所以 T33 起:**用途只由这里判**;调用方若显式给了不一致的 `purpose`,接缝当场拒
 * (见 `createAudioTask`),不让两条判断并存。
 */
export function purposeOfPath(outputPath: string): AudioPurpose {
  return /(^|\/)voice\//.test(normalizeAudioOutputPath(outputPath)) ? 'voice' : 'music'
}

/**
 * 音频目标路径的**形状检查**。
 *
 * 两条硬要求(都来自引擎的读法):
 *  - 必须落在 `game/` 下(引擎的 searchpath 只有 `game/`)—— 否则 `play`/`auto_voice` 找不到;
 *  - 必须是相对路径(绝对路径会被静默回退,T17 的实测教训)。
 */
export function assertAudioOutputPath(outputPath: string): void {
  const normalized = normalizeAudioOutputPath(outputPath)
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    throw new Error(`音频产物要用**项目内相对路径**(给的是绝对路径:${outputPath})—— 引擎的 searchpath 只有 game/`)
  }
  if (!normalized.startsWith('game/')) {
    throw new Error(`音频产物要落在 game/ 下(给的是 ${outputPath})—— 引擎的 searchpath 只有 game/,别处放它找不到`)
  }
}

// ─── 适配器(按协议收,不按厂商收)────────────────────────────────────
//
// 与图像那条同一形状(`ImageAdapter`):**适配器只把"任务参数"翻译成"一次 HTTP 调用"
// 再翻译回来**,不碰磁盘、不碰网络 —— 出网由接缝经注入的端口做。
// 这样快带能用假上游验完整回路,生产换真适配器不改形状。

/** 适配器要发的那一个 HTTP 请求(与图像的 `HttpRequest` 同形)。 */
export interface AudioHttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface AudioRequestPlan {
  request: AudioHttpRequest
  /** 这次调用用的适配器(进任务历史的诊断信息)。 */
  adapter: AudioAdapterId
}

/** 一次提交的结果:要么直接拿到字节(base64 解码后),要么拿到一个要轮询的任务。 */
export type AudioSubmission =
  | { kind: 'bytes'; bytes: Uint8Array; contentType?: string }
  | { kind: 'pending'; taskId: string }
  /** 上游明说不行(原话带回,不吞成"失败了")。 */
  | { kind: 'failed'; error: string }

/** 轮询一步的结果。 */
export type AudioPollStep =
  | { kind: 'running'; note: string }
  | { kind: 'done'; url?: string; bytes?: Uint8Array; contentType?: string }
  | { kind: 'failed'; error: string }

/**
 * **做任务要带上的东西**(适配器的输入)。刻意与图像那份对称:
 * 渠道(端点/密钥)、模型(目录条目,含能力声明)、以及任务自己的参数。
 */
export interface AudioAdapterInput {
  channel: AudioChannelSettings
  model: AudioModelDescriptor
  task: {
    purpose: AudioPurpose
    prompt: string
    /** 语音任务:要读的文本就是 prompt;这条给"用什么语气"。 */
    format?: string
    sampleRate?: number
    loop?: boolean
    dialogueId: string | null
    voiceId?: string
    /** 参考样本(服务端**音色库**里的文件名,不是项目内路径)。 */
    voiceSample?: string
    voiceSpeaker?: string
    voiceLang?: string
    voiceEmotion?: VoiceEmotion
    referenceAudio: Array<{ path: string; note?: string }>
  }
}

export interface AudioAdapter {
  id: AudioAdapterId
  /** 把任务翻译成一次 HTTP 调用(纯函数:不发请求)。 */
  buildRequest: (input: AudioAdapterInput) => AudioRequestPlan
  /**
   * 提交之后的解释:字节 / 任务 id / 上游拒绝。
   *
   * **可以是异步的**:有的上游把产物放在**服务端路径**上(IndexTTS 就是),
   * 这时适配器要读那个文件才拿得到字节。异步在这里是必要的,不是顺手加的。
   */
  onSubmit: (response: { status: number; text: string }, model: AudioModelDescriptor) => AudioSubmission | Promise<AudioSubmission>
  /** 异步制:轮询一步。 */
  poll?: (response: { status: number; text: string }, taskId: string) => AudioPollStep
  /** 异步制:据此拼下一次轮询的请求。 */
  buildPollRequest?: (input: AudioAdapterInput, taskId: string) => AudioHttpRequest
}

/**
 * 适配器注册表(**此刻是空的**,如实:适配器是 T28/T29 的活)。
 *
 * `adapterFor` 找不到就抛 —— 于是"跑一个任务"会如实记一条失败,
 * 说清"还没接上这个协议",而不是假装成功(也不静默什么都不做)。
 */
const ADAPTERS = new Map<AudioAdapterId, AudioAdapter>()

/** 注册一个适配器(T28/T29 用;同 id 覆盖 = 测试夹具可以换掉真实现)。 */
export function registerAudioAdapter(adapter: AudioAdapter): void {
  ADAPTERS.set(adapter.id, adapter)
}

/** 取一个适配器;没有就抛(带上"还没实现"的事实,不吞)。 */
export function adapterFor(id: AudioAdapterId): AudioAdapter {
  const adapter = ADAPTERS.get(id)
  if (adapter === undefined) {
    throw new Error(`音频协议「${id}」的适配器还没实现(见 #36 音乐 / #37 TTS)—— 这个任务不会假装成功`)
  }
  return adapter
}

/** 已注册的适配器(诊断/面板用)。 */
export function registeredAudioAdapters(): AudioAdapterId[] {
  return [...ADAPTERS.keys()]
}

/**
 * 清空适配器注册表(**给测试用**;也用于诊断"是不是一个适配器都没注册")。
 *
 * 为什么要有它:注册表是模块级的,夹具注册的假适配器不摘掉就会污染别的用例 ——
 * 而"没有适配器"正是本票要如实拒绝的那种状态,得有办法真的造出来。
 */
export function clearAudioAdapters(): void {
  ADAPTERS.clear()
}

/** 内容类型 → 后缀(下载回来的音频要知道自己是什么格式)。 */
export function audioFormatOf(contentType: string | undefined, url: string): string {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('ogg') || type.includes('opus')) return 'ogg'
  if (type.includes('wav') || type.includes('wave')) return 'wav'
  if (type.includes('flac')) return 'flac'
  if (type.includes('m4a') || type.includes('mp4')) return 'm4a'
  const fromUrl = /\.([A-Za-z0-9]{2,5})(?:\?|$)/.exec(url)?.[1]
  return fromUrl === undefined ? 'ogg' : fromUrl.toLowerCase()
}

/** 认得的音频容器(**后缀就是 Ren'Py 选解码器的依据**)。 */
export const AUDIO_CONTAINER_FORMATS = ['mp3', 'ogg', 'wav', 'flac', 'm4a'] as const

/**
 * **字节的真实格式**(看魔数,不看扩展名;内容类型只在魔数认不出时兜底)。
 *
 * 为什么必须有它(2026-09-13 真机踩到):上游给的是 **mp3**,而我们按调用方给的目标路径
 * 落成了 `.ogg` —— Ren'Py **按扩展名选解码器**,那个文件在游戏里就是读不出来
 * ("看着生成了、玩的时候没声音"的又一变体)。而很多上游的 content-type 是
 * `application/octet-stream`,所以**魔数才是判据**;认不出来返回 `null`
 * (由调用方决定:如实说明,而不是猜一个后缀写下去)。
 */
export function audioFormatOfBytes(bytes: Uint8Array, contentType?: string): string | null {
  const magic = (offset: number, text: string): boolean =>
    bytes.byteLength >= offset + text.length
    && text.split('').every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (magic(0, 'ID3')) return 'mp3'
  // 无 ID3 的裸 mp3:帧同步字 `FF Ex/Fx`。
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'mp3'
  if (magic(0, 'OggS')) return 'ogg'
  if (magic(0, 'RIFF')) return 'wav'
  if (magic(0, 'fLaC')) return 'flac'
  if (magic(4, 'ftyp')) return 'm4a'
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('ogg') || type.includes('opus')) return 'ogg'
  if (type.includes('wav') || type.includes('wave')) return 'wav'
  if (type.includes('flac')) return 'flac'
  if (type.includes('m4a') || type.includes('mp4')) return 'm4a'
  return null
}

/** 路径的后缀(小写;没有后缀返回空串)。 */
export function audioExtensionOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 把路径的后缀换成给定格式(其余部分一字不动)。 */
export function withAudioExtension(path: string, format: string): string {
  return `${path.replace(/\.[A-Za-z0-9]+$/, '')}.${format}`
}

/**
 * 响应体 → 音频字节。
 *
 * 两种上游都给:有的直接回 **base64**(MiniMax `music_generation` 的 `hex`/base64 一族),
 * 有的回一个**可下载的 URL**(那种走 `#awaitAudioResult` 的下载分支)。
 * **认不出来就抛**:宁可让人看到"这个响应我不认识",也不要写一个空文件进项目 ——
 * 后者会在板上显示成"已填",而播放时是静音(这正是 T17 那条"悬空引用"要防的形状)。
 */
export function decodeBase64OrRaw(text: string): Uint8Array {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('上游返回了空响应:没有音频字节可写')
  // 纯文本响应(不是 base64):直接当 UTF-8 字节(测试夹具与"上游其实回了个错误页"都走这里)。
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed) || trimmed.length % 4 !== 0) {
    return new TextEncoder().encode(trimmed)
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.byteLength === 0) throw new Error('base64 解出来是空的:没有音频字节可写')
  return new Uint8Array(decoded)
}

/** 异步制的轮询上限(有界:等不到就如实说"没等到",不算成功)。 */
export const AUDIO_POLL_TIMEOUT_MS = 5 * 60 * 1000
/** 轮询间隔。 */
export const AUDIO_POLL_INTERVAL_MS = 2_000
