/**
 * 音频生成卡(T27)判断的守卫 —— 两条纪律:① 跑之前看得见"这一跑要花几条请求";
 * ② 渠道没配好时如实说清,不给人一个点了必然失败的按钮。
 */
import { describe, expect, it } from 'vitest'
import { summarizeAudioBoard, type AudioChannelFacts, type AudioTaskFacts } from './client/audio-board.ts'

const channel = (over: Partial<AudioChannelFacts> = {}): AudioChannelFacts => ({
  configured: true,
  apiKeyConfigured: true,
  models: [{ id: 'music-3.0', purpose: 'music', capabilities: { textToMusic: true } }],
  ...over,
})

const tasks = (...states: AudioTaskFacts['state'][]): AudioTaskFacts[] =>
  states.map((state, index) => ({ id: `t${index}`, state, purpose: 'music' as const }))

describe('音频生成卡:队列处境(T27)', () => {
  it('排队数就是**这一跑要花的请求数**(TTS 按台词行计费,必须先看得见)', () => {
    const summary = summarizeAudioBoard(channel(), tasks('queued', 'queued', 'queued', 'awaiting-review', 'failed', 'running'))
    expect(summary.queued).toBe(3)
    expect(summary.awaitingReview).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.running).toBe(1)
    expect(summary.canRun).toBe(true)
  })

  it('空队列不给"跑"按钮(点了也是白点)', () => {
    const summary = summarizeAudioBoard(channel(), tasks('awaiting-review'))
    expect(summary.queued).toBe(0)
    expect(summary.canRun).toBe(false)
  })

  it('没配渠道 → **说清为什么**,而且不给跑按钮(不让人点了才发现)', () => {
    const summary = summarizeAudioBoard(null, tasks('queued'))
    expect(summary.canRun).toBe(false)
    expect(summary.blockedBy).toMatch(/还没配音频生成渠道/)
    // 但排队数照旧报(那是账本里的事实)。
    expect(summary.queued).toBe(1)
  })

  it('目录为空 / 没填密钥:各自说清是哪一种(不合成一句含糊的"配置有问题")', () => {
    expect(summarizeAudioBoard(channel({ models: [] }), tasks('queued')).blockedBy).toMatch(/模型目录是空的/)
    expect(summarizeAudioBoard(channel({ apiKeyConfigured: false }), tasks('queued')).blockedBy).toMatch(/没填密钥/)
  })

  it('渠道没配好时,即使有排队任务也不给跑(顺序:先拦,再按钮)', () => {
    const summary = summarizeAudioBoard(channel({ apiKeyConfigured: false }), tasks('queued', 'queued'))
    expect(summary.blockedBy).not.toBeNull()
    expect(summary.canRun).toBe(false)
  })
})
