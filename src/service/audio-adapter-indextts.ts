/**
 * 本地 TTS 适配器:**IndexTTS 2.5**(`app_api.py` 那个 HTTP 服务)。
 *
 * ## 为什么是"本地 HTTP 服务"这条路(ADR-0012 的第三种形态)
 *
 * 发起人机器上有一份整合包(`yzy-index-tts-2.5-260824`),它自带一个 FastAPI 服务
 * (`app_api.py`,默认 `0.0.0.0:9005`)。**不需要把模型塞进插件**(那是几个 GB 的
 * Python 运行时 + 权重),只要把它的端点填进渠道设置 —— 这就是"内置 TTS"的可行形态。
 *
 * ## 契约(从 `app_api.py` 读出来的,不是猜的)
 *
 * | 事实 | 出处 |
 * |---|---|
 * | `POST /tts` 收 JSON,**必传** `speaker`(说话人模型名)、`audio`(音频库里的参考音频文件名)、`text` | `class TTSRequest` |
 * | 可选:`lang`(缺省 `ZH`)、`return_type`(`file` / `json`)、情感四项、采样若干 | 同上 |
 * | `return_type: "json"` → `{ok, sampling_rate, segments, path(绝对路径), filename}` | `_do_and_respond` |
 * | `return_type: "file"`(缺省)→ 直接回 **wav 字节** | 同上(POST 是 `attachment`) |
 * | 辅助读法:`GET /health`、`GET /speakers`、`GET /voices` | 路由表 |
 *
 * ## 两条决定
 *
 * 1. **`return_type` 用 `json` + 同机读文件**:我们的出网端口只拿文本,拿不了二进制;
 *    走 json 拿到服务端路径,再由适配器读那个文件(同机时那条路径就是真的)。
 *    **跨机部署不适用** —— 那种情况请走"本地批量清单"那条路(T29),别用这个适配器;
 * 2. **不做格式转换**:它出 wav,而 Ren'Py 认 wav(`AUDIO_EXTENSIONS` 里有)—— 原样落盘。
 *    想换 ogg 是发布前的独立决定(要 ffmpeg),不该藏在一个生成适配器里。
 */
import { readFile } from 'node:fs/promises'
import type { AudioAdapter, AudioAdapterId } from './audio-generation.ts'
import type { VoiceEmotion, VoiceEmotionMode } from './characters.ts'

/** 缺省说话人(服务端 `/speakers` 里常有的那个;人可以在模型目录里改)。 */
export const INDEXTTS_DEFAULT_SPEAKER = 'default'
/** 缺省语言。 */
export const INDEXTTS_DEFAULT_LANG = 'ZH'

/**
 * 模型目录里的 `note` 可以按 `speaker=xxx;audio=yyy.wav;lang=ZH` 这种**分号键值**写,
 * 用来给这个适配器补上"用哪把嗓子读"的信息。
 *
 * 为什么放在 `note` 而不是给模型条目加新字段:`speaker` / `audio` 是**这一家服务**的参数,
 * 不是音频生成的通用概念 —— 塞进通用条目会让别家适配器看到一个自己用不上的字段。
 *
 * **T32 起它只是"模型级缺省"**:真正的音色锚是**登记簿的音色档案**(每个角色一份参考样本),
 * 由任务带着进来(`task.voiceSample` / `voiceSpeaker` / `voiceLang`)。任务优先于它。
 */
export function parseIndexttsNote(note: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const piece of (note ?? '').split(';')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/**
 * 情感四档 → 服务端的 `emo_control_method` 整数值(`app_api.py:478` / `:388-399`)。
 *
 * 名字按语义起(`follow` / `reference` / `vector` / `text`),数值只在这**一处**映射 ——
 * 别处再写一遍数字,加一档时就会漏。
 */
const EMO_METHOD: Record<VoiceEmotionMode, number> = { follow: 0, reference: 1, vector: 2, text: 3 }

/**
 * 情感 → 请求体那几个键。
 *
 * **没配就一个键都不发**(不替人编一个 0):服务端缺省本来就是 `follow`(情绪跟着音色参考音频走),
 * 把它显式发出去只是复述缺省;而"面板上能调情绪"这件事靠的是**配了就真的发**。
 */
function emotionFields(emotion: VoiceEmotion | undefined): Record<string, unknown> {
  if (emotion === undefined) return {}
  const method = EMO_METHOD[emotion.mode]
  return {
    emo_control_method: method,
    ...(emotion.mode === 'reference' && emotion.refSample !== undefined ? { emo_ref_audio: emotion.refSample } : {}),
    ...(emotion.mode === 'vector' && emotion.vector !== undefined ? { emo_vector: emotion.vector } : {}),
    ...(emotion.mode === 'text' && emotion.text !== undefined ? { emo_text: emotion.text } : {}),
    ...(emotion.weight === undefined ? {} : { emo_weight: emotion.weight }),
  }
}

interface IndexttsTtsResponse {
  ok?: boolean
  path?: string
  filename?: string
  sampling_rate?: number
  segments?: number
  detail?: string
}

export function createIndexttsAdapter(): AudioAdapter {
  const id: AudioAdapterId = 'sync-http'
  return {
    id,
    buildRequest: (input) => {
      const options = parseIndexttsNote(input.model.note)
      // **`speaker` 不是音色**(T32 修掉的错位):它只选 LoRA 适配器目录
      // (`runs/exp1_<name>/`),而 `task.voiceId` 是"哪把嗓子"(登记簿 id)。
      // 拿 voiceId 去当 speaker 发,只会得到一个必然 400 的值(本机 runs/ 是空的)。
      // 于是来源只有两处:任务的音色档案 → 模型目录的缺省 → 底模。
      const speaker = input.task.voiceSpeaker ?? options.speaker ?? INDEXTTS_DEFAULT_SPEAKER
      // **参考样本必须是音色库里的文件名**(这就是音色的来源)。
      // 刻意**不**兜底到 `task.referenceAudio[0].path`:那是**项目内相对路径**,
      // 与服务端 `voices/` 是**两个命名空间**,送过去必然 400(反而把真正的病因藏起来)。
      const audio = input.task.voiceSample ?? options.audio
      if (audio === undefined || audio === '') {
        throw new Error(
          'IndexTTS 需要一个**参考样本**(音色来源,服务端音色库里的文件名):'
          + '到角色视图给这个角色记一条**音色档案**(`音色库里的文件名`,如 xiao_tang.wav),'
          + '或在模型目录的 note 里写 `audio=xiao_tang.wav`。'
          + '注意音色库是**服务端自己的 `voices/` 目录**(面板「读音色库」能看到它的绝对路径),'
          + '项目里的 `game/voice/…` 与它不是一个命名空间 —— 把文件放进那个目录,再按文件名引用。',
        )
      }
      return {
        adapter: id,
        request: {
          url: `${input.channel.baseUrl.replace(/\/+$/, '')}/tts`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
              ? {}
              : { authorization: `Bearer ${input.channel.apiKey}` }),
          },
          body: JSON.stringify({
            speaker,
            audio,
            // TTS 要读的就是**台词原文**(不是"制作指令"—— 那是音乐那边的事)。
            text: input.task.prompt,
            lang: input.task.voiceLang ?? options.lang ?? INDEXTTS_DEFAULT_LANG,
            // **必须是 json**:我们的出网端口只拿文本(见文件头第 1 条决定)。
            return_type: 'json',
            // 情感(缺省不发:服务端自己的缺省就是"跟着参考样本走")。
            ...emotionFields(input.task.voiceEmotion),
          }),
        },
      }
    },
    onSubmit: async (response) => {
      if (response.status < 200 || response.status >= 300) {
        // 上游原话带回(它的 400/500 里写的是人话:`合成失败:…`)。
        return { kind: 'failed', error: `IndexTTS 拒绝(HTTP ${response.status}):${response.text.slice(0, 300)}` }
      }
      let parsed: IndexttsTtsResponse
      try {
        parsed = JSON.parse(response.text) as IndexttsTtsResponse
      } catch {
        return { kind: 'failed', error: `IndexTTS 回的不是 JSON(拿不到产物路径):${response.text.slice(0, 200)}` }
      }
      if (typeof parsed.path !== 'string' || parsed.path === '') {
        return { kind: 'failed', error: `IndexTTS 说 ok 却没给 path:${response.text.slice(0, 200)}` }
      }
      // 读那个 wav(**同机部署**才成立;见文件头第 1 条决定)。
      try {
        const bytes = await readFile(parsed.path)
        return { kind: 'bytes', bytes, contentType: 'audio/wav' }
      } catch (error) {
        return {
          kind: 'failed',
          error: `IndexTTS 生成了 ${parsed.path} 但我们读不到(${error instanceof Error ? error.message : String(error)})—— `
            + '这个适配器要求服务与插件在**同一台机器**上;跨机请改用"本地批量清单"那条路。',
        }
      }
    },
  }
}
