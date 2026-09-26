/**
 * **README 的配置文档不能漂**(T27 那四把键丢过一次,今天才发现)。
 *
 * 症状形态很典型:`music*` / `voice*` 八个键在 schema 里、在面板上、在模板里都有,
 * 而 README 那张表**只列了四个 `image*`** —— 于是照 README 配的人根本不知道有音乐与语音两条渠道,
 * 而**没有任何测试会红**(示例代码、字段名、表格全都是"散文",不进编译)。
 *
 * 判据三条,都跑真东西:
 *  1. `Config` 的每个键都必须在 README 里出现过(要么进那张表,要么进"没有界面"那三项的说明);
 *  2. README 里像设置键的标识符(`imageBaseUrl` 这种驼峰)必须是**真的**设置键(防手滑与防旧名);
 *  3. README 的 JSON 示例必须能过**真解析器**,示例里出现的 `adapter` id 必须是**真协议**
 *     (防"照着 README 抄,抄出一个不存在的协议"—— 那正好是上一票修掉的那类静默故障)。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, parseAudioModelCatalog, parseModelCatalog } from './index.ts'
import { AUDIO_ADAPTER_IDS } from './service/audio-generation.ts'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** schema 的键(与 `settings-card.test.ts` 同一读法)。 */
function schemaKeys(): string[] {
  return Object.keys(Config.dict ?? {})
}

/** 语言里出现的"像设置键"的标识符:小驼峰、至少两个词。防误报靠"必须真是个键"这条断言兜底。 */
function camelIdentifiers(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [])]
}

/**
 * 那张配置表里**第一列**列出的设置键(反引号包着的那一列)。
 *
 * 为什么锚在这里而不是"扫全文的驼峰标识符":README 里合法地出现着一堆不是设置键的标识符
 * (面板 API 名 `directoryPicker` / `stampSlot`、npm 字段 `allowBuilds`、装配字段 `autoGenerate`……),
 * 扫全文只会得到一堆噪音 —— 守卫一旦靠白名单压噪音,下次真问题就会被那道白名单盖住。
 * 而**表的第一列**正是"照 README 配的人会去填的那些键",风险面只有它。
 */
function tableSettingKeys(): string[] {
  const rows = [...README.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)].map((match) => match[1]!)
  return [...new Set(rows)]
}

/** 取出标了 ```` ```json ```` 的代码块(README 里放示例的那几个)。 */
function jsonBlocks(): string[] {
  return [...README.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => match[1]!)
}

describe('README 的配置文档与 schema 对齐', () => {
  it('**每一个设置键都在 README 里出现过**(少了就是"照 README 配的人不知道有这个键")', () => {
    const keys = schemaKeys()
    expect(keys.length).toBeGreaterThan(10)
    const missing = keys.filter((key) => !README.includes(key))
    expect(missing, `README 里找不到这些设置键:${missing.join('、')}`).toEqual([])
  })

  it('配置表里列的每个键**都是真的**(防手滑、防写到旧名上)', () => {
    const keys = new Set(schemaKeys())
    const listed = tableSettingKeys()
    expect(listed.length, 'README 的配置表里一个设置键都没认出来(表结构变了?)').toBeGreaterThan(5)
    // **表列什么就必须是什么**:手滑写错一个字母、或把 ADR-0012 明确"不再被读取"的旧键
    // (`audioBaseUrl` 一族)照旧写进文档,都会在这里红 —— 而后者正是最贵的那种:
    // 照它配出来的是一个**永不生效**的渠道。
    const unknown = listed.filter((key) => !keys.has(key))
    expect(unknown, `配置表里出现了不是设置键的名字:${unknown.join('、')}`).toEqual([])
    // 反向也要留住:那三把没有界面的键必须**在表里被点名**(说明它们改哪儿),
    // 否则"表里全都有"这句话本身就是错的。
    for (const key of ['enabled', 'defaultProjectsRoot', 'sdkPath']) {
      expect(README.includes(key), `README 少了没有界面的那把键 ${key}`).toBe(true)
    }
  })

  it('README 的 JSON 示例能过**真解析器**(照它抄不会抄出一个解析不出来的目录)', () => {
    const blocks = jsonBlocks()
    expect(blocks.length).toBeGreaterThan(0)
    let sawModels = false
    for (const block of blocks) {
      let parsed: unknown
      try {
        parsed = JSON.parse(block)
      } catch (error) {
        throw new Error(`README 里有一段 json 块不是合法 JSON:${String(error)}\n${block.slice(0, 200)}`)
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      const first = parsed[0] as Record<string, unknown>
      if (typeof first.id !== 'string') continue
      sawModels = true
      if (first.purpose === 'music' || first.purpose === 'voice') {
        // 音频目录:走真解析器,条数不能少(少一条就是被判据丢掉了)。
        const models = parseAudioModelCatalog(block)
        expect(models.length, `音频示例被解析器丢掉了条目:\n${block}`).toBe(parsed.length)
      } else {
        const models = parseModelCatalog(block)
        expect(models.length, `图像示例被解析器丢掉了条目:\n${block}`).toBe(parsed.length)
      }
    }
    expect(sawModels, 'README 里应当有模型目录的 JSON 示例').toBe(true)
  })

  it('README 提到的每个 `adapter` id 都**真的存在**(两侧清单都认)', () => {
    const ids = new Set<string>(AUDIO_ADAPTER_IDS as readonly string[])
    // README 里写成 `adapter` 值的那些(反引号包着、且出现在 adapter 表或示例里)。
    const mentioned = [...README.matchAll(/`(async-task-rest|async-task|sync-http|openai-speech|mimo-chat-tts|openai-compatible)`/g)]
      .map((match) => match[1]!)
    expect(mentioned.length).toBeGreaterThan(0)
    for (const id of new Set(mentioned)) {
      // 图像的 `openai-compatible` 是**省略默认**,不是音频协议 —— 单独放行。
      if (id === 'openai-compatible') continue
      expect(ids.has(id), `README 提到了协议 ${id},而它不在音频协议清单里`).toBe(true)
    }
  })
})
