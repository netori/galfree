/**
 * 音乐适配器:**Suno 类聚合站**(发起人指定的那家图像聚合商,模型 `suno-generation`)。
 *
 * ## 协议事实从哪来(不是猜的)
 *
 * 那家聚合商是**图像**聚合站,音乐接口没有公开文档可查;但它卖的模型叫 `suno-generation`,
 * 而 Suno 类聚合站的协议已经收敛成一套事实标准 —— 下面每一步都对着
 * [sunoapi.org 的公开文档](https://docs.sunoapi.org/cn/suno-api/generate-music)核过:
 *
 * | 事实 | 出处 |
 * |---|---|
 * | 提交:`POST /api/v1/generate` → `{code:200, msg, data:{taskId}}` | 生成音乐那一页 |
 * | 提交体:`customMode` / `instrumental` / `model` / `callBackUrl` **必填**;`prompt`(非自定义模式下始终必填);`style`/`title` 只在自定义模式必填;可选 `vocalGender` / `styleWeight` / `weirdnessConstraint` / `audioWeight` / `negativeTags` / `duration` / `personaId`… | 同上 |
 * | 轮询:`GET /api/v1/generate/record-info?taskId=…` → `data.status`(见下)+ `data.response.sunoData[]` | 获取音乐生成详情那一页 |
 * | 状态:`PENDING` → `TEXT_SUCCESS` → `FIRST_SUCCESS` → `SUCCESS`;失败:`CREATE_TASK_FAILED` / `GENERATE_AUDIO_FAILED` / `CALLBACK_EXCEPTION` / `SENSITIVE_WORD_ERROR` | 同上 |
 * | 产物:每条 `sunoData[i]` 给 `audio_url`(**mp3 链接**)与 `duration`;纯音乐不含歌词 | 同上 |
 * | `callBackUrl` 必填但**可以给一个用不上的值** —— 文档明说"也可以使用详情接口轮询任务状态" | 同上 |
 *
 * ## 两条工程决定
 *
 * 1. **只用轮询,不用回调**:回调要一个**公网可达**的地址,而本插件跑在用户本机;
 *    文档允许用详情接口轮询,所以 `callBackUrl` 填一个占位(如实写在注释里,不假装我们有回调);
 * 2. **路径与模型名可覆盖**:那家聚合商的路径未必与 sunoapi 逐字相同,所以
 *    `note` 里可以写 `submit=/api/v1/generate;record=/api/v1/generate/record-info;model=V6`
 *    覆盖缺省 —— 这正是 ADR-0012"端点可填、不写死厂商"那条边界的落实。
 */

/** 提交路径(缺省;可在模型目录的 `note` 里覆盖)。 */
export const SUNO_SUBMIT_PATH = '/api/v1/generate'
/** 轮询路径(缺省;同上)。 */
export const SUNO_RECORD_PATH = '/api/v1/generate/record-info'
/** 缺省模型版本。 */
export const SUNO_DEFAULT_MODEL = 'V6'
/**
 * 回调地址的**占位值**。
 *
 * 文档把 `callBackUrl` 列为必填,但同时说明"也可以使用详情接口轮询任务状态"。
 * 我们只用轮询,所以这里给一个**明确的占位**(本机地址,没人会收到它)——
 * 不编一个假域名,也不假装我们有公网回调。
 */
export const SUNO_CALLBACK_PLACEHOLDER = 'http://127.0.0.1:1/galfree-no-callback'

export interface SunoPaths {
  submit: string
  record: string
  model: string
}

/** 从模型目录的 `note` 里读覆盖项;认不出的键忽略(不因为一个错字就整条不可用)。 */
export function sunoPathsFromNote(note: string | undefined): SunoPaths {
  const overrides: Record<string, string> = {}
  for (const piece of (note ?? '').split(';')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    overrides[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim()
  }
  return {
    submit: overrides.submit ?? SUNO_SUBMIT_PATH,
    record: overrides.record ?? SUNO_RECORD_PATH,
    model: overrides.model ?? SUNO_DEFAULT_MODEL,
  }
}

/** 提交体(**非自定义模式**:只给 prompt,歌词由上游自动生成)。 */
export function buildSunoSubmitBody(input: {
  prompt: string
  instrumental: boolean
  model: string
  /** 纯人声/纯音乐之外,还想**排除**的风格(可选)。 */
  negativeTags?: string
  /** 时长(秒;只有 V5_5/V6 系列支持 —— 不支持的模型会忽略它,这里不假装一定有)。 */
  durationSeconds?: number
}): Record<string, unknown> {
  return {
    // 非自定义模式:参数最少、最不容易撞"必填字段"的 400;发起人也说了"大部分音乐只需要纯音乐"。
    customMode: false,
    instrumental: input.instrumental,
    model: input.model,
    callBackUrl: SUNO_CALLBACK_PLACEHOLDER,
    prompt: input.prompt,
    ...(input.negativeTags === undefined || input.negativeTags === '' ? {} : { negativeTags: input.negativeTags }),
    ...(input.durationSeconds === undefined ? {} : { duration: input.durationSeconds }),
  }
}

/** 提交响应 → taskId,或者一句**可执行**的拒绝。 */
export function readSunoSubmit(text: string): { ok: true; taskId: string } | { ok: false; error: string } {
  let parsed: { code?: number; msg?: string; data?: { taskId?: string } }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: `提交响应不是 JSON:${text.slice(0, 200)}` }
  }
  if (parsed.code !== 200) {
    // 它的 code 是一张**有语义的表**(429 = 积分不足、430 = 频率过高、405 = 超限…),
    // 所以原样带上 —— 让人一眼看出是"没钱了"还是"太快了",而不是一句"提交失败"。
    return { ok: false, error: `上游拒绝(code ${parsed.code ?? '?'}):${parsed.msg ?? text.slice(0, 200)}` }
  }
  const taskId = parsed.data?.taskId
  if (typeof taskId !== 'string' || taskId === '') {
    return { ok: false, error: `上游说成功却没给 taskId:${text.slice(0, 200)}` }
  }
  return { ok: true, taskId }
}

/** 轮询的一步:还在跑 / 成了(给音频 URL)/ 上游明说失败。 */
export type SunoPollStep =
  | { kind: 'running'; note: string }
  | { kind: 'done'; audioUrl: string; durationSeconds?: number }
  | { kind: 'failed'; error: string }

/** 文档里那几个终态(失败类的名字见文件头表格)。 */
const SUNO_FAILED_STATUS = new Set(['CREATE_TASK_FAILED', 'GENERATE_AUDIO_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR'])

export function readSunoPoll(text: string): SunoPollStep {
  let parsed: {
    code?: number
    msg?: string
    data?: { status?: string; errorMessage?: string; response?: { sunoData?: Array<{ audio_url?: string; duration?: number }> } }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { kind: 'failed', error: `轮询响应不是 JSON:${text.slice(0, 200)}` }
  }
  if (parsed.code !== 200) {
    return { kind: 'failed', error: `轮询被拒(code ${parsed.code ?? '?'}):${parsed.msg ?? text.slice(0, 200)}` }
  }
  const status = parsed.data?.status ?? ''
  if (SUNO_FAILED_STATUS.has(status)) {
    return { kind: 'failed', error: `上游判定这次生成失败(${status})${parsed.data?.errorMessage === undefined ? '' : `:${parsed.data.errorMessage}`}` }
  }
  if (status === 'SUCCESS') {
    // 一次请求会生成**多个变体**;我们只取第一个 —— 想让人挑的话那是"多版历史"该管的事,
    // 而我们的账本本来就是"一次尝试一份产物 + 可重 roll"。
    const first = parsed.data?.response?.sunoData?.[0]
    if (first?.audio_url === undefined || first.audio_url === '') {
      return { kind: 'failed', error: '上游说 SUCCESS 却没给 audio_url(拿不到产物)' }
    }
    return {
      kind: 'done',
      audioUrl: first.audio_url,
      ...(typeof first.duration === 'number' ? { durationSeconds: first.duration } : {}),
    }
  }
  // PENDING / TEXT_SUCCESS / FIRST_SUCCESS,以及将来可能新增的中间态。
  return { kind: 'running', note: status === '' ? '上游没给状态' : status }
}
