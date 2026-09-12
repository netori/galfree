/**
 * 图像子系统(Host 直连,ADR-0010)—— 渠道、任务、适配与降级。
 *
 * 这里的每一样东西都刻意**不碰磁盘也不碰网络**:适配器只把"任务参数"翻译成
 * "一次 HTTP 调用"再翻译回来,落盘由接缝经写网关做(ADR-0004),执队列由
 * `ProjectService` 编排。这样:
 *
 *  - 快带能用**假 HTTP 上游**验完整回路(票面 AC 明写),生产换真适配器不改形状;
 *  - 上游能力的参差(支不支持参考链/图生图/尺寸参数)**声明在模型目录里**,
 *    而不是靠运行时猜 —— 猜错就会静默地发出上游看不懂的请求;
 *  - "降级"是**任务上的一条事实**(`degradation`),人和 agent 都读得到,
 *    绝不静默丢参数(ADR-0010 Consequences 最后一条)。
 *
 * 密钥:明文存在本机**插件设置**里(与 dsh-imagegen 同风险面,知情选择),
 * 但它**不进项目**、不进任务账本 —— 账本里只留渠道名与模型 id。
 */

// ─── 渠道与模型目录 ────────────────────────────────────────────────────

/** 上游协议适配器 id。v1 只做 OpenAI 兼容;别的协议按需再加,不改这里。 */
export type ImageAdapterId = 'openai-compatible'

/**
 * **模型能力声明**。这是"协议不合要如实降级"的唯一依据:
 * 上游支不支持某件事,由人配在目录里,代码不猜。
 */
export interface ImageModelCapabilities {
  /** 文生图(/images/generations)。 */
  textToImage: boolean
  /** 图生图(/images/edits,能收单张参考图)。 */
  imageToImage: boolean
  /** 能收**参考图链**(多张、跨批次保持同一张脸的关键)。 */
  referenceChain: boolean
  /** 尺寸/宽高比参数有效(有些端点只认固定档位)。 */
  aspectRatioParam: boolean
  /** 能用返回的 b64_json(否则只能用 url 拉回来)。 */
  b64Json: boolean
}

export interface ImageModelDescriptor {
  /** 传给上游的模型名。 */
  id: string
  /** 面板显示名。 */
  label?: string
  adapter: ImageAdapterId
  capabilities: ImageModelCapabilities
  /** 这个模型可用的尺寸档(空 = 不限制,透传)。 */
  sizes?: string[]
  /** 备注(给人看的,比如"不支持参考图,差分靠 prompt")。 */
  note?: string
}

/**
 * 渠道设置(= 一个上游端点 + 它自己的模型目录)。
 * **密钥明文**存本机设置文档,这一点在文档里写明,不含糊。
 */
export interface ImageChannelSettings {
  /** OpenAI 兼容基址,如 `https://api.example.com/v1`(末尾斜杠可有可无)。 */
  baseUrl: string
  /** 密钥明文(本机设置文档)。 */
  apiKey?: string
  /** 这个渠道可用的模型目录。 */
  models: ImageModelDescriptor[]
  /** 渠道名(只为在账本/面板里指认,不含密钥)。 */
  name?: string
}

/** 模型目录里找得到、且声明了文生图的那些模型(聊天/嵌入模型不进这个列表)。 */
export function imageModels(channel: ImageChannelSettings): ImageModelDescriptor[] {
  return channel.models.filter((model) => model.capabilities.textToImage)
}

// ─── 任务模型(一级对象:全结构化)────────────────────────────────────

export type GenerationTaskState = 'queued' | 'running' | 'awaiting-review' | 'failed'

export type ImageSize = string

/** 一次尝试的历史条目(重试历史就是这一串,只追加)。 */
export interface GenerationAttempt {
  n: number
  startedAt: string
  finishedAt: string
  outcome: 'ok' | 'failed'
  /** 失败的**原因原文**(状态码 + 上游说的那句话),不吞。 */
  error?: string
  /** 成功时的产物指纹(内容哈希),与板上槽位的指纹同口径。 */
  fingerprint?: string
  /** 成功时的字节数。 */
  bytes?: number
  /**
   * **被这一次覆盖掉的那一版的指纹**(T15:重 roll 保留上一产物为历史)。
   *
   * 文件必然被覆盖(槽位的约定路径只有一个),但覆盖前的快照里有它的内容 ——
   * 有了这个指纹,人就能从快照历史里精确找回"上一张是哪个版本",对比才有依据。
   * 首次生成时缺省(没有上一版)。
   */
  replacedFingerprint?: string
}

/**
 * 降级说明:**给出去的参数为什么与要求的不一样**。
 * 有它 = 请求被改了;没有 = 请求原样发出。不存在"改了但不说"的第三种。
 */
export interface GenerationDegradation {
  code: 'reference-chain-unsupported' | 'image-to-image-unsupported' | 'size-unsupported' | 'b64-unsupported'
  /** 面向人的一句话(中文;面板与 agent 直接显示)。 */
  message: string
  /** 被丢掉的参考图(给人确认"到底丢了什么")。 */
  droppedReferenceImages: Array<{ path: string; note?: string }>
  /** 其余被改动的参数说明。 */
  notes: string[]
}

export interface GenerationTask {
  schemaVersion: 1
  id: string
  /** 目标槽(槽名,与 `.rpy` 图像引用派生的槽 id 同一口径)。 */
  slot: string
  /** 产物目标路径(相对项目根;**一律**是槽位的约定路径)。 */
  outputPath: string
  state: GenerationTaskState
  /** 渠道名 + 模型 id(账本里**不记密钥**)。 */
  channel?: string
  model: string
  prompt: string
  /** 登记簿上下文:这个槽要求哪些角色出场(引用登记簿 id,不复制设定)。 */
  requiresCharacters: string[]
  /** 画风锚(来自槽账本或角色登记簿)。 */
  artStyleAnchor?: string
  size?: ImageSize
  quality?: string
  /** 参考图链(登记簿的引用)。 */
  referenceImages: Array<{ path: string; note?: string }>
  /** 被降级掉的事实(缺省 = 没降级)。 */
  degradation?: GenerationDegradation
  attempts: GenerationAttempt[]
  createdAt: string
  updatedAt: string
  /** 失败时的最后原因(与 attempts 末条一致,方便一眼看)。 */
  lastError?: string
}

/** 任务账本(落 `.studio/image-tasks.json`;只放制作信息,不复制叙述内容)。 */
export interface GenerationTaskDocument {
  schemaVersion: 1
  tasks: GenerationTask[]
}

export const IMAGE_TASKS_FILE = '.studio/image-tasks.json'
export const IMAGE_TASKS_SCHEMA = 1

/** 新建任务的输入。 */
export interface CreateGenerationTaskInput {
  /** 目标槽(必须在 `.rpy` 里被引用,推导板上的槽清单里有它)。 */
  slot: string
  /** 模型 id(必须在当前渠道的目录里)。 */
  model: string
  /** 提示词(制作指令;**不是**叙述内容)。 */
  prompt: string
  /** 尺寸/宽高比(模型不支持会被降级并说明)。 */
  size?: ImageSize
  quality?: string
  /** 参考图链(模型不支持会被降级并说明)。 */
  referenceImages?: Array<{ path: string; note?: string }>
  /** 登记簿上下文:要求出场的角色 id。 */
  requiresCharacters?: string[]
  artStyleAnchor?: string
  /** 建完立刻跑(缺省 false:入队,由 `runGenerationQueue` 推进)。 */
  run?: boolean
}

// ─── HTTP 端口(可注入:快带假上游 / 生产真 fetch)────────────────────

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  /** JSON 请求体(图像接口是 JSON;不涉及 multipart,故不走字节流)。 */
  body?: unknown
}

export interface HttpResponse {
  status: number
  /** 响应原文(解析交给调用方,便于把上游原话带进失败原因)。 */
  text: string
}

/**
 * **出网端口**。生产 = 真 fetch;快带 = 打到本地假上游的真 HTTP 实现。
 * 两者是同一个端口的两个实现 —— 协议形状不因测试而变。
 */
export interface ImageHttpClient {
  send: (request: HttpRequest) => Promise<HttpResponse>
}

/** 生产实现:node 原生 fetch;非 2xx 也**照常返回**(错误正文要留给人看)。 */
export function createNodeHttpClient(): ImageHttpClient {
  return {
    send: async (request) => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
      return { status: response.status, text: await response.text() }
    },
  }
}

// ─── 适配器:任务参数 ⇄ 一次 HTTP 调用 ───────────────────────────────

export interface ImageRequestPlan {
  request: HttpRequest
  /** 这次调用用的适配器(进任务历史的诊断信息)。 */
  adapter: ImageAdapterId
}

export interface ImageAdapter {
  id: ImageAdapterId
  buildRequest: (input: {
    channel: ImageChannelSettings
    model: ImageModelDescriptor
    prompt: string
    size?: ImageSize
    quality?: string
    /** 非空 = 走图生图端点(上游支持时才有值)。 */
    referenceImages: Array<{ path: string }>
  }) => ImageRequestPlan
  /** 从响应里取出图片字节;取不到就抛(错误信息带上游原话)。 */
  parseResponse: (response: HttpResponse, model: ImageModelDescriptor) => Uint8Array
}

const openAiCompatible: ImageAdapter = {
  id: 'openai-compatible',

  buildRequest: ({ channel, model, prompt, size, quality, referenceImages }) => {
    const base = channel.baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (channel.apiKey !== undefined && channel.apiKey !== '') headers.authorization = `Bearer ${channel.apiKey}`

    const body: Record<string, unknown> = { model: model.id, prompt, n: 1 }
    // 尺寸只在模型声明"认这个参数"时才发 —— 否则宁可不发,也不发一个会被忽略的值。
    if (size !== undefined && model.capabilities.aspectRatioParam) body.size = size
    if (quality !== undefined) body.quality = quality
    // 参考图链:模型支持时挂在 image 字段上(OpenAI 兼容的图生图口径)。
    if (referenceImages.length > 0 && model.capabilities.imageToImage) {
      body.image = referenceImages.map((reference) => ({ image_url: reference.path }))
    }
    return { request: { method: 'POST', url: `${base}/images/generations`, headers, body }, adapter: 'openai-compatible' }
  },

  parseResponse: (response, model) => {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`上游返回 ${response.status}:${summarize(response.text)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.text)
    } catch {
      throw new Error(`上游返回的不是 JSON:${summarize(response.text)}`)
    }
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data) || data.length === 0) throw new Error(`上游没有返回图片:${summarize(response.text)}`)
    const first = data[0] as { b64_json?: unknown; url?: unknown }
    if (typeof first.b64_json === 'string' && first.b64_json !== '') {
      if (!model.capabilities.b64Json) throw new Error(`模型声明不支持 b64_json,却只给了内联图片:${summarize(response.text)}`)
      return Buffer.from(first.b64_json, 'base64')
    }
    throw new Error(`上游只给了 url,当前适配器不会去取(如实报告):${summarize(response.text)}`)
  },
}

const ADAPTERS: Record<ImageAdapterId, ImageAdapter> = {
  'openai-compatible': openAiCompatible,
}

export function adapterFor(id: ImageAdapterId): ImageAdapter {
  const adapter = ADAPTERS[id]
  if (adapter === undefined) throw new Error(`未知的图像协议适配器:${id}`)
  return adapter
}

function summarize(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

// ─── 降级(AC3:协议不合要如实说,不静默)────────────────────────────

export interface DegradationResult {
  /** 降级之后真正要发的参数。 */
  effective: {
    size?: ImageSize
    quality?: string
    referenceImages: Array<{ path: string; note?: string }>
  }
  /** 缺省 = 没降级。 */
  degradation?: GenerationDegradation
}

/**
 * 按模型能力把"人要的参数"收敛成"上游能收的参数",并把每一次收敛都记下来。
 *
 * 三条规矩:
 *  - 参考图链不支持 → 丢参考图,**同时**说明(这是最容易让人误以为
 *    "跨批次同一张脸"生效的地方,不能含糊);
 *  - 图生图不支持但不带参考图 → 什么都不用说(文生图本来就是它的能力);
 *  - 尺寸参数不支持 → 不发 size,并说明用了模型默认档。
 */
export function degradeInput(
  model: ImageModelDescriptor,
  input: { size?: ImageSize; quality?: string; referenceImages?: Array<{ path: string; note?: string }> },
): DegradationResult {
  const notes: string[] = []
  const dropped: Array<{ path: string; note?: string }> = []
  const references = input.referenceImages ?? []

  let code: GenerationDegradation['code'] | undefined
  let message = ''
  let keptReferences = references
  if (references.length > 0 && !model.capabilities.referenceChain) {
    code = 'reference-chain-unsupported'
    message = `模型 ${model.id} 不支持参考链(声明的能力:${capabilitySummary(model)});参考图已丢弃,本次按**文生图**发出`
    dropped.push(...references)
    notes.push('参考图链被丢弃:跨批次一致性这次只能靠 prompt 里的外观描述')
    keptReferences = []
  } else if (references.length > 0 && !model.capabilities.imageToImage) {
    // 声明了参考链却不能图生图 = 目录自相矛盾。如实说不一致,而不是挑一个默默用。
    code = 'image-to-image-unsupported'
    message = `模型 ${model.id} 的目录声明自相矛盾:说有参考链却不支持图生图;参考图已丢弃,本次按文生图发出`
    dropped.push(...references)
    notes.push('建议修正模型目录里的能力声明')
    keptReferences = []
  }

  let size = input.size
  if (size !== undefined && !model.capabilities.aspectRatioParam) {
    notes.push(`模型不支持尺寸参数,已改用它的默认档(要求的是 ${size})`)
    if (code === undefined) {
      code = 'size-unsupported'
      message = `模型 ${model.id} 不支持尺寸参数;尺寸已降级为模型默认档(要求 ${size})`
    }
    size = undefined
  }

  const degradation: GenerationDegradation | undefined = code === undefined
    ? undefined
    : { code, message, droppedReferenceImages: dropped, notes }

  return {
    effective: { ...(size === undefined ? {} : { size }), ...(input.quality === undefined ? {} : { quality: input.quality }), referenceImages: keptReferences },
    ...(degradation === undefined ? {} : { degradation }),
  }
}

function capabilitySummary(model: ImageModelDescriptor): string {
  const caps = model.capabilities
  const on = [
    caps.textToImage ? '文生图' : null,
    caps.imageToImage ? '图生图' : null,
    caps.referenceChain ? '参考链' : null,
    caps.aspectRatioParam ? '尺寸参数' : null,
  ].filter((entry): entry is string => entry !== null)
  return on.length === 0 ? '没有任何生图能力' : on.join('/')
}

// ─── 任务账本(纯函数;落盘由接缝做)────────────────────────────────

export function emptyTasksDocument(): GenerationTaskDocument {
  return { schemaVersion: IMAGE_TASKS_SCHEMA, tasks: [] }
}

/** 解析账本;坏文档不静默当成空(宁可抛,让人看到 .studio 被改坏了)。 */
export function parseTasksDocument(text: string): GenerationTaskDocument {
  if (text.trim() === '') return emptyTasksDocument()
  const parsed = JSON.parse(text) as Partial<GenerationTaskDocument>
  if (parsed.schemaVersion !== IMAGE_TASKS_SCHEMA || !Array.isArray(parsed.tasks)) {
    throw new Error(`${IMAGE_TASKS_FILE} 不是有效的任务账本(schemaVersion 应为 ${IMAGE_TASKS_SCHEMA})`)
  }
  return { schemaVersion: IMAGE_TASKS_SCHEMA, tasks: parsed.tasks }
}

export function tasksDocument(document: GenerationTaskDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function findTask(document: GenerationTaskDocument, id: string): GenerationTask | undefined {
  return document.tasks.find((task) => task.id === id)
}

/** 追加/替换一个任务(只动这一个;别处逐字保留)。 */
export function upsertTask(document: GenerationTaskDocument, task: GenerationTask): GenerationTaskDocument {
  const index = document.tasks.findIndex((entry) => entry.id === task.id)
  const tasks = index < 0
    ? [...document.tasks, task]
    : document.tasks.map((entry, i) => (i === index ? task : entry))
  return { schemaVersion: IMAGE_TASKS_SCHEMA, tasks }
}
