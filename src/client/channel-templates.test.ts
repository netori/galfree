/**
 * **渠道模板的守卫**(ADR-0012 修订 · 纪律 1/3/4 的机器判据)。
 *
 * 这一组存在的理由,是模板这种"预置值"最容易出的三种错**都不会自己报错**:
 *
 *  1. **引用一个不存在的协议**(模板写了 `adapter:'xxx'`,而那两侧清单里没有)——
 *     面板能选、保存后模型被**整条丢掉**(`openai-speech` 真发生过一次);
 *  2. **写错了 `purpose`**(音乐模板声明 `purpose:"voice"`)—— 拼渠道时按用途过滤,
 *     于是那条模型**静默不在这条渠道里**,表现是"模板套了、模型数是 0";
 *  3. **充值链接挂了推广码 / 指错域名**—— 这条不是技术故障,是信任问题:
 *     插件替第三方拉客与"插件与这些站点无利益关系"这句话不能同时成立。
 *
 * 判据一律**跑真解析器**(`parseModelCatalog` / `parseAudioModelCatalog`)与**真拼渠道**
 * (`audioChannelFromSettings`),而不是在测试里重写一遍规则 —— 否则守卫测的是副本,不是系统。
 */
import { describe, expect, it } from 'vitest'
import { audioChannelFromSettings, parseAudioModelCatalog, parseModelCatalog, type ConfigValues } from '../index.ts'
import { AUDIO_ADAPTER_IDS } from '../service/audio-generation.ts'
import { CHANNEL_TEMPLATES, templateKeys, templatePatchFor, templatePurpose, templatesFor, type ChannelTemplate, type TemplateChannel } from './channel-templates.ts'
import { AUDIO_ADAPTER_INFO } from './audio-catalog.ts'

/** 把一条模板铺进一份空设置(只动模板声明的那几个键 —— 与面板 `save()` 同一口径)。 */
function settingsWith(template: ChannelTemplate): ConfigValues {
  const keys = templateKeys(template.channel)
  const base: ConfigValues = {
    enabled: true,
    defaultProjectsRoot: '',
    sdkPath: '',
    imageBaseUrl: '', imageApiKey: '', imageChannelName: '', imageModels: '',
    musicBaseUrl: '', musicApiKey: '', musicChannelName: '', musicModels: '',
    voiceBaseUrl: '', voiceApiKey: '', voiceChannelName: '', voiceModels: '',
    publishDir: '',
  }
  const patch = templatePatchFor(template.channel, template)
  base[keys.baseUrl] = patch.baseUrl
  base[keys.channelName] = patch.channelName
  base[keys.models] = patch.models
  return base
}

describe('渠道模板(给个起点,不是推荐位)', () => {
  it('每条模板的端点、渠道名、模型目录都填齐了', () => {
    expect(CHANNEL_TEMPLATES.length).toBeGreaterThan(0)
    for (const template of CHANNEL_TEMPLATES) {
      const where = `${template.site}/${template.channel}`
      expect(template.baseUrl, `${where}: 端点`).toMatch(/^https:\/\//)
      expect(template.baseUrl.endsWith('/'), `${where}: 端点不该以斜杠结尾(适配器自己拼路径)`).toBe(false)
      expect(template.channelName.length, `${where}: 渠道名`).toBeGreaterThan(0)
      expect(template.models.length, `${where}: 模型目录`).toBeGreaterThan(0)
      expect(template.capturedAt, `${where}: 抄写日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(template.basis.length, `${where}: 实测口径(不能空着)`).toBeGreaterThan(0)
      expect(template.note.length, `${where}: 给用户看的那行说明`).toBeGreaterThan(0)
    }
  })

  it('图像模板的目录能过真解析器,而且至少要能文生图', () => {
    for (const template of templatesFor('image')) {
      const models = parseModelCatalog(template.models)
      expect(models.length, `${template.site}: 声明了模型却没解析出任何一条`).toBeGreaterThan(0)
      for (const model of models) {
        // 一条"什么都不能干"的模型 = 套了模板也出不了图,等于把新手卡在原地。
        expect(model.capabilities.textToImage, `${template.site}: ${model.id} 连文生图都没声明`).toBe(true)
      }
    }
  })

  it('音频模板:用途写对、协议两侧都认得、能力不是空的', () => {
    for (const channel of ['music', 'voice'] as const) {
      const want = templatePurpose(channel)
      for (const template of templatesFor(channel)) {
        const where = `${template.site}/${channel}`
        const models = parseAudioModelCatalog(template.models)
        expect(models.length, `${where}: 声明了模型却一条都没解析出来(协议或用途写错了)`).toBeGreaterThan(0)
        for (const model of models) {
          expect(model.purpose, `${where}: ${model.id} 的 purpose 必须是 ${want}`).toBe(want)
          // **两侧清单都要认**:宿主认、面板不认 → 用户根本选不到;
          // 面板认、宿主不认 → 保存后被静默丢掉(那 115 行适配器的下场)。
          expect(AUDIO_ADAPTER_IDS as readonly string[], `${where}: ${model.adapter} 不在宿主清单里`).toContain(model.adapter)
          expect(Object.keys(AUDIO_ADAPTER_INFO), `${where}: ${model.adapter} 不在面板清单里`).toContain(model.adapter)
          const capabilities = Object.values(model.capabilities).filter((value) => value === true)
          expect(capabilities.length, `${where}: ${model.id} 一个能力都没声明`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('套进设置之后,模型真的落在**它自己那条**渠道里(不是被用途过滤掉)', () => {
    // 这一条是"模板看起来生效了、模型数是 0"那类静默故障的判据:
    // 拼渠道按 purpose 过滤,写错一个词就会整条不见。
    for (const template of CHANNEL_TEMPLATES) {
      const settings = settingsWith(template)
      const where = `${template.site}/${template.channel}`
      if (template.channel === 'image') {
        const channel = audioChannelFromSettings(settings, 'music')
        expect(channel, `${where}: 不该拼出音频渠道`).toBeNull()
        continue
      }
      const purpose = templatePurpose(template.channel)!
      const mine = audioChannelFromSettings(settings, purpose)
      expect(mine, `${where}: 套了模板却没拼出渠道(端点没写进去)`).not.toBeNull()
      expect(mine!.models.length, `${where}: 渠道拼出来了、模型 0 条(purpose 或协议写错了)`).toBeGreaterThan(0)
      // 另一条线**不受影响**:模板只该动它自己那条。
      const other = audioChannelFromSettings(settings, purpose === 'music' ? 'voice' : 'music')
      expect(other, `${where}: 竟然也拼出了另一条渠道(模板越界了)`).toBeNull()
    }
  })

  it('套用模板**绝不**碰密钥(类型上没有密钥字段,这里再断一次行为)', () => {
    for (const template of CHANNEL_TEMPLATES) {
      const patch = templatePatchFor(template.channel, template)
      expect(Object.keys(patch).sort()).toEqual(['baseUrl', 'channelName', 'models'])
      // 判据按**形态**查,不按子串:`token` 这种词在模型 id 里合法
      // (`mimo-v2.5-tts-voicedesign` 里就有),子串匹配会误伤 ——
      // 头一版就是这么误报的,所以这里只认"像个密钥/像个密钥键"的东西。
      const fields = Object.keys(patch)
      expect(fields).not.toContain('apiKey')
      expect(fields.some((field) => /key|secret|credential/i.test(field))).toBe(false)
      for (const [field, value] of Object.entries(patch)) {
        expect(value, `${field} 里出现了像密钥的东西`).not.toMatch(/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/)
      }
    }
  })

  it('套错渠道会**抛**(不是把音乐模板写进语音那一段)', () => {
    const music = templatesFor('music')[0]!
    expect(() => templatePatchFor('voice', music)).toThrow(/不能套到/)
    expect(() => templatePatchFor('image', music)).toThrow(/不能套到/)
  })

  it('充值链接:https、不带推广码、且**只做指路**', () => {
    for (const template of CHANNEL_TEMPLATES) {
      if (template.consoleUrl === undefined) continue
      const where = `${template.site}/${template.channel}`
      const url = new URL(template.consoleUrl)
      expect(url.protocol, where).toBe('https:')
      // **不带推广码**:挂码等于插件替第三方拉客,与"无利益关系"不能同时成立。
      for (const key of ['aff', 'affiliate', 'ref', 'referral', 'invite', 'inviter', 'code']) {
        expect(url.searchParams.has(key), `${where}: 充值链接带了推广参数 ${key}`).toBe(false)
      }
      // 域名必须与模板自己的站点一致(不能指到别人的站去)。
      expect(url.hostname.endsWith(template.site), `${where}: 充值链接的域名与站点不符`).toBe(true)
    }
  })

  it('标签用域名:站点名与渠道名里不出现站方自称', () => {
    for (const template of CHANNEL_TEMPLATES) {
      expect(template.site, '站点标签应当是域名').toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(template.channelName, '渠道名应当是域名').toBe(template.site)
    }
  })

  it('`basis` 必须**逐条如实**(说清是谁验的、验到哪一步 —— 这三档不能互相冒充)', () => {
    // 这条守的是**措辞的诚实性**:模板上那句"实测口径"是给用户判断可信度的,
    // 而"真机验过" / "别人跑通过" / "照文档抄的"是三个不同的可信度档位。
    // 混着写(把照抄的说成实测)比不写更糟 —— 用户会据此省掉自己该做的那次验证。
    for (const template of CHANNEL_TEMPLATES) {
      const where = `${template.site}/${template.channel}`
      const basis = template.basis
      const tiers: Array<[string, RegExp]> = [
        ['真机/实测(我们验的)', /真机|实测|闭环验证/],
        ['他人生产配置(用户验的)', /发起人|生产配置|跑通过/],
        ['照文档抄的', /文档|照.*抄/],
      ]
      const hit = tiers.filter(([, pattern]) => pattern.test(basis)).map(([name]) => name)
      expect(hit.length, `${where}: basis 至少要落到一个可信度档位里:${basis}`).toBeGreaterThan(0)
      // 没验过的必须**明说没验过**(而不是含糊过去)。
      if (hit.includes('照文档抄的') && !hit.includes('真机/实测(我们验的)')) {
        expect(basis, `${where}: 只照文档抄的,就得明说没真跑过`).toMatch(/没真跑过|没跑过|未实测/)
      }
    }
  })

  it('模板引用的协议,**面板上真的有这个选项**', async () => {
    // 反向补一刀:模板用到的每个协议都必须有中文标签与说明(面板的 <option> 直接读它们)。
    const used = new Set<string>()
    for (const template of CHANNEL_TEMPLATES) {
      if (template.channel === 'image') continue
      for (const model of parseAudioModelCatalog(template.models)) used.add(model.adapter)
    }
    expect(used.size).toBeGreaterThan(0)
    for (const id of used) {
      const info = AUDIO_ADAPTER_INFO[id as keyof typeof AUDIO_ADAPTER_INFO]
      expect(info, `协议 ${id} 在面板上没有标签`).toBeDefined()
      expect(info.label.length).toBeGreaterThan(0)
    }
  })
})
