/**
 * 音频模型目录(T27 续)的**纯函数守卫** —— 与图像那条(`model-picker` 的 rows/catalog)
 * 同一批口径,外加两条音频专有的:
 *
 *  1. 目录 JSON 里**一定带 `purpose`** —— 拼渠道按它过滤,少了它那条模型会被静默滤掉
 *     (那正是"配置看着生效了、跑起来说不认识"的形状);
 *  2. 两条渠道的**能力表不一样**(音乐四项 / 语音四项),而能力是一份**全量快照**。
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_CAPABILITY_FIELDS, NO_AUDIO_CAPABILITIES,
  audioCatalogFromRows, audioRowFromManual, audioRowsFromCatalog, sameAudioRows,
} from './client/audio-catalog.ts'

describe('音频模型目录的纯函数(T27 续)', () => {
  it('手输的模型:能力按最保守口径填、标"待确认",协议按用途给默认', () => {
    const music = audioRowFromManual('music', 'V6')
    expect(music).toMatchObject({ id: 'V6', selected: true, manual: true, needsConfirmation: true, adapter: 'async-task' })
    expect(music.capabilities).toEqual({ ...NO_AUDIO_CAPABILITIES, textToMusic: true })

    const voice = audioRowFromManual('voice', 'indextts-2.5')
    expect(voice.adapter).toBe('sync-http')
    expect(voice.capabilities).toEqual({ ...NO_AUDIO_CAPABILITIES, textToSpeech: true })
  })

  it('目录 JSON:带 purpose、协议、全量能力;名字/备注空就不写那个字段', () => {
    const json = audioCatalogFromRows('music', [
      { ...audioRowFromManual('music', 'V6'), selected: true, label: '', note: '' },
    ])
    const [entry] = JSON.parse(json) as Array<Record<string, unknown>>
    expect(entry).toMatchObject({ id: 'V6', purpose: 'music', adapter: 'async-task' })
    expect(entry!.label).toBeUndefined()
    expect(entry!.note).toBeUndefined()
    // 六个字段一个都不能少(缺字段的条目会被按缺省口径读)。
    expect(Object.keys(entry!.capabilities as object).sort()).toEqual([
      'audioReference', 'instrumental', 'lyrics', 'textToMusic', 'textToSpeech', 'voiceCloning', 'voiceId',
    ])
  })

  it('**只写勾上的**:取消勾选 = 从目录移除', () => {
    const rows = [
      { ...audioRowFromManual('music', 'a'), selected: true },
      { ...audioRowFromManual('music', 'b'), selected: false },
    ]
    const ids = (JSON.parse(audioCatalogFromRows('music', rows)) as Array<{ id: string }>).map((entry) => entry.id)
    expect(ids).toEqual(['a'])
  })

  it('目录文本 → 清单行:能力按原样带出来、**不再算待确认**、协议认得出就认', () => {
    const text = JSON.stringify([
      { id: 'indextts-2.5', purpose: 'voice', adapter: 'sync-http', label: '本地 TTS', capabilities: { textToSpeech: true, voiceCloning: true } },
      { id: 'weird', purpose: 'voice', capabilities: {} },
    ])
    const rows = audioRowsFromCatalog('voice', text)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'indextts-2.5', selected: true, needsConfirmation: false, adapter: 'sync-http', label: '本地 TTS' })
    expect(rows[0]!.capabilities).toMatchObject({ textToSpeech: true, voiceCloning: true, lyrics: false })
    // 没写 adapter 的按异步兜底(与图像那条"缺字段按缺省读"同一态度)。
    expect(rows[1]!.adapter).toBe('async-task')
  })

  it('坏 JSON / 不是数组 / 空文本 → 空清单(面板据此显示"没有模型",不静默兜底一个)', () => {
    expect(audioRowsFromCatalog('music', '')).toEqual([])
    expect(audioRowsFromCatalog('music', '{oops')).toEqual([])
    expect(audioRowsFromCatalog('music', '{"id":"x"}')).toEqual([])
  })

  it('两条渠道的能力表**不一样长、切的是不同的那几项**', () => {
    const music = AUDIO_CAPABILITY_FIELDS.music.map((field) => field.key)
    const voice = AUDIO_CAPABILITY_FIELDS.voice.map((field) => field.key)
    expect(music).toEqual(['textToMusic', 'instrumental', 'lyrics', 'audioReference'])
    expect(voice).toEqual(['textToSpeech', 'voiceCloning', 'voiceId', 'audioReference'])
    // 参考音频那一项两条都有(音乐当风格参考、语音当音色克隆的输入)。
    expect(music).toContain('audioReference')
    expect(voice).toContain('audioReference')
  })

  it('**按内容比对**(sameAudioRows):没变就返回 true —— 渲染自锁那道闸', () => {
    const a = [audioRowFromManual('music', 'a')]
    const b = [audioRowFromManual('music', 'a')]
    expect(sameAudioRows(a, b)).toBe(true)
    // 勾选状态变了 / 能力变了 / 协议变了 / 条数变了 —— 都算变。
    expect(sameAudioRows(a, [{ ...b[0]!, selected: false }])).toBe(false)
    expect(sameAudioRows(a, [{ ...b[0]!, capabilities: { ...b[0]!.capabilities, lyrics: true } }])).toBe(false)
    expect(sameAudioRows(a, [{ ...b[0]!, adapter: 'sync-http' }])).toBe(false)
    expect(sameAudioRows(a, [])).toBe(false)
  })
})
