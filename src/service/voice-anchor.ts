/**
 * **声音锚**(T32):登记簿的音色档案 → 这条语音任务该用哪把嗓子。
 *
 * 与图像的参考链(`reference-chain.ts`)**同一个形状**:这条模块**不碰磁盘、不碰网络**
 * —— "音色库里有没有那个文件"由调用方问出来传进来(`library`),于是面板、agent 工具、
 * 建任务那条路读到的是**同一份判断**。
 *
 * ## 为什么"没有"要分成三档来报
 *
 * 一次真合成的代价是**一次上游请求**(TTS 还按台词行计费),所以"发不出去"必须在建任务
 * 那一步就说清,而且要说清**缺的是哪一样**:
 *
 * | 事实 | `missing` | 人该做什么 |
 * |---|---|---|
 * | 剧本里这个说话人**还没登记** | `no-character` | 先在登记簿里登记这个角色 |
 * | 登记了,但**没有音色档案** | `no-profile` | 给它记一条档案(参考样本) |
 * | 有档案,但**库里没有那个文件名** | `null`(只标 `inLibrary: false`) | 把样本丢进服务端 `voices/`,或改档案 —— 照发,上游会回它有的那几个 |
 *
 * 第三条**不阻断**:我们手里的库清单可能是**旧的**(人刚把文件丢进去),拿它去否决一次
 * 合成是越权。所以只如实标出来,让上游去拒并回它真正有的清单。
 *
 * ## 没核对过 ≠ 库里没有
 *
 * `library: null` 表示**还没问过服务端**(没配语音渠道、没点「读音色库」、或那台服务
 * 压根没有 `/voices`)。这时 `inLibrary` 是 `null` 而不是 `false` —— 把"不知道"渲染成
 * "没有"会让人去修一个不存在的问题。
 */
import { GalfreeError } from './error.ts'
import type { CharacterRecord, VoiceEmotion, VoiceEmotionMode, VoiceProfile } from './characters.ts'

/** 为什么这把嗓子拿不到(拿到了 = `null`)。 */
export type VoiceAnchorGap = 'no-character' | 'no-profile'

export interface VoiceAnchorView {
  /** 登记簿 id(没登记 = null)。 */
  character: string | null
  /** 剧本里的说话人变量(按它查时才有)。 */
  speakerVar?: string
  /** 角色显示名(面板用)。 */
  name?: string
  /** 要发给上游的**音色库文件名**(null = 这次拿不到声音锚)。 */
  sample: string | null
  /** LoRA 适配器名(缺省 `default`)。**它不是音色**。 */
  speaker: string
  lang?: string
  emotion?: VoiceEmotion
  note?: string
  /** 音色库清单里有没有这个样本;`null` = **没核对过**。 */
  inLibrary: boolean | null
  /** 拿不到锚的原因(拿到了 = null)。 */
  missing: VoiceAnchorGap | null
  /** 一句人话(降级注记与工具返回都用它;命中了就要能照着做)。 */
  message: string
}

export interface ResolveVoiceAnchorInput {
  /** 显式给的登记簿 id(优先于 `speakerVar`)。 */
  characterId?: string
  /** 剧本里的说话人变量(从 `.rpy` 派生;反查登记簿的 `voice` 字段)。 */
  speakerVar?: string
  characters: CharacterRecord[]
  /** 服务端音色库里的文件名清单;`null` = 没核对过。 */
  library: string[] | null
}

/** 缺省说话人 = 底模(服务端 `/speakers` 里恒有的那个)。 */
export const DEFAULT_VOICE_SPEAKER = 'default'

function findCharacter(characters: CharacterRecord[], input: ResolveVoiceAnchorInput): CharacterRecord | undefined {
  if (input.characterId !== undefined && input.characterId !== '') {
    return characters.find((character) => character.id === input.characterId)
  }
  if (input.speakerVar !== undefined && input.speakerVar !== '') {
    // 剧本里的变量名 → 登记簿的 `voice` 字段(那正是它存在的理由:改设定不改剧本)。
    return characters.find((character) => character.voice === input.speakerVar)
  }
  return undefined
}

/**
 * 解析"这次用哪把嗓子"。
 *
 * 顺序:**显式 id → 说话人变量 → 登记簿 → 音色档案**;任何一步没有就如实说清是**哪一步**
 * 没有(不静默用服务端缺省 —— 那正是"每个角色听起来都一样"的形状)。
 */
export function resolveVoiceAnchor(input: ResolveVoiceAnchorInput): VoiceAnchorView {
  const asked = input.characterId ?? input.speakerVar ?? ''
  const record = findCharacter(input.characters, input)
  const speakerVar = input.speakerVar === undefined || input.speakerVar === '' ? undefined : input.speakerVar

  if (record === undefined) {
    return {
      character: null,
      ...(speakerVar === undefined ? {} : { speakerVar }),
      sample: null,
      speaker: DEFAULT_VOICE_SPEAKER,
      inLibrary: null,
      missing: 'no-character',
      message: `登记簿里没有说话人「${asked}」:先把这个角色登记上(外观设定卡 + \`voice\` 绑定剧本变量),再给它记一条音色档案`,
    }
  }

  const profile: VoiceProfile | undefined = record.voiceProfile
  if (profile === undefined) {
    return {
      character: record.id,
      ...(speakerVar === undefined ? {} : { speakerVar }),
      name: record.name,
      sample: null,
      speaker: DEFAULT_VOICE_SPEAKER,
      inLibrary: null,
      missing: 'no-profile',
      message: `角色「${record.name}」(${record.id})还没有**音色档案**:给它记一条(参考样本 = 服务端音色库里的文件名),`
        + '否则这条语音拿不到"谁的嗓子"—— 用服务端缺省只会让每个角色听起来都一样',
    }
  }

  const inLibrary = input.library === null ? null : input.library.includes(profile.sample)
  return {
    character: record.id,
    ...(speakerVar === undefined ? {} : { speakerVar }),
    name: record.name,
    sample: profile.sample,
    speaker: profile.speaker === undefined || profile.speaker === '' ? DEFAULT_VOICE_SPEAKER : profile.speaker,
    ...(profile.lang === undefined ? {} : { lang: profile.lang }),
    ...(profile.emotion === undefined ? {} : { emotion: profile.emotion }),
    ...(profile.note === undefined ? {} : { note: profile.note }),
    inLibrary,
    missing: null,
    message: inLibrary === false
      ? `音色档案要的是音色库里的 \`${profile.sample}\`,但服务端此刻的 /voices 里没有它(照发,上游多半会拒并回它有的那几个)`
      : `用音色库里的 \`${profile.sample}\`${profile.speaker === undefined || profile.speaker === '' ? '' : ` + LoRA \`${profile.speaker}\``}`,
  }
}

/**
 * 外部输入(路由 body / agent 工具参数)→ 一份音色档案。
 *
 * **形状不对就抛**,不静默凑一个:面板与 agent 都从这条路进来,而"写进去一个发不出去的值"
 * 要到一次真合成才显形(还要花一次额度)。细校验在 `assertCharacterValid` 里
 * (它才是登记簿的守门人),这里只负责**把 JSON 解成那个形状**:
 *  - 键**不在** body 里 → `undefined`(调用方据此"别动它");
 *  - `null` → `undefined`(**明确清掉**这条档案);
 *  - 有 `sample` 的对象 → 一条档案(其余字段按出现与否带上)。
 */
export function voiceProfileFromInput(raw: unknown): VoiceProfile | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    throw new GalfreeError('character-invalid', `音色档案要是一个对象(或 null 表示清掉它),给的是 ${typeof raw}`)
  }
  const record = raw as Record<string, unknown>
  const sample = typeof record.sample === 'string' ? record.sample.trim() : ''
  if (sample === '') {
    throw new GalfreeError('character-invalid', '音色档案需要 `sample`(服务端音色库里的文件名,如 xiao_tang.wav)')
  }
  const emotion = voiceEmotionFromInput(record.emotion)
  return {
    sample,
    ...(typeof record.speaker === 'string' && record.speaker.trim() !== '' ? { speaker: record.speaker.trim() } : {}),
    ...(typeof record.lang === 'string' && record.lang.trim() !== '' ? { lang: record.lang.trim() } : {}),
    ...(emotion === undefined ? {} : { emotion }),
    ...(typeof record.note === 'string' && record.note !== '' ? { note: record.note } : {}),
  }
}

/** 情感输入(同上:没给 = 不给,形状不对就抛)。 */
export function voiceEmotionFromInput(raw: unknown): VoiceEmotion | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    throw new GalfreeError('character-invalid', `情感输入要是一个对象(mode + 它自己的那几项),给的是 ${typeof raw}`)
  }
  const record = raw as Record<string, unknown>
  const mode = record.mode
  if (mode !== 'follow' && mode !== 'reference' && mode !== 'vector' && mode !== 'text') {
    throw new GalfreeError('character-invalid', `情感模式只有 follow / reference / vector / text:${String(mode ?? '(空)')}`)
  }
  const vector = Array.isArray(record.vector) ? record.vector.map((value) => Number(value)) : undefined
  return {
    mode: mode as VoiceEmotionMode,
    ...(typeof record.refSample === 'string' && record.refSample.trim() !== '' ? { refSample: record.refSample.trim() } : {}),
    ...(typeof record.weight === 'number' ? { weight: record.weight } : {}),
    ...(vector === undefined ? {} : { vector }),
    ...(typeof record.text === 'string' && record.text !== '' ? { text: record.text } : {}),
  }
}

// ─── 整部戏的嗓子清单(面板与 agent 工具读的那一份)────────────────────
export interface VoiceAnchorRow {
  character: string
  name: string
  /** 剧本里绑定的说话人变量(缺省 = 还没绑定)。 */
  speakerVar?: string
  /** 音色库文件名(null = 还没有音色档案)。 */
  sample: string | null
  speaker: string
  emotion?: VoiceEmotion
  note?: string
  inLibrary: boolean | null
}

export interface VoiceAnchorBoard {
  rows: VoiceAnchorRow[]
  /** 剧本里出现、登记簿里没有的说话人(悬空引用:它们拿不到声音锚)。 */
  unregisteredSpeakers: string[]
  /** 有档案的角色数。 */
  withProfile: number
  /** 还没有档案的角色 id(要"每个角色一把嗓子",这就是那份名单)。 */
  withoutProfile: string[]
  library: {
    /** 服务端音色库里的文件名;`null` = 还没核对过。 */
    files: string[] | null
    /** 服务端的音色库目录(绝对路径;没读过 = undefined)。 */
    dir?: string
  }
  /** 库里有、没有任何角色引用的样本(信息,不是错误)。 */
  unusedSamples: string[]
}

export interface BuildVoiceAnchorBoardInput {
  characters: CharacterRecord[]
  /** 剧本里的说话人变量(派生的;用来找"还没登记"的那些)。 */
  speakers: string[]
  library: string[] | null
  /** 服务端音色库目录(读过 `/voices` 才有)。 */
  libraryDir?: string
}

/**
 * 整部戏的嗓子处境。
 *
 * `withoutProfile` 是这一票的**主指标**:它等于"还有几个角色听起来会跟别人一样"。
 * `unregisteredSpeakers` 是**另一件事**(剧本里有个说话人连登记都没有),分开报 ——
 * 合成一个数字会让人分不清该去补哪一样。
 */
export function buildVoiceAnchorBoard(input: BuildVoiceAnchorBoardInput): VoiceAnchorBoard {
  const rows: VoiceAnchorRow[] = input.characters.map((character) => {
    const profile = character.voiceProfile
    return {
      character: character.id,
      name: character.name,
      ...(character.voice === undefined ? {} : { speakerVar: character.voice }),
      sample: profile?.sample ?? null,
      speaker: profile?.speaker === undefined || profile?.speaker === '' ? DEFAULT_VOICE_SPEAKER : profile.speaker,
      ...(profile?.emotion === undefined ? {} : { emotion: profile.emotion }),
      ...(profile?.note === undefined ? {} : { note: profile.note }),
      inLibrary: profile === undefined || input.library === null ? null : input.library.includes(profile.sample),
    }
  })

  const bound = new Set(input.characters.map((character) => character.voice).filter((value): value is string => value !== undefined))
  const unregisteredSpeakers = [...new Set(input.speakers)].filter((speaker) => !bound.has(speaker)).sort()
  // "用上了"的样本含**情感参考音频**那一份 —— 只算音色样本会把它误报成没人用。
  const used = new Set<string>()
  for (const character of input.characters) {
    if (character.voiceProfile !== undefined) used.add(character.voiceProfile.sample)
    const refSample = character.voiceProfile?.emotion?.refSample
    if (refSample !== undefined && refSample !== '') used.add(refSample)
  }

  return {
    rows,
    unregisteredSpeakers,
    withProfile: rows.filter((row) => row.sample !== null).length,
    withoutProfile: rows.filter((row) => row.sample === null).map((row) => row.character),
    library: {
      files: input.library === null ? null : [...input.library],
      ...(input.libraryDir === undefined ? {} : { dir: input.libraryDir }),
    },
    unusedSamples: input.library === null ? [] : input.library.filter((name) => !used.has(name)).sort(),
  }
}
