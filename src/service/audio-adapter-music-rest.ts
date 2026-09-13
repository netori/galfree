/**
 * 音乐适配器:**资源式 REST 的异步任务**(提交 → 拿 id → `GET .../tasks/{id}` 轮询)。
 *
 * ## 为什么单列一条协议(而不是把 `audio-adapter-suno.ts` 改宽)
 *
 * 2026-09-13 的真机验收把这件事打了出来:同一家网关(`api.seedance.nz`)的**图像**走
 * OpenAI 兼容,而**音乐**是它自己的一套 —— 与 sunoapi.org 那套**只是长得像**:
 *
 * | | sunoapi.org 那套(`async-task`) | 这一套(`async-task-rest`) |
 * |---|---|---|
 * | 提交 | `POST /api/v1/generate`,体 `{customMode, instrumental, model, callBackUrl, prompt}` | `POST /v1/music/generations`,体 `{model:"suno", custom:false, version:"v6", prompt, instrumental}` |
 * | 轮询 | `GET /api/v1/generate/record-info?**taskId=**…` | `GET /v1/music/tasks/**{id}**`(**id 在路径里**) |
 * | 完成 | `data.status:"SUCCESS"` + `data.response.sunoData[0].audio_url` | `{code:200, data:{status:"completed", …}}` |
 *
 * 差别**不是路径字符串**,所以 `note` 覆盖补不上;而 ADR-0012 的原话是"适配器按协议收,
 * 不按厂商收" —— 两条协议各一个适配器,各自能被守卫喂字符串验。
 *
 * ## 协议事实(全部抄自服务商文档的 `suno-generation` 那一页,**不是猜的**)
 *
 * | 事实 | 文档原话 |
 * |---|---|
 * | 提交 | `POST /v1/music/generations`(`Authorization: Bearer <api_key>`) |
 * | 查询 | `GET /v1/music/tasks/{id}` |
 * | 提交体 | `{"model":"suno","custom":false,"version":"v6","prompt":"…"}` |
 * | 参数 | `model`(默认 `suno`)/ `version`(`v6`/`v6-5`/`v6-mini`,或自定义模型 id,二者不同时用)/ `custom`(`false`=prompt 是**灵感描述**,`true`=prompt 是歌词)/ `instrumental`(`true`=纯音乐)/ `title` / `style` / `vocal_gender` / `audio_format`(`mp3`/`m4a`/`wav`)/ `duration`(10–360)… |
 * | 完成响应 | `{ code: 200, data: { status: "completed", usage: { amount, currency } } }`;任务完成后 **48 小时**过期 |
 *
 * **两条来自真机的实测**(2026-09-13,打了一次真上游 + 只读轮询了一次;文档那一页没写响应体):
 *  1. **提交响应的 `data` 是数组**:`{"code":200,"data":[{"status":"submitted","task_id":"task_…"}]}`;
 *  2. **轮询响应的 `data` 是对象**:`{id, task_id, status, progress, estimated_time, cost, credits_cost}`,
 *     中间态字面量是 `processing`(带百分比进度)。
 * 两边形状不一样,所以两处各认各的(**数组与对象都认**)——「看着像就成」在这里是不够的:
 * 认错一次的代价是一次真生成(那次就是这么丢的,好在有 48 小时可取回)。
 *
 * **一条如实标注的不确定**(等第一次跑到 `completed` 才知道):完成响应里音频地址的字段名
 * —— [`findAudioUrl`] 按"名字像音频 → 值像 http(s) 音频链接"找;**找不到就把响应原话贴出来**
 * 当失败原因(不假装成功、也不写一个空文件进项目),同时把上游任务 id 记进账本备查。
 */
import type { AudioAdapter, AudioAdapterId, AudioPollStep, AudioSubmission } from './audio-generation.ts'

/** 提交路径(相对渠道 baseUrl;注意那家网关 baseUrl 含 `/v1`)。 */
export const MUSIC_REST_SUBMIT_PATH = '/music/generations'
/** 轮询路径模板:**任务 id 在路径里**(与 sunoapi 那套最要紧的差别)。 */
export const MUSIC_REST_POLL_PATH = '/music/tasks/{id}'
/** 提交体里 `model` 的缺省值(文档:默认 `suno`)。 */
export const MUSIC_REST_DEFAULT_MODEL = 'suno'
/** 版本缺省(文档给的三个之一)。 */
export const MUSIC_REST_DEFAULT_VERSION = 'v6'
/** 输出格式缺省(文档:`mp3` / `m4a` / `wav`)。 */
export const MUSIC_REST_DEFAULT_FORMAT = 'mp3'

export interface MusicRestPaths {
  submit: string
  /** 模板,必须含 `{id}`。 */
  poll: string
  model: string
  version: string
  format: string
}

/**
 * 从模型目录的 `note` 里读覆盖项(与 suno 那条同一套分号键值)。
 *
 * 为什么仍然要它:聚合站的路径与版本会变(`v6-5` / 自定义模型 id 都是真的用法),
 * 而 ADR-0012 的硬边界是"端点一律可填"。认不出的键忽略(不因一个错字整条不可用)。
 */
export function musicRestPathsFromNote(note: string | undefined): MusicRestPaths {
  const overrides: Record<string, string> = {}
  for (const piece of (note ?? '').split(';')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    overrides[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim()
  }
  return {
    submit: overrides.submit ?? MUSIC_REST_SUBMIT_PATH,
    poll: overrides.poll ?? MUSIC_REST_POLL_PATH,
    model: overrides.model ?? MUSIC_REST_DEFAULT_MODEL,
    version: overrides.version ?? MUSIC_REST_DEFAULT_VERSION,
    format: overrides.format ?? MUSIC_REST_DEFAULT_FORMAT,
  }
}

/**
 * 提交体(**灵感模式**:`custom:false`,prompt 是风格/情绪/场景那类制作指令)。
 *
 * 为什么不发 `custom:true`:那要求 prompt 是**歌词**,而我们的 `prompt` 从第一天起就是
 * 制作指令(TTS 那边它才是台词)。发起人也说了"大部分音乐只需要纯音乐"。
 */
export function buildMusicRestSubmitBody(input: {
  prompt: string
  /** 纯音乐(`true`)= 不要人声;来自模型目录的能力声明。 */
  instrumental: boolean
  model: string
  version: string
  format: string
}): Record<string, unknown> {
  return {
    model: input.model,
    custom: false,
    version: input.version,
    prompt: input.prompt,
    instrumental: input.instrumental,
    audio_format: input.format,
  }
}

/** 提交响应 → taskId,或者一句**带原话**的拒绝。 */
export function readMusicRestSubmit(text: string): { ok: true; taskId: string } | { ok: false; error: string } {
  let parsed: { code?: number; msg?: string; message?: string; data?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: `提交响应不是 JSON:${clip(text)}` }
  }
  if (typeof parsed.code === 'number' && parsed.code !== 200) {
    return { ok: false, error: `上游拒绝(code ${parsed.code}):${parsed.msg ?? parsed.message ?? clip(text)}` }
  }
  // **真机实测的形状**(2026-09-13 打了一次真上游才知道:文档那一页没写响应体):
  // `data` 是一个**数组** —— `{"code":200,"data":[{"status":"submitted","task_id":"task_…"}]}`。
  // 所以对象与数组都要认(数组取每一项;对象直接取那几个字段名)。
  const candidates: unknown[] = []
  for (const bucket of Array.isArray(parsed.data) ? parsed.data : [parsed.data]) {
    if (bucket === null || typeof bucket !== 'object') {
      candidates.push(bucket)
      continue
    }
    const record = bucket as Record<string, unknown>
    candidates.push(record.id, record.task_id, record.taskId, (record.task as Record<string, unknown> | undefined)?.id)
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return { ok: true, taskId: candidate }
  }
  return { ok: false, error: `上游说成功却没给任务 id(认得的字段都试过了):${clip(text)}` }
}

export type MusicRestPollStep =
  | { kind: 'running'; note: string }
  | { kind: 'done'; audioUrl: string }
  | { kind: 'failed'; error: string }

/** 文档里那两个字面量 + 常见变体(失败类按前缀认)。 */
const DONE_STATUS = new Set(['completed', 'complete', 'success', 'succeeded', 'finished'])
const FAILED_STATUS = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected'])

/** 报错里带原话时要截断:全贴会把一条失败撑成几 KB。 */
function clip(text: string, limit = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 在完成响应里找**音频地址**。
 *
 * **真机实测的形状**(2026-09-13,那次生成完成后 `GET /music/tasks/{id}` 的原话):
 *
 * ```jsonc
 * { "code": 200, "data": { "status": "completed", "progress": 100, "actual_time": 61,
 *   "result": { "music": [ { "audio_id": "…", "audio_url": "https://…mp3", "duration": 213.6,
 *                            "title": "雨前教室", "lyrics": "[Instrumental]", "status": "complete" }, … ] },
 *   "usage": { "amount": 0.4375, "currency": "¥" } } }
 * ```
 *
 * 所以:**`data.result.music[]`.`audio_url`** 是那条路(一次请求给**两个变体**,我们取第一个
 * —— 与 suno 那条同一取舍:多版对比是账本该管的事)。
 *
 * 但这里**不只认这一条**:先按"名字像音频/像列表"的键找(见得多的那些名字优先),
 * 再退一步**整棵树walk一遍**找 http(s) 链接 —— 因为"认不出形状"的代价是一句
 * "拿不到产物",而那时一次真生成已经花掉了(这条协议的第一版就是这么栽的:
 * 文档没写响应体,靠猜)。真的什么都没有才返回 null,由调用方**贴原话**。
 */
export function findAudioUrl(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioUrl(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  // 第一轮:名字像音频 / 像列表的键(顺序即优先级:越具体的越靠前)。
  const named = keys
    .filter((key) => /audio|music|url|file|src|stream|download|output|result|items?|clips?|tracks?|songs?|variants?|data$/i.test(key))
    .sort((a, b) => weight(a) - weight(b))
  for (const key of named) {
    const found = findAudioUrl(record[key], depth + 1)
    if (found !== null) return found
  }
  // 第二轮(**兜底**):名字一个都不像时,整棵子树里找 http(s) 链接 —— 音频扩展名优先。
  const loose: string[] = []
  const walk = (node: unknown, level: number): void => {
    if (level > 5 || loose.length > 50 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, level + 1)
      return
    }
    for (const item of Object.values(node as Record<string, unknown>)) {
      if (typeof item === 'string' && /^https?:\/\//.test(item)) loose.push(item)
      else walk(item, level + 1)
    }
  }
  walk(record, depth)
  return loose.find((url) => /\.(mp3|m4a|wav|ogg|flac)(\?|$)/i.test(url)) ?? loose[0] ?? null
}

function weight(key: string): number {
  const lower = key.toLowerCase()
  if (lower === 'audio_url' || lower === 'audiourl') return 0
  if (lower === 'music' || lower === 'musics') return 1
  if (lower.includes('audio')) return 1
  if (lower === 'url') return 2
  if (lower === 'result' || lower === 'results') return 3
  if (lower === 'items' || lower === 'data' || lower === 'clips' || lower === 'tracks') return 4
  return 5
}

/** 轮询的一步:还在跑 / 成了(音色地址)/ 上游明说失败。 */
export function readMusicRestPoll(text: string): MusicRestPollStep {
  let parsed: { code?: number; msg?: string; message?: string; data?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { kind: 'failed', error: `轮询响应不是 JSON:${clip(text)}` }
  }
  if (typeof parsed.code === 'number' && parsed.code !== 200) {
    return { kind: 'failed', error: `轮询被拒(code ${parsed.code}):${parsed.msg ?? parsed.message ?? clip(text)}` }
  }
  // **真机实测**:这一边 `data` 是**对象**(与提交那一边的数组不同!字段是
  // `{id, task_id, status, progress, estimated_time, cost, credits_cost}`)——
  // 两边形状不一样,所以两处各认各的;数组也照认(别因为形状换了就整条读不出来)。
  const data = (Array.isArray(parsed.data) ? parsed.data[0] : parsed.data) as Record<string, unknown> | undefined ?? {}
  const status = typeof data.status === 'string' ? data.status : ''
  const lower = status.toLowerCase()
  if (FAILED_STATUS.has(lower) || lower.startsWith('fail')) {
    const reason = data.error ?? data.errorMessage ?? data.message ?? parsed.msg
    return { kind: 'failed', error: `上游判定这次生成失败(${status})${typeof reason === 'string' ? `:${reason}` : ''}` }
  }
  if (DONE_STATUS.has(lower)) {
    const audioUrl = findAudioUrl(data)
    if (audioUrl === null) {
      // **不猜、也不假装成功**:认不出的形状把原话贴出来(改解析的人照着它改),
      // 而且调用方会把上游任务 id 一起记进账本(48 小时内可取回)。
      return { kind: 'failed', error: `上游说 ${status} 却在响应里找不到音频地址(把原话带回来):${clip(text, 600)}` }
    }
    return { kind: 'done', audioUrl }
  }
  // 排队 / 生成中,以及将来可能新增的中间态。**进度也报出来** ——
  // 音乐要跑几分钟,只说"还在跑"让人以为卡住了(实测那家会给 `progress` 与 `estimated_time`)。
  const progress = typeof data.progress === 'number' ? data.progress : undefined
  const estimate = typeof data.estimated_time === 'number' ? data.estimated_time : undefined
  const label = status === '' ? '上游没给状态' : status
  return {
    kind: 'running',
    note: `${label}${progress === undefined ? '' : ` ${progress}%`}${estimate === undefined ? '' : `(预计 ${estimate} 秒)`}`,
  }
}

export function createMusicRestAdapter(): AudioAdapter {
  const id: AudioAdapterId = 'async-task-rest'
  return {
    id,
    buildRequest: (input) => {
      const paths = musicRestPathsFromNote(input.model.note)
      return {
        adapter: id,
        request: {
          url: `${input.channel.baseUrl.replace(/\/+$/, '')}${paths.submit}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
              ? {}
              : { authorization: `Bearer ${input.channel.apiKey}` }),
          },
          body: JSON.stringify(buildMusicRestSubmitBody({
            // 音乐那边 `prompt` 是**制作指令**(风格/情绪/场景):灵感模式下上游按它生成。
            prompt: input.task.prompt,
            instrumental: input.model.capabilities.instrumental,
            model: paths.model,
            version: paths.version,
            format: paths.format,
          })),
        },
      }
    },
    onSubmit: (response): AudioSubmission => {
      if (response.status < 200 || response.status >= 300) {
        return { kind: 'failed', error: `提交被拒(HTTP ${response.status}):${clip(response.text, 300)}` }
      }
      const parsed = readMusicRestSubmit(response.text)
      return parsed.ok ? { kind: 'pending', taskId: parsed.taskId } : { kind: 'failed', error: parsed.error }
    },
    // 异步任务制:**id 在路径里**(这条协议与 sunoapi 那套最要紧的差别)。
    buildPollRequest: (input, taskId) => {
      const paths = musicRestPathsFromNote(input.model.note)
      const url = `${input.channel.baseUrl.replace(/\/+$/, '')}${paths.poll.replace('{id}', encodeURIComponent(taskId))}`
      return {
        url,
        method: 'GET',
        headers: {
          ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
            ? {}
            : { authorization: `Bearer ${input.channel.apiKey}` }),
        },
        body: '',
      }
    },
    poll: (response): AudioPollStep => {
      if (response.status < 200 || response.status >= 300) {
        return { kind: 'failed', error: `轮询被拒(HTTP ${response.status}):${clip(response.text, 300)}` }
      }
      const step = readMusicRestPoll(response.text)
      if (step.kind === 'running') return { kind: 'running', note: step.note }
      if (step.kind === 'failed') return { kind: 'failed', error: step.error }
      // 协议层给的是"音频 URL";`AudioPollStep` 的 `done` 正好能吃 URL,
      // 由接缝去下载(它手上有下载口)—— 见 `#awaitAudioResult`。
      return { kind: 'done', url: step.audioUrl }
    },
  }
}
