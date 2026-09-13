/**
 * 音频生成子系统(T27 / ADR-0012)—— 音乐与语音共用的**渠道 + 任务**形状。
 *
 * 与图像子系统(ADR-0010 / `images.ts`)**同构但不共用渠道**:三条生成线各自一条渠道,
 * 因为它们的上游与协议不重叠(图像有事实标准,音乐与语音各家私有)。
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

/** 上游协议适配器 id(按**协议**收,不按厂商收)。 */
export type AudioAdapterId =
  /** 同步返回:一次 POST 直接拿回音频(或它的 URL)。MiniMax `music_generation` 是这种。 */
  | 'sync-http'
  /** 异步任务:提交拿任务 id,轮询到终态再取音频。Suno 类聚合多为此。 */
  | 'async-task'

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
  /** 这个模型干什么用的:**音乐 / 语音**(同一条渠道里可以都有)。 */
  purpose: 'music' | 'voice'
  capabilities: AudioModelCapabilities
  paths?: AudioModelPaths
}

/** 渠道设置(与图像渠道同形:端点 + 密钥 + 模型目录)。 */
export interface AudioChannelSettings {
  name?: string
  baseUrl: string
  apiKey?: string
  models: AudioModelDescriptor[]
}

/**
 * 音频子系统的**注入端口**(T27):出网 + 渠道读取。
 *
 * 与图像同一态度:**`null` = 没配渠道** → 生成动作如实拒绝(`no-audio-channel`),
 * 绝不假装能生成。出网走注入的端口,所以快带能用假上游验完整回路,生产换真 fetch 不改形状。
 */
export interface AudioPorts {
  /** 出网(生产 fetch / 快带假上游)。形状与图像的 `HttpRequest` 同构,但**各走各的渠道**。 */
  http: { send: (request: { url: string; method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text: string }> }
  /** 当前渠道设置;`null` = 还没配。每次现读(设置可能刚被改)。 */
  channel: () => AudioChannelSettings | null
}

/** 只要声明了能干这件事的模型(与 `imageModels` 同口径)。 */
export function audioModels(channel: AudioChannelSettings, purpose?: 'music' | 'voice'): AudioModelDescriptor[] {
  const usable = channel.models.filter((model) => purpose === undefined || model.purpose === purpose)
  return usable
}

// ─── 任务(与图像任务同底层,字段按音频的用途)──────────────────────

/** 音频任务的产物类型 discriminator。 */
export type AudioTaskKind = 'music' | 'voice'

export interface AudioTask extends GenerationTaskBase {
  kind: AudioTaskKind
  /** 用途:音乐(BGM/SE)还是语音(对白配音)。 */
  purpose: 'music' | 'voice'
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
  /** 音色档案 id(语音任务;来自登记簿)。 */
  voiceId?: string
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
  purpose?: 'music' | 'voice'
  /** 语音任务的对话 id(ADR-0013)。 */
  dialogueId?: string
  format?: string
  sampleRate?: number
  loop?: boolean
  referenceAudio?: Array<{ path: string; note?: string }>
  voiceId?: string
  /** 建完立刻跑。 */
  run?: boolean
}

/**
 * 目标路径 → 用途的**唯一口径**。
 *
 * 为什么按路径推:`game/voice/` 是 ADR-0013 定下的语音目录(`config.auto_voice = "voice/{id}.ogg"`),
 * 而"这句话是对白配音还是 BGM"在路径上就已经说清了。让调用方每次显式声明反而容易漏。
 */
export function purposeOfPath(outputPath: string): 'music' | 'voice' {
  return /(^|\/)voice\//.test(outputPath.replace(/\\/g, '/')) ? 'voice' : 'music'
}

/**
 * 音频目标路径的**形状检查**。
 *
 * 两条硬要求(都来自引擎的读法):
 *  - 必须落在 `game/` 下(引擎的 searchpath 只有 `game/`)—— 否则 `play`/`auto_voice` 找不到;
 *  - 必须是相对路径(绝对路径会被静默回退,T17 的实测教训)。
 */
export function assertAudioOutputPath(outputPath: string): void {
  const normalized = outputPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    throw new Error(`音频产物要用**项目内相对路径**(给的是绝对路径:${outputPath})—— 引擎的 searchpath 只有 game/`)
  }
  if (!normalized.startsWith('game/')) {
    throw new Error(`音频产物要落在 game/ 下(给的是 ${outputPath})—— 引擎的 searchpath 只有 game/,别处放它找不到`)
  }
}
