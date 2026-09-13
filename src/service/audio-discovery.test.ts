/**
 * 音频渠道的**自动发现**守卫(T27 续)——
 * 「拉取 → 推断能力与协议 → 勾选成目录」这条路,与图像那条同一态度。
 *
 * 两条最要紧的:
 *  1. **绝不凭空许诺能力**:认不出来的模型只许它最基础的那一件事,并标 `needsConfirmation`
 *     (上游不认的请求只会失败,而那种失败本该可避免);
 *  2. **认错用途比认不出更坏**:一条音乐模型的家族能力被按在语音渠道上,人会看到一份骗人的
 *     能力表 —— 所以家族与渠道用途不一致时**退回保守默认**,并如实说明为什么。
 */
import { describe, expect, it } from 'vitest'
import {
  audioModelsToCatalogJson, discoverAudioModels, inferAudioCapabilities, NO_AUDIO_CAPS, readVoiceLibrary,
} from './audio-discovery.ts'

/** 假上游:回一份 OpenAI 形状的 `/models`。 */
const upstream = (body: string, status = 200) => ({
  send: async () => ({ status, text: body }),
})

describe('音频渠道的自动发现(T27 续)', () => {
  // ─── 推断:认得出来的家族 ───────────────────────────────────────────

  it('音乐:Suno 类聚合站 = **异步任务制** + 支持纯音乐与带唱(所以能力里有 urlResult)', () => {
    const got = inferAudioCapabilities('chirp-v3-5', 'music')
    // 能力认得准,但**协议那半要人确认**(T34 真机验收打出来的):同一个 "suno" 底下
    // 有两套形状(sunoapi 那套 / 网关自己的资源式 REST),光看 id 分不出来。
    expect(got).toMatchObject({ adapter: 'async-task', family: 'suno', needsConfirmation: true })
    expect(got.capabilities).toMatchObject({ textToMusic: true, instrumental: true, lyrics: true, urlResult: true })
    // 音乐模型不该被许诺 TTS 那一族能力。
    expect(got.capabilities.textToSpeech).toBe(false)
    // 那句"两种形状同名"要在依据里 —— 面板直接显示给人看。
    expect(got.basis).toContain('两种协议形状同名')
  })

  it('音乐:MusicGen 一类 = **同步** + 以纯音乐为主(不收歌词)', () => {
    const got = inferAudioCapabilities('musicgen-large', 'music')
    expect(got).toMatchObject({ adapter: 'sync-http', family: 'musicgen' })
    expect(got.capabilities).toMatchObject({ textToMusic: true, instrumental: true, lyrics: false })
  })

  it('语音:IndexTTS = 同步 + **零样本音色克隆**(参考音频)+ 服务端预置嗓子', () => {
    const got = inferAudioCapabilities('indextts-2.5', 'voice')
    expect(got).toMatchObject({ adapter: 'sync-http', family: 'indextts', needsConfirmation: false })
    expect(got.capabilities).toMatchObject({ textToSpeech: true, voiceCloning: true, voiceId: true, audioReference: true })
    // 语音模型不该被许诺音乐那一族能力。
    expect(got.capabilities.textToMusic).toBe(false)
    expect(got.basis).toMatch(/克隆/)
  })

  it('语音:只有预置嗓子的 TTS(edge-tts 一类)= 能选音色,**不能**克隆', () => {
    const got = inferAudioCapabilities('tts-1', 'voice')
    expect(got.capabilities).toMatchObject({ textToSpeech: true, voiceId: true, voiceCloning: false })
    expect(got.basis).toMatch(/音色 id|预置/)
  })

  // ─── 推断:认不出来 ────────────────────────────────────────────────

  it('认不出来 → **保守默认 + 待确认**,而且按渠道的用途给默认协议', () => {
    const music = inferAudioCapabilities('mystery-model-xyz', 'music')
    expect(music.needsConfirmation).toBe(true)
    expect(music.family).toBeUndefined()
    // 音乐这边默认异步(聚合站多为"提交 → 轮询");猜成同步会让一次调用拿不到产物。
    expect(music.adapter).toBe('async-task')
    expect(music.capabilities).toEqual({ ...NO_AUDIO_CAPS, textToMusic: true })

    const voice = inferAudioCapabilities('mystery-model-xyz', 'voice')
    expect(voice.adapter).toBe('sync-http')
    expect(voice.capabilities).toEqual({ ...NO_AUDIO_CAPS, textToSpeech: true })
  })

  it('**认错用途比认不出更坏**:音乐家族的 id 落在语音渠道上时,退回保守默认并说明为什么', () => {
    // 人把音乐那条的模型 id 粘到了语音渠道里 —— 不能把 Suno 的能力表按在语音上。
    const got = inferAudioCapabilities('chirp-v3-5', 'voice')
    expect(got.needsConfirmation).toBe(true)
    expect(got.family).toBeUndefined()
    expect(got.capabilities).toEqual({ ...NO_AUDIO_CAPS, textToSpeech: true })
    expect(got.basis).toMatch(/音乐/)
    expect(got.basis).toMatch(/请人确认/)
  })

  // ─── 拉取 ──────────────────────────────────────────────────────────

  it('拉取:OpenAI 形状的 /models → 解析出 id 与 label,像本用途的排在前面(**不隐藏**别的)', async () => {
    const result = await discoverAudioModels(upstream(JSON.stringify({ data: [
      { id: 'gpt-4o' },
      { id: 'suno-v4', name: 'Suno v4' },
      { id: 'text-embedding-3' },
    ] })), { baseUrl: 'https://agg.example/v1/', purpose: 'music' })

    expect(result.endpoint).toBe('https://agg.example/v1/models')
    expect(result.total).toBe(3)
    // 像音乐的那个在前,其余的仍在清单里(人还能手选)。
    expect(result.models[0]).toMatchObject({ id: 'suno-v4', label: 'Suno v4', likely: true })
    expect(result.models.map((model) => model.id).sort()).toEqual(['gpt-4o', 'suno-v4', 'text-embedding-3'])
    expect(result.models.find((model) => model.id === 'gpt-4o')?.likely).toBe(false)
  })

  it('拉取:**去掉尾斜杠**、密钥只进请求头、重复 id 只留一条', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const http = {
      send: async (request: { url: string; method: 'GET' | 'POST'; headers: Record<string, string> }) => {
        seen.push({ url: request.url, headers: request.headers })
        return { status: 200, text: JSON.stringify({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }) }
      },
    }
    const result = await discoverAudioModels(http, { baseUrl: 'http://127.0.0.1:9005///', apiKey: 'sk-x', purpose: 'voice' })
    expect(seen[0]!.url).toBe('http://127.0.0.1:9005/models')
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-x')
    expect(result.total).toBe(2)
  })

  it('本机 TTS 服务没有 /models(只有 /health /speakers /voices)→ **如实说清并指路手动添加**', async () => {
    // 这正是 IndexTTS 那类服务的真实形状:FastAPI 没注册 /models,通常回 404 或一个非 JSON。
    await expect(discoverAudioModels(upstream('{"detail":"Not Found"}', 404), { baseUrl: 'http://127.0.0.1:9005', purpose: 'voice' }))
      .rejects.toThrow(/404/)
    await expect(discoverAudioModels(upstream('ok', 200), { baseUrl: 'http://127.0.0.1:9005', purpose: 'voice' }))
      .rejects.toThrow(/手动添加/)
  })

  it('非 OpenAI 形状(响应里没有 data 数组)→ 如实拒绝,不猜一个空目录', async () => {
    await expect(discoverAudioModels(upstream(JSON.stringify({ models: [] })), { baseUrl: 'https://x.example', purpose: 'music' }))
      .rejects.toThrow(/没有 data 数组/)
  })

  // ─── 勾选 → 目录 JSON ──────────────────────────────────────────────

  it('写进目录的 JSON **一定带 purpose**:少了它,那条模型会在拼渠道时被静默滤掉', () => {
    const json = audioModelsToCatalogJson('music', () => 'async-task', [
      { id: 'suno-v4', label: 'Suno v4', capabilities: { ...NO_AUDIO_CAPS, textToMusic: true, instrumental: true } },
    ])
    const [entry] = JSON.parse(json) as Array<Record<string, unknown>>
    expect(entry).toMatchObject({ id: 'suno-v4', purpose: 'music', adapter: 'async-task', label: 'Suno v4' })
    // 能力是**全量快照**:六个字段一个都不能少(缺字段的条目会被按缺省口径读)。
    expect(Object.keys(entry!.capabilities as object).sort()).toEqual([
      'audioReference', 'instrumental', 'lyrics', 'textToMusic', 'textToSpeech', 'voiceCloning', 'voiceId',
    ])
  })

  it('语音目录写出来就是 voice:两条渠道的目录不通用', () => {
    const [entry] = JSON.parse(audioModelsToCatalogJson('voice', () => 'sync-http', [
      { id: 'indextts-2.5', capabilities: { ...NO_AUDIO_CAPS, textToSpeech: true } },
    ])) as Array<Record<string, unknown>>
    expect(entry).toMatchObject({ purpose: 'voice', adapter: 'sync-http' })
  })
})

describe('读音色库(T32):/health + /speakers + /voices', () => {
  /** 照 IndexTTS 那份 `app_api.py` 的三个读法回话的假服务。 */
  const indextts = (over: { voicesStatus?: number } = {}) => {
    const calls: string[] = []
    return {
      calls,
      send: async (request: { url: string; method: string; body: string }) => {
        calls.push(request.url)
        // GET **不能带 body**(生产那份出网口按方法决定;这里守一句:无脑带 body 会让 GET 整个失败)。
        if (request.method !== 'GET') throw new Error(`读音色库只发 GET,收到 ${request.method}`)
        if (request.url.endsWith('/health')) return { status: 200, text: JSON.stringify({ status: 'ok', model_loaded: true, qwen_emo: false }) }
        if (request.url.endsWith('/speakers')) return { status: 200, text: JSON.stringify({ speakers: ['default'] }) }
        if (request.url.endsWith('/voices')) {
          if (over.voicesStatus !== undefined) return { status: over.voicesStatus, text: JSON.stringify({ detail: 'Not Found' }) }
          return { status: 200, text: JSON.stringify({ voices: ['xiao_tang.wav', '测试参考音频.mp3'], dir: 'F:\\creative_app\\yzy-index-tts-2.5-260824\\voices' }) }
        }
        return { status: 404, text: JSON.stringify({ detail: 'Not Found' }) }
      },
    }
  }

  it('三个端点各答各的:音色(voices)+ 目录 + LoRA 名(speakers)+ 服务状态', async () => {
    const http = indextts()
    const reading = await readVoiceLibrary(http, { baseUrl: 'http://127.0.0.1:9005/' })
    expect(reading.reachable).toBe(true)
    expect(reading.voices).toEqual(['xiao_tang.wav', '测试参考音频.mp3'])
    expect(reading.voiceDir).toContain('voices')
    // `/speakers` 是 **LoRA 名清单**(恒含 default)—— 它不是"可选音色"。
    expect(reading.speakers).toEqual(['default'])
    expect(reading.health).toMatchObject({ status: 'ok', qwenEmo: false })
    expect(reading.problems).toEqual([])
  })

  it('**逐端点如实报**:`/voices` 没答上来 ≠ 这条路走不通(`/speakers` 与 `/health` 照旧报)', async () => {
    const reading = await readVoiceLibrary(indextts({ voicesStatus: 500 }), { baseUrl: 'http://127.0.0.1:9005' })
    expect(reading.reachable).toBe(true)
    expect(reading.speakers).toEqual(['default'])
    expect(reading.voices).toBeUndefined()
    expect(reading.problems.join('\n')).toMatch(/\/voices 返回 500/)
  })

  it('服务没在跑(连接被拒)→ `reachable: false` + 每个端点各一条原因(不整体抛)', async () => {
    const http = {
      send: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9005') },
    }
    const reading = await readVoiceLibrary(http, { baseUrl: 'http://127.0.0.1:9005' })
    expect(reading.reachable).toBe(false)
    expect(reading.voices).toBeUndefined()
    expect(reading.problems).toHaveLength(3)
    expect(reading.problems[0]).toMatch(/ECONNREFUSED/)
  })

  it('不是这台服务的形状(响应里没有 voices 数组)→ 如实说,不猜一个空库', async () => {
    const http = { send: async (request: { url: string }) => ({ status: 200, text: request.url.endsWith('/voices') ? JSON.stringify({ models: [] }) : '{}' }) }
    const reading = await readVoiceLibrary(http, { baseUrl: 'http://127.0.0.1:9005' })
    expect(reading.voices).toBeUndefined()
    expect(reading.problems.join('\n')).toMatch(/没有 voices 数组/)
  })
})
