/**
 * **小米 MiMo(chat 形状 TTS)**适配器守卫 —— 协议层纯函数,不发真请求。
 *
 * 这条协议的每一条事实都是 **2026-09-26 真机探针**打出来的(见 `audio-adapter-mimo-chat.ts`
 * 文件头),所以这份守卫的作用是**把那次实测钉死**:谁哪天"顺手改一下字段名",
 * 这里就会红,而不是等到用户跑一部戏才发现产出的是一堆乱码。
 *
 * 盯五件事:
 *  1. **路径与鉴权**(`{base}/chat/completions`,Bearer);
 *  2. **要念的文本必须在 `role:"assistant"` 的消息里**(放 user 里会被当指令 —— 这是这家最容易踩的坑);
 *  3. **音色:登记簿的音色档案优先**于模型目录的 `note`;两条都没有就**如实拒绝**(不猜默认嗓子);
 *  4. **响应里音频在 `choices[0].message.audio.data`**,base64 解出来是字节;认不出就**贴原话**;
 *  5. **`-voiceclone` 明确拒绝**(没接那条路,不能发一个形状不对的请求)。
 */
import { describe, expect, it } from 'vitest'
import { createMimoChatTtsAdapter, mimoEmotionInstruction, mimoLangLabel, MIMO_DEFAULT_FORMAT, readMimoAudio } from './audio-adapter-mimo-chat.ts'
import type { AudioAdapterInput, AudioModelDescriptor } from './audio-generation.ts'

const adapter = createMimoChatTtsAdapter()

function input(overrides: {
  modelId?: string
  note?: string
  voiceSample?: string
  voiceLang?: string
  voiceEmotion?: AudioAdapterInput['task']['voiceEmotion']
  format?: string
  prompt?: string
  apiKey?: string
  baseUrl?: string
} = {}): AudioAdapterInput {
  const model: AudioModelDescriptor = {
    id: overrides.modelId ?? 'mimo-v2.5-tts',
    purpose: 'voice',
    adapter: 'mimo-chat-tts',
    capabilities: {
      textToMusic: false, instrumental: false, lyrics: false, audioReference: false,
      textToSpeech: true, voiceCloning: false, voiceId: true,
    },
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  }
  return {
    channel: {
      baseUrl: overrides.baseUrl ?? 'https://api.xiaomimimo.com/v1',
      apiKey: overrides.apiKey ?? 'sk-test',
      models: [model],
    },
    model,
    task: {
      purpose: 'voice',
      prompt: overrides.prompt ?? '今天天气不错。',
      ...(overrides.format === undefined ? {} : { format: overrides.format }),
      ...(overrides.voiceLang === undefined ? {} : { voiceLang: overrides.voiceLang }),
      ...(overrides.voiceEmotion === undefined ? {} : { voiceEmotion: overrides.voiceEmotion }),
      dialogueId: 'c09_two_umbrellas_0003',
      ...(overrides.voiceSample === undefined ? {} : { voiceSample: overrides.voiceSample }),
      referenceAudio: [],
    },
  }
}

interface MimoBody {
  model: string
  messages: Array<{ role: string; content: string }>
  audio: { format: string; voice?: string }
}

function bodyOf(plan: ReturnType<typeof adapter.buildRequest>): MimoBody {
  return JSON.parse(plan.request.body) as MimoBody
}

/** 一条"真响应"的骨架(照探针打到的形状写;`data` 是 base64)。 */
function responseWith(base64: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '7e850507f6ea461d82a31abc19bfdafd',
    choices: [{ finish_reason: 'stop', index: 0, message: { content: '', role: 'assistant', audio: { id: 'a1', data: base64, expires_at: null, transcript: null } } }],
    model: 'mimo-v2.5-tts',
    object: 'chat.completion',
    usage: { prompt_tokens: 142, completion_tokens: 26, total_tokens: 168, prompt_tokens_details: { cached_tokens: 110 } },
    ...extra,
  })
}

describe('小米 MiMo(chat 形状 TTS)适配器', () => {
  it('请求形状:POST {base}/chat/completions,Bearer 鉴权,尾斜杠不写进路径', () => {
    const plan = adapter.buildRequest(input({ voiceSample: '冰糖', baseUrl: 'https://api.xiaomimimo.com/v1/' }))
    expect(plan.adapter).toBe('mimo-chat-tts')
    expect(plan.request.method).toBe('POST')
    expect(plan.request.url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(plan.request.headers.authorization).toBe('Bearer sk-test')
  })

  it('**要念的文本在 assistant 消息里**(不是 user,也不是 input 字段)', () => {
    const body = bodyOf(adapter.buildRequest(input({ voiceSample: '冰糖', prompt: '雨下大了。' })))
    const assistant = body.messages.filter((message) => message.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('雨下大了。')
    expect(body.model).toBe('mimo-v2.5-tts')
    // 没有情感/音色描述时**不发 user 消息**:让服务端用它自己的缺省行为。
    expect(body.messages.filter((message) => message.role === 'user')).toEqual([])
  })

  it('格式缺省 mp3;任务指定的格式优先', () => {
    expect(bodyOf(adapter.buildRequest(input({ voiceSample: '冰糖' }))).audio.format).toBe(MIMO_DEFAULT_FORMAT)
    expect(bodyOf(adapter.buildRequest(input({ voiceSample: '冰糖', format: 'wav' }))).audio.format).toBe('wav')
  })

  it('音色:**角色的音色档案**优先于模型目录的 note 缺省', () => {
    const fromSample = bodyOf(adapter.buildRequest(input({ voiceSample: '茉莉', note: 'voice=冰糖' })))
    expect(fromSample.audio.voice).toBe('茉莉')
    const fromNote = bodyOf(adapter.buildRequest(input({ note: 'voice=冰糖' })))
    expect(fromNote.audio.voice).toBe('冰糖')
  })

  it('预置音色模型没有音色可依据 → **如实拒绝**,不猜一个默认嗓子', () => {
    expect(() => adapter.buildRequest(input())).toThrow(/预置音色 id/)
    // 报了错还要把"去哪儿填"说清(错误信息是可执行的,不是一句"失败了")。
    expect(() => adapter.buildRequest(input())).toThrow(/音色档案|note/)
  })

  it('voicedesign:音色描述进 user 消息;没描述就拒绝(它的音色**就是**那段文字)', () => {
    const body = bodyOf(adapter.buildRequest(input({
      modelId: 'mimo-v2.5-tts-voicedesign',
      voiceSample: '年轻女性,清澈偏冷,语速稍慢,句尾轻微气声。',
    })))
    const user = body.messages.filter((message) => message.role === 'user')
    expect(user).toHaveLength(1)
    expect(user[0]!.content).toContain('清澈偏冷')
    // voicedesign **不发** audio.voice(它不支持预置音色)。
    expect(body.audio.voice).toBeUndefined()
    expect(() => adapter.buildRequest(input({ modelId: 'mimo-v2.5-tts-voicedesign' }))).toThrow(/音色描述/)
  })

  it('voiceclone:**明确拒绝**(那条路没接),并指路 voicedesign', () => {
    expect(() => adapter.buildRequest(input({ modelId: 'mimo-v2.5-tts-voiceclone', voiceSample: 'x' })))
      .toThrow(/还没接|voicedesign/)
  })

  it('情感:只有 text / vector 两档转成指令;follow / reference **一个指令都不发**', () => {
    expect(mimoEmotionInstruction({ mode: 'follow' })).toBeUndefined()
    // reference 档是"情感参考音频"——这家没有这个入参,硬映射就是编。
    expect(mimoEmotionInstruction({ mode: 'reference', refSample: 'a.wav' })).toBeUndefined()
    expect(mimoEmotionInstruction({ mode: 'text', text: '带着哽咽的笑意' })).toBe('带着哽咽的笑意')
    // 8 维向量:取最强的两维 + 强度短语(原样 8 个数这家看不懂)。
    const strong = mimoEmotionInstruction({ mode: 'vector', vector: [0.9, 0, 0, 0, 0, 0, 0, 0] })
    expect(strong).toContain('喜')
    expect(strong).toContain('强烈地')
    const mild = mimoEmotionInstruction({ mode: 'vector', vector: [0.3, 0.25, 0, 0, 0, 0, 0, 0] })
    expect(mild).toContain('略带')
    // 向量维度不对 / 全为零 → 不发(不编)。
    expect(mimoEmotionInstruction({ mode: 'vector', vector: [1, 2] })).toBeUndefined()
    expect(mimoEmotionInstruction({ mode: 'vector', vector: [0, 0, 0, 0, 0, 0, 0, 0] })).toBeUndefined()
  })

  it('情感指令与音色描述**同住 user 消息**(voicedesign 时两段并列)', () => {
    const body = bodyOf(adapter.buildRequest(input({
      modelId: 'mimo-v2.5-tts-voicedesign',
      voiceSample: '年轻女性,清澈偏冷。',
      voiceEmotion: { mode: 'text', text: '压着怒气。' },
    })))
    const user = body.messages.filter((message) => message.role === 'user')
    expect(user).toHaveLength(1)
    expect(user[0]!.content).toContain('清澈偏冷')
    expect(user[0]!.content).toContain('压着怒气')
  })

  it('语言标签写进目标文本开头(这家认 `(中文)` 这种前缀)', () => {
    expect(mimoLangLabel('ZH')).toBe('中文')
    expect(mimoLangLabel('english')).toBe('英文')
    // 认不出的语言**不加标签**(不猜)。
    expect(mimoLangLabel('klingon')).toBeUndefined()
    const body = bodyOf(adapter.buildRequest(input({ voiceSample: '冰糖', voiceLang: 'ja', prompt: 'おはよう。' })))
    const assistant = body.messages.find((message) => message.role === 'assistant')!
    expect(assistant.content).toBe('(日文)おはよう。')
  })

  it('note 里的 label 覆盖语言标签(风格标签优先)', () => {
    const body = bodyOf(adapter.buildRequest(input({ voiceSample: '冰糖', note: 'label= singing', voiceLang: 'ja', prompt: 'x' })))
    expect(body.messages.find((message) => message.role === 'assistant')!.content).toBe('(singing)x')
  })

  it('响应:音频从 `choices[0].message.audio.data` 取,base64 解出真字节', async () => {
    const bytes = Buffer.from('MIMO-AUDIO-BYTES-0123456789')
    const fixture = input({ voiceSample: '冰糖' })
    const result = await adapter.onSubmit({ status: 200, text: responseWith(bytes.toString('base64')) }, fixture.model)
    expect(result.kind).toBe('bytes')
    if (result.kind !== 'bytes') throw new Error('unreachable')
    expect(Buffer.from(result.bytes).toString()).toBe('MIMO-AUDIO-BYTES-0123456789')
  })

  it('响应认不出音频 → **失败并贴原话**(不写空文件、不假装成功)', async () => {
    const fixture = input({ voiceSample: '冰糖' })
    // 真发生过的形态:`transcript`/`expires_at` 是 null,而 audio.data 才是音频。
    const missing = await adapter.onSubmit(
      { status: 200, text: JSON.stringify({ choices: [{ message: { content: '好的' } }] }) },
      fixture.model,
    )
    expect(missing.kind).toBe('failed')
    if (missing.kind !== 'failed') throw new Error('unreachable')
    expect(missing.error).toContain('choices[0].message.audio.data')
    expect(missing.error).toContain('choices') // 顶层键名带回去,方便下次定位
    // 不是 JSON(网关挂了回 HTML 之类)。
    expect(readMimoAudio('<html>502</html>').ok).toBe(false)
    // 空 base64 也要如实报错。
    const empty = await adapter.onSubmit({ status: 200, text: responseWith('') }, fixture.model)
    expect(empty.kind).toBe('failed')
  })

  it('鉴权失败给一句**可执行**的话(不是干巴巴的 HTTP 401)', async () => {
    const result = await adapter.onSubmit({
      status: 401,
      text: JSON.stringify({ error: { message: 'Invalid API Key', code: '401', type: 'invalid_key' } }),
    }, input({ voiceSample: '冰糖' }).model)
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.error).toContain('401')
    expect(result.error).toContain('密钥')
    expect(result.error).toContain('Invalid API Key') // 原话照带
  })
})
