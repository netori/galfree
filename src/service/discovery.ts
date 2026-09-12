/**
 * 渠道自动化(T14 续):从「一个端点 + 一个密钥」推到「可用的模型目录」。
 *
 * 目标是把配置成本压到最低 —— 人只填端点与密钥,其余能自动的都自动:
 *
 *  1. **拉模型清单**:`GET {base}/models`(OpenAI 兼容);
 *  2. **挑出像图像模型的**并排在前面(聊天/嵌入模型排后面,不隐藏 —— 藏起来
 *     人就没法手选,而模型的命名千奇百怪,最后兜底的还是人);
 *  3. **推断能力**:已知家族按实测/文档给(**标记为"确定"**);不认识的按
 *     **保守默认**(只文生图)并**标记为"待确认"** —— 绝不凭空许诺参考链:
 *     上游不认的能力发出去只会失败,而失败本该是可以避免的。
 *
 * 这里全是纯函数:不碰磁盘、不碰网络(拉取由调用方经注入的出网端口做)。
 */
import type { ImageHttpClient, ImageModelCapabilities, ImageModelDescriptor } from './images.ts'

/** 已知家族的识别结果;`needsConfirmation` = 能力是保守默认还是确实知道。 */
export interface ModelInference {
  capabilities: ImageModelCapabilities
  /** 命中的家族名(未知 = undefined)。 */
  family?: string
  /** 一句话说明依据,面板直接显示给人看。 */
  basis: string
  /** true = 保守默认,请人到面板上确认;false = 已知家族,按已知给。 */
  needsConfirmation: boolean
}

/** 全 false 的底(capabilities 是**全量快照字段**,写目录时必须显式给全)。 */
const NO_CAPS: ImageModelCapabilities = {
  textToImage: false, imageToImage: false, referenceChain: false, aspectRatioParam: false, b64Json: false,
}

/**
 * 已知家族的**能力档案**。
 *
 * 口径:只写有把握的。`aspectRatioParam` 对 OpenAI 兼容端点普遍为真(尺寸档),
 * `referenceChain`(多张参考图跨批次一致性)是**最少见的**,所以只在明确知道
 * 它支持的家族上开 —— 这条一旦写错,发出去的请求上游看不懂,任务会失败。
 */
interface Family {
  /** 匹配模型 id(小写)的正则。 */
  match: RegExp
  name: string
  capabilities: ImageModelCapabilities
  basis: string
}

const FAMILIES: Family[] = [
  {
    match: /^gpt-image/,
    name: 'gpt-image',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
    basis: 'OpenAI gpt-image 系列:文生图 / 图生图 / 多图参考链 / 尺寸档,返回内联图片',
  },
  {
    match: /^dall-e/,
    name: 'dall-e',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: 'OpenAI DALL·E 系列:文生图 / 编辑(单图),不支持多图参考链',
  },
  {
    match: /flux/,
    name: 'flux',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: 'FLUX 家族:文生图 / 图生图;多图参考链多数托管端点不提供,故未开',
  },
  {
    match: /(seedream|seededit|doubao.*(image|seed))/,
    name: 'seedream',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
    basis: 'Seedream / SeedEdit:支持参考图入参(图生图与多图参考)',
  },
  {
    match: /(qwen-image|wanx|wan2)/,
    name: 'qwen-image',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: '通义万相 / qwen-image:文生图与图像编辑;参考链视端点而定,故未开',
  },
  {
    match: /(imagen)/,
    name: 'imagen',
    capabilities: { ...NO_CAPS, textToImage: true, aspectRatioParam: true, b64Json: true },
    basis: 'Google Imagen:文生图为主',
  },
  {
    match: /(grok.*image|image.*grok)/,
    name: 'grok-imagine',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
    basis: 'grok-imagine:文生图与图生图(参考图按官方 JSON 协议)',
  },
  {
    match: /(nano.?banana|gemini.*image|image.*gemini)/,
    name: 'nanobanana',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
    basis: 'nanobanana / Gemini 图像:支持参考图与宽高比参数',
  },
  {
    match: /(sdxl|stable-diffusion|sd3|sd-?turbo)/,
    name: 'stable-diffusion',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: 'Stable Diffusion 家族:文生图 / 图生图',
  },
  {
    match: /^glm-image/,
    name: 'glm-image',
    capabilities: { ...NO_CAPS, textToImage: true, aspectRatioParam: true, b64Json: true },
    basis: '智谱 glm-image:当前只支持文生图',
  },
  {
    match: /^image-01|minimax.*image/,
    name: 'minimax-image',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: 'MiniMax image-01:文生图 + 单张主体参考(非像素级编辑)',
  },
  {
    match: /(^|[-_/])(kolors|hunyuan.*image|ernie.*image)/,
    name: '国产生图',
    capabilities: { ...NO_CAPS, textToImage: true, imageToImage: true, aspectRatioParam: true, b64Json: true },
    basis: '可灵 / 混元 / 文心生图:文生图 + 图像编辑;参考链视端点而定,故未开',
  },
]

/** 明显不是图像模型的(嵌入/重排/语音/审核)—— 排在清单末尾,但仍列出来让人能选。 */
const NON_IMAGE = /(embed|rerank|whisper|tts|audio|moderation|speech|transcri|text-to-speech|^o[13]|^gpt-[45]|^gpt-3|^claude|^deepseek|^qwen[0-9]|^gemini-[0-9.]+-(pro|flash)$)/

/**
 * 从一个模型 id 推断能力。
 *
 * 不认识的一律保守默认(**只文生图**)并标 `needsConfirmation`:
 * "支持参考链"这种话,没验过就不能替上游说。
 */
export function inferCapabilities(modelId: string): ModelInference {
  const id = modelId.trim().toLowerCase()
  for (const family of FAMILIES) {
    if (!family.match.test(id)) continue
    return { capabilities: { ...family.capabilities }, family: family.name, basis: family.basis, needsConfirmation: false }
  }
  return {
    // 保守默认:文生图(几乎所有图像端点都有)+ 尺寸参数(OpenAI 兼容常见),
    // 其余一律 false —— 参考链是最容易"看起来能用其实不能"的一档。
    capabilities: { ...NO_CAPS, textToImage: true, aspectRatioParam: true, b64Json: true },
    basis: '没认出来的模型:按最保守的口径填(只文生图 + 尺寸参数)。请到下面勾选它真实支持的能力',
    needsConfirmation: true,
  }
}

/** 拉取结果里的一项(给面板渲染用;不含密钥)。 */
export interface DiscoveredModel {
  id: string
  /** 上游给的显示名(有就用)。 */
  label?: string
  /** 像不像图像模型(只影响排序与默认勾选,**不隐藏**)。 */
  imageLikely: boolean
  inference: ModelInference
}

export interface DiscoverModelsResult {
  models: DiscoveredModel[]
  /** 上游一共回了多少个 id(含非图像模型)。 */
  total: number
  /** 实际请求的 URL(排障用;不含密钥)。 */
  endpoint: string
}

/** 去掉末尾斜杠与多余空白,得到规范的基址。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 拉模型清单 —— **走注入的出网端口**(生产 fetch / 快带假上游,协议形状不因测试而变)。
 *
 * 错误如实抛:面板把上游原话显示出来(401 就是密钥不对、404 就是端点不对),
 * 不吞成"拉取失败"让人猜。
 */
export async function discoverModels(
  http: ImageHttpClient,
  input: { baseUrl: string; apiKey?: string },
): Promise<DiscoverModelsResult> {
  const base = normalizeBaseUrl(input.baseUrl)
  const endpoint = `${base}/models`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.apiKey !== undefined && input.apiKey !== '') headers.authorization = `Bearer ${input.apiKey}`

  const response = await http.send({ method: 'GET', url: endpoint, headers })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`拉模型清单失败:${endpoint} 返回 ${response.status} —— ${summarize(response.text)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    throw new Error(`拉模型清单失败:${endpoint} 返回的不是 JSON —— ${summarize(response.text)}`)
  }

  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error(`拉模型清单失败:${endpoint} 的响应里没有 data 数组(不是 OpenAI 兼容的 /models 形状)`)
  }

  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; name?: unknown }
    if (typeof record.id !== 'string' || record.id.trim() === '') continue
    const id = record.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    const inference = inferCapabilities(id)
    models.push({
      id,
      ...(typeof record.name === 'string' && record.name !== '' ? { label: record.name } : {}),
      imageLikely: inference.family !== undefined || !NON_IMAGE.test(id.toLowerCase()),
      inference,
    })
  }

  // 排序:像图像模型的在前,明显不是的在后;组内保持上游顺序。
  const ordered = [...models].sort((a, b) => Number(b.imageLikely) - Number(a.imageLikely))
  return { models: ordered, total: models.length, endpoint }
}

/** 把选中的模型(含人确认过的能力)编成 `imageModels` 设置项要的 JSON。 */
export function modelsToCatalogJson(selected: Array<{ id: string; label?: string; note?: string; capabilities: ImageModelCapabilities }>): string {
  return JSON.stringify(selected.map((model) => ({
    id: model.id,
    ...(model.label === undefined || model.label === '' ? {} : { label: model.label }),
    ...(model.note === undefined || model.note === '' ? {} : { note: model.note }),
    capabilities: { ...model.capabilities },
  })), null, 2)
}

/** 把设置里已有的目录 JSON 解回可编辑状态(坏 JSON → 空,由面板报错)。 */
export function catalogJsonToModels(text: string): ImageModelDescriptor[] {
  if (text.trim() === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is ImageModelDescriptor => entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
  } catch {
    return []
  }
}

function summarize(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}
