/**
 * 推导进度引擎(ADR-0008):阶段板 = (项目文件 + 结构解析 + 校验 + 审读戳)
 * 的**纯函数推导** —— 可全量重算、幂等,任何侧不得手改进度字段。
 *
 * 客观可算的一律推导:缺对白、素材槽缺没缺(文件在不在)、lint 过没过、
 * 戳过没盖过 / 盖了但内容又变了(待复审)。算不出的(主观认可)才是戳。
 */
import { ABSENT, fileFingerprint, fingerprint } from './hash.ts'
import type { DialectProblem, SceneNode, Statement } from './rpy/dialect.ts'
import type { PlaytestRun } from './playtest.ts'
import { readStamps, sceneTarget, slotTarget, BIBLE_STAMP_TARGET } from './stamps.ts'
import type { CharacterRecord, SlotRecord } from './characters.ts'
import { OUTLINE_FILE } from './bible.ts'
import type { DerivedSlot, SlotOrigin } from './slots.ts'
import type { AudioPoolView } from './audio.ts'
import type { PublishView } from './publish.ts'

export type StampState = 'none' | 'pending' | 'approved' | 'stale' | 'missing'

/**
 * 场景上"需要人看一眼的事"——**由推导引擎给出,不是 UI 自己判断**。
 *
 * 舞台板要在一行里说清每一场戏的处境;如果让 UI 拿 missingDialogue/slots/lintErrors
 * 自己拼结论,那就是把领域判断搬进适配器(ADR-0002 明令禁止)。因此这里把每条
 * 事实按同一优先级顺序派生成带文案与严重度的 marks:agent 工具面与工作台读同一份。
 */
export type SceneMarkSeverity = 'info' | 'warn' | 'error'

export interface SceneMark {
  /** 稳定机器码(供 agent/前端判别,不依赖中文文案)。 */
  code: 'lint-error' | 'missing-dialogue' | 'missing-slots' | 'read-only-degraded' | 'content-changed' | 'settled' | 'clear'
  severity: SceneMarkSeverity
  /** 面向人的一句话(中文;UI 直接显示,不再自己措辞)。 */
  label: string
  /** 相关计数(缺几个槽、几个 lint 错);不适用则缺省。 */
  count?: number
  /** 悬停补充说明。 */
  detail?: string
}

/** 严重度顺序由 `deriveSceneMarks` 的 push 次序直接保证:error → warn → info。 */

export interface SlotProgress {
  slot: string
  /** 约定素材路径(相对项目根);由槽名派生。 */
  assetPath: string
  filled: boolean
  /** 素材文件指纹(内容哈希),缺=absent。 */
  fingerprint: string
  stamp: StampState
  /**
   * 人能否给它盖戳 —— 由接缝判定(未填 → 不可;已认可 → 可重盖)。
   * UI 只读这个布尔,不自己复述"未填不可盖"这条规则。
   */
  approvable: boolean
  /** 盖戳被拒的原因(approvable=false 时有值)。 */
  approvableBlockedBy?: string
  /**
   * 有图、但还没被人认可(含"认可过又变了")——**纯推导**。
   * T15 的"待复审队列"与面板的徽标都读这一个布尔,不在适配器里重算。
   */
  awaitingReview: boolean
}

export interface SceneProgress {
  label: string
  file: string
  line: number
  /** 子集外语法 → 只读降级(与 T4 同源)。 */
  readOnly: boolean
  missingDialogue: boolean
  dialogueCount: number
  slots: SlotProgress[]
  missingSlots: string[]
  /** 场景级审读戳状态。 */
  stamp: StampState
  /** 人能否给这一场盖戳(只读降级 → 不可:先改回子集内再谈定稿)。 */
  stampable: boolean
  stampableBlockedBy?: string
  lintErrors: number
  /** 舞台上这一行要显示的派生事实(已排序:error → warn → info)。 */
  marks: SceneMark[]
}

export interface ProgressSummary {
  scenes: number
  missingDialogue: number
  missingSlots: number
  lintErrors: number
  /** 盖过戳但内容已变(待复审)的戳数(场景 + 槽)。 */
  awaitingReview: number
  degraded: number
  /** 最近试玩技术不通过(0/1)。 */
  playtestFail: number
  /** 从未成功跑过试玩(0/1)。 */
  playtestNotRun: number
}

export interface PlaytestView {
  at: string
  /** pass = 技术通过且内容未再变动;fail = 有 traceback/非零退出;stale = 跑过后内容又变了。 */
  state: 'pass' | 'fail' | 'stale'
  exitCode: number
  technicalPass: boolean
  traceback: string | null
  /** 从哪一场开始试的(null = 从头)。 */
  from: string | null
}

/** 项目级完整性处境(T13):板上一眼看出"这条线走不走得通"。 */
export interface CompletenessView {
  entry: string | null
  orphans: string[]
  endingReachable: boolean
}

/**
 * 「下一步」的动作码(T21)—— 稳定机器码,面板与 agent 都按它判别,不依赖中文文案。
 *
 * 命名分族:`*-missing` = 东西还没有;`*-needs-stamp` / `*-awaiting-review` = 等人;
 * `*-errors` / `*-failed` = 坏了要先修;`publish-*` = 收尾那一下。
 */
export type NextActionCode =
  | 'bible-missing'
  | 'bible-needs-stamp'
  | 'scenes-missing'
  | 'lint-errors'
  | 'missing-slots'
  | 'missing-audio'
  | 'playtest-not-run'
  | 'playtest-failed'
  | 'playtest-stale'
  | 'scenes-awaiting-review'
  | 'art-awaiting-review'
  | 'publish-ready'
  | 'publish-stale'
  | 'publish-failed'

/** 面板据此跳转(工作台上的锚点;agent 可以据此决定先动哪一场/哪个槽)。 */
export type NextActionTarget =
  | { kind: 'bible' }
  | { kind: 'scene'; label: string }
  | { kind: 'slot'; slot: string }
  | { kind: 'audio'; scene: string; line: number }
  | { kind: 'playtest' }
  | { kind: 'publish' }

/**
 * 板上的一条「下一步」。
 *
 * 与 `problems` 的分工是刻意的:`problems` 说**哪里坏了**(定位到文件与行,是缺陷清单),
 * `nextActions` 说**接着做什么**(带 actor 与跳转目标,是行动清单)。同一件事可以两边都出现
 * (悬空跳转既是 problem 也是"谁去修"),但一个用来读、一个用来做。
 */
export interface NextAction {
  code: NextActionCode
  /** 面向人的一句话(面板与 agent 读**同一份**,不各自措辞)。 */
  label: string
  /** 谁能做这件事:要人主观判断的一律 `human`(盖戳 / 认可 / 发布拍板)。 */
  actor: 'agent' | 'human'
  /** 具体到槽名 / label / 引用(照着做就行)。 */
  detail?: string
  target?: NextActionTarget
}

/** detail 里罗列名字的上限(板上几十个槽时,别把一屏塞满)。 */
const DETAIL_LIST_LIMIT = 12

function listOf(names: readonly string[]): string {
  if (names.length <= DETAIL_LIST_LIMIT) return names.join('、')
  return `${names.slice(0, DETAIL_LIST_LIMIT).join('、')} …(共 ${names.length} 个)`
}

/**
 * **下一步**(纯函数,T21):从同一份推导结果里排出"接着做什么"。
 *
 * 三条规矩:
 *  1. **纯推导**:只读入参,不写、不缓存;同一份输入两次调用结果完全相同(顺序也相同)。
 *  2. **阻塞在前、打磨在后**:先"没它就走不下去"(设定集 / 结构错 / 缺素材 / 悬空音频),
 *     再"该看一眼了"(试玩),最后才是等人认可与收尾(盖戳 / 发布)。
 *  3. **actor 是推导的一部分**:要人主观判断的一律 `human` —— 盖审读戳、认可、发布拍板;
 *     生成 / 补素材 / 接线 / 跑试玩是 `agent` 能做的(它有没有入口由工具面决定,
 *     这里只说"这件事归谁")。
 *
 * 板上没毛病时**给一条 `publish-ready`**(而不是空数组):让"可以做完了"有明确形态 ——
 * 与 `deriveSceneMarks` 的 `clear/settled` 同一个态度。
 */
export function deriveNextActions(input: {
  bible: BibleProgress
  scenes: readonly SceneProgress[]
  slots: readonly SlotProgress[]
  audio: AudioPoolView
  problems: readonly DialectProblem[]
  lint: { ok: boolean; errors: number }
  playtest: PlaytestView | null
  publish: PublishView | null
}): NextAction[] {
  const actions: NextAction[] = []
  const errors = input.problems.filter((problem) => problem.severity === 'error')

  // ── 设定集:先有内容,再等人拍板 ────────────────────────────────────
  const bibleEmpty = input.bible.chapters === 0 && !input.bible.hasOutline
  if (bibleEmpty) {
    // 措辞要跟着**实际有什么**走:已经写了世界观 / 角色卡但还没章节骨架时,
    // 说"还没有设定集"是假话(而且会让人以为前面白写了)。
    const started = input.bible.characters > 0
    actions.push({
      code: 'bible-missing',
      actor: 'agent',
      label: '写设定集(世界观 / 角色 / 章节大纲)',
      detail: started
        ? '设定集还没有章节骨架 —— 下游生成要有它才站得住'
        : '还没有设定集 —— 它是下游所有生成的唯一记忆源',
      target: { kind: 'bible' },
    })
  } else if (input.bible.stamp !== 'approved') {
    actions.push({
      code: 'bible-needs-stamp',
      actor: 'human',
      label: input.bible.stamp === 'stale'
        ? '请人重新审读设定集并盖「设定定稿」戳(改过之后戳失效了)'
        : '请人审读设定集并盖「设定定稿」戳',
      detail: '没盖章时逐场生成会被 bible-not-final 拒 —— 那不是故障,是"去请人盖戳"',
      target: { kind: 'bible' },
    })
  }

  // ── 剧本:还没有生成过任何场景 ──────────────────────────────────────
  // 生成物固定落在 game/scenes/(一 label 一文件);一个都没有 = 还没开始逐场生成。
  if (input.scenes.length === 0 || input.scenes.every((scene) => !scene.file.startsWith('scenes/'))) {
    actions.push({
      code: 'scenes-missing',
      actor: 'agent',
      label: '生成第一场戏',
      detail: '还没有逐场生成过场景(生成物落在 game/scenes/<label>.rpy)',
    })
  }

  // ── 结构错:先修再谈别的 ────────────────────────────────────────────
  if (input.lint.errors > 0) {
    const first = errors.find((problem) => problem.file !== '')
    // 定位到**包含这一行的那一场**(同文件里起始行最大的那个仍 ≤ 问题行)——
    // 取第一个匹配会把整份文件的问题都算到第一场上,面板跳过去就跳错了。
    const candidates = first === undefined || first.line === undefined
      ? []
      : input.scenes.filter((candidate) => candidate.file === first.file && candidate.line <= first.line!)
    const scene = candidates.length === 0
      ? (first === undefined ? undefined : input.scenes.find((candidate) => candidate.file === first.file))
      : candidates.reduce((best, candidate) => (candidate.line > best.line ? candidate : best))
    actions.push({
      code: 'lint-errors',
      actor: 'agent',
      // 说"板上的 error"而不是"结构问题":这个清单里既有结构问题(structural),
      // 也有悬空音频引用这类**内容引用**的问题 —— 一律叫结构问题是在替它们归类。
      label: `修板上的 error(${input.lint.errors} 处)`,
      detail: listOf(errors.slice(0, 6).map((problem) => `${problem.file}${problem.line === undefined ? '' : `:${problem.line}`} ${problem.message}`)),
      ...(scene === undefined ? {} : { target: { kind: 'scene' as const, label: scene.label } }),
    })
  }

  // ── 素材 / 音频:还没落地的引用 ─────────────────────────────────────
  const missingSlots = input.slots.filter((slot) => !slot.filled)
  if (missingSlots.length > 0) {
    actions.push({
      code: 'missing-slots',
      actor: 'agent',
      label: `补素材(${missingSlots.length} 个槽还没有图)`,
      detail: listOf(missingSlots.map((slot) => slot.slot)),
      target: { kind: 'slot', slot: missingSlots[0]!.slot },
    })
  }
  if (input.audio.missing.length > 0) {
    const first = input.audio.missing[0]!
    actions.push({
      code: 'missing-audio',
      actor: 'agent',
      label: `让音频引用落地(${input.audio.missing.length} 处悬空)`,
      detail: `${listOf(input.audio.missing.map((reference) => `${reference.ref}(${reference.scene}:${reference.line})`))} —— 改成池里已有的路径,或请人把文件放进 game/`,
      target: { kind: 'audio', scene: first.scene, line: first.line },
    })
  }

  // ── 试玩:技术通过是推导,跑不跑是 agent 的活 ───────────────────────
  if (input.playtest === null) {
    actions.push({
      code: 'playtest-not-run',
      actor: 'agent',
      label: '跑一次试玩(会用钉版 SDK 开真窗口)',
      detail: '还没跑过:技术通过是推导(退出码 + 日志干净);认可才是人的事',
      target: { kind: 'playtest' },
    })
  } else if (input.playtest.state === 'fail') {
    actions.push({
      code: 'playtest-failed',
      actor: 'agent',
      label: '照 traceback 修完再跑一次试玩',
      detail: (input.playtest.traceback ?? `退出码 ${input.playtest.exitCode}`).split('\n').slice(0, 6).join('\n'),
      target: { kind: 'playtest' },
    })
  } else if (input.playtest.state === 'stale') {
    actions.push({
      code: 'playtest-stale',
      actor: 'agent',
      label: '内容改过了,再跑一次试玩',
      detail: '上次试玩之后内容又变了 —— 那一次的技术通过不再代表这一版',
      target: { kind: 'playtest' },
    })
  }

  // ── 等人:审读戳只有人能盖 ──────────────────────────────────────────
  // 两种"等人"共用一条动作:戳失效了(stale,改过之后要重看)与还没盖过(none)。
  // 同时只会出现一种 —— 所以合成一条,而不是写两遍同样的 push。
  const staleScenes = input.scenes.filter((scene) => scene.stamp === 'stale')
  const unstampedScenes = input.scenes.filter((scene) => scene.stamp === 'none')
  const pendingScenes = staleScenes.length > 0 ? staleScenes : unstampedScenes
  if (pendingScenes.length > 0) {
    actions.push({
      code: 'scenes-awaiting-review',
      actor: 'human',
      label: staleScenes.length > 0
        ? `请人复审改动过的场景(${staleScenes.length} 场戳失效了)`
        : `请人读一遍并盖场景戳(${unstampedScenes.length} 场还没定稿)`,
      detail: listOf(pendingScenes.map((scene) => scene.label)),
      target: { kind: 'scene', label: pendingScenes[0]!.label },
    })
  }
  const unreviewed = input.slots.filter((slot) => slot.awaitingReview)
  if (unreviewed.length > 0) {
    actions.push({
      code: 'art-awaiting-review',
      actor: 'human',
      label: `请人在素材板上盖槽戳(${unreviewed.length} 张待认可)`,
      detail: listOf(unreviewed.map((slot) => slot.slot)),
      target: { kind: 'slot', slot: unreviewed[0]!.slot },
    })
  }

  // ── 收尾:板上没有拦路的东西了,才谈"发不发"(而那是人拍板)──────────
  //
  // 这一格的措辞要**准**:它推的是"板上的推导不再挡着发布",不是"发布会成功" ——
  // SDK 供给 / 输出目录 / 界面图这些前置不在这份推导里(那是 `publishReadiness()` 的事),
  // 所以 detail 里必须点明去哪看真正的准备度。上一次构建**失败**也要如实说,
  // 不能因为 `stale:false` 就说成"产物就是当前这一版"(那时根本没有产物)。
  const boardClear = input.lint.ok && missingSlots.length === 0 && input.audio.missing.length === 0
  if (boardClear) {
    const readinessNote = '能不能真发以发布前置检查为准(SDK 供给 / 输出目录 / 界面图那些不在这份推导里)'
    if (input.publish !== null && !input.publish.ok) {
      actions.push({
        code: 'publish-failed',
        actor: 'agent',
        label: '上一次构建失败了:看日志修完再发',
        detail: (input.publish.logTail.trim() === '' ? '(没有日志尾巴)' : input.publish.logTail.trim()).split('\n').slice(-6).join('\n'),
        target: { kind: 'publish' },
      })
    } else if (input.publish !== null && input.publish.stale) {
      actions.push({
        code: 'publish-stale',
        actor: 'human',
        label: '上次发布的产物已过期(内容又改了)—— 问人要不要重发',
        detail: `${input.publish.destination};${readinessNote}`,
        target: { kind: 'publish' },
      })
    } else if (input.publish === null) {
      actions.push({
        code: 'publish-ready',
        actor: 'human',
        label: '挡着发布的东西都没了:问人要不要发第一版',
        detail: `产物会落在项目源树之外,平台上传不做;${readinessNote}`,
        target: { kind: 'publish' },
      })
    } else {
      actions.push({
        code: 'publish-ready',
        actor: 'human',
        label: '产物就是当前这一版 —— 问人还要不要发别的包',
        detail: `${input.publish.destination};${readinessNote}`,
        target: { kind: 'publish' },
      })
    }
  }

  return actions
}

/**
 * 素材板上的一个槽:派生出来的槽(来自 `.rpy` 引用)+ 账本制作信息 + 推导出来的状态。
 *
 * `filled` / `stamp` / `approvable` 仍是**推导**(文件在不在 + 指纹比对 + 戳账本);
 * `ledger` 是挂上来的制作信息(要谁出场、提示词、画风锚),不参与状态判定。
 */
export interface SlotBoardEntry extends SlotProgress {
  ledger?: SlotRecord
  origin: SlotOrigin
}

/**
 * 素材板上的一个角色:登记簿条目 + 推导出来的可见性。
 * `defined` = 剧本里有对应的 `define <voice> = Character(...)`;
 * `slots` = 账本要求这个角色出场的槽(来自 `requiresCharacters`)。
 */
export interface CharacterBoardEntry extends CharacterRecord {
  defined: boolean
  /** 剧本里那个 Character 的显示名(与登记簿 name 不一致时如实并列)。 */
  scriptDisplayName?: string
  definedAt?: { file: string; line: number }
  /** 账本里要求这个角色出场的槽名(派生)。 */
  slots: string[]
}

/** 设定集在板上的处境(T9):戳状态 + 大纲原文状态都是推导的。 */
export interface BibleProgress {
  stamp: StampState
  chapters: number
  characters: number
  /** 有没有导入过人的原文。 */
  hasOutline: boolean
  /**
   * 原文与记录在设定集里的指纹是否一致。
   * 不一致 → 原文被外部改过,板上如实报(不假装它还是那份权威原文)。
   */
  outlineFingerprintOk: boolean
}

export interface ProgressSnapshot {
  scenes: SceneProgress[]
  /** 素材板:`.rpy` 派生的槽清单(挂账本 + 推导状态),与 scenes[].slots 同源。 */
  slots: SlotBoardEntry[]
  /** 素材板:角色登记簿 + 推导出来的可见性。 */
  characters: CharacterBoardEntry[]
  /** 设定集处境(推导:戳指纹比对 + 原文指纹比对)。 */
  bible: BibleProgress
  /** 项目级完整性(T13):入口 / 孤立场景 / 结局可达。 */
  completeness: CompletenessView
  /** 音频文件池与引用处境(T17):池是派生的,悬空引用已经并进 problems。 */
  audio: AudioPoolView
  /**
   * 发布处境(T18):上次发布的产物与新鲜度(没发布过 = null)。
   * 与试玩同一套:事实记在 `.studio/`,推导只回答"还代表当前这一版吗"。
   */
  publish: PublishView | null
  /** 顶层(非场景内)结构问题。 */
  problems: DialectProblem[]
  lint: { ok: boolean; errors: number; warnings: number }
  /** 最近一次试玩事实的推导视图(无记录 = null)。 */
  playtest: PlaytestView | null
  /**
   * 「下一步」(T21):**纯推导**的行动清单(带 actor 与跳转目标)。
   * 与 `problems` 分工:那个说哪里坏了(定位缺陷),这个说接着做什么(给动作)。
   */
  nextActions: NextAction[]
  summary: ProgressSummary
  degraded: boolean
}

/** 槽名与约定素材路径的唯一出处在 slot-naming.ts;此处再导出以兼容既有引用。 */
export { slotAssetPath, slotName } from './slot-naming.ts'
import { slotAssetPath, slotName } from './slot-naming.ts'

/** 场景内容指纹:**原始文本块**哈希(任何改动都算改动,包括被解析器
 *  跳过的子集外内容 —— 否则新增 if/ATL 块不会使已有戳失效)。 */
export function sceneFingerprint(scene: Pick<SceneNode, 'text'>): string {
  return fingerprint(scene.text)
}

async function assetFingerprint(root: string, assetPath: string): Promise<string> {
  return fileFingerprint(root, assetPath)
}

/**
 * 场景事实 → 舞台上那一行要显示的标记(纯函数,已排序)。
 *
 * 顺序即优先级:先 error(lint 错),再 warn(缺对白/缺素材/待复审),
 * 最后 info(只读降级 —— 它是要人动手的事,但不是这一场内容本身的缺陷)。
 * 全都没有时给一条 info,让"这一场没毛病"在界面上有明确形态,而不是空白。
 */
export function deriveSceneMarks(input: {
  lintErrors: number
  missingDialogue: boolean
  missingSlots: string[]
  readOnly: boolean
  stamp: StampState
}): SceneMark[] {
  const marks: SceneMark[] = []
  if (input.lintErrors > 0) {
    marks.push({
      code: 'lint-error',
      severity: 'error',
      count: input.lintErrors,
      // 注意:label **不带计数** —— 计数由 count 单独承载,由 UI 决定怎么摆,
      // 否则界面上会出现"lint 1 错 1"这种重复。
      label: 'lint 错',
      detail: '这一场有 error 级结构问题(悬空跳转/重复 label 等),先修再谈定稿',
    })
  }
  if (input.missingSlots.length > 0) {
    marks.push({
      code: 'missing-slots',
      severity: 'warn',
      count: input.missingSlots.length,
      label: '缺素材',
      detail: input.missingSlots.join('、'),
    })
  }
  if (input.missingDialogue) {
    marks.push({
      code: 'missing-dialogue',
      severity: 'warn',
      label: '缺对白',
      detail: '这一场没有任何对白行',
    })
  }
  if (input.stamp === 'stale') {
    marks.push({
      code: 'content-changed',
      severity: 'warn',
      label: '待复审',
      detail: '盖过审读戳,但内容之后又变了 —— 需要人重新审读',
    })
  }
  if (input.readOnly) {
    marks.push({
      code: 'read-only-degraded',
      severity: 'info',
      label: '只读降级',
      detail: '这一场用了方言子集外的语法:结构只按能解析的部分算,不能盖审读戳',
    })
  }
  if (marks.length === 0) {
    // 没有任何待办时,把"处境"本身说清楚:定稿了,还是只是暂时没毛病。
    marks.push(input.stamp === 'approved'
      ? { code: 'settled', severity: 'info', label: '定稿', detail: '人已盖审读戳,且内容未再变动' }
      : { code: 'clear', severity: 'info', label: '结构齐', detail: '这一场没有缺对白、没有缺素材、没有 lint 错;还没盖审读戳' })
  }
  return marks
}

export interface ProgressInputs {
  /** 解析出的场景(来自 parseRpy)。 */
  scenes: SceneNode[]
  /** 顶层结构问题(来自 parseRpy.problems)。 */
  problems: DialectProblem[]
  /**
   * 派生出来的槽(来自 `deriveSlots`:`.rpy` 引用 + 账本 + 登记簿)。
   * 给了就用来组素材板;不给则退回"只从场景引用算"的轻量形态。
   */
  derivedSlots?: DerivedSlot[]
  /**
   * 角色登记簿 + 剧本里定义了哪些 Character(素材板角色视图要显示的派生事实)。
   * 登记簿本身是数据;`defined` 是推导出来的(剧本里有没有这个 voice)。
   */
  characters?: CharacterRecord[]
  definedCharacters?: Array<{ var: string; displayName: string; file: string; line: number }>
  /** 设定集处境输入(T9):戳与原文的指纹比对都在这里做。 */
  bible?: {
    /** 设定集派生物的当前指纹(与戳里记的比 → approved/stale)。 */
    fingerprint: string
    chapters: number
    characters: number
    hasOutline: boolean
    /** 原文当前指纹(读不到 = null)。 */
    outlineFingerprint: string | null
    /** 设定集里记的原文引用(没导入过 = null)。 */
    outlineRef: { fingerprint: string } | null
  }
  /** 项目级完整性输入(T13):入口 / 孤立场景 / 结局可达。 */
  completeness?: {
    entry: string | null
    orphans: string[]
    endingReachable: boolean
  }
  /** 音频文件池与引用处境(T17;池是派生的,悬空引用已经并进 problems)。 */
  audio: AudioPoolView
  /** 发布处境(T18;没发布过 = null)。 */
  publish?: PublishView | null
  /** 试玩事实(账本 last + 当前内容指纹);缺省视为未跑过。 */
  playtest?: { last: PlaytestRun | null; currentFingerprint: string }
}

/** 纯推导:读磁盘(戳账本 + 素材文件指纹)+ 已解析结构 → 进度快照。 */
export async function computeProgress(root: string, inputs: ProgressInputs): Promise<ProgressSnapshot> {
  const stamps = await readStamps(root)
  const byTarget = new Map(stamps.map((s) => [s.target, s]))

  const seenSlots = new Set<string>()
  const sceneProgress: SceneProgress[] = []
  // 场景行区间:同文件内按起始行排序,下一场景起始行 = 本场景上界。
  const lineBounds = new Map<SceneNode, number>()
  const byFile = new Map<string, SceneNode[]>()
  for (const scene of inputs.scenes) {
    const list = byFile.get(scene.file) ?? []
    list.push(scene)
    byFile.set(scene.file, list)
  }
  for (const list of byFile.values()) {
    const sorted = [...list].sort((a, b) => a.line - b.line)
    for (let i = 0; i < sorted.length; i += 1) {
      const next = sorted[i + 1]
      if (next !== undefined) lineBounds.set(sorted[i]!, next.line)
    }
  }
  for (const scene of inputs.scenes) {
    const slotNames: string[] = []
    for (const statement of scene.statements) {
      if (statement.kind === 'image' && (statement.role === 'show' || statement.role === 'scene')) {
        const name = slotName(statement)
        if (name.trim() !== '' && !slotNames.includes(name)) slotNames.push(name)
      }
    }
    const slots: SlotProgress[] = []
    for (const name of slotNames) {
      seenSlots.add(name)
      const assetPath = slotAssetPath(name)
      const assetFp = await assetFingerprint(root, assetPath)
      const filled = assetFp !== ABSENT
      const record = byTarget.get(slotTarget(name))
      let stamp: StampState
      if (record === undefined) stamp = filled ? 'pending' : 'missing'
      else stamp = record.fingerprint === assetFp ? 'approved' : 'stale'
      // 可盖性由接缝判定(与 stampSlot 的守卫同源):未填不能盖;已认可可重盖。
      slots.push({
        slot: name,
        assetPath,
        filled,
        fingerprint: assetFp,
        stamp,
        approvable: filled,
        ...(filled ? {} : { approvableBlockedBy: '素材文件还没生成,先出图再认可' }),
        awaitingReview: filled && stamp !== 'approved',
      })
    }
    const dialogueCount = scene.statements.filter((s) => s.kind === 'dialogue').length
    const sceneRecord = byTarget.get(sceneTarget(scene.label))
    const sceneFp = sceneFingerprint(scene)
    const sceneStamp: StampState = sceneRecord === undefined ? 'none' : sceneRecord.fingerprint === sceneFp ? 'approved' : 'stale'
    // 场景级 lint 错误:顶层 error 按 文件+行号区间 归属(行号落在本场景起、下一场景止之间)。
    let lintErrors = 0
    for (const problem of inputs.problems) {
      if (problem.severity !== 'error' || problem.file !== scene.file || problem.line === undefined) continue
      if (problem.line >= scene.line && (!lineBounds.has(scene) || problem.line < (lineBounds.get(scene) ?? Infinity))) lintErrors += 1
    }
    const missingSlots = slots.filter((s) => !s.filled).map((s) => s.slot)
    sceneProgress.push({
      label: scene.label,
      file: scene.file,
      line: scene.line,
      readOnly: scene.readOnly,
      missingDialogue: dialogueCount === 0,
      dialogueCount,
      slots,
      missingSlots,
      stamp: sceneStamp,
      stampable: !scene.readOnly,
      ...(scene.readOnly ? { stampableBlockedBy: '这一场用了方言子集外的语法(只读降级),先改回子集内再谈定稿' } : {}),
      lintErrors,
      marks: deriveSceneMarks({ lintErrors, missingDialogue: dialogueCount === 0, missingSlots, readOnly: scene.readOnly, stamp: sceneStamp }),
    })
  }

  // 全局素材槽缺失汇总:跨场景同名槽只计一次(去重后按缺失计)。
  const uniqueSlots = new Map<string, SlotProgress>()
  for (const scene of sceneProgress) for (const slot of scene.slots) if (!uniqueSlots.has(slot.slot)) uniqueSlots.set(slot.slot, slot)

  // 素材板:派生槽(带账本与定位)+ 推导出来的状态(与 scenes[].slots 同源,不另算一遍)。
  const sceneUsage = new Map<string, string[]>()
  for (const scene of sceneProgress) {
    for (const slot of scene.slots) {
      const used = sceneUsage.get(slot.slot) ?? []
      if (!used.includes(scene.label)) used.push(scene.label)
      sceneUsage.set(slot.slot, used)
    }
  }
  const slots: SlotBoardEntry[] = (inputs.derivedSlots ?? []).map((derived) => {
    const status = uniqueSlots.get(derived.slot)
    const usedIn = sceneUsage.get(derived.slot) ?? derived.origin.scenes
    return {
      slot: derived.slot,
      assetPath: derived.assetPath,
      filled: status?.filled ?? false,
      fingerprint: status?.fingerprint ?? ABSENT,
      stamp: status?.stamp ?? 'missing',
      approvable: status?.approvable ?? false,
      ...(status?.approvableBlockedBy === undefined ? {} : { approvableBlockedBy: status.approvableBlockedBy }),
      awaitingReview: status?.awaitingReview ?? false,
      ...(derived.ledger === undefined ? {} : { ledger: derived.ledger }),
      origin: { ...derived.origin, scenes: usedIn },
    }
  })

  // 设定集处境 + 原文指纹比对:两个"被改过"是两件事,分别判(戳管派生物,原文管原文)。
  const bibleRecord = byTarget.get(BIBLE_STAMP_TARGET)
  const bibleInput = inputs.bible
  const outlineFingerprintOk = bibleInput === undefined || bibleInput.outlineRef === null
    ? true
    : bibleInput.outlineRef.fingerprint === bibleInput.outlineFingerprint
  const bible: BibleProgress = {
    stamp: bibleRecord === undefined
      ? 'none'
      : bibleInput !== undefined && bibleRecord.fingerprint === bibleInput.fingerprint ? 'approved' : 'stale',
    chapters: bibleInput?.chapters ?? 0,
    characters: bibleInput?.characters ?? 0,
    hasOutline: bibleInput?.hasOutline ?? false,
    outlineFingerprintOk,
  }
  const bibleProblems: DialectProblem[] = outlineFingerprintOk ? [] : [{
    severity: 'error',
    file: OUTLINE_FILE,
    code: 'outline-fingerprint-mismatch',
    message: '人写的设定集原文与导入时记录不一致(被外部改过):请人确认后再据它生成',
    snippet: OUTLINE_FILE,
  }]
  const problems = [...inputs.problems, ...bibleProblems]
  const lintErrors = problems.filter((p) => p.severity === 'error').length
  const lintWarnings = problems.filter((p) => p.severity === 'warning').length

  // 素材板角色视图:登记簿条目 + 推导出来的"剧本里有没有它 / 哪些槽要它出场"。
  const definedByVar = new Map((inputs.definedCharacters ?? []).map((defined) => [defined.var, defined]))
  const slotsByCharacter = new Map<string, string[]>()
  for (const record of (inputs.derivedSlots ?? []).flatMap((derived) => (derived.ledger === undefined ? [] : [derived.ledger]))) {
    for (const id of record.requiresCharacters) {
      const used = slotsByCharacter.get(id) ?? []
      if (!used.includes(record.slot)) used.push(record.slot)
      slotsByCharacter.set(id, used)
    }
  }
  const characters: CharacterBoardEntry[] = (inputs.characters ?? []).map((character) => {
    const defined = character.voice === undefined ? undefined : definedByVar.get(character.voice)
    return {
      ...character,
      defined: defined !== undefined,
      ...(defined === undefined ? {} : { scriptDisplayName: defined.displayName, definedAt: { file: defined.file, line: defined.line } }),
      slots: slotsByCharacter.get(character.id) ?? [],
    }
  })

  const awaitingReview = sceneProgress.filter((s) => s.stamp === 'stale').length
    + [...uniqueSlots.values()].filter((s) => s.stamp === 'stale').length

  let playtest: PlaytestView | null = null
  const last = inputs.playtest?.last ?? null
  if (last !== null) {
    const fresh = last.fingerprint === (inputs.playtest?.currentFingerprint ?? '')
    playtest = {
      at: last.at,
      state: !fresh ? 'stale' : last.technicalPass ? 'pass' : 'fail',
      exitCode: last.exitCode,
      technicalPass: last.technicalPass,
      traceback: last.traceback,
      from: last.from ?? null,
    }
  }

  const completeness: CompletenessView = {
    entry: inputs.completeness?.entry ?? null,
    orphans: inputs.completeness?.orphans ?? [],
    endingReachable: inputs.completeness?.endingReachable ?? true,
  }

  // 「下一步」(T21):与上面同一份推导结果算出来的行动清单 —— 纯函数、无写、顺序固定。
  const nextActions = deriveNextActions({
    bible,
    scenes: sceneProgress,
    slots: [...uniqueSlots.values()],
    audio: inputs.audio,
    problems,
    lint: { ok: lintErrors === 0, errors: lintErrors },
    playtest,
    publish: inputs.publish ?? null,
  })

  const summary: ProgressSummary = {
    scenes: sceneProgress.length,
    missingDialogue: sceneProgress.filter((s) => s.missingDialogue).length,
    missingSlots: [...uniqueSlots.values()].filter((s) => !s.filled).length,
    lintErrors,
    awaitingReview,
    degraded: sceneProgress.filter((s) => s.readOnly).length,
    playtestFail: playtest !== null && playtest.state === 'fail' ? 1 : 0,
    playtestNotRun: playtest === null ? 1 : 0,
  }

  return {
    scenes: sceneProgress,
    slots,
    characters,
    bible,
    completeness,
    // 池与引用处境原样带出去(它是推导输入,不是这里算的):板上与面板读同一份。
    // **不给"缺省空池"**:空池 ≠ 没音频,静默绿灯比报错坏(缺省由调用方显式给)。
    audio: inputs.audio,
    // 发布处境同理:没发布过就是 null(如实),不是"发过了但是空的"。
    publish: inputs.publish ?? null,
    problems,
    lint: { ok: lintErrors === 0, errors: lintErrors, warnings: lintWarnings },
    playtest,
    nextActions,
    summary,
    degraded: summary.degraded > 0 || problems.length > 0,
  }
}
