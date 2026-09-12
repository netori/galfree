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
    summary,
    degraded: summary.degraded > 0 || problems.length > 0,
  }
}
