/**
 * 「Galgame 制作」preset 的**前置检查行**(随插件包一起交付的一个极小 cordis 插件)。
 *
 * 它只做一件事:在会话挂载这个 preset 时,**确认 GALFree 插件在场**(工具面在 = 版本下限够)。
 *
 * ## 为什么还需要它
 *
 * preset 与插件现在**同一个 bundle**(`cordis.patch.yml` 里 `galfree` 与 `preset-galgame`
 * 是同一个 insert 的两行),所以"插件根本没装"这种情形已经不可能:装了 bundle 才有这一行。
 * 剩下的真实缺口只有两个,而且都值得**带原因地拒绝**而不是静默降级:
 *   ① 用户在插件管理器里关掉了 `galfree` 那一行(bundle 还在,插件不在);
 *   ② 那一行激活失败(例如宿主没有 `webServer` 席位 —— `src/index.ts` 的 `inject` 是
 *      `['webServer']`,静态席位等不到就永远不注册工具)。
 * 两种情况下这个模式都只剩 persona,连 `galfree_*` 工具与 `galfree-workflow` 指引都没有。
 *
 * ## 为什么不能"挂载时立刻查一次"
 *
 * 因为**查不到**:宿主的行是**并行激活**的 —— `@deepseek-ai/cordis-plugin-loader` 的
 * `EntryGroup.update()` 对每一行 `Promise.all(ids.map(...))`,没有先后保证;而 GALFree 的
 * 16 个工具是在**懒注入回调**里补上的(`src/index.ts` 的 `ctx.inject(['tools'], …)` →
 * `registerGalfreeTools`)。于是 preset 的挂载可能早于那次注册。
 * 本机实测(0.1.7-rc.2):同一个 `inject: ['tools']` 席位里,挂载那一刻 8 个工具**全部**
 * 看不到,3 秒后**全部**在(探针把两次结果写进错误信息,由 `agentPresets/list` 的诊断带出);
 * 而这一行一旦抛错,这次挂载就是**永久失败** —— 会员名单里这个 preset 会一直挂着 `broken`,
 * 不可选、不可切(registry 的 `mountPreset`/`auditRows`:`apply` 抛错 = 这一行 failed)。
 *
 * 所以判据是"**等到看见为止,有上限**":上限只是兜底,不是调参 —— 正常情况下轮询一轮就过,
 * 看不到工具时最多等 `waitMs`(默认 5000)然后带原因地抛。
 * 上限可以用这一行的 `config.waitMs` 覆盖(给慢机器);这是 cordis 的正常插件配置参数。
 */

/** 这一行不是服务,只注册一个钩子;名字用于诊断。 */
export const name = 'galfree-preset-guard'

/**
 * 这个 preset 认得的「全流程」最少需要哪些工具(每个环节一个代表)。
 *
 * 口径是**版本下限**,不是"16 个工具的全量清单":它要抓的是"GALFree 那一行没在跑 /
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

/** 等工具出现时的轮询间隔;25ms 是为了"正常情况下一轮就过",不是精度要求。 */
const POLL_MS = 25

/** 默认上限(毫秒):看不到工具时最多等这么久,然后带原因地抛。 */
const DEFAULT_WAIT_MS = 5000

/** 面向人的修复指引(错误信息里直接给,别让人去猜)。 */
const HOW_TO_FIX = [
  '这个 preset 与 GALFree 插件在**同一个 bundle**(dsh-galfree 的 `cordis.patch.yml`),',
  '所以它出现就说明 bundle 装了;看不到工具最可能是那一行 `galfree` 被关掉或没激活成功。',
  '修法:在插件管理器/设置里确认 dsh-galfree 是启用状态(或去这个 profile 的 cordis.patch.yml',
  '删掉指向 `galfree` 那一行的 `disabled: true`),然后重启宿主。',
].join('')

/**
 * **必须有这一行**:cordis 的服务不能"随手取" —— 不声明 inject 就读 `ctx.tools`,
 * 会当场抛 `cannot get property "tools" without inject`,会话压根切不过来
 * (这一条是被真机教出来的:第一版就是这么栽的)。
 */
export const inject = ['tools']

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 挂载时检查。抛错 = 这次挂载失败,名单里这个 preset 会带原因地显示成不可用
 * (registry 的 `auditRows` 把 failed 行原样报出来),不是静默少几个工具。
 *
 * `tools` 席位真缺席时会怎样?**这一行会一直等着它** —— 宿主的规则是"等待组装从未提供的服务的插件"
 * 会让挂载失败并指名那一行。所以声明 inject 不会把"没有工具注册表"变成静默跳过;
 * 真正要在这里判的,是**席位在、但 GALFree 的工具还没出现/不会出现**。
 *
 * @param ctx 这一行的 cordis 上下文(席位由 `inject` 保证)。
 * @param config 这一行的插件配置;`waitMs` 可覆盖默认上限(毫秒)。
 */
export async function apply(ctx, config) {
  const tools = ctx !== null && typeof ctx === 'object' ? ctx.tools : undefined
  if (tools === undefined || typeof tools.get !== 'function') {
    // 生产上到不了这里(inject 保证席位);留着是为了"形状不对"时也说人话,而不是抛 TypeError。
    throw new Error(
      '「Galgame 制作」preset 需要宿主提供工具注册表(ctx.tools),但它不在或形状不对:这个部署的组合不完整。' +
      HOW_TO_FIX,
    )
  }
  const configured = config !== null && typeof config === 'object' ? config.waitMs : undefined
  const waitMs = typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_WAIT_MS
  const deadline = Date.now() + waitMs

  let missing = REQUIRED_TOOLS.filter((tool) => tools.get(tool) === undefined)
  while (missing.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS)
    missing = REQUIRED_TOOLS.filter((tool) => tools.get(tool) === undefined)
  }
  if (missing.length > 0) {
    throw new Error(
      `「Galgame 制作」preset 需要 GALFree 插件(它提供 galfree_* 工具与系统提示里的流程指引),` +
      `等了 ${String(waitMs)}ms 仍未看到:${missing.join('、')}。${HOW_TO_FIX}`,
    )
  }
}
