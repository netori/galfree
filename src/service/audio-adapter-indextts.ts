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
      // `voiceId` 优先(面板/工具能按角色给),否则模型目录里写死的,最后才是缺省。
      const speaker = input.task.voiceId ?? options.speaker ?? INDEXTTS_DEFAULT_SPEAKER
      // 参考音频**必传**(这就是音色的来源)。给不出就如实拒绝 ——
      // 拿空字符串去撞 400 只会得到一句没有上下文的"合成失败"。
      const audio = options.audio ?? input.task.referenceAudio[0]?.path
      if (audio === undefined || audio === '') {
        throw new Error(
          'IndexTTS 需要一个**参考音频**(音色来源):在模型目录的 note 里写 `speaker=<说话人>;audio=<音频库里的文件名.wav>`,'
          + '或给这个任务挂一条 referenceAudio —— 两者都没有时它不知道该用谁的声音。',
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
            lang: options.lang ?? INDEXTTS_DEFAULT_LANG,
            // **必须是 json**:我们的出网端口只拿文本(见文件头第 1 条决定)。
            return_type: 'json',
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
