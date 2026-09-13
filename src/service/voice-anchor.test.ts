/**
 * T32 守卫 —— 语音的「声音锚」(登记簿的音色档案 + 解析)。
 *
 * 契约来源(`docs/research-indextts-voice.md`,行号已核):
 *  - **音色只由参考音频决定**(同路径 ⇒ 同 speaker embedding 缓存命中 ⇒ 同一把嗓子);
 *  - **`speaker` 不是音色**(它只选 LoRA 适配器目录,本机 `runs/` 是空的);
 *  - 参考音频是**服务端 `voices/` 目录里的文件名** —— 与"项目内相对路径"是两个命名空间。
 *
 * 所以这一票的两个硬边界在这里守:
 *  1. **两个命名空间不许混**:带 `/`、`\`、盘符的"样本"写不进登记簿;
 *  2. **没有档案就如实说没有**(`sample: null` + 一句能照着做的说明),不许静默发一个空值,
 *     也不许把"库里没这个名字"说成"没有档案"(前者是上游会拒,后者是登记簿缺一条)。
 */
import { describe, expect, it } from 'vitest'
import { assertCharacterValid, upsertCharacter, type CharacterRecord } from './characters.ts'
import { buildVoiceAnchorBoard, resolveVoiceAnchor, voiceProfileFromInput } from './voice-anchor.ts'

function character(over: Partial<CharacterRecord> = {}): CharacterRecord {
  return {
    id: 'xiao_tang',
    name: '小棠',
    voice: 'xiao_tang',
    appearance: { hair: '黑色长直发' },
    references: [],
    ...over,
  }
}

/** 服务端 `GET /voices` 读回来的那一摞(含一个没人用的)。 */
const library = ['xiao_tang.wav', 'xiao_tang_calm.wav', 'someone_else.mp3']

describe('音色档案:登记簿里的形状(T32)', () => {
  it('整条档案能写进登记簿(参照链同一种"制作信息",不是叙述内容)', () => {
    const record = character({
      voiceProfile: {
        sample: 'xiao_tang.wav',
        speaker: 'default',
        lang: 'ZH',
        emotion: { mode: 'reference', refSample: 'xiao_tang_calm.wav', weight: 0.65 },
        note: '5 秒单人干声,情绪中性',
      },
    })
    expect(() => assertCharacterValid(record)).not.toThrow()
    const [saved] = upsertCharacter([], record)
    expect(saved!.voiceProfile).toEqual(record.voiceProfile)
  })

  it('**样本是文件名不是路径**:带斜杠 / 盘符 / `..` 一律在写入前拦下', () => {
    for (const sample of ['game/voice/xiao_tang.wav', 'voices\\x.wav', 'C:/x.wav', '../x.wav', '']) {
      expect(() => assertCharacterValid(character({ voiceProfile: { sample } })))
        .toThrow(/音色库/)
    }
  })

  it('情感向量必须**恰好 8 个数**(服务端就是这么收的)', () => {
    const good = character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'vector', vector: [0, 0, 0, 0, 0, 0, 0, 1] } } })
    expect(() => assertCharacterValid(good)).not.toThrow()
    for (const vector of [[0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 1, 1]]) {
      expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'vector', vector } } })))
        .toThrow(/8 个数/)
    }
    // 长度对了但里面混了非数:分开报(不然"给的是 8 个"那句话会自相矛盾)。
    expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'vector', vector: [0, 0, 0, 0, 0, 0, 0, Number.NaN] } } })))
      .toThrow(/第 8 个不是数/)
  })

  it('外部输入(路由 / 工具)解析:该转的转、转不了就抛(**不静默丢参数**)', () => {
    // 模型的参数常常是字符串 —— 能转就转。
    expect(voiceProfileFromInput({ sample: 'x.wav', emotion: { mode: 'follow', weight: '0.5' } }))
      .toMatchObject({ emotion: { mode: 'follow', weight: 0.5 } })
    expect(() => voiceProfileFromInput({ sample: 'x.wav', emotion: { mode: 'follow', weight: '半年' } }))
      .toThrow(/情感强度/)
    expect(() => voiceProfileFromInput({ sample: 'x.wav' })).not.toThrow()
    // `null` / 不给 = 没有这一条(调用方据此"别动它"或"清掉")。
    expect(voiceProfileFromInput(null)).toBeUndefined()
    expect(voiceProfileFromInput(undefined)).toBeUndefined()
    // 有对象但没 sample = 形状不对,如实抛。
    expect(() => voiceProfileFromInput({ speaker: 'default' })).toThrow(/sample/)
  })

  it('情感模式与它的参数要对得上:`reference` 要参考音频、`text` 要文本、强度只在 0–1', () => {
    expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'reference' } } })))
      .toThrow(/情感参考音频/)
    expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'reference', refSample: 'game/x.wav' } } })))
      .toThrow(/音色库/)
    expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'text' } } })))
      .toThrow(/情感描述/)
    expect(() => assertCharacterValid(character({ voiceProfile: { sample: 'x.wav', emotion: { mode: 'follow', weight: 1.5 } } })))
      .toThrow(/0–1|0-1/)
  })
})

describe('resolveVoiceAnchor:这次用哪把嗓子(T32)', () => {
  it('按登记簿 id 解析:样本 / 说话人 / 情感一起给出来,并核对库里有它', () => {
    const view = resolveVoiceAnchor({
      characterId: 'xiao_tang',
      characters: [character({
        voiceProfile: {
          sample: 'xiao_tang.wav',
          speaker: 'default',
          lang: 'ZH',
          emotion: { mode: 'vector', vector: [0, 0, 0, 0, 0, 0, 0, 1] },
        },
      })],
      library,
    })
    expect(view).toMatchObject({
      character: 'xiao_tang',
      sample: 'xiao_tang.wav',
      speaker: 'default',
      lang: 'ZH',
      inLibrary: true,
      missing: null,
    })
    expect(view.emotion).toMatchObject({ mode: 'vector' })
  })

  it('按**说话人变量**反查(剧本里的 `xiao_tang` → 登记簿的 `voice` 字段)', () => {
    const view = resolveVoiceAnchor({
      speakerVar: 'xiao_tang',
      characters: [character({ voiceProfile: { sample: 'xiao_tang.wav' } })],
      library,
    })
    expect(view).toMatchObject({ character: 'xiao_tang', speakerVar: 'xiao_tang', sample: 'xiao_tang.wav', missing: null })
    // 没配 speaker 时缺省就是底模(default)—— 而不是拿 voiceId 去当 speaker 发。
    expect(view.speaker).toBe('default')
  })

  it('角色还没有音色档案 → `sample: null` + 一句**照着能做**的说明(不静默用服务端默认)', () => {
    const view = resolveVoiceAnchor({ characterId: 'xiao_tang', characters: [character()], library })
    expect(view.sample).toBeNull()
    expect(view.missing).toBe('no-profile')
    expect(view.message).toContain('音色档案')
    expect(view.message).toContain('xiao_tang')
  })

  it('剧本里的说话人还没登记 → 如实说"没这个角色"(与"有角色但没档案"分开报)', () => {
    const view = resolveVoiceAnchor({ speakerVar: 'ghost', characters: [character()], library })
    expect(view.missing).toBe('no-character')
    expect(view.sample).toBeNull()
    expect(view.message).toContain('ghost')
  })

  it('**没核对过库 ≠ 库里没有**:没读过 `/voices` 时 `inLibrary` 是 null', () => {
    const view = resolveVoiceAnchor({ characterId: 'xiao_tang', characters: [character({ voiceProfile: { sample: 'x.wav' } })], library: null })
    expect(view.inLibrary).toBeNull()
    expect(view.sample).toBe('x.wav')
  })

  it('库里有清单但没有这个名字 → 照发,但如实标出来(上游多半会拒,并回它有的那几个)', () => {
    const view = resolveVoiceAnchor({ characterId: 'xiao_tang', characters: [character({ voiceProfile: { sample: 'missing.wav' } })], library })
    expect(view.inLibrary).toBe(false)
    expect(view.message).toContain('missing.wav')
    expect(view.missing).toBeNull()
  })
})

describe('buildVoiceAnchorBoard:这一部戏的嗓子清单(T32)', () => {
  const characters = [
    character({ id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', voiceProfile: { sample: 'xiao_tang.wav' } }),
    character({ id: 'ghost', name: '幽灵', voice: 'ghost', references: [] }),
  ]

  it('在册角色各一行;剧本里有、登记簿里没有的说话人单独报(它拿不到锚)', () => {
    const board = buildVoiceAnchorBoard({
      characters,
      speakers: ['xiao_tang', 'ghost', 'narrator_ghost'],
      library,
    })
    expect(board.rows.map((row) => row.character)).toEqual(['xiao_tang', 'ghost'])
    expect(board.rows[0]).toMatchObject({ sample: 'xiao_tang.wav', inLibrary: true })
    expect(board.rows[1]).toMatchObject({ sample: null, inLibrary: null })
    expect(board.unregisteredSpeakers).toEqual(['narrator_ghost'])
    expect(board.withProfile).toBe(1)
    expect(board.withoutProfile).toEqual(['ghost'])
    // 库里有、没人用的那些也报出来(信息,不是错误):情感参考样本也算"用上了"。
    expect(board.unusedSamples).toEqual(['someone_else.mp3', 'xiao_tang_calm.wav'])
  })

  it('没读过库时 `library.files` 是 null —— 面板据此说"还没核对",不说"库里没有"', () => {
    const board = buildVoiceAnchorBoard({ characters, speakers: [], library: null })
    expect(board.library.files).toBeNull()
    expect(board.rows[0]!.inLibrary).toBeNull()
    expect(board.unusedSamples).toEqual([])
  })
})
