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

/** 上游协议适配器 id。 */
export type ImageAdapterId = 'openai-compatible' | 'async-task'

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
  /** 返回的是**图片 URL**(异步任务制常见:终态里给 result_url)。 */
  urlResult?: boolean
}

/**
 * **异步任务制**上游的参数(适配器 `async-task`)。
 *
 * 这类网关(one-api / new-api 系)与 OpenAI 的同步接口不是一回事:提交后**先回一个任务**,
 * 要按 id 轮询到终态,完成后给的是**图片 URL** 而不是 b64。
 * 实测样本:提交 `POST /v1/image/generations`(**单数 image**)→ `{task_id, status:'queued'}`;
 * 轮询 `GET /v1/image/generations/{task_id}` → `data.status==='SUCCESS'` + `data.result_url`。
 */
export interface ImageAsyncOptions {
  /** 提交路径(默认 `/image/generations`)。 */
  submitPath?: string
  /** 轮询路径模板,`{taskId}` 会被替换(默认 `/image/generations/{taskId}`)。 */
  pollPath?: string
  /** 轮询间隔(毫秒)。快带设 0(立刻);生产默认 3000。 */
  pollIntervalMs?: number
  /** 最多轮询几次(默认 60;到顶如实报"上游没在时限内给结果")。 */
  pollMaxAttempts?: number
  /** 终态判定用的状态串(默认这一套;大小写不敏感)。 */
  successStatuses?: string[]
  failureStatuses?: string[]
}

/** 模型目录里声明的端点路径(默认为 OpenAI 兼容口径)。 */
export interface ImageModelPaths {
  /** 提交路径;默认 `/images/generations`(OpenAI 是**复数**)。 */
  submit?: string
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
  /** 端点路径覆盖(路径口径不同的网关靠它对齐,例如单数 `/image/generations`)。 */
  paths?: ImageModelPaths
  /** 异步任务制的轮询参数(仅 `adapter: 'async-task'` 用)。 */
  async?: ImageAsyncOptions
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
 * **拒收注记**(T16):人对某一版的否决理由。
 *
 * 它是**制作信息**(为什么这张不行:脸太圆 / 眼神太凶),不是叙述内容 ——
 * 长度有上限,超了会被挡在写入之前。注记只追加、永不改写,并指向**被拒的那一版**
 * (尝试号 + 产物指纹),所以"这张为什么被打回"在历史里对得上号,而不是一句无主的话。
 */
export interface GenerationRejection {
  /** 被拒的那一次尝试(第几次)。 */
  attempt: number
  /** 被拒那一版的产物指纹(可从快照历史精确找回那一版)。 */
  fingerprint?: string
  /** 人的原话(拒收理由)。 */
  note: string
  /** 谁记的:工作台上的人,还是替人转述的 agent。 */
  via: 'human' | 'agent'
  at: string
}

/**
 * 降级说明:**给出去的参数为什么与要求的不一样**。
 * 有它 = 请求被改了;没有 = 请求原样发出。不存在"改了但不说"的第三种。
 */
export interface GenerationDegradation {
  code: 'reference-chain-unsupported' | 'image-to-image-unsupported' | 'size-unsupported' | 'b64-unsupported' | 'reference-missing'
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
  /**
   * **拒收注记**(T16,只追加):人对某一版的否决理由。
   * 老账本里没有这个字段 —— 读的时候按空数组归一(`task.rejections ?? []`)。
   */
  rejections: GenerationRejection[]
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

/** 二进制下载的应答(异步任务制:终态给的是图片 URL,得再取一次)。 */
export interface HttpDownload {
  status: number
  bytes: Uint8Array
  /** 上游给的 content-type(判格式用,拿不到就是空串)。 */
  contentType: string
}

/**
 * **出网端口**。生产 = 真 fetch;快带 = 打到本地假上游的真 HTTP 实现。
 * 两者是同一个端口的两个实现 —— 协议形状不因测试而变。
 *
 * 两个方法:`send` 走 JSON 接口(提交/轮询),`download` 取二进制(结果图)。
 */
export interface ImageHttpClient {
  send: (request: HttpRequest) => Promise<HttpResponse>
  download: (request: { url: string; headers: Record<string, string> }) => Promise<HttpDownload>
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
    download: async (request) => {
      const response = await fetch(request.url, { headers: request.headers })
      const buffer = await response.arrayBuffer()
      return {
        status: response.status,
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get('content-type') ?? '',
      }
    },
  }
}

// ─── 适配器:任务参数 ⇄ 上游调用 ─────────────────────────────────────

export interface ImageRequestPlan {
  request: HttpRequest
  /** 这次调用用的适配器(进任务历史的诊断信息)。 */
  adapter: ImageAdapterId
}

/** 一次提交的结果:要么直接拿到字节(同步),要么拿到一个要轮询的任务(异步)。 */
export type SubmissionResult =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'pending'; taskId: string }

/** 轮询一步的结果:还在跑 / 已成功(给图片 URL 或字节)/ 上游明说失败。 */
export type PollStep =
  | { kind: 'running'; note: string }
  | { kind: 'done'; url?: string; bytes?: Uint8Array }
  | { kind: 'failed'; error: string }

export interface ImageAdapter {
  id: ImageAdapterId
  buildRequest: (input: {
    channel: ImageChannelSettings
    model: ImageModelDescriptor
    prompt: string
    size?: ImageSize
    quality?: string
    /**
     * 非空 = 走图生图端点(上游支持时才有值)。
     * `dataUrl` 给了就用它(**内联字节**),否则退回 `path`。
     *
     * 为什么要有 `dataUrl`:链上的参考图是**项目内的文件**,远端网关够不着一个
     * 项目内相对路径;`image_url` 字段要的是可取的地址,于是发送前把字节内联进来。
     * 账本里存的是路径(引用),不是图片内容 —— 铁律不变。
     */
    referenceImages: Array<{ path: string; dataUrl?: string }>
  }) => ImageRequestPlan
  /** 提交后的处理:同步适配器在这里就解码出字节;异步适配器只取 task id。 */
  onSubmit: (response: HttpResponse, model: ImageModelDescriptor) => SubmissionResult
  /** 异步适配器:轮询一步(同步适配器不实现 —— 它一次就拿到了)。 */
  pollOnce?: (input: {
    model: ImageModelDescriptor
    /** 渠道基址(轮询 URL 由基址 + 路径模板拼)。 */
    baseUrl: string
    taskId: string
    http: ImageHttpClient
    headers: Record<string, string>
  }) => Promise<PollStep>
  /** 轮询参数(间隔/上限)。缺省 = 不需要轮询。 */
  pollConfig?: (model: ImageModelDescriptor) => { intervalMs: number; maxAttempts: number }
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
    if (referenceImages.length > 0 && model.capabilities.imageToImage) body.image = referenceField(referenceImages)
    return { request: { method: 'POST', url: `${base}${model.paths?.submit ?? '/images/generations'}`, headers, body }, adapter: 'openai-compatible' }
  },

  onSubmit: (response, model) => {
    if (response.status < 200 || response.status >= 300) {
      // 404 是"这条路走不通"的强信号:多数异步任务制网关的提交路径是**单数**
      // `/image/generations`。如实指出来,别让人对着一个 404 猜。
      const hint = response.status === 404
        ? '(注意:异步任务制网关的提交路径常是单数 `/image/generations`,不是 OpenAI 的复数;'
          + '若上游是那种网关,请把该模型 adapter 改成 async-task 并配 paths/async)'
        : ''
      throw new Error(`上游返回 ${response.status}:${summarize(response.text)}${hint}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.text)
    } catch {
      throw new Error(`上游返回的不是 JSON:${summarize(response.text)}`)
    }
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data) || data.length === 0) {
      // 异步任务制网关的提交应答长这样:`{id, task_id, status:'queued'}` —— 没有 data 数组。
      // 这不是"上游坏了",是**协议不对**:如实指出来,别让人对着它猜。
      const looksAsync = typeof (parsed as { task_id?: unknown }).task_id === 'string'
        || typeof (parsed as { status?: unknown }).status === 'string'
      throw new Error(
        looksAsync
          ? `上游回的是**任务**(异步任务制),不是图片:请把该模型的 adapter 改成 async-task 并按上游文档配 paths/async。上游原话:${summarize(response.text)}`
          : `上游没有返回图片:${summarize(response.text)}`,
      )
    }
    const first = data[0] as { b64_json?: unknown; url?: unknown }
    if (typeof first.b64_json === 'string' && first.b64_json !== '') {
      if (!model.capabilities.b64Json) throw new Error(`模型声明不支持 b64_json,却只给了内联图片:${summarize(response.text)}`)
      return { kind: 'bytes', bytes: Buffer.from(first.b64_json, 'base64') }
    }
    throw new Error(
      `上游没有给内联图片${typeof first.url === 'string' ? '(只给了 url)' : ''}:若这是"异步任务制"网关,`
      + '请把该模型的 adapter 改成 async-task 并按上游文档填 paths/async;当前适配器不会去猜协议。'
      + `上游原话:${summarize(response.text)}`,
    )
  },
}

/**
 * **异步任务制**适配器(one-api / new-api 系的图像网关)。
 *
 * 与 OpenAI 的差别有三处,都由**模型目录声明**决定,不靠猜:
 *  1. 路径:提交 `/image/generations`(**单数**),轮询 `/image/generations/{taskId}`;
 *  2. 提交只回任务 id(`{task_id, status:'queued'}`),不是图片;
 *  3. 终态给 `result_url`(图片 URL),要再取一次二进制。
 */
const asyncTask: ImageAdapter = {
  id: 'async-task',

  buildRequest: ({ channel, model, prompt, size, referenceImages }) => {
    const base = channel.baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (channel.apiKey !== undefined && channel.apiKey !== '') headers.authorization = `Bearer ${channel.apiKey}`

    const body: Record<string, unknown> = { model: model.id, prompt, n: 1 }
    if (size !== undefined && model.capabilities.aspectRatioParam) body.size = size
    if (referenceImages.length > 0 && model.capabilities.imageToImage) body.image = referenceField(referenceImages)
    return {
      request: { method: 'POST', url: `${base}${model.async?.submitPath ?? '/image/generations'}`, headers, body },
      adapter: 'async-task',
    }
  },

  onSubmit: (response) => {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`上游返回 ${response.status}:${summarize(response.text)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.text)
    } catch {
      throw new Error(`上游返回的不是 JSON:${summarize(response.text)}`)
    }
    const shape = parsed as { task_id?: unknown; id?: unknown; data?: { task_id?: unknown } }
    // 任务 id 可能在顶层、也可能是 `id`,或在 `data.task_id`(各家写法不一,都认)。
    const taskId = [shape.task_id, shape.data?.task_id, shape.id].find((value): value is string => typeof value === 'string' && value !== '')
    if (taskId === undefined) {
      throw new Error(`上游没给任务 id(不是异步任务制的形状):${summarize(response.text)}`)
    }
    return { kind: 'pending', taskId }
  },

  pollOnce: async ({ model, baseUrl, taskId, http, headers }) => {
    const base = baseUrl.replace(/\/+$/, '')
    const template = model.async?.pollPath ?? '/image/generations/{taskId}'
    const pollUrl = `${base}${template.replace('{taskId}', encodeURIComponent(taskId))}`
    const response = await http.send({ method: 'GET', url: pollUrl, headers })
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'failed', error: `轮询失败:GET ${pollUrl} 返回 ${response.status} —— ${summarize(response.text)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.text)
    } catch {
      return { kind: 'failed', error: `轮询返回的不是 JSON:${summarize(response.text)}` }
    }
    const data = ((parsed as { data?: unknown }).data ?? parsed) as {
      status?: unknown; progress?: unknown; fail_reason?: unknown; result_url?: unknown
      data?: { content?: { image_url?: unknown } }
    }
    const status = typeof data.status === 'string' ? data.status.toUpperCase() : ''
    const success = (model.async?.successStatuses ?? ['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL']).map((s) => s.toUpperCase())
    const failure = (model.async?.failureStatuses ?? ['FAILURE', 'FAILED', 'ERROR', 'REVOKED']).map((s) => s.toUpperCase())

    if (failure.includes(status)) {
      const reason = typeof data.fail_reason === 'string' && data.fail_reason !== '' ? data.fail_reason : status
      return { kind: 'failed', error: `上游报失败:${reason}(${summarize(response.text, 200)})` }
    }
    if (!success.includes(status)) {
      const progress = typeof data.progress === 'string' ? data.progress : ''
      return { kind: 'running', note: `${status}${progress === '' ? '' : ` ${progress}`}` }
    }
    // 终态:优先 result_url,其次 data.data.content.image_url(实测两种都出现过)。
    const nested = typeof data.data?.content?.image_url === 'string' ? data.data.content.image_url : undefined
    const resultUrl = typeof data.result_url === 'string' && data.result_url !== '' ? data.result_url : nested
    if (resultUrl === undefined) {
      return { kind: 'failed', error: `上游说成功了但没给图片地址:${summarize(response.text)}` }
    }
    return { kind: 'done', url: resultUrl }
  },

  pollConfig: (model) => ({
    intervalMs: model.async?.pollIntervalMs ?? 3000,
    maxAttempts: model.async?.pollMaxAttempts ?? 60,
  }),
}

const ADAPTERS: Record<ImageAdapterId, ImageAdapter> = {
  'openai-compatible': openAiCompatible,
  'async-task': asyncTask,
}

export function adapterFor(id: ImageAdapterId): ImageAdapter {
  const adapter = ADAPTERS[id]
  if (adapter === undefined) throw new Error(`未知的图像协议适配器:${id}`)
  return adapter
}

/**
 * 下载结果图。**非 2xx 与空体都如实报**,不产半成品。
 * 格式由调用方按 content-type / 扩展名定(落盘要用对后缀)。
 */
export async function downloadResultImage(
  http: ImageHttpClient,
  url: string,
  headers: Record<string, string>,
): Promise<{ bytes: Uint8Array; format: string }> {
  const response = await http.download({ url, headers })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`取图失败:${url} 返回 ${response.status}`)
  }
  if (response.bytes.byteLength === 0) throw new Error(`取图失败:${url} 返回了空内容`)
  return { bytes: response.bytes, format: imageFormatOf(response.contentType, url) }
}

/** 从 content-type / 扩展名判图片格式(判不出就按 png)。 */
export function imageFormatOf(contentType: string, url: string): string {
  const type = contentType.toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('png')) return 'png'
  const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase()
  if (ext !== undefined && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'png'
}

function summarize(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 参考图的线上形态:优先内联字节(`dataUrl`),退回路径。
 *
 * 退回路径是给"上游自己认项目内路径"这种自定义网关留的口子(以及既有调试用法);
 * 常规远端网关只认可取的地址,所以生产路径上走的是内联。
 */
export function referenceField(referenceImages: Array<{ path: string; dataUrl?: string }>): Array<{ image_url: string }> {
  return referenceImages.map((reference) => ({ image_url: reference.dataUrl ?? reference.path }))
}

/** 路径 → MIME(判不出按 png;与 `imageFormatOf` 同一套后缀口径)。 */
export function mimeOfPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

/** 字节 → data URL(内联参考图用)。 */
export function dataUrlOf(bytes: Uint8Array, path: string): string {
  return `data:${mimeOfPath(path)};base64,${Buffer.from(bytes).toString('base64')}`
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
 * 四条规矩(次序即优先级:"模型支不支持"是持久属性,先判;"文件在不在"是此刻的处境):
 *  - 参考图链不支持 → 丢参考图,**同时**说明(这是最容易让人误以为
 *    "跨批次同一张脸"生效的地方,不能含糊);
 *  - 图生图不支持但不带参考图 → 什么都不用说(文生图本来就是它的能力);
 *  - **链上有图但文件还不存在** → 发不出去,丢掉并列出(`missingReferenceImages`,
 *    T16 的"不假装链生效");模型支持参考链时它才是那条主要的说明;
 *  - 尺寸参数不支持 → 不发 size,并说明用了模型默认档。
 */
export function degradeInput(
  model: ImageModelDescriptor,
  input: {
    size?: ImageSize
    quality?: string
    /** 这一次**要带**的参考图(含此刻还不存在的那些)。 */
    referenceImages?: Array<{ path: string; note?: string }>
    /** 其中此刻磁盘上还没有的那些(调用方读盘得出)。 */
    missingReferenceImages?: Array<{ path: string; note?: string }>
  },
): DegradationResult {
  const notes: string[] = []
  const dropped: Array<{ path: string; note?: string }> = []
  const requested = input.referenceImages ?? []
  const absent = input.missingReferenceImages ?? []
  const ready = requested.filter((reference) => !absent.some((missing) => missing.path === reference.path))

  let code: GenerationDegradation['code'] | undefined
  let message = ''
  let keptReferences: Array<{ path: string; note?: string }> = ready
  if (requested.length > 0 && !model.capabilities.referenceChain) {
    code = 'reference-chain-unsupported'
    message = `模型 ${model.id} 不支持参考链(声明的能力:${capabilitySummary(model)});参考图已丢弃,本次按**文生图**发出`
    dropped.push(...requested)
    notes.push('参考图链被丢弃:跨批次一致性这次只能靠 prompt 里的外观描述')
    keptReferences = []
  } else if (requested.length > 0 && !model.capabilities.imageToImage) {
    // 声明了参考链却不能图生图 = 目录自相矛盾。如实说不一致,而不是挑一个默默用。
    code = 'image-to-image-unsupported'
    message = `模型 ${model.id} 的目录声明自相矛盾:说有参考链却不支持图生图;参考图已丢弃,本次按文生图发出`
    dropped.push(...requested)
    notes.push('建议修正模型目录里的能力声明')
    keptReferences = []
  } else if (absent.length > 0) {
    code = 'reference-missing'
    message = `参考链上有 ${absent.length} 张图此刻还不存在(登记簿里引用了,磁盘上没有);本次没带上它们`
    dropped.push(...absent)
    notes.push(`还不存在的参考图:${absent.map((reference) => reference.path).join('、')} —— 先把它出出来(或从登记簿的参考链里去掉),链才生效`)
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
  // 老账本没有 `rejections`(T16 才加):读的时候归一成空数组,不逼人去改历史文件。
  return { schemaVersion: IMAGE_TASKS_SCHEMA, tasks: parsed.tasks.map((task) => ({ ...task, rejections: task.rejections ?? [] })) }
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
