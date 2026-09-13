/**
 * 「**schema 里有的设置键,面板上都得有**」—— 这条守卫是补一次真实缺口之后加的。
 *
 * ## 缺口长什么样(T27 那次的实况)
 *
 * 音频渠道那四个键(`audioBaseUrl` / `audioApiKey` / `audioChannelName` / `audioModels`)
 * 加进了 Host 半的设置 schema,但**面板那张卡没跟上** —— 于是:
 *
 *  - 设置页里**没有音频渠道的输入框**(发起人重启宿主后就是这么发现的:
 *    "没有语音渠道设置的面板");
 *  - 而且因为面板的保存是**按自己那份键清单**逐条 set/unset 的,那四个键
 *    面板**既不写也不清** —— 想配只能手改设置文档。
 *
 * ## 为什么这守卫直接 import 面板文件
 *
 * 这是快带里少数几处碰客户端的断言,但值的:`settings-card.tsx` 的那份 key 清单是**纯数据**
 * (`EMPTY_DRAFT` 的键),import 它不需要 DOM —— 而"两处清单是否一一对应"正是唯一要保的事。
 * 换成"人在真界面里点一遍"就没人会点。
 */
import { describe, expect, it } from 'vitest'
import { GalfreeSettingsSchema } from './index.ts'
import { SETTINGS_CARD_KEYS } from './client/settings-card.tsx'

/**
 * **不由这张卡管的三个键** —— 各自有界面,且都**列出来**而不是"过滤掉":
 *
 * | 键 | 归谁 |
 * |---|---|
 * | `enabled` | 插件总开关(宿主插件列表那张卡的启用开关) |
 * | `defaultProjectsRoot` | 工作台「新建项目」里那个父目录输入框(+ 目录选择器) |
 * | `sdkPath` | 工作台的 SDK 卡(供给与覆盖路径) |
 *
 * 这份清单是**显式**的:哪天有个键既不属于这三处、也不在频道卡里,这条守卫就会红 ——
 * 而"某个设置没有任何界面"正是 T27 那次音频四键的真实缺口。
 */
const HANDLED_ELSEWHERE = ['enabled', 'defaultProjectsRoot', 'sdkPath'] as const

describe('设置面板与 schema 的键一一对应(T27)', () => {
  it('schema 里的每个键,要么归频道卡,要么在"归别处"那份清单里(**没有第三种**)', () => {
    const schemaKeys = Object.keys(GalfreeSettingsSchema.dict ?? {})
    expect(schemaKeys.length).toBeGreaterThan(0)
    const orphans = schemaKeys.filter((key) =>
      !SETTINGS_CARD_KEYS.includes(key as never) && !(HANDLED_ELSEWHERE as readonly string[]).includes(key))
    expect(orphans, `这些键有 schema 但没有任何界面:${orphans.join(', ')}`).toEqual([])
  })

  it('频道卡**逐字**管着两族渠道键 + 发布目录(少一个就有设置没有输入框)', () => {
    const expected = [
      'imageBaseUrl', 'imageApiKey', 'imageChannelName', 'imageModels',
      'audioBaseUrl', 'audioApiKey', 'audioChannelName', 'audioModels',
      'publishDir',
    ]
    expect([...SETTINGS_CARD_KEYS].sort()).toEqual(expected.sort())
  })

  it('面板不会管 schema 里不存在的键(否则保存时会被拒/静默丢)', () => {
    const schemaKeys = new Set(Object.keys(GalfreeSettingsSchema.dict ?? {}))
    const extra = SETTINGS_CARD_KEYS.filter((key) => !schemaKeys.has(key))
    expect(extra, `这些键面板有但 schema 没有:${extra.join(', ')}`).toEqual([])
  })
})
