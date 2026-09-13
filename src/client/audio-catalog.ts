/**
 * 音频模型目录的**纯数据与纯函数**(放在组件外,所以能守卫)。
 *
 * 与图像那条(`model-picker.tsx` 里的 `ModelRow` / `catalogFromRows`)同一口径:
 * **列表 = 上游拉到的全部、目录 = 勾上的那些**;目录 JSON 是唯一真相。
 *
 * 两条与图像不同的地方,都在这里定死:
 *  1. **能力表按用途不同**:音乐是"文生音乐 / 纯音乐 / 能收歌词 / 能收参考音频 / 返回 URL",
 *     语音是"合成语音 / 克隆音色 / 音色 id / 能收参考音频"。合成一张表会让每条模型都带着
 *     一半用不上的字段 —— 而"用不上的字段"在拼渠道时正是会被过滤掉的那些。
 *  2. **目录里一定写 `purpose`**:拼渠道按它过滤(音乐渠道只收 `purpose:"music"`),
 *     少了这一栏那条模型会被静默滤掉。
 */
import type { AudioAdapterId, AudioModelCapabilities, AudioPurpose } from '../service/audio-generation.ts'

/** 音频模型目录里的一项(面板用;与手工目录 JSON 同形,只多两个界面字段)。 */
export interface AudioModelRow {
  id: string
  label?: string
  note?: string
  selected: boolean
  capabilities: AudioModelCapabilities
  /** 能力是保守默认(要人确认)还是已知家族给的。 */
  needsConfirmation: boolean
  basis: string
  /** 像不像这个用途的模型(只影响排序与提示,**不隐藏**)。 */
  likely: boolean
  /** 手输进来的(上游没列)。 */
  manual?: boolean
  adapter: AudioAdapterChoice
}

/** 面板上能选的协议(按协议收,不按厂商收)。 */
export type AudioAdapterChoice = AudioAdapterId

export interface AudioCapabilityField {
  key: AudioCapabilityKey
  label: string
  hint: string
}

export type AudioCapabilityKey =
  | 'textToMusic' | 'instrumental' | 'lyrics' | 'audioReference'
  | 'textToSpeech' | 'voiceCloning' | 'voiceId'

/** 音乐渠道要勾的那几项。 */
const MUSIC_FIELDS: AudioCapabilityField[] = [
  { key: 'textToMusic', label: '文生音乐', hint: '按提示词出曲子(音乐渠道的基本盘)' },
  { key: 'instrumental', label: '纯音乐', hint: '不给歌词也能出 —— 大多数人只要这一种' },
  { key: 'lyrics', label: '能收歌词', hint: '要带唱的时候用得上(不收歌词的上游会直接拒)' },
  { key: 'audioReference', label: '参考音频', hint: '能收一段音频当风格参考(改风格 / 翻唱那一类)' },
]

/** 语音渠道要勾的那几项。 */
const VOICE_FIELDS: AudioCapabilityField[] = [
  { key: 'textToSpeech', label: '合成语音', hint: '按文本出人声(语音渠道的基本盘)' },
  { key: 'voiceCloning', label: '克隆音色', hint: '给一段参考音频就能用那个嗓子 —— **同一个角色的声音一致靠的就是它**' },
  { key: 'voiceId', label: '音色 id', hint: '服务端预置嗓子的名字(IndexTTS 的 `speaker` 就是这一类)' },
  { key: 'audioReference', label: '参考音频', hint: '任务里能挂一段参考音频(克隆那条路的输入)' },
]

export const AUDIO_CAPABILITY_FIELDS: Record<AudioPurpose, AudioCapabilityField[]> = {
  music: MUSIC_FIELDS,
  voice: VOICE_FIELDS,
}

/** 协议的中文名与说明(面板显示;两条渠道共用同一份措辞)。 */
export const AUDIO_ADAPTER_INFO: Record<AudioAdapterChoice, { label: string; hint: string }> = {
  'sync-http': {
    label: '同步(一次 POST 拿回)',
    hint: '本机 TTS、MiniMax 音乐这一类:一次调用直接回音频(或它的 base64)。',
  },
  'async-task': {
    label: '异步任务制(提交后轮询)',
    hint: 'Suno 类聚合站:提交 → 拿到任务 id → 轮询到终态 → 再下载音频 URL。',
  },
}

/** 六项能力全 false(目录里的能力是一份**全量快照**,写的时候必须给全)。 */
export const NO_AUDIO_CAPABILITIES: AudioModelCapabilities = {
  textToMusic: false,
  instrumental: false,
  lyrics: false,
  audioReference: false,
  textToSpeech: false,
  voiceCloning: false,
  voiceId: false,
}

/** 手输的模型:能力按最保守的口径填,并标"待确认"(与图像那条同一态度)。 */
export function audioRowFromManual(purpose: AudioPurpose, id: string): AudioModelRow {
  return {
    id,
    selected: true,
    capabilities: purpose === 'music'
      ? { ...NO_AUDIO_CAPABILITIES, textToMusic: true }
      : { ...NO_AUDIO_CAPABILITIES, textToSpeech: true },
    needsConfirmation: true,
    basis: '手动添加:能力按最保守的口径填,请勾准它真实支持的',
    likely: true,
    manual: true,
    // 协议也按用途给保守默认:音乐那边多半是聚合站(异步),语音那边多半是本机服务(同步)。
    adapter: purpose === 'music' ? 'async-task' : 'sync-http',
  }
}

/** 已保存的目录文本 → 清单行(都算勾上;面板打开时把现状带出来)。 */
export function audioRowsFromCatalog(purpose: AudioPurpose, text: string): AudioModelRow[] {
  if (text.trim() === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id as string,
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
        selected: true,
        capabilities: { ...NO_AUDIO_CAPABILITIES, ...((entry.capabilities as Partial<AudioModelCapabilities> | undefined) ?? {}) },
        // 已保存的能力是人定过的,不再算"待确认"。
        needsConfirmation: false,
        basis: '目录里已有的条目',
        likely: true,
        adapter: entry.adapter === 'sync-http' ? 'sync-http' as const : 'async-task' as const,
      }))
  } catch {
    return []
  }
}

/** 勾选结果 → 设置项要的目录 JSON(**一定带 purpose**,理由见文件头)。 */
export function audioCatalogFromRows(purpose: AudioPurpose, rows: AudioModelRow[]): string {
  return JSON.stringify(rows.filter((row) => row.selected).map((row) => ({
    id: row.id,
    purpose,
    adapter: row.adapter,
    ...(row.label === undefined || row.label === '' ? {} : { label: row.label }),
    ...(row.note === undefined || row.note === '' ? {} : { note: row.note }),
    capabilities: { ...row.capabilities },
  })), null, 2)
}

/**
 * 两份清单行是否等价(**按内容比**)。
 *
 * 与图像那条 `sameRows` 同一个理由,而且那次是**真栽过**的:勾选回调会改 `musicModels` 文本,
 * 文本变化又反过来同步清单 —— 无脑 `setState(新数组)` 会让每次渲染触发下一次渲染,
 * 主线程被占死(界面看着在、按钮点不动)。所以内容没变就**原样返回旧引用**。
 */
export function sameAudioRows(a: AudioModelRow[], b: AudioModelRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.selected !== y.selected || x.label !== y.label || x.note !== y.note || x.adapter !== y.adapter) return false
    for (const key of Object.keys(NO_AUDIO_CAPABILITIES) as AudioCapabilityKey[]) {
      if (x.capabilities[key] !== y.capabilities[key]) return false
    }
  }
  return true
}
