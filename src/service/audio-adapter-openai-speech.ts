/**
 * **OpenAI 兼容的语音合成**适配器:`POST {base}/audio/speech`。
 *
 * ## 为什么单列一条协议(而不是把 `sync-http` 那条改宽)
 *
 * 差别不在路径字符串,而在**响应形状**:
 *
 * | | 请求 | 响应 |
 * |---|---|---|
 * | `sync-http`(IndexTTS) | `POST {base}/tts` + `{speaker, audio, text, lang, return_type}` | **JSON**(服务端路径),再去读那个文件 |
 * | `openai-speech` | `POST {base}/audio/speech` + `{model, input, voice, response_format}` | **响应体就是音频字节** |
 *
 * 一条适配器同时认两种响应形状,结果就是"看着配好了、跑起来拿到的是一堆乱码"。
 * 所以按 ADR-0012 的原话 —— **适配器按协议收,不按厂商收** —— 各收各的。
 *
 * ## 它一条覆盖一大类
 *
 * 硅基流动(`FunAudioLLM/CosyVoice2-0.5B`、`IndexTeam/IndexTTS-2`、fish-speech 都挂在它下面)、
 * OpenAI 自己的 `tts-1` / `gpt-4o-mini-tts`、以及绝大多数"OpenAI 兼容"的中转网关 ——
 * 都是这一个形状。**云端 TTS 由此第一次能配成插件的一条渠道**(此前只有 IndexTTS 形状的
 * `sync-http`,而它要服务端音色库文件名、还只能同机读盘)。
 *
 * ## 音色:用上游的 `voice` **名字**,不是参考音频
 *
 * 这条协议里"哪把嗓子"= `voice` 字段的一个**名字**(如 `alloy`、
 * `FunAudioLLM/CosyVoice2-0.5B:alex`、或硅基流动上传后得到的
 * `speech:<名字>:<id>:<token>`)。它不是文件、也不是服务端音色库里的文件名 ——
 * 与 IndexTTS 那条的"参考样本"是**两个概念**。
 *
 * 取值顺序:**角色的音色档案(`task.voiceSample`)→ 模型目录 `note` 里的 `voice=`**。
 * 两处都没有就**如实拒绝**,不替人猜一个默认嗓子 —— 猜错的形态是"听起来不对劲",
 * 而那种错在成品里才被发现。
 *
 * ## 参数覆盖(都写在模型目录的 `note` 里,分号分隔)
 *
 * `voice=名字`(缺省嗓子)、`format=mp3`(回应格式;也认 `response_format=`)、
 * `speed=1.0`(语速)。`note` 是这家服务的参数,不进通用条目 —— 与 IndexTTS 那条同一态度。
 */
import type { AudioAdapter, AudioAdapterId } from './audio-generation.ts'
import { parseIndexttsNote } from './audio-adapter-indextts.ts'

/** 这条协议的缺省回应格式(Ren'Py 认 mp3;想换 ogg 得自己转 —— 本适配器不做转码)。 */
export const OPENAI_SPEECH_DEFAULT_FORMAT = 'mp3'

/** 模型目录 `note` 里那几个键的解析(与 IndexTTS 那条共用一份分号键值解析)。 */
export { parseIndexttsNote as parseSpeechNote }

export function createOpenAiSpeechAdapter(): AudioAdapter {
  const id: AudioAdapterId = 'openai-speech'
  return {
    id,
    buildRequest: (input) => {
      const options = parseIndexttsNote(input.model.note)
      // **音色只从两处来**:角色的音色档案 → 模型目录的缺省。都没有就不猜。
      const voice = input.task.voiceSample ?? options.voice
      if (voice === undefined || voice === '') {
        throw new Error(
          '这条上游要一个**音色名字**(`voice` 字段),而任务与模型目录里都没有:'
          + '到角色视图给这个角色记一条**音色档案**(这一条协议里 `sample` 填的不是文件名,'
          + '而是**上游那边的音色名**:OpenAI 是 `alloy` 这类,硅基流动是'
          + '`FunAudioLLM/CosyVoice2-0.5B:alex` 或上传音色后拿到的 `speech:<名字>:…`),'
          + '或在模型目录的 note 里写 `voice=<名字>` 当缺省。'
          + '**不替你猜一个默认嗓子** —— 猜错只会得到"声音不对",而那要到听成品才发现。',
        )
      }
      const format = input.task.format ?? options.format ?? options.response_format ?? OPENAI_SPEECH_DEFAULT_FORMAT
      const speed = options.speed
      return {
        adapter: id,
        request: {
          url: `${input.channel.baseUrl.replace(/\/+$/, '')}/audio/speech`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
              ? {}
              : { authorization: `Bearer ${input.channel.apiKey}` }),
          },
          body: JSON.stringify({
            model: input.model.id,
            // 这条协议里"要念的文本"就叫 `input`(不是 `text`)。
            input: input.task.prompt,
            voice,
            response_format: format,
            ...(speed === undefined || speed === '' ? {} : { speed: Number(speed) }),
          }),
        },
      }
    },

    onSubmit: (response) => {
      if (response.status !== 200) {
        return {
          kind: 'failed',
          error: `上游回了 HTTP ${response.status}:${response.text.slice(0, 400)}`,
        }
      }
      // **响应体就是音频**。拿不到字节就如实报错 ——
      // 绝不把 `text` 拿去当音频用:那是把二进制按文本解码,产物是坏的、而且坏得看不出来。
      if (response.bytes === undefined || response.bytes.byteLength === 0) {
        return {
          kind: 'failed',
          error: '上游回了 200,但出网端口没给回字节(这条协议的产物**就在响应体里**,不是 JSON、也没有 URL 可再取)。'
            + '看不到音频字节说明这一格能力没接上 —— 请把这条报给插件作者。'
            + `响应开头:${response.text.slice(0, 200)}`,
        }
      }
      return {
        kind: 'bytes',
        bytes: response.bytes,
        ...(response.contentType === undefined || response.contentType === '' ? {} : { contentType: response.contentType }),
      }
    },
  }
}
