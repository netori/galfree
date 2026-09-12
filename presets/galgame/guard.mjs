/**
 * 「Galgame 制作」preset 的**前置检查行**(随 preset 目录走的一个极小 cordis 插件)。
 *
 * 它只做一件事:在会话挂载这个 preset 时,**确认 GALFree 插件在场**。
 *
 * 为什么需要它:GALFree 的工具与流程指引由插件提供,而插件的安装位置是**部署级**的
 * (profile 的 bundles / 宿主组合),preset 自己不能把它再装一遍 —— 那会重复注册
 * 设置命名空间与 `/api/galfree/*` 路由,两个注册点都是"重复即抛"
 * (`settings namespace "dsh-galfree" is already registered` /
 * `webserver: duplicate GET route …`),于是会话创建会失败。
 *
 * 所以这个 preset 的姿态是**要求**而不是**授予**:插件必须在部署里装好。
 * 没装的时候,这一行会抛错 —— 宿主会让会话创建失败并回滚,**并指名是这一行**
 * (见 `@deepseek-ai/dsh-agent-presets` README「失败与恢复」的第二种:模块能加载但随后拒绝的行)。
 * 于是失败是**带原因的**,而不是"静默少几个工具"。
 */

/** 这一行不是服务,只注册一个钩子;名字用于诊断。 */
export const name = 'galfree-preset-guard'

/**
 * 这个 preset 认得的「全流程」最少需要哪些工具(每个环节一个代表)。
 *
 * 口径是**版本下限**,不是"16 个工具的全量清单":它要抓的是"GALFree 根本没装 /
 * 装的是 v1 那一版(只有剧本与出图,没有 T20 那批环节入口)"这种情形。
 * 插件以后加新环节**不必**改这里 —— 除非你要这个 preset 硬性要求那个新环节。
 *
 * 这份名单与插件真实注册的工具名由 `src/preset.test.ts` 钉在一起(改名就红);
 * 而"查工具 ⇒ 指引也在"这条蕴含关系也有守卫(同一个插件的组装既注册工具、
 * 也把 `galfree-workflow` 段装进系统提示)。
 */
export const REQUIRED_TOOLS = [
  'galfree_project_status', // 问现状(读板 + 下一步)
  'galfree_create_project', // 建项目
  'galfree_story_bible', // 设定集
  'galfree_generate_scene', // 剧本
  'galfree_fill_missing_art', // 素材
  'galfree_wire_audio', // 音频
  'galfree_playtest', // 试玩
  'galfree_publish', // 发布
]

/** 面向人的安装指引(错误信息里直接给,别让人去猜)。 */
const HOW_TO_INSTALL = [
  '装法:把 dsh-galfree 装进这个 profile(插件市场 / `dsh` 插件设置,或 profile 的 bundles 里加一行),',
  '然后重启宿主;preset 与插件不在同一个地方 —— 见 presets/galgame/README.md 的「两种装法」。',
].join('')

/**
 * 挂载时检查。抛错 = 会话创建失败并指名这一行(带原因,不是静默降级)。
 *
 * 刻意**不用 `inject: ['tools']`**:那样工具席位缺席时这一行会被静默跳过,
 * 而"工具席位都没有"恰恰是最该报出来的情形。所以这里自己取、自己判。
 */
export function apply(ctx) {
  const tools = ctx !== null && typeof ctx === 'object' ? ctx.tools : undefined
  if (tools === undefined || typeof tools.get !== 'function') {
    throw new Error(
      '「Galgame 制作」preset 需要宿主提供工具注册表(ctx.tools),但它不在:这个部署的组合不完整。' +
      HOW_TO_INSTALL,
    )
  }
  const missing = REQUIRED_TOOLS.filter((tool) => tools.get(tool) === undefined)
  if (missing.length > 0) {
    throw new Error(
      `「Galgame 制作」preset 需要 GALFree 插件(它提供 galfree_* 工具与系统提示里的流程指引),` +
      `但没找到:${missing.join('、')}。${HOW_TO_INSTALL}`,
    )
  }
}
