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
 * 2026-09-13 复核:那四个键后来被**拆成两条渠道**(`music*` / `voice*` 各四个,见 ADR-0012
 * "三条生成线各自一条渠道"),这张清单跟着改成八个 —— 而"拆键时忘了改界面"正是这条守卫
 * 要挡的第二种形状(凭空多出四个没有输入框的键)。
 *
 * ## 为什么这守卫直接 import 面板文件
 *
 * 这是快带里少数几处碰客户端的断言,但值的:`settings-card.tsx` 的那份 key 清单是**纯数据**
 * (`EMPTY_DRAFT` 的键),import 它不需要 DOM —— 而"两处清单是否一一对应"正是唯一要保的事。
 * 换成"人在真界面里点一遍"就没人会点。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { Config } from './index.ts'
import {
  SETTINGS_BUNDLE_PACKAGE,
  SETTINGS_CARD_KEYS,
  SETTINGS_ENTRY_ID,
  apply as applySettingsPage,
} from './client/settings-card.tsx'

/**
 * **不由这张卡管的三个键** —— 都**列出来**而不是"过滤掉"。
 *
 * ⚠️ **T37 更正了这张表的口径(2026-09-24)**:这三行原来写的是"各自有界面"
 * (插件列表的启用开关 / 新建项目表单 / SDK 卡)。**那在三处都不写设置** ——
 * 它们只是**读**这三项(实测:`git grep defaultProjectsRoot src/client` 只有读,
 * 全路由表里没有任何一条**写设置**的路由)。旧版能改它们,靠的是**宿主自己**给
 * 已注册命名空间渲染的通用表单;0.1.7 起宿主不再渲染插件配置
 * (`autoGenerate` 只是个描述字段,随包客户端没有消费者),**所以现在这三项
 * 只能改 profile 的 `cordis.patch.yml`**(那一行 `id: galfree` 的 `config`)。
 *
 * 这不算把守卫作废:它守的仍是"schema 里的键要么有界面、要么**明确记录在案**"。
 * 三条都**优雅降级**(`enabled` 默认 true;新建项目表单本来就让人显式选目录,
 * 默认值只是方便;`sdkPath` 只在要覆盖钉版时才需要)—— 所以是"缺口记在案",
 * 不是"功能坏了"。要真正补齐,就把它们做进这张卡(布尔开关 + 两个路径输入),
 * 那是下一票的事,不是靠改这份清单。
 */
const HANDLED_ELSEWHERE = ['enabled', 'defaultProjectsRoot', 'sdkPath'] as const

describe('设置面板与 schema 的键一一对应(T27)', () => {
  // T37:键的清单仍是 Host 半的 `Config`(0.1.7 里就是那个 volatile schema,
  // 设置面按它决定"哪些字段可改")—— 只是不再有 `settings.register` 那个命名空间。
  it('schema 里的每个键,要么归频道卡,要么在"归别处"那份清单里(**没有第三种**)', () => {
    const schemaKeys = Object.keys(Config.dict ?? {})
    expect(schemaKeys.length).toBeGreaterThan(0)
    const orphans = schemaKeys.filter((key) =>
      !SETTINGS_CARD_KEYS.includes(key as never) && !(HANDLED_ELSEWHERE as readonly string[]).includes(key))
    expect(orphans, `这些键有 schema 但没有任何界面:${orphans.join(', ')}`).toEqual([])
  })

  it('频道卡**逐字**管着三族渠道键(图像 / 音乐 / 语音)+ 发布目录(少一个就有设置没有输入框)', () => {
    const expected = [
      'imageBaseUrl', 'imageApiKey', 'imageChannelName', 'imageModels',
      // 音乐与语音**各四个键**:ADR-0012 的三条生成线各自一条渠道。
      'musicBaseUrl', 'musicApiKey', 'musicChannelName', 'musicModels',
      'voiceBaseUrl', 'voiceApiKey', 'voiceChannelName', 'voiceModels',
      'publishDir',
    ]
    expect([...SETTINGS_CARD_KEYS].sort()).toEqual(expected.sort())
  })

  it('两条音频渠道的键**成对出现**(只剩一半 = 拆到一半的残局)', () => {
    // 这条挡的是"拆渠道时漏了半条":比如加了 musicBaseUrl 却忘了 voiceBaseUrl,
    // 上面那条逐字断言会红,但这条能把"是哪一族缺了"说清楚。
    for (const family of ['image', 'music', 'voice']) {
      const keys = SETTINGS_CARD_KEYS.filter((key) => key.startsWith(family))
      expect(keys.map((key) => key.replace(family, '')).sort(),
        `${family} 那一族少了键`).toEqual(['ApiKey', 'BaseUrl', 'ChannelName', 'Models'])
    }
  })

  it('面板不会管 schema 里不存在的键(否则保存时会被拒/静默丢)', () => {
    const schemaKeys = new Set(Object.keys(Config.dict ?? {}))
    const extra = SETTINGS_CARD_KEYS.filter((key) => !schemaKeys.has(key))
    expect(extra, `这些键面板有但 schema 没有:${extra.join(', ')}`).toEqual([])
  })
})

/**
 * 设置面在 DSH 0.1.7 上的三条契约(T37)。
 *
 * 这一组是升级事故的回执:旧模型(`ctx.settings.register` + `settingsScope` +
 * `settings.plugin.item`)在 0.1.7 里**一个都不存在**,插件因此整块装不上。
 * 迁移后的形状有三件容易再错的事,每件都**静默**:
 *
 *  1. 某个设置字段忘了 `.volatile()` → `dsh-settings` 的 `describe()` 直接跳过这个 entry,
 *     设置页里**整页不存在**(不是少一个输入框);
 *  2. `configForms.get()` 传了**包名**而不是 Profile 行 id → 拿到的表永远 `unavailable`;
 *  3. 页面注册回旧槽位(`settings.section` / `settings.plugin.item`)→ 0.1.7 里没人渲染它;
 *     或注册时不问 `whileServed` → 宿主没服务这个命名空间时留下一页点不开的空壳。
 */
describe('设置面契约(T37 · DSH 0.1.7)', () => {
  it('Config 的每个字段都声明了 volatile(少一个 = 那一页设置永远不会出现)', () => {
    const dict = (Config.dict ?? {}) as Record<string, { meta?: { volatile?: boolean } }>
    const keys = Object.keys(dict)
    expect(keys.length).toBeGreaterThan(0)
    const notVolatile = keys.filter((key) => dict[key]?.meta?.volatile !== true)
    expect(notVolatile, `这些键没有 .volatile(),设置面上不会有它们:${notVolatile.join(', ')}`).toEqual([])
  })

  it('设置面问的是 **Profile 行 id**,不是包名:它必须与 cordis.patch.yml 的 insert id 逐字相同', () => {
    // ⚠️ 这份 patch 里现在还有 preset 的 `config.plugins`(整份 standard 行表),
    // 而那张表用 **Loader 自己的 YAML 方言**表达平台条件:`disabled: !!js process.platform === 'win32'`。
    // 默认 schema 遇到这个 tag 会**抛**(`unknown tag !<tag:yaml.org,2002:js>`)——
    // 用默认 schema 读它 = 这条守卫在解析阶段就红,而不是在断言阶段。
    // 与 `src/preset.test.ts` 的 `CORDIS_SCHEMA` 同一份写法(那边也读同一批文件)。
    const CORDIS_SCHEMA = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: () => true,
      construct: (data: unknown) => ({ js: data }),
    })])
    const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: CORDIS_SCHEMA }) as Array<{
      insert?: Array<{ id?: string; name?: string }>
    }>
    const rows = patch.flatMap((entry) => entry.insert ?? [])
    const row = rows.find((candidate) => candidate.name === SETTINGS_BUNDLE_PACKAGE)
    expect(row, `cordis.patch.yml 里没有 name=${SETTINGS_BUNDLE_PACKAGE} 的行`).toBeDefined()
    expect(row?.id, 'configForms.get() 认的是这一行的 id;两者不一致 = 设置页永远 unavailable').toBe(SETTINGS_ENTRY_ID)
  })

  it('页面注册到 Plugins 页的 plugins.bundle.config(key = bundle 包名),并**先问 whileServed**', () => {
    const registrations: Array<Record<string, unknown>> = []
    const served: string[][] = []
    const ctx = {
      configForms: {
        get: () => { throw new Error('这一条只验注册,不读表单') },
        whileServed: (namespaces: string[], register: (served: Set<string>) => () => void) => {
          served.push(namespaces)
          return register(new Set(namespaces))
        },
      },
      slots: {
        inject: (_name: string, build: () => () => void) => build(),
        register: (options: Record<string, unknown>) => {
          registrations.push(options)
          return () => { /* disposer */ }
        },
      },
    }

    applySettingsPage(ctx as never)

    expect(served).toEqual([[SETTINGS_ENTRY_ID]])
    expect(registrations).toHaveLength(1)
    // 槽位名与 key 都是"注册到哪儿"的一部分:换回 settings.section 会在 0.1.7 上静默消失。
    expect(registrations[0]!.name).toBe('plugins.bundle.config')
    expect(registrations[0]!.key).toBe(SETTINGS_BUNDLE_PACKAGE)
  })
})
