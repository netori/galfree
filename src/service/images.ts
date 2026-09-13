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
import {
  emptyTasksDocument as emptyTaskDocument,
  findTask as findTaskIn,
  MAX_REJECTION_NOTE_CHARS as TASK_MAX_REJECTION_NOTE_CHARS,
  parseTasksDocument as parseTaskDocument,
  tasksDocument as serializeTaskDocument,
  TASK_SCHEMA,
  upsertTask as upsertTaskIn,
  type GenerationAttempt,
  type GenerationDegradation,
  type GenerationRejection,
  type GenerationTaskBase,
  type GenerationTaskState,
  type TaskDocument,
  type TaskKind,
} from './tasks.ts'

// 账本那套的**通用部分在 `tasks.ts`**(T27 / ADR-0012:音乐与语音复用同一套纪律);
// 这里**再导出**它们,老引用(`from './images.ts'`)一行都不用改。
export type { GenerationAttempt, GenerationDegradation, GenerationRejection, GenerationTaskState }
/** 拒收注记长度上限的唯一出处是 `tasks.ts`;此处再导出以兼容既有引用。 */
export const MAX_REJECTION_NOTE_CHARS = TASK_MAX_REJECTION_NOTE_CHARS

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
  /**
   * **参考图挂在 `image` 字段上的形状**(缺省 `'array'` = OpenAI 兼容的 `[{image_url}]`)。
   *
   * 这一条是**实测换来的**,不是猜的:seedance / one-api 系的 Go 网关里那个字段是
   * `string`,发数组会被原样拒掉 ——
   * `400 invalid_request: json: cannot unmarshal array into Go struct field .Alias.image of type string`
   * (见 `docs/contracts/stage-zero.md` 的 T16 节与慢带 `live-chain.slow.test.ts`)。
   *
   * `'string'` 形状**一次只收一张**:链上有多张时按登记簿顺序取第一张,其余走
   * "如实降级"(`reference-truncated`)记进任务 —— 绝不静默少发。
   */
  referenceField?: 'array' | 'string'
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
//
// 状态机 / 尝试历史 / 拒收注记 / 降级的**通用形状**在 `tasks.ts`(T27 起音乐与语音共用);
// 这里只留图像自己的输入输出字段。

export type ImageSize = string

export interface GenerationTask extends GenerationTaskBase {
  /** 产物类型(账本里显式写出来;老账本没有这一字段 → 读成 'image')。 */
  kind: ImageTaskKind
  /**
   * 目标槽(槽名,与 `.rpy` 图像引用派生的槽 id 同一口径)。
   * **封面类任务**(T30)没有槽 —— 它的身份是 `target`,这里为空串。
   */
  slot: string
  /**
   * 封面类任务的目标(T30 / #38):`main_menu` / `game_menu` / `window_icon`。
   * 槽类任务没有这一字段(老账本也没有)。
   */
  target?: string
  /** 登记簿上下文:这个槽要求哪些角色出场(引用登记簿 id,不复制设定)。 */
  requiresCharacters: string[]
  /** 画风锚(来自槽账本或角色登记簿)。 */
  artStyleAnchor?: string
  size?: ImageSize
  quality?: string
  /** 参考图链(登记簿的引用)。 */
  referenceImages: Array<{ path: string; note?: string }>
}

/** 图像任务账本(落 `.studio/image-tasks.json`;只放制作信息,不复制叙述内容)。 */
export type GenerationTaskDocument = TaskDocument<GenerationTask>

export const IMAGE_TASKS_FILE = '.studio/image-tasks.json'
export const IMAGE_TASKS_SCHEMA = TASK_SCHEMA

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
    // 参考图链:模型支持时挂在 image 字段上(形状按目录声明:数组 / 单个字符串)。
    if (model.capabilities.imageToImage) {
      const image = referenceField(referenceImages, model.referenceField ?? 'array')
      if (image !== undefined) body.image = image
    }
    return { request: { method: 'POST', url: `${base}${model.paths?.submit ?? '/images/generations'}`, headers, body }, adapter: 'openai-compatible' }
  },

  onSubmit: (response, model) => {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`上游返回 ${response.status}:${summarize(response.text)}${protocolHint(response)}`)
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
    if (model.capabilities.imageToImage) {
      const image = referenceField(referenceImages, model.referenceField ?? 'array')
      if (image !== undefined) body.image = image
    }
    return {
      request: { method: 'POST', url: `${base}${model.async?.submitPath ?? '/image/generations'}`, headers, body },
      adapter: 'async-task',
    }
  },

  onSubmit: (response) => {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`上游返回 ${response.status}:${summarize(response.text)}${protocolHint(response)}`)
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

/**
 * **协议错配要给可执行的指引**,不能只说"失败了"。这里每一条都是被真实的上游拒绝教出来的
 * (见契约 T16 节的实测记录):
 *
 *  - 404:异步任务制网关的提交路径常是**单数** `/image/generations`;
 *  - 参考图是数组但字段是字符串:Go 系网关的 `image` 字段只收一个字符串;
 *  - 要求"公网 HTTP(S) URL":那类上游**不收内联字节、也不收项目内路径** ——
 *    在插件能给出公网可取的地址之前,这个模型的参考链是不可用的,如实说清楚,
 *    别让人对着 400 反复重试。
 */
function protocolHint(response: HttpResponse): string {
  if (response.status === 404) {
    return '(注意:异步任务制网关的提交路径常是单数 `/image/generations`,不是 OpenAI 的复数;'
      + '若上游是那种网关,请把该模型 adapter 改成 async-task 并配 paths/async)'
  }
  if (/cannot unmarshal .*image/i.test(response.text) && /string/i.test(response.text)) {
    return '(上游的参考图字段是**单个字符串**,不是数组:到「设置 → GALFREE」把该模型的'
      + '「参考图字段」改成「单个字符串」—— 那个字段一次只收一张,多张会按链上顺序取第一张并如实记降级)'
  }
  if (/public HTTP\(S\) URLs|must contain public/i.test(response.text)) {
    return '(这个上游**只收公网可取的 HTTP(S) 图片地址**:项目内的图与内联字节它都不收 ——'
      + '在能给出公网地址之前,该模型的参考链不可用;建议把目录里它的「参考链」关掉,'
      + '让任务改成如实降级(一致性退回 prompt 描述),而不是每次出图都撞 400)'
  }
  return ''
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
 * 参考图的线上形态。
 *
 * - `'array'`(缺省,OpenAI 兼容):`[{image_url}]`,`image_url` 优先取内联字节(`dataUrl`),
 *   退回路径(给"上游自己认项目内路径"这种自定义网关留的口子);
 * - `'string'`:**这个字段只收一张**(实测的 Go 网关形状),取链上第一张。
 *   多张的截断由 `degradeInput` 记成 `reference-truncated` —— 这里不静默丢东西。
 */
export function referenceField(
  referenceImages: Array<{ path: string; dataUrl?: string }>,
  shape: 'array' | 'string' = 'array',
): Array<{ image_url: string }> | string | undefined {
  if (referenceImages.length === 0) return undefined
  const urls = referenceImages.map((reference) => reference.dataUrl ?? reference.path)
  return shape === 'string' ? urls[0]! : urls.map((image_url) => ({ image_url }))
}

/** 路径 → MIME(判不出按 png;**建在 `imageFormatOf` 之上**,后缀口径只有一处)。 */
export function mimeOfPath(path: string): string {
  const format = imageFormatOf('', path)
  return format === 'jpg' ? 'image/jpeg' : `image/${format}`
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

  // 4) 字段形状的容量:`referenceField:'string'` 的上游那个字段**只收一张**
  //    (实测的 Go 网关形状)。按登记簿顺序取第一张,其余如实降级 —— 不静默少发。
  if (keptReferences.length > 1 && model.referenceField === 'string') {
    const truncated = keptReferences.slice(1)
    dropped.push(...truncated)
    notes.push(`模型声明 image 字段为单个字符串(只收一张):按参考链顺序取了第一张 ${keptReferences[0]!.path},其余 ${truncated.length} 张本次没发`)
    if (code === undefined) {
      code = 'reference-truncated'
      message = `模型 ${model.id} 的 image 字段只收一张参考图;链上 ${keptReferences.length} 张里只发了第一张`
    }
    keptReferences = keptReferences.slice(0, 1)
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
//
// 通用那半在 `tasks.ts`(状态机 / 尝试历史 / 拒收注记 / 读写纯函数)——
// 音乐与语音共用它(T27 / ADR-0012 的"任务队列复用图像那套")。
// 这里只剩**图像自己的差异**:盘上路径、人话标签、以及字段形状的归一。

/** 图像任务的产物类型 discriminator(T27 起,老账本没有这一字段 → 读成 'image')。 */
export type ImageTaskKind = 'image'

const IMAGE_TASK_KIND: TaskKind<GenerationTask> = {
  file: IMAGE_TASKS_FILE,
  label: '图像任务',
  normalize: (raw) => ({
    schemaVersion: TASK_SCHEMA,
    // 老账本没有 `rejections`(T16 才加):读的时候归一成空数组,不逼人去改历史文件。
    // `kind` 同理(T27 才加):缺省就是图像任务 —— 那时账本里只有这一种。
    tasks: (raw.tasks ?? []).map((task) => ({ ...task, kind: 'image', rejections: task.rejections ?? [] })),
  }),
}

/** 账本工厂要的那点差异(接缝装配时用)。 */
export const IMAGE_TASK_KIND_DESCRIPTOR: TaskKind<GenerationTask> = IMAGE_TASK_KIND

export function emptyTasksDocument(): GenerationTaskDocument {
  return emptyTaskDocument<GenerationTask>()
}

/** 解析账本;坏文档不静默当成空(宁可抛,让人看到 .studio 被改坏了)。 */
export function parseTasksDocument(text: string): GenerationTaskDocument {
  return parseTaskDocument(IMAGE_TASK_KIND, text)
}

export function tasksDocument(document: GenerationTaskDocument): string {
  return serializeTaskDocument(document)
}

export function findTask(document: GenerationTaskDocument, id: string): GenerationTask | undefined {
  return findTaskIn(document, id)
}

/** 追加/替换一个任务(只动这一个;别处逐字保留)。 */
export function upsertTask(document: GenerationTaskDocument, task: GenerationTask): GenerationTaskDocument {
  return upsertTaskIn(document, task)
}
