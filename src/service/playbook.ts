/**
 * agent 流程指引(T19 / #27)—— 往会话的 system prompt 注入一段 playbook。
 *
 * 为什么要有它:没有它,一个新会话的 agent 眼里只有一堆**工具的名字与描述** —— 没有顺序、
 * 没有"做到什么算完"、没有"哪一步必须请人"。它能"走错时被纠正",但不被"带着走"。
 *
 * 三条规矩:
 *
 *  1. **判据与接缝同源**:每一步的"做完了"都写成**推导板上的字段路径**(`BoardCriterion.path`),
 *     闸门写成**接缝真的会抛的码**(`GATE`,取自 `gates.ts`)。指引里**没有**"8 个槽""5 场戏"
 *     这种会过期的数 —— 要数字就读板。守卫(`playbook.test.ts`)拿一个真项目推导出来的快照
 *     逐条解析这些路径,并真去撞每一道闸门。
 *  2. **不假装有不存在的入口**:每一步挂一组工具名,但只有**真的注册了**的才写进文本
 *     (见 `PlaybookOptions.hasTool`)。所以"这一票还没做的入口"会如实显示成
 *     "目前没有 agent 入口 —— 请人在工作台做",而不是报一个调不通的工具名。
 *  3. **懒注入**:宿主没有 `systemPrompt` 席位时,这段提示就不存在,插件照常工作
 *     (入口用 cordis 的 `inject` 按需装配;`registerGalfreePlaybook` 自己也容忍缺席)。
 */
import { GATE } from './gates.ts'

/**
 * 这段 section 的名字(宿主里唯一 —— 重名注册会抛)。
 */
export const WORKFLOW_SECTION = 'galfree-workflow'

/**
 * 排序位置:第一方工具段(1000–2900)之后、生成的工具 SDK(5000)之前。
 *
 * 这一段讲的是"这些工具按什么顺序用、怎么算用完",紧挨着工具说明读起来才顺;
 * 早于它会被工具说明冲散,晚于工具 SDK 又会被那一大坨参考淹掉。
 */
export const WORKFLOW_SECTION_ORDER = 4900

/**
 * 一条判据的写法。
 *
 * - `zero` / `empty` / `nonEmpty` / `true` / `false` 是"形态";
 * - `equals` 拿 `value` 比字面量(`playtest.state` = `"pass"` 这种枚举)。
 */
export type CriterionOp = 'zero' | 'empty' | 'nonEmpty' | 'true' | 'false' | 'equals'

/**
 * **一条"这一步做完了"的判据**:指向推导板上的一个真字段。
 *
 * 刻意不是一句人话:人话会跟接缝分叉,字段路径不会 —— 字段被改名,守卫就红。
 */
export interface BoardCriterion {
  /** `ProgressSnapshot` 上的点路径(如 `summary.missingSlots`)。 */
  path: string
  op: CriterionOp
  /** `op: 'equals'` 时的期望值。 */
  value?: string
}

/** 流程里的一个环节。 */
export interface WorkflowStage {
  /** 这一步叫什么(面向人的说法:建项目 / 设定集 / 剧本 / 素材 / 音频 / 试玩 / 发布)。 */
  name: string
  /** 这一步在干什么(一句话,给模型定坐标用)。 */
  what: string
  /**
   * 服务这一步的 agent 工具名。**这里可以列"还没做"的入口** —— 渲染时只露真的注册了的;
   * 一个都没有就如实说"请人在工作台做"。所以这个列表允许超前于工具面。
   */
  tools: string[]
  /**
   * 进这一步之前挡在前面的东西(**每一环都有**,包括第一环:没有项目时什么都做不了)。
   *
   * `code` 有值 = 这是接缝会**抛**的拒绝码(取自 `gates.ts`,渲染时点名);
   * 没有 `code` = 这道闸门不是一条拒绝,而是板上的一条 error / 发布前置里的一项
   * (发布那格是 `blockers[]`,不是一个码)—— 那就把**形状**讲清楚,别编一个码出来。
   */
  gate: { code?: string; what: string }
  /** 完成判据(板上真字段;至少一条)。 */
  done: BoardCriterion[]
  /** 这一步里**只有人能做**的事。 */
  human?: string
}

/**
 * 全流程(环节名 / 闸门 / 判据 / 谁来做)。
 *
 * 顺序即真相:v1 的环节是横向建的(环节零 → 剧本 → 组装试玩 → 素材 → 音频/发布,
 * 见 CONTEXT 的"环节"条),但**走的时候是纵向的** —— 上一环没过,下一环的产物就没有意义
 * (没定稿的设定集生成出来的戏、没素材的戏试玩出来的界面,都不算数)。这里的七步是那条
 * 纵线,比"环节"多出建项目与设定集两步。
 */
export const GALFREE_WORKFLOW: readonly WorkflowStage[] = [
  {
    name: '建项目',
    what: '一部 galgame = 磁盘上一个 Ren\'Py 项目目录(v1 只从模板新建,不导入既有项目)',
    tools: ['galfree_create_project'],
    gate: { what: '一部都还没有的时候,所有 galfree 工具都只会回一句"先新建或激活一个项目" —— 第一步只能请人开个头' },
    done: [{ path: 'scenes', op: 'nonEmpty' }],
  },
  {
    name: '设定集',
    what: '世界观 / 角色设定(同步落角色登记簿)/ 章节大纲 —— 下游所有生成的唯一记忆源',
    tools: ['galfree_write_bible', 'galfree_import_outline'],
    gate: { what: '空设定集生成出来的东西没有上游依据 —— 先把世界观 / 角色 / 章节写下(人给的主题或大纲是它的输入)' },
    // 这一步的"做完"就是**人拍板**:设定集是后面每一次生成的上游,不盖章就往下走等于拿草稿当真源。
    done: [{ path: 'bible.stamp', op: 'equals', value: 'approved' }],
    human: '「设定定稿」戳只有人能盖',
  },
  {
    name: '剧本',
    what: '逐场写 `.rpy`(方言子集,一场一个 label):`.rpy` 是叙述与分支结构的唯一真相',
    tools: ['galfree_generate_scene'],
    gate: {
      code: GATE.bibleNotFinal,
      what: '设定集还没盖「设定定稿」戳(或盖过之后内容又改了)—— **这不是故障,是"去请人盖戳"**;盖上再来生成',
    },
    done: [
      { path: 'lint.ok', op: 'true' },
      { path: 'completeness.orphans', op: 'empty' },
    ],
    human: '写完请人读一遍、盖场景戳才算这一幕定稿(板上"只读降级"的场景盖不了:先把子集外语法改回子集内)',
  },
  {
    name: '素材',
    what: '给 `.rpy` 引用到的每个素材槽出图(立绘表情差分 / 背景 / CG)',
    tools: [
      'galfree_image_channel', 'galfree_art_queue',
      'galfree_generate_image', 'galfree_reroll_image',
      'galfree_fill_missing_art', 'galfree_character_art', 'galfree_reference_chain',
    ],
    gate: {
      code: GATE.noImageChannel,
      what: '还没配图像渠道 —— 请人到「设置 → 插件 → GALFree」填端点、密钥与模型目录,再用 `galfree_image_channel` 看有哪些模型',
    },
    done: [{ path: 'summary.missingSlots', op: 'zero' }],
    human: '出完图请人在素材板上盖槽戳(审读戳只有人能盖)',
  },
  {
    name: '音频',
    what: 'BGM/SE 是**接进来的**,不是生成的:把音频文件放进 `game/`,再在场景里接线(引用是**相对 `game/` 的路径**)',
    tools: ['galfree_set_scene_audio'],
    gate: { what: '池是派生的(文件丢进 `game/` 就有,不用登记),但**引用必须落地**:悬空的音频引用在板上是一条 error(定位到哪一场哪一行),发布前置也会被它拦下' },
    done: [{ path: 'audio.missing', op: 'empty' }],
    human: '试听靠试玩,认可靠人盖场景戳',
  },
  {
    name: '试玩',
    what: '用钉版 SDK **真跑一次**游戏(技术通过是推导:退出码 + 日志干净)',
    tools: ['galfree_playtest'],
    gate: {
      code: GATE.sdkNotReady,
      what: '钉版 SDK 还没就绪 —— 先到工作台 / 设置里完成 SDK 供给(首次是下载)',
    },
    done: [{ path: 'playtest.state', op: 'equals', value: 'pass' }],
    human: '"玩过了、行"只有人能说(盖场景戳)—— 技术通过不等于好玩',
  },
  {
    name: '发布',
    what: '钉版 SDK 打本地发行物(build_dists):产物落在**项目源树之外**,平台上传与在线分发不做',
    tools: ['galfree_publish'],
    gate: {
      what: '前置检查没过就**不构建**:`blockers[]` 逐项列出缺什么(每项有 `code` / `label` / `detail`)—— 先 `readiness_only: true` 只看缺项,照着 `label` 修,别绕过',
    },
    done: [
      { path: 'publish.ok', op: 'true' },
      { path: 'publish.stale', op: 'false' },
    ],
    human: '这一版发不发(以及发哪些包)由人拍板',
  },
]

/** 注册这段指引时能看到的工具面。 */
export interface PlaybookOptions {
  /** 某个工具此刻**真的注册了**吗(`ctx.tools.get(name) !== undefined`)。 */
  hasTool?: (name: string) => boolean
}

/** 判据 → 人话(只报字段与形态,不报数字;数字永远去问板)。 */
function describeCriterion(criterion: BoardCriterion): string {
  const at = `板上 \`${criterion.path}\``
  switch (criterion.op) {
    case 'zero': return `${at} 为 0`
    case 'empty': return `${at} 为空`
    case 'nonEmpty': return `${at} 非空`
    case 'true': return `${at} 为 true`
    case 'false': return `${at} 为 false`
    case 'equals': return `${at} 为 "${criterion.value ?? ''}"`
  }
}

/** 这一步现在能不能自己做(能就点名工具,不能就如实说请人做)。 */
function describeTools(tools: readonly string[], hasTool: (name: string) => boolean): string {
  const available = tools.filter(hasTool)
  if (available.length === 0) {
    return '怎么做:**目前没有 agent 入口** —— 这一步请人在工作台做(说清要他做什么、为什么要做)'
  }
  return `怎么做:用 ${available.map((tool) => `\`${tool}\``).join(' / ')}`
}

/** 渲染整段流程指引(纯函数:工具面由 `hasTool` 现问,所以文本不会报一个不存在的入口)。 */
export function workflowPlaybook(options: PlaybookOptions = {}): string {
  const hasTool = options.hasTool ?? (() => false)
  const lines: string[] = [
    '## GALFree:galgame 全流程',
    '',
    '**动手之前先问现状,不要凭记忆**:调 `galfree_project_status` 读推导板 —— 场景(含审读戳状态)、素材槽、',
    '角色、设定集处境、音频引用、lint、试玩与发布都在那一份里。下面每一步的"做完了"都用**板上的字段**当判据,',
    '不写死数字:板说没齐就是没齐。',
    '',
    '**顺序**(上一环没过就别跳下一环:没定稿的设定集生成出来的戏、没素材的戏试玩出来的界面,都不算数):',
    '',
  ]
  GALFREE_WORKFLOW.forEach((stage, index) => {
    lines.push(`${index + 1}. **${stage.name}** —— ${stage.what}`)
    lines.push(`   - ${describeTools(stage.tools, hasTool)}`)
    lines.push(`   - 闸门${stage.gate.code === undefined ? '' : `(\`${stage.gate.code}\`)`}:${stage.gate.what}`)
    lines.push(`   - 做完了 = ${stage.done.map(describeCriterion).join('、')}`)
    if (stage.human !== undefined) lines.push(`   - 人:${stage.human}`)
  })
  lines.push(
    '',
    `**谁来做**:审读戳(场景 / 素材槽 / 设定定稿)**永远只有人能盖** —— agent 侧根本没有这个入口,硬试会被 \`${GATE.stampForbidden}\` 拒。`,
    '所以:内容你改,戳请人盖;试玩的"玩过了、行"、"这一版发不发"也是人的事。校验通过、试玩技术通过、',
    '发布前置检查都是**推导**,不用人点头。',
    '',
    '**如实呈现的纪律**:校验不过、构建失败、出图失败都**不抛异常**,而是把事实(issues / lint / blockers /',
    'lastError / degradation)原样带回给你 —— 照着它当场改完,再用**同一个 label / 同一个槽**重试,别换个名字绕开,',
    '也不要把 `ok: false` 说成"完成了"。被拒绝的那句话本身,就是下一步要你做的事。',
  )
  return lines.join('\n')
}

/**
 * `ctx.systemPrompt` 的**结构面**(只用到 `section`):这样这段指引既能在真宿主上装配,
 * 也能在没有宿主的测试里注册进一个假席位 —— 不为了测试而引入对宿主包的运行时依赖。
 */
export interface SystemPromptSeat {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}

/**
 * `ctx.tools` 的**结构面**(只用到 `get`):指引靠它回答"这一步有没有 agent 入口"。
 *
 * 与目录选择席位同一个态度 —— 按名取用、容忍缺席。探不到就**当没有**:这段提示是锦上添花,
 * 绝不能把整段系统提示搞崩(宁可保守说"请人做")。放在这里而不是入口里,是为了让真宿主守卫
 * 能用**同一个**探针(否则守卫验的是它自己另写的一个)。
 */
export interface ToolRegistrySeat {
  // 方法写法(而非属性写法):宿主的 `get` 收的是它自己的 `ScopeKey`,这里按结构对齐时
  // 参数按双变处理 —— 我们只传一个名字,不碰 scope。
  get?(name: string, scope?: unknown): unknown
}

/** 工具在不在?缺席位 / 席位形状不对 / 探测抛错 → 一律"不在"。 */
export function toolPresenceProbe(seat: ToolRegistrySeat | undefined): (name: string) => boolean {
  return (name) => {
    try {
      return seat?.get?.(name) !== undefined
    } catch {
      return false
    }
  }
}

/**
 * 注册这段指引;返回接缝给的 disposer(插件卸载要能摘掉)。
 *
 * `seat` 缺席(宿主没有 system prompt 席位)= 少一段提示,**不崩**:返回一个空的 disposer。
 * 入口侧本来就用 cordis 的 `inject` 按需装配,这一层是同一个态度的兜底。
 */
export function registerGalfreePlaybook(seat: SystemPromptSeat | undefined, options: PlaybookOptions = {}): () => void {
  if (seat === undefined) return () => { /* 没有席位:什么都不做 */ }
  return seat.section({
    name: WORKFLOW_SECTION,
    order: WORKFLOW_SECTION_ORDER,
    // **每次组装现算**:工具面是可选席位,可能晚于本段就位(#28 还会继续往里加工具),
    // 固化成字符串就会报一个那一刻并不存在的入口。
    text: () => workflowPlaybook(options),
  })
}
