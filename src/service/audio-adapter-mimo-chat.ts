/**
 * **小米 MiMo TTS 适配器**(`mimo-chat-tts`)—— 走它家的 `POST {base}/chat/completions`。
 *
 * ## 为什么单列一条协议
 *
 * 它的形状与现有四条**都不同**(2026-09-26 真机探针实测,不是读文档猜的):
 *
 * | | 请求 | 响应 |
 * |---|---|---|
 * | `openai-speech` | `POST {base}/audio/speech` + `{model, input, voice, response_format}` | **响应体就是音频字节** |
 * | `async-task*` | 提交 → 拿任务 id → 轮询 → 再下载 URL | JSON + 音频 URL |
 * | **`mimo-chat-tts`** | `POST {base}/chat/completions`,**要念的文本放 `role:"assistant"` 的消息里**,`audio:{format, voice}` | **JSON**,音频在 `choices[0].message.audio.data`(**base64**) |
 *
 * 三处都不一样:路径、请求体形状(文本不是 `input` 而是消息)、响应形状(不是字节、也不是 URL)。
 * ADR-0012 的原话是"适配器按协议收,不按厂商收" —— 但这条协议的**形状**确实是这家独有的,
 * 所以按形状命名(`chat-tts`),而不是按厂商命名。
 *
 * ## 实测拿到的四条事实(探针 `--` 全部当场验过)
 *
 * 1. **音频在** `choices[0].message.audio.data`,是 **base64**;解出来 30552 / 34608 字节,
 *    ffprobe 认成 24kHz 单声道 mp3(3.84s / 4.96s)。
 * 2. **`format` 真的生效**:请求 `mp3` 回 `ff f3 84 c4`(MP3 帧同步),请求 `wav` 回 `52 49 46 46`(RIFF)。
 *    ⇒ 所以**格式按请求参数判**,不按 magic 猜(猜错就是把 mp3 字节写成 `.wav`)。
 * 3. `audio.transcript` / `audio.expires_at` **两次都返回 `null`** ⇒ 一律不依赖它们。
 * 4. `usage` 按 token 报(`prompt_tokens` / `completion_tokens` / `cached_tokens`)——
 *    注意这与那家网关的"按秒/按次"不是一套口径。
 *
 * ## 音色:**登记簿的音色档案优先**,模型目录的 `note` 只是缺省
 *
 * 与 `openai-speech` 那条同一取舍(见它的注释):同一个字段认不同形态,
 * 由角色自己的音色档案说了算 —— 因为"哪个角色用哪把嗓子"是**每个角色**的事,
 * 挂在模型目录上会变成"全书一个嗓子"。
 *
 * | 模型 | `voiceSample` 填什么 |
 * |---|---|
 * | `mimo-v2.5-tts` | **预置音色 id**(`冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / …) |
 * | `mimo-v2.5-tts-voicedesign` | **这个角色的音色描述文字**(一句话,如"年轻女性,清澈偏冷,语速稍慢") |
 * | `mimo-v2.5-tts-voiceclone` | **暂不支持**(见下) |
 *
 * ## 两条如实标注的能力边界(不假装支持)
 *
 * · **`voiceclone` 没接**:它要 `audio.voice` 里塞**音频样本的 base64**(那家平台没有上传接口,
 *   样本只能随每次请求重发;真机样本量级 20–80KB/次)。这条路的成本形状与别的都不同,
 *   要单独验证 prompt cache 是否命中(探针里 `cached_tokens` 有值,是**线索不是结论**),
 *   所以**先不接** —— 现在传 `-voiceclone` 的 model id 会被明确拒绝,而不是发一个形状不对的请求。
 * · **情感只认 `text` 与 `vector` 两档**:`text` 直接当指令发;`vector`(8 维)转成强度短语
 *   (≥0.7 强 / ≥0.4 偏 / 否则略);`follow` 与 `reference` **一个指令都不发**
 *   (小米没有"情感参考音频"这个入参,硬映射就是编——而不发等于让模型按文本自身情绪演,
 *   这是这家服务的缺省行为,不是降级)。强度 `weight` 对 `vector` 档生效。
 *
 * ## 风格标签(`label=`)怎么写
 *
 * 小米认 `(风格)` 前缀:`(唱歌)` / `(东北话)` / `(怒吼)` 一类。本适配器**只加一个前缀**,
 * 不做风格词表(那会变成"插件替模型编风格");要带语气就在 `note` 里写 `label=…`。
 */
import type { AudioAdapter, AudioAdapterId, AudioAdapterInput, AudioSubmission } from './audio-generation.ts'
import type { VoiceEmotion, VoiceEmotionMode } from './characters.ts'
import { parseIndexttsNote } from './audio-adapter-indextts.ts'

/** 缺省输出格式(实测 `format` 生效;Ren'Py 认 mp3)。 */
export const MIMO_DEFAULT_FORMAT = 'mp3'

/** 这条协议默认的端点路径(相对 baseUrl)。 */
export const MIMO_CHAT_PATH = '/chat/completions'

/** 小米三个模型的 id(路由到哪条行为按它判)。 */
export const MIMO_MODEL_PRESET = 'mimo-v2.5-tts'
export const MIMO_MODEL_VOICEDESIGN = 'mimo-v2.5-tts-voicedesign'
export const MIMO_MODEL_VOICECLONE = 'mimo-v2.5-tts-voiceclone'

/** 8 维情感向量的中文名(顺序**不能改**:与登记簿 `characters.ts` 的约定一致)。 */
const EMO_VECTOR_LABELS = ['喜', '怒', '哀', '惧', '厌恶', '低落', '惊喜', '平静'] as const

/** 情感档位 → 数值(只在这一处映射;与 IndexTTS 那条同一个态度)。 */
const EMO_MODE: Record<VoiceEmotionMode, number> = { follow: 0, reference: 1, vector: 2, text: 3 }

/**
 * 情感 → **`user` 消息里的自然语言指令**(或者不发)。
 *
 * 返回 `undefined` = **不发 user 消息**:小米的 `user` 是可选的,缺省行为是"按文本自身情绪演"。
 * 为什么不"至少发一句中性的话":那会覆盖服务端缺省,把我们自己的猜测塞进去 ——
 * 与"没配就一个键都不发"同一个纪律(见 `audio-adapter-indextts.ts` 的 `emotionFields`)。
 */
export function mimoEmotionInstruction(emotion: VoiceEmotion | undefined): string | undefined {
  if (emotion === undefined) return undefined
  if (EMO_MODE[emotion.mode] === 3) {
    const text = emotion.text?.trim()
    return text === undefined || text === '' ? undefined : text
  }
  if (EMO_MODE[emotion.mode] === 2) {
    const vector = emotion.vector
    if (vector === undefined || vector.length !== 8) return undefined
    // 取最强的两维当"情绪词",强度落到短语上 —— 8 个数原样发过去这家看不懂。
    const liked = vector
      .map((value, index) => ({ value, label: EMO_VECTOR_LABELS[index]! }))
      .filter((item) => Number.isFinite(item.value) && item.value > 0.2)
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
    if (liked.length === 0) return undefined
    const peak = liked[0]!.value
    const strength = peak >= 0.7 ? '强烈地' : peak >= 0.4 ? '明显地' : '略带'
    return `用${strength}${liked.map((item) => item.label).join('、')}的语气念。`
  }
  // `follow`(情绪跟着音色样本走)与 `reference`(情感参考音频)在这家**没有对应入参** ——
  // 不编一个指令替它,让它用服务端缺省。
  return undefined
}

/** 语言 → 小米的标签写法(`(中文)` / `(英文)` / …)。认不出的语言**不加标签**(不猜)。 */
const MIMO_LANG_LABELS: Record<string, string> = {
  zh: '中文', cn: '中文', chinese: '中文',
  en: '英文', english: '英文',
  ja: '日文', jp: '日文', japanese: '日文',
  ko: '韩文', korean: '韩文',
  yue: '粤语', cantonese: '粤语',
}

export function mimoLangLabel(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined
  return MIMO_LANG_LABELS[lang.trim().toLowerCase()]
}

/**
 * 从响应里取音频 base64 —— **认不出就返回 `null`**,由调用方贴原话如实报错。
 *
 * 只认 `choices[0].message.audio.data` 这一条(`/health` 那种"猜一棵树"的做法在这里不必要:
 * 形状是**实测**出来的,不是猜的)。认不出时把顶层键名带回去,方便下次定位。
 */
export function readMimoAudio(text: string): { ok: true; base64: string } | { ok: false; error: string } {
  let parsed: {
    choices?: Array<{ message?: { audio?: { data?: unknown }; content?: unknown } }>
    error?: { message?: unknown }
    usage?: unknown
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, error: `响应不是 JSON(前 300 字):${clip(text)}` }
  }
  const audio = parsed.choices?.[0]?.message?.audio
  const data = audio?.data
  if (typeof data === 'string' && data !== '') return { ok: true, base64: data }
  const upstream = typeof parsed.error?.message === 'string' ? `上游原话:${parsed.error.message}` : ''
  return {
    ok: false,
    error: `响应里没有 \`choices[0].message.audio.data\`(这条协议的音频在那儿)${upstream === '' ? '' : `;${upstream}`}`
      + `;顶层键:${Object.keys(parsed).join(', ')};响应前 300 字:${clip(text)}`,
  }
}

function clip(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * `voiceSample` → `audio.voice`,或者一句**可执行**的拒绝。
 *
 * 三条分支都**不猜默认嗓子**:猜错的形态是"声音不对",而那要到听成品才发现 ——
 * 与 `openai-speech` 那条的措辞同源。
 */
export function mimoVoiceField(modelId: string, voiceSample: string | undefined, noteVoice: string | undefined): string | undefined {
  const sample = voiceSample !== undefined && voiceSample.trim() !== '' ? voiceSample.trim() : undefined
  if (modelId === MIMO_MODEL_VOICECLONE) return undefined // 调用方单独拒绝
  if (modelId === MIMO_MODEL_VOICEDESIGN) {
    // voicedesign 的"音色"就是**用户消息里那段描述** —— 它不是 audio.voice 字段。
    return undefined
  }
  return sample ?? (noteVoice === undefined || noteVoice === '' ? undefined : noteVoice)
}

export function createMimoChatTtsAdapter(): AudioAdapter {
  const id: AudioAdapterId = 'mimo-chat-tts'
  return {
    id,
    buildRequest: (input: AudioAdapterInput) => {
      const options = parseIndexttsNote(input.model.note)
      const modelId = input.model.id

      if (modelId === MIMO_MODEL_VOICECLONE) {
        throw new Error(
          '`mimo-v2.5-tts-voiceclone` 这条路**插件还没接**:它要 `audio.voice` 里塞音频样本的 base64,'
          + '而那家平台没有上传接口 —— 样本只能随**每一次**请求重发(实测样本量级 20–80KB/次),'
          + '一部戏几百句台词就是几百次重发。它不是形状问题,是**成本形状**问题,所以要先单独验证过再接。'
          + '现在请改用 `mimo-v2.5-tts-voicedesign`(每个角色一段音色描述,零成本携带)。',
        )
      }

      const voice = mimoVoiceField(modelId, input.task.voiceSample, options.voice)
      if (modelId === MIMO_MODEL_PRESET && (voice === undefined || voice === '')) {
        throw new Error(
          '这条上游要一个**预置音色 id**(`audio.voice`),而角色的音色档案与模型目录的 note 里都没有:'
          + '到角色视图给这个角色记一条音色档案,`sample` 填**小米那边的预置音色名**'
          + '(`冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean`),'
          + '或在模型目录的 note 里写 `voice=冰糖` 当缺省。**不替你猜一个默认嗓子**。',
        )
      }

      // voicedesign:音色 = user 消息里那段描述。**没给描述就直接拒绝** ——
      // 少了它这个模型等于没有音色输入(它不支持预置音色),产出的嗓子只能靠运气。
      const designText = modelId === MIMO_MODEL_VOICEDESIGN
        ? (input.task.voiceSample?.trim() ?? '')
        : ''
      if (modelId === MIMO_MODEL_VOICEDESIGN && designText === '') {
        throw new Error(
          '`mimo-v2.5-tts-voicedesign` 的音色**就是** `user` 消息里那段描述文字,而角色的音色档案是空的:'
          + '到角色视图给这个角色写一句音色描述(如"年轻女性,清澈偏冷,语速稍慢,句尾轻微气声")—— '
          + '这个模型不支持预置音色,没描述就没有音色依据。',
        )
      }

      // 情感指令与音色描述**是同一格**(都是 user 消息):
      // · voicedesign → 音色描述是必需的,情感指令追加在后;
      // · 其余模型 → 情感指令就是全部(没有就**不发** user 消息)。
      const emotion = mimoEmotionInstruction(input.task.voiceEmotion)
      const instruction = [designText === '' ? undefined : designText, emotion]
        .filter((piece): piece is string => piece !== undefined && piece !== '')
        .join(' ')
      const lang = MIMO_LANG_LABELS[(input.task.voiceLang ?? '').trim().toLowerCase()]
      const label = options.label !== undefined && options.label !== '' ? options.label : lang
      // 风格标签是小米在**目标文本开头**认的写法(`(唱歌)` / `(东北话)`);不写就不加。
      const spoken = label === undefined ? input.task.prompt : `(${label})${input.task.prompt}`

      const format = input.task.format ?? options.format ?? MIMO_DEFAULT_FORMAT
      const userMessages: Array<{ role: string; content: string }> = instruction === ''
        ? []
        : [{ role: 'user', content: instruction }]

      return {
        adapter: id,
        request: {
          url: `${input.channel.baseUrl.replace(/\/+$/, '')}${MIMO_CHAT_PATH}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
              ? {}
              // 实测两种鉴权都行(`api-key:` 与 `Authorization: Bearer`);用标准的那个。
              : { authorization: `Bearer ${input.channel.apiKey}` }),
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              ...userMessages,
              // **要念的文本必须在 assistant 消息里**(小米文档的硬规矩:放 user 里会被当成指令)。
              { role: 'assistant', content: spoken },
            ],
            audio: {
              format,
              ...(voice === undefined ? {} : { voice }),
            },
          }),
        },
      }
    },

    onSubmit: (response): AudioSubmission => {
      if (response.status !== 200) {
        // 401 的措辞单独给一句可执行的:这家把"密钥不对"回成 `{"error":{"type":"invalid_key"}}`。
        const hint = response.status === 401 || response.status === 403
          ? ' —— 密钥没被接受(检查设置里那条语音渠道的密钥,或它是否还有效)。'
          : ''
        return { kind: 'failed', error: `上游回了 HTTP ${response.status}${hint}原话:${clip(response.text, 400)}` }
      }
      const read = readMimoAudio(response.text)
      if (!read.ok) return { kind: 'failed', error: read.error }
      // base64 → 字节;**解不出就如实报错**,不写一个空文件进项目。
      const bytes = Buffer.from(read.base64, 'base64')
      if (bytes.byteLength === 0) {
        return { kind: 'failed', error: `响应里的音频字段是空 base64(长度 ${read.base64.length})` }
      }
      return { kind: 'bytes', bytes: new Uint8Array(bytes) }
    },
  }
}
