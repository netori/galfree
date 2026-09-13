/**
 * T27(#35)第二片守卫 —— **音乐与语音两条渠道**的设置拼装(与图像那条对称)。
 *
 * 2026-09-13 改:此前这一层是"音乐与语音共用一条渠道"(`audioBaseUrl` 一族),
 * 而 ADR-0012 的原话是**三条生成线各自一条渠道** —— 音乐与语音的上游与协议不重叠,
 * 合成一条的表现是"换了音乐上游,语音那半跟着坏"。现在两个用途各四个键
 * (`musicBaseUrl` 一族 / `voiceBaseUrl` 一族),拼装走同一个函数。
 *
 * 拼装这一层最容易出的两种错,守卫就盯这两种:
 *  1. **认不出的值静默兜底**:目录里写了个不认识的 `purpose` / `adapter`,
 *     代码"顺手给个默认" → 出声按错的协议发,而人以为配置生效了。所以一律**跳过该条**
 *     (目录里少一条,面板看得见),不猜;而且**按用途过滤** —— 音乐渠道里混进的语音模型
 *     只会在选模型时被拒(或者更坏:把 TTS 模型递给了音乐上游)。
 *  2. **密钥漏出去**:渠道视图不许带 `apiKey` 明文(账本/路由/面板都读它)。
 */
import { describe, expect, it } from 'vitest'
import { audioChannelFromSettings, parseAudioModelCatalog } from './index.ts'

/** 与本文件配套的最小设置:两条渠道的键各在,按用途取用。 */
const settings = (over: Partial<Record<string, string>> = {}) => ({
  musicBaseUrl: 'https://api.example.com/v1',
  musicApiKey: 'sk-music-secret',
  musicChannelName: 'test-music',
  musicModels: '',
  voiceBaseUrl: 'http://127.0.0.1:7860',
  voiceApiKey: '',
  voiceChannelName: 'local-tts',
  voiceModels: '',
  ...over,
}) as never

const MUSIC_CATALOG = JSON.stringify([
  { id: 'music-3.0', purpose: 'music', adapter: 'sync-http', capabilities: { textToMusic: true, instrumental: true } },
])
const VOICE_CATALOG = JSON.stringify([
  { id: 'indextts', purpose: 'voice', adapter: 'sync-http', capabilities: { textToSpeech: true, voiceCloning: true } },
])

describe('音乐 / 语音两条渠道的设置拼装(T27 / ADR-0012)', () => {
  it('没填端点 = **那条**渠道没有(null),不是"一个空渠道" —— 而且两条各算各的', () => {
    expect(audioChannelFromSettings(settings({ musicBaseUrl: '   ' }), 'music')).toBeNull()
    // 音乐那条空了,**不影响**语音那条(这正是拆开的意义)。
    const voice = audioChannelFromSettings(settings({ musicBaseUrl: '' }), 'voice')
    expect(voice).not.toBeNull()
    expect(voice!.baseUrl).toBe('http://127.0.0.1:7860')
    // 反过来也一样。
    expect(audioChannelFromSettings(settings({ voiceBaseUrl: '' }), 'music')).not.toBeNull()
    expect(audioChannelFromSettings(settings({ voiceBaseUrl: ' ' }), 'voice')).toBeNull()
  })

  it('各读各的四个键:端点/密钥/名字/目录,四条都对上那条渠道', () => {
    const music = audioChannelFromSettings(settings({ musicModels: MUSIC_CATALOG }), 'music')!
    expect(music.baseUrl).toBe('https://api.example.com/v1')
    expect(music.apiKey).toBe('sk-music-secret')
    expect(music.name).toBe('test-music')
    expect(music.models.map((model) => model.id)).toEqual(['music-3.0'])

    const voice = audioChannelFromSettings(settings({ voiceModels: VOICE_CATALOG }), 'voice')!
    expect(voice.baseUrl).toBe('http://127.0.0.1:7860')
    // 本地服务通常不要密钥:空字符串 = 没配密钥,不是"配了个空密钥"。
    expect(voice.apiKey).toBe('')
    expect(voice.name).toBe('local-tts')
    expect(voice.models.map((model) => model.id)).toEqual(['indextts'])
  })

  it('名字留空就不写这个字段(与图像那条同口径)', () => {
    const channel = audioChannelFromSettings(settings({ musicModels: MUSIC_CATALOG, musicChannelName: '' }), 'music')!
    expect('name' in channel).toBe(false)
  })

  it('**按用途过滤目录**:音乐渠道里混进的语音模型不会出现在它里面(反之亦然)', () => {
    // 人把两家的目录粘串了 —— 这是配置阶段就能拦下的事,别等到选模型时才说"不认"。
    const mixed = JSON.stringify([
      { id: 'music-3.0', purpose: 'music', adapter: 'sync-http' },
      { id: 'indextts', purpose: 'voice', adapter: 'sync-http' },
    ])
    const music = audioChannelFromSettings(settings({ musicModels: mixed }), 'music')!
    expect(music.models.map((model) => model.id)).toEqual(['music-3.0'])
    const voice = audioChannelFromSettings(settings({ voiceModels: mixed }), 'voice')!
    expect(voice.models.map((model) => model.id)).toEqual(['indextts'])
  })

  it('**认不出的产物类型 / 协议一律跳过该条**(不猜、不静默兜底)', () => {
    const models = parseAudioModelCatalog(JSON.stringify([
      { id: 'ok-music', purpose: 'music', adapter: 'sync-http' },
      { id: 'bad-purpose', purpose: 'video', adapter: 'sync-http' },
      { id: 'bad-adapter', purpose: 'music', adapter: 'magic' },
      { id: '', purpose: 'music', adapter: 'sync-http' },
      { purpose: 'music', adapter: 'sync-http' },
    ]))
    expect(models.map((model) => model.id)).toEqual(['ok-music'])
  })

  it('能力缺省 = **全 false**(没声明就是不能干,不能靠默认值许诺)', () => {
    const [model] = parseAudioModelCatalog(JSON.stringify([{ id: 'bare', purpose: 'voice', adapter: 'async-task' }]))
    expect(model!.capabilities).toEqual({
      textToMusic: false, instrumental: false, lyrics: false, audioReference: false,
      textToSpeech: false, voiceCloning: false, voiceId: false,
    })
  })

  it('能力按目录原样读进来(只认 true)', () => {
    const [model] = parseAudioModelCatalog(JSON.stringify([{
      id: 'speech', purpose: 'voice', adapter: 'sync-http',
      capabilities: { textToSpeech: true, voiceCloning: 'yes', voiceId: true },
    }]))
    expect(model!.capabilities).toMatchObject({ textToSpeech: true, voiceCloning: false, voiceId: true })
  })

  it('坏 JSON / 不是数组 → 空目录(面板据此显示"没模型",不静默兜底一个)', () => {
    expect(parseAudioModelCatalog('{oops')).toEqual([])
    expect(parseAudioModelCatalog('{"id":"x"}')).toEqual([])
    expect(parseAudioModelCatalog('')).toEqual([])
  })

  it('格式与采样率清单读得进来(空 = 不限)', () => {
    const [model] = parseAudioModelCatalog(JSON.stringify([{
      id: 'm', purpose: 'music', adapter: 'sync-http',
      paths: { formats: ['ogg', 'mp3'], sampleRates: [44100, 48000] },
    }]))
    expect(model!.paths).toEqual({ formats: ['ogg', 'mp3'], sampleRates: [44100, 48000] })
  })
})
