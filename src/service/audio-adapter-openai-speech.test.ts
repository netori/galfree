/**
 * **OpenAI 兼容语音**适配器(T36)守卫 —— **协议层,纯函数**,不发真请求。
 *
 * 这一条协议值得单列是因为它的**响应形状**与别家都不同:**响应体就是音频**。
 * 而 `sync-http`(IndexTTS)那条是"回 JSON、再去拿"。一条适配器同时认两种形状,
 * 结果就是"看着配好了、拿到一堆乱码"——所以按协议各收各的(ADR-0012 的原话)。
 *
 * 守卫盯四件事:
 *  1. **请求形状**(路径 / 字段名 / 密钥走哪);
 *  2. **响应体就是音频** ⇒ 给出字节 + contentType;
 *  3. **没有音色名字就如实拒绝**,不替人猜一个默认嗓子(猜错要到听成品才发现);
 *  4. **端口没给字节时不许拿 `text` 冒充音频**(那是把二进制按文本解码:坏的,且看不出来)。
 */
import { describe, expect, it } from 'vitest'
import { createOpenAiSpeechAdapter, OPENAI_SPEECH_DEFAULT_FORMAT } from './audio-adapter-openai-speech.ts'
import type { AudioAdapterInput, AudioModelDescriptor } from './audio-generation.ts'

const adapter = createOpenAiSpeechAdapter()

function input(overrides: {
  note?: string
  voiceSample?: string
  format?: string
  prompt?: string
  apiKey?: string
  modelId?: string
} = {}): AudioAdapterInput {
  const model: AudioModelDescriptor = {
    id: overrides.modelId ?? 'FunAudioLLM/CosyVoice2-0.5B',
    purpose: 'voice',
    adapter: 'openai-speech',
    capabilities: { textToMusic: false, instrumental: false, lyrics: false, audioReference: false, textToSpeech: true, voiceCloning: true, voiceId: true },
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  }
  return {
    channel: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: overrides.apiKey ?? 'sk-test', models: [model] },
    model,
    task: {
      purpose: 'voice',
      prompt: overrides.prompt ?? '今天天气不错。',
      ...(overrides.format === undefined ? {} : { format: overrides.format }),
      dialogueId: 'c09_two_umbrellas_0003',
      ...(overrides.voiceSample === undefined ? {} : { voiceSample: overrides.voiceSample }),
      referenceAudio: [],
    },
  }
}

function bodyOf(plan: ReturnType<typeof adapter.buildRequest>): Record<string, unknown> {
  return JSON.parse(plan.request.body) as Record<string, unknown>
}

describe('OpenAI 兼容语音适配器', () => {
  it('请求形状:POST {base}/audio/speech,字段名是 model / input / voice / response_format', () => {
    const plan = adapter.buildRequest(input({ voiceSample: 'FunAudioLLM/CosyVoice2-0.5B:alex' }))

    expect(plan.adapter).toBe('openai-speech')
    expect(plan.request.method).toBe('POST')
    // 基址尾斜杠不该被写进路径(否则 `//audio/speech`)。
    expect(plan.request.url).toBe('https://api.siliconflow.cn/v1/audio/speech')
    // 密钥走 Authorization(这条协议是 Bearer)。
    expect(plan.request.headers.authorization).toBe('Bearer sk-test')
    expect(plan.request.headers['content-type']).toBe('application/json')

    const body = bodyOf(plan)
    // 这条协议里"要念的文本"叫 `input`,不是 `text` —— 名字错一个就整个不通。
    expect(body.input).toBe('今天天气不错。')
    expect(body.model).toBe('FunAudioLLM/CosyVoice2-0.5B')
    expect(body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:alex')
    expect(body.response_format).toBe(OPENAI_SPEECH_DEFAULT_FORMAT)
  })

  it('音色:任务的音色档案优先,其次模型目录 note 里的 voice=', () => {
    // 只有 note
    expect(bodyOf(adapter.buildRequest(input({ note: 'voice=alloy' }))).voice).toBe('alloy')
    // 任务压过 note(角色自己的嗓子说了算)
    expect(bodyOf(adapter.buildRequest(input({ note: 'voice=alloy', voiceSample: 'nova' }))).voice).toBe('nova')
  })

  it('**没有音色名字就如实拒绝**,不替人猜一个默认嗓子', () => {
    // 猜错的形态是"这个角色的声音不对",而那要到听成品才发现 —— 所以宁可不发。
    let message = ''
    try { adapter.buildRequest(input()) } catch (error) { message = (error as Error).message }
    expect(message).toContain('音色')
    // 错误里要说清去哪填(音色档案的 sample 在这一条协议里指的是上游的 voice 名)
    expect(message).toContain('音色档案')
    expect(message).toContain('voice=')
  })

  it('回应格式:任务给了就用它;note 里的 format= 也能覆盖;缺省 mp3', () => {
    expect(bodyOf(adapter.buildRequest(input({ voiceSample: 'x', format: 'wav' }))).response_format).toBe('wav')
    expect(bodyOf(adapter.buildRequest(input({ voiceSample: 'x', note: 'voice=a;format=opus' }))).response_format).toBe('opus')
    expect(bodyOf(adapter.buildRequest(input({ voiceSample: 'x' }))).response_format).toBe('mp3')
  })

  it('**响应体就是音频** ⇒ 直接给字节(还带上 contentType)', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]) // 'ID3…'
    const submission = await adapter.onSubmit({ status: 200, text: '', bytes, contentType: 'audio/mpeg' }, input({ voiceSample: 'x' }).model)

    expect(submission.kind).toBe('bytes')
    if (submission.kind !== 'bytes') throw new Error('应当是 bytes')
    expect(submission.bytes).toEqual(bytes)
    expect(submission.contentType).toBe('audio/mpeg')
  })

  it('**端口没给字节就不许拿 text 冒充音频**(如实报错,不产坏产物)', async () => {
    // 这条是这一票的要害:响应体是音频,而老端口只回文本 ——
    // 把音频按文本解码得到的东西是坏的,**而且坏得看不出来**。
    const submission = await adapter.onSubmit(
      { status: 200, text: '�ID3\u0004\u0000\u0000' },
      input({ voiceSample: 'x' }).model,
    )
    expect(submission.kind).toBe('failed')
    if (submission.kind !== 'failed') throw new Error('应当是 failed')
    expect(submission.error).toContain('没给回字节')
    expect(submission.error).toContain('报给插件作者')
  })

  it('上游非 200:原话带回来(不吞成"失败了")', async () => {
    const submission = await adapter.onSubmit(
      { status: 401, text: '{"error":{"message":"Invalid API key"}}' },
      input({ voiceSample: 'x' }).model,
    )
    expect(submission.kind).toBe('failed')
    if (submission.kind !== 'failed') throw new Error('应当是 failed')
    expect(submission.error).toContain('401')
    expect(submission.error).toContain('Invalid API key')
  })

  it('200 但是空体:也算失败(不产 0 字节的"产物")', async () => {
    const submission = await adapter.onSubmit(
      { status: 200, text: '', bytes: new Uint8Array(0), contentType: 'audio/mpeg' },
      input({ voiceSample: 'x' }).model,
    )
    expect(submission.kind).toBe('failed')
  })
})
