/**
 * 音频生成卡(T27)判断的守卫 —— 三条纪律:
 *  ① 跑之前看得见"这一跑要花几条请求";
 *  ② 渠道没配好时如实说清,不给人一个点了必然失败的按钮;
 *  ③ **两张卡各算各的**(2026-09-13 拆渠道之后新增):音乐那张卡上的"排队 3 条"
 *     不该把语音的任务算进来 —— 点它的「跑队列」也不会去跑语音。
 */
import { describe, expect, it } from 'vitest'
import { audioPurposeLabel, summarizeAudioBoard, type AudioChannelFacts, type AudioTaskFacts, type AudioPurpose } from './client/audio-board.ts'

const channel = (over: Partial<AudioChannelFacts> = {}): AudioChannelFacts => ({
  configured: true,
  apiKeyConfigured: true,
  models: [{ id: 'music-3.0', purpose: 'music', capabilities: { textToMusic: true } }],
  ...over,
})

const tasks = (...states: AudioTaskFacts['state'][]): AudioTaskFacts[] =>
  states.map((state, index) => ({ id: `t${index}`, state, purpose: 'music' as const }))

const mixed = (...items: Array<[AudioTaskFacts['state'], AudioPurpose]>): AudioTaskFacts[] =>
  items.map(([state, purpose], index) => ({ id: `t${index}`, state, purpose }))

describe('音频生成卡:队列处境(T27)', () => {
  it('排队数就是**这一跑要花的请求数**(TTS 按台词行计费,必须先看得见)', () => {
    const summary = summarizeAudioBoard('music', channel(), tasks('queued', 'queued', 'queued', 'awaiting-review', 'failed', 'running'))
    expect(summary.queued).toBe(3)
    expect(summary.awaitingReview).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.running).toBe(1)
    expect(summary.canRun).toBe(true)
  })

  it('空队列不给"跑"按钮(点了也是白点)', () => {
    const summary = summarizeAudioBoard('music', channel(), tasks('awaiting-review'))
    expect(summary.queued).toBe(0)
    expect(summary.canRun).toBe(false)
  })

  it('**只数本用途的任务**:音乐卡不把语音的排队算进"这一跑要花几条"', () => {
    const all = mixed(['queued', 'music'], ['queued', 'voice'], ['queued', 'voice'], ['awaiting-review', 'voice'])
    const music = summarizeAudioBoard('music', channel(), all)
    expect(music.queued).toBe(1)
    expect(music.awaitingReview).toBe(0)
    const voice = summarizeAudioBoard('voice', channel({ models: [{ id: 'tts', purpose: 'voice', capabilities: { textToSpeech: true } }] }), all)
    expect(voice.queued).toBe(2)
    expect(voice.awaitingReview).toBe(1)
  })

  it('没配渠道 → **说清是哪一条**没配(音乐 / 语音各说各的),而且不给跑按钮', () => {
    const music = summarizeAudioBoard('music', null, tasks('queued'))
    expect(music.canRun).toBe(false)
    expect(music.blockedBy).toMatch(/音乐生成/)
    // 但排队数照旧报(那是账本里的事实)。
    expect(music.queued).toBe(1)

    const voice = summarizeAudioBoard('voice', null, mixed(['queued', 'voice']))
    expect(voice.blockedBy).toMatch(/语音\(TTS\)/)
    // 两条渠道的措辞指到**设置里不同的那一段** —— 不然人会去填错的那半。
    expect(audioPurposeLabel('music').section).not.toBe(audioPurposeLabel('voice').section)
  })

  it('目录为空:各自说清是哪一个目录空了', () => {
    expect(summarizeAudioBoard('music', channel({ models: [] }), tasks('queued')).blockedBy).toMatch(/音乐渠道的模型目录是空的/)
    expect(summarizeAudioBoard('voice', channel({ models: [] }), mixed(['queued', 'voice'])).blockedBy).toMatch(/语音渠道的模型目录是空的/)
  })

  it('没填密钥:只有**音乐**那条会拦(本机 TTS 通常不要密钥,对着它报 401 是猜的)', () => {
    expect(summarizeAudioBoard('music', channel({ apiKeyConfigured: false }), tasks('queued')).blockedBy).toMatch(/没填密钥/)
    expect(summarizeAudioBoard('voice', channel({ apiKeyConfigured: false }), mixed(['queued', 'voice'])).blockedBy).toBeNull()
  })

  it('渠道没配好时,即使有排队任务也不给跑(顺序:先拦,再按钮)', () => {
    const summary = summarizeAudioBoard('music', channel({ apiKeyConfigured: false }), tasks('queued', 'queued'))
    expect(summary.blockedBy).not.toBeNull()
    expect(summary.canRun).toBe(false)
  })
})
