/**
 * T27(#35)第二片守卫 —— 音频渠道的**设置拼装**(与图像那条对称)。
 *
 * 拼装这一层最容易出的两种错,守卫就盯这两种:
 *  1. **认不出的值静默兜底**:目录里写了个不认识的 `purpose` / `adapter`,
 *     代码"顺手给个默认" → 出图/出声按错的协议发,而人以为配置生效了。所以一律**跳过该条**
 *     (目录里少一条,面板看得见),不猜。
 *  2. **密钥漏出去**:渠道视图不许带 `apiKey` 明文(账本/路由/面板都读它)。
 */
import { describe, expect, it } from 'vitest'
import { audioChannelFromSettings, parseAudioModelCatalog } from './index.ts'

/** 与本文件配套的最小设置(只列音频要用的几个键)。 */
const settings = (over: Partial<Record<string, string>> = {}) => ({
  audioBaseUrl: 'https://api.example.com/v1',
  audioApiKey: 'sk-audio-secret',
  audioChannelName: 'test-audio',
  audioModels: '',
  ...over,
}) as never

describe('音频渠道的设置拼装(T27)', () => {
  it('没填端点 = 没渠道(null),不是"一个空渠道"', () => {
    expect(audioChannelFromSettings(settings({ audioBaseUrl: '   ' }))).toBeNull()
  })

  it('端点/密钥/名字/目录四项拼成渠道;名字留空就不写这个字段', () => {
    const channel = audioChannelFromSettings(settings({
      audioModels: JSON.stringify([
        { id: 'music-3.0', purpose: 'music', adapter: 'sync-http', capabilities: { textToMusic: true, instrumental: true } },
      ]),
    }))
    expect(channel).not.toBeNull()
    expect(channel!.baseUrl).toBe('https://api.example.com/v1')
    expect(channel!.apiKey).toBe('sk-audio-secret')
    expect(channel!.name).toBe('test-audio')
    expect(channel!.models.map((model) => model.id)).toEqual(['music-3.0'])
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
