/**
 * 舞台板:一场戏一行,读的全是推导引擎给出的东西。
 *
 * 这里**不做判断**:标记文案、严重度、能不能盖戳(以及为什么不能)都来自接缝
 * (`scene.marks` / `scene.stampable` / `slot.approvable`)。加一行显示逻辑可以,
 * 加一条领域规则不行 —— 那种规则要长在 src/service/progress.ts 里,agent 工具面
 * 才能看到同一份(ADR-0002:独占逻辑零 UI 化)。
 *
 * 「下一步」(T21)同理:文案 / actor / 跳转目标全是 `progress.nextActions` 给的,
 * 面板只负责把它画出来、把点击翻译成"滚到那一格 / 打开那一场"。
 *
 * 三处动作面也守同一条纪律:
 *  · **「全部认可」**(T39):能盖什么、有多少全从 `progress` 数出来,先摆确认行再说清
 *    "将认可哪几类、各多少个",然后才调接缝(`stampPending`)—— 那是人的**一次性**认可,
 *    不许让人被自己盖掉的东西吓一跳;回执里的 `skipped` 由调用方原样报出。
 *  · **结构问题可点**:点一行就跳到"要改的那份文件"——能归到某一场的跳场景编辑器,
 *    否则跳文件检视器。**哪一场拥有这一行**是导航(在客户端按行号重推一次),
 *    不是领域规则(能不能盖戳那类结论仍然只从接缝来)。
 *  · **看 / 认可分成两个动作**:槽名点开是"看图",那颗「印」才是盖戳 —— 以前
 *    点一下就是盖戳,想看一眼图反而会盖上戳。
 */
import { useEffect, useState } from 'react'
import type { GalfreeApi } from './api.ts'
import type { DialectProblemView, NextActionView, ProgressView, SceneProgressView, StampPendingKind, StampTarget } from './types.ts'
import { STAGE_SYNC_KEY, STAMP_PENDING_KEY, stampKey } from './types.ts'
import { Chip, Seal, Spinner, relativeTime } from './ui.tsx'
import s from './panel.module.css'

const MARK_TONE: Record<string, 'warn' | 'bad' | 'none'> = {
  error: 'bad',
  warn: 'warn',
  info: 'none',
}

function markTone(severity: string): 'warn' | 'bad' | 'none' {
  return MARK_TONE[severity] ?? 'none'
}

/**
 * 跳转按钮的措辞:按 `target.kind` 给一个人话动词。
 *
 * 这是**表现层映射**(对一个场景目标,我们会打开场景编辑器),不是领域判断 ——
 * "该做什么"是 `progress.nextActions` 给的。所以映射只有这一处,认不出来的 kind
 * 退回一句中性的话,而不是让按钮点了没反应(`panel.tsx` 那边对认不出的 kind 会明说)。
 */
const JUMP_CAPTION: Record<string, string> = {
  scene: '打开这一场',
  audio: '打开这一场', // 音频的 target 带 scene + line:面板打开那一场(行内高亮不做,行号给 agent 用)
  slot: '看这个槽',
  bible: '看设定集',
  playtest: '看试玩',
  publish: '看发布',
  stage: '整备舞台', // 舞台层的目标落在本卡那颗按钮上(anchor `gf-stage-sync`)
}

/** 批量认可与整备舞台在 `busyKey` 里的 key 由 `types.ts` 统一给(见那里)。 */

/**
 * 「全部认可」将要盖什么、各有多少 —— **全从推导读**。
 *
 * 三类一起数,是因为确认行要一句说清(例:"将认可 51 场戏 + 23 个素材槽 + 设定集");
 * 只读降级的场景、文件还不存在的槽**盖不上**(接缝会如实列进 `skipped`),所以单独数出来
 * 一并说清 —— 确认行里报的数与实际会发生的事必须对得上,否则那句确认就是假的。
 */
function pendingStampCounts(progress: ProgressView): {
  scenes: number
  slots: number
  bible: boolean
  blockedScenes: number
  blockedSlots: number
  total: number
} {
  const scenes = progress.scenes.filter((scene) => scene.stamp !== 'approved')
  const slots = progress.slots.filter((slot) => slot.stamp !== 'approved')
  const stampable = scenes.filter((scene) => scene.stampable).length
  const approvable = slots.filter((slot) => slot.approvable).length
  const bible = progress.bible.stamp !== 'approved'
  return {
    scenes: stampable,
    slots: approvable,
    bible,
    blockedScenes: scenes.length - stampable,
    blockedSlots: slots.length - approvable,
    total: stampable + approvable + (bible ? 1 : 0),
  }
}

/** 确认行里那一句"将认可 …"(只报**真会盖上的**:盖不上的另起一句说)。 */
function pendingSentence(counts: ReturnType<typeof pendingStampCounts>): string {
  const parts: string[] = []
  if (counts.scenes > 0) parts.push(`${counts.scenes} 场戏`)
  if (counts.slots > 0) parts.push(`${counts.slots} 个素材槽`)
  if (counts.bible) parts.push('设定集')
  return parts.length === 0 ? '没有待认可的东西' : parts.join(' + ')
}

/**
 * 一条结构问题该跳到哪。
 *
 * 规则(与 `deriveNextActions` 挑跳转目标那条**同一套**):
 *  1. 有文件 + 行号,且这一行落在某一场的区间里(同文件里起始行 ≤ 问题行、且最大的那个)
 *     → 打开那一场;没有行号就退到"该文件里的第一场"。
 *  2. 否则 → 文件检视器里打开那份文件。
 *
 * **客户端重推一次是可以的**:这是**导航**(把人带到哪一行),不是领域判断 ——
 * "这一行算不算错""能不能盖戳"那类结论仍然只从接缝来。认不出的(空文件名、`(sdk)`
 * 这种不是文件的名字)返回 null,那一行就照旧只显示文字 —— 不假装点得动。
 */
function problemTarget(problem: DialectProblemView, scenes: readonly SceneProgressView[]): { kind: 'scene'; label: string } | { kind: 'file'; path: string } | null {
  if (problem.file === '') return null
  const sameFile = scenes.filter((scene) => scene.file === problem.file)
  if (sameFile.length > 0) {
    // 与 `deriveNextActions` **逐字同一条**规则:同文件里起始行 ≤ 问题行、且最大的那个
    // (取第一个匹配会把整份文件的问题都算到第一场上,跳过去就跳错了);没有行号、
    // 或一个都够不着,退回该文件里的第一场。
    const candidates = problem.line === undefined ? [] : sameFile.filter((scene) => scene.line <= problem.line!)
    const owner = candidates.length === 0
      ? sameFile[0]!
      : candidates.reduce((best, scene) => (scene.line > best.line ? scene : best))
    return { kind: 'scene', label: owner.label }
  }
  const path = inspectorPath(problem.file)
  return path === null ? null : { kind: 'file', path }
}

/**
 * 问题定位到文件检视器里的**项目根相对路径**(导航用的口径转换,不是领域规则):
 * `scene.file` 是 `game/` 下相对路径(`script.rpy`),而 `.studio/…` 那几条本来就是项目根口径。
 * 没有扩展名的名字(`(sdk)`、`game` 这种"位置"而不是文件)→ null:不把人带去一个打不开的东西。
 */
function inspectorPath(file: string): string | null {
  const name = file.split('/').pop() ?? ''
  if (!name.includes('.')) return null
  if (file.startsWith('game/') || file.startsWith('.studio/')) return file
  return `game/${file}`
}

/**
 * 「下一步」那一行(T21):把推导出来的行动清单摆出来。
 *
 * 只画 `progress.nextActions` 给的东西 —— 文案、`actor`、`target` 全是接缝推导的
 * (与 agent 工具面读同一份);这里唯一做的事是把 `target` 翻译成"滚到哪一格 / 打开哪一场"。
 */
function NextActions({ actions, onJump }: { actions: NextActionView[]; onJump: (target: NextActionView['target']) => void }) {
  if (actions.length === 0) return null
  return (
    <div className={s.nextActions} aria-label="下一步">
      <div className={s.nextActionsHead}>
        <span className={s.cardTitle}>下一步</span>
        <span className={s.cardCount}>推导出来的:顺序、谁能做、点得动</span>
      </div>
      {actions.map((action, index) => (
        <div key={`${action.code}-${index}`} className={s.nextActionRow}>
          <Chip tone={action.actor === 'human' ? 'warn' : 'ok'} title={action.actor === 'human' ? '这条归人做' : '这条 agent 能做'}>
            {action.actor === 'human' ? '请人' : 'agent'}
          </Chip>
          <span className={s.nextActionLabel}>{action.label}</span>
          {action.detail !== undefined ? <span className={s.nextActionDetail}>{action.detail}</span> : null}
          {action.target !== undefined ? (
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => onJump(action.target)}>
              {JUMP_CAPTION[action.target.kind] ?? '去处理'}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function StageBoard({
  progress, api, busyKey, playing, running, cancelling,
  onStamp, onStampPending, onPlaytest, onPlaytestFrom, onPlaytestCancel, onRelocate, onOpenScene, onOpenFile, onStageSync, onJump, hasProject,
}: {
  progress: ProgressView | null
  /** 只用来搭素材图的地址(`api.assetUrl`)—— 判读仍然只从 `progress` 来。 */
  api: GalfreeApi
  /** 正在盖戳的目标 key(stampKey 的产物);null = 空闲。 */
  busyKey: string | null
  playing: boolean
  /** 服务端此刻有没有一次试玩在跑(agent 起的那一次也算 —— 取消按钮不能只看 `playing`)。 */
  running: boolean
  cancelling: boolean
  onStamp: (target: StampTarget) => void
  /** 「全部认可」:一次推导入参 = 一个写批(确认行由本组件摆,调用与回执在主面板)。 */
  onStampPending: (kind: StampPendingKind) => void
  onPlaytest: () => void
  /** 从这一场开始试玩(T13)。 */
  onPlaytestFrom: (label: string) => void
  /** 中止正在跑的那一次试玩(T24 / #32)。 */
  onPlaytestCancel: () => void
  /** 把手写文件里的段搬进生成目录(T10):搬完这一场才能被重生成。 */
  onRelocate: (label: string) => void
  /** 打开场景编辑器定位到这一场(T11)。 */
  onOpenScene: (label: string) => void
  /** 在文件检视器里打开一份文件(结构问题定位不到场景时走这条,T39)。 */
  onOpenFile: (path: string) => void
  /** 整备舞台(T39):重算生成物(图片定义 + 立绘站位)。 */
  onStageSync: () => void
  /** 「下一步」那条上的跳转(T21):面板把它翻译成滚动 / 打开。 */
  onJump: (target: NextActionView['target']) => void
  hasProject: boolean
}) {
  const summary = progress?.summary ?? null
  const [openScene, setOpenScene] = useState<string | null>(null)
  /** 「全部认可」的确认行开着没有(点了才摆出来 —— 它是一个不可逆的批量动作)。 */
  const [confirmStamp, setConfirmStamp] = useState(false)
  const errorCount = progress === null ? 0 : progress.lint.errors
  const warningCount = progress === null ? 0 : progress.lint.warnings
  /** 待认可的三类各有多少(全从推导数出来,不写死)。 */
  const counts = progress === null ? null : pendingStampCounts(progress)
  const pending = counts === null ? 0 : counts.total
  const confirming = confirmStamp && pending > 0
  const batching = busyKey !== null && busyKey.startsWith(`${STAMP_PENDING_KEY}:`)
  const runningKind = batching ? busyKey!.slice(STAMP_PENDING_KEY.length + 1) : null
  const syncing = busyKey === STAGE_SYNC_KEY
  const stage = progress?.stage ?? null
  /** 会叠在一起的场景名(挂在徽标的 title 上 —— 板上不展开那一长串)。 */
  const overlapScenes = [...new Set((stage?.report.overlaps ?? []).map((entry) => entry.scene))]

  // 待认可的东西盖完了 → 把确认行收掉。不收的话它会在**下一次**又有新东西时自己冒出来
  // (那时人并没有点过它)。
  useEffect(() => {
    if (pending === 0) setConfirmStamp(false)
  }, [pending])

  return (
    <section className={s.card} aria-label="舞台板">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>舞台板</span>
        <span className={s.cardCount}>
          {summary === null ? '推导进度' : `${summary.scenes} 场 · 推导自 .rpy + 校验 + 戳 + 试玩`}
        </span>
        <span className={s.cardOps}>
          {!hasProject ? (
            <span className={s.cardCount}>先建一个项目</span>
          ) : (
            <>
              {progress !== null ? (
                <Chip tone={progress.lint.ok ? 'ok' : 'bad'} dot title="方言子集结构校验 + SDK lint">
                  {progress.lint.ok ? 'lint 通过' : `lint ${errorCount} 错`}
                </Chip>
              ) : null}
              {progress !== null ? (
                <Chip
                  tone={progress.playtest === null ? 'warn' : progress.playtest.state === 'pass' ? 'ok' : 'bad'}
                  dot
                  title="试玩 = 用钉版 SDK 真跑一次;技术通过是推导,不是人盖的戳"
                >
                  {progress.playtest === null ? '试玩未跑'
                    // `stale` 先判(那是"跑过之后内容又变了",比当时怎么停的更当紧);
                    // 再判超时 —— 等满上限**不是**"有报错"(T24):那次是窗口没关,剧本可能一点毛病都没有。
                    : progress.playtest.state === 'stale' ? `已过期 · ${relativeTime(progress.playtest.at)}`
                    : progress.playtest.timedOut ? `等满 ${Math.round(progress.playtest.elapsedMs / 1000)} 秒 · 窗口没关`
                    : progress.playtest.state === 'pass' ? `技术通过 · ${relativeTime(progress.playtest.at)}`
                    : `有报错 · 退出码 ${progress.playtest.exitCode}`}
                  {/* 中止了但进程没确认停下:如实说,别让人以为窗口已经没了(T24)。 */}
                  {progress.playtest?.killed === false ? ' · 进程没停,窗口可能还开着' : ''}
                  {progress.playtest !== null && progress.playtest.from !== null ? ` · 从 ${progress.playtest.from}` : ''}
                </Chip>
              ) : null}
              {progress !== null ? (
                <Chip
                  tone={progress.completeness.orphans.length === 0 && progress.completeness.endingReachable ? 'ok' : 'bad'}
                  dot
                  title="项目级完整性:从入口能不能走到每一场、能不能走到结局(T13)"
                >
                  {progress.completeness.endingReachable ? '' : '结局不可达 · '}
                  {progress.completeness.orphans.length === 0 ? '全场景可达' : `${progress.completeness.orphans.length} 场孤立`}
                </Chip>
              ) : null}
              {/* 舞台层(T39):"剧本对了"不等于"画面对了" —— 生成物跟上没有、立绘会不会叠,
                  都挂在这颗按钮上(板上的「下一步」也跳到它)。 */}
              {stage !== null && stage.outOfSync ? (
                <Chip tone="warn" dot title="生成物 game/zz_galfree_stage.rpy 还没跟上:图片定义或立绘站位要重算一次">
                  舞台未整备
                </Chip>
              ) : null}
              {stage !== null && stage.report.overlaps.length > 0 ? (
                <Chip tone="bad" dot title={`这些场景里有立绘会叠在同一处:${overlapScenes.join('、')}`}>
                  立绘重叠 {stage.report.overlaps.length} 处
                </Chip>
              ) : null}
              {stage !== null && !stage.outOfSync ? (
                <Chip tone="quiet" num={stage.definitions} title={`舞台层已经是最新的:图片定义 ${stage.definitions} 张(剧本引用到的槽 ${stage.slots} 个)`}>
                  舞台已生成
                </Chip>
              ) : null}
              <button
                type="button"
                className={s.button}
                id="gf-stage-sync"
                disabled={syncing}
                onClick={onStageSync}
                title="重算 game/zz_galfree_stage.rpy:给磁盘上真有的素材写图片定义(缺了它背景是灰底占位,带属性的立绘会让游戏当场报错),并按此刻台上有几个人给立绘补 at 站位(不补的话两个立绘会叠在一处)。一个写批 = 一条快照;已经是最新的就什么都不写,只对 game/scenes/ 出手。"
              >
                {syncing ? <><Spinner /> 整备中…</> : '整备舞台'}
              </button>
              {/* 「全部认可」(T39):只在真有东西待认可时出现。点它**不直接盖** ——
                  先摆出确认行,把"将认可哪几类、各多少个"说清楚(那是人的一次性认可,ADR-0008)。 */}
              {pending > 0 ? (
                <button
                  type="button"
                  className={s.button}
                  disabled={batching}
                  aria-expanded={confirming}
                  onClick={() => setConfirmStamp(!confirmStamp)}
                  title={`一次盖掉全部还在等人的(此刻 ${pending} 项:场景 / 素材槽 / 设定集)。点开先看确认行 —— 上面写清将认可哪些、各多少个`}
                >
                  全部认可
                </button>
              ) : null}
              <button type="button" className={s.button} id="gf-playtest-button" disabled={playing} onClick={onPlaytest}
                title="用钉版 SDK 启动本项目;SDK 未就绪时先下载。它会等人去关掉那个游戏窗口才回来(默认最多等 3 分钟)">
                {playing ? <><Spinner /> 运行中…</> : '启动试玩'}
              </button>
              {/*
                取消(T24 / #32):`playing` 是**这个面板**等着;`running` 是**服务端**有没有在跑。
                后者才兜得住"agent 起的试玩"(AI 那一轮挂在那儿,人只能干看着 —— 那就是用户报的卡住)。
              */}
              {playing || running ? (
                <button type="button" className={s.button} id="gf-playtest-cancel" disabled={cancelling}
                  onClick={onPlaytestCancel}
                  title="中止正在跑的那一次试玩(杀掉游戏进程)。这一次不会被记进账本 —— 它不是一个结果">
                  {cancelling ? <><Spinner /> 取消中…</> : '取消试玩'}
                </button>
              ) : null}
            </>
          )}
        </span>
      </div>

      <div className={s.cardBody}>
        {progress === null ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>{hasProject ? '进度读不到' : '还没有可推导的项目'}</div>
            <div className={s.emptyHint}>
              {hasProject ? '目录可能刚被挪走;刷新一次,或看下面的提示条。' : '新建或激活一个项目后,这里会列出每一场戏的状态。'}
            </div>
          </div>
        ) : (
          <>
            {/* 「全部认可」的确认行:先说要盖什么、各多少个,再给按钮 —— 这是**人的**一次性认可
                (ADR-0008:审读戳只能由人盖),而且它可能一口气盖掉几十项。不许让人被自己盖掉的
                东西吓一跳,所以中间隔一行明账(与文件检视器的回滚确认同一个形态,只是语气是印章
                而不是危险)。盖不上的也在这里先说出来,免得那几十项里混着几个"本来就盖不上"。 */}
            {confirming && counts !== null ? (
              <div className={[s.confirm, s.confirmSeal].join(' ')} role="group" aria-label="全部认可确认">
                <span>
                  将认可 <b>{pendingSentence(counts)}</b> —— 一次写批 = 一条快照(git 历史里是一笔,
                  不是 {pending} 笔)。审读戳只能由人盖,agent 无权:按下去就是你认可了它们。
                  {counts.blockedScenes > 0 || counts.blockedSlots > 0 ? (
                    <>
                      {' '}另有
                      {counts.blockedScenes > 0 ? `${counts.blockedScenes} 场只读降级` : ''}
                      {counts.blockedScenes > 0 && counts.blockedSlots > 0 ? '、' : ''}
                      {counts.blockedSlots > 0 ? `${counts.blockedSlots} 个槽还没有图` : ''}
                      {' '}—— 这些现在盖不上,结果里会如实列出来。
                    </>
                  ) : null}
                </span>
                <button type="button" className={`${s.button} ${s.primary}`} disabled={batching} onClick={() => onStampPending('all')}>
                  {runningKind === 'all' ? <><Spinner /> 认可中…</> : `全部认可(${pending} 项)`}
                </button>
                {counts.scenes > 0 ? (
                  <button type="button" className={s.button} disabled={batching} title="只盖场景戳(素材槽与设定集留着)" onClick={() => onStampPending('scene')}>
                    {runningKind === 'scene' ? <><Spinner /> 认可中…</> : `只认可场景(${counts.scenes})`}
                  </button>
                ) : null}
                {counts.slots > 0 ? (
                  <button type="button" className={s.button} disabled={batching} title="只盖素材槽戳(场景与设定集留着)" onClick={() => onStampPending('slot')}>
                    {runningKind === 'slot' ? <><Spinner /> 认可中…</> : `只认可素材(${counts.slots})`}
                  </button>
                ) : null}
                <button type="button" className={s.button} disabled={batching} onClick={() => setConfirmStamp(false)}>取消</button>
              </div>
            ) : null}
            <NextActions actions={progress.nextActions} onJump={onJump} />
            {summary !== null ? (
              <div className={s.chips} style={{ marginBottom: 10 }}>
                <Chip tone={summary.missingDialogue === 0 ? 'ok' : 'warn'} num={summary.missingDialogue} dot>缺对白</Chip>
                <Chip tone={summary.missingSlots === 0 ? 'ok' : 'warn'} num={summary.missingSlots} dot>缺素材</Chip>
                <Chip tone={summary.awaitingReview === 0 ? 'ok' : 'warn'} num={summary.awaitingReview} dot title="盖过戳但内容又变了 —— 需要人重新审读">待复审</Chip>
                <Chip tone={summary.degraded === 0 ? 'ok' : 'warn'} num={summary.degraded} dot title="用了方言子集外语法的场景数">只读降级</Chip>
              </div>
            ) : null}

            {progress.playtest?.traceback != null ? (
              <pre className={s.traceback}>{progress.playtest.traceback}</pre>
            ) : null}

            {progress.scenes.length === 0 ? (
              <div className={s.empty}>
                <div className={s.emptyTitle}>脚本里还没有 label</div>
                <div className={s.emptyHint}>舞台板按 label 分幕;让 agent 生成第一场戏,或自己写进 game/script.rpy。</div>
              </div>
            ) : (
              <div>
                {progress.scenes.map((scene) => (
                  <SceneRow
                    key={`${scene.file}:${scene.label}`}
                    scene={scene}
                    open={openScene === scene.label}
                    busyKey={busyKey}
                    api={api}
                    onToggle={() => setOpenScene(openScene === scene.label ? null : scene.label)}
                    onStamp={onStamp}
                    onRelocate={onRelocate}
                    onOpen={() => onOpenScene(scene.label)}
                    onPlaytestFrom={() => onPlaytestFrom(scene.label)}
                  />
                ))}
              </div>
            )}

            {progress.problems.length > 0 ? (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--gf-text-2)' }}>
                  结构问题 {errorCount} 错 · {warningCount} 警告 · 点一条跳到要改的地方
                </summary>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {progress.problems.map((problem, i) => {
                    // 每一条都尽量"点得动":能归到某一场的跳场景编辑器,否则在文件检视器里打开
                    // 那份文件(判据见 `problemTarget` —— 那是导航,不是领域规则)。
                    const target = problemTarget(problem, progress.scenes)
                    const body = (
                      <>
                        <Chip tone={problem.severity === 'error' ? 'bad' : 'warn'}>{problem.code}</Chip>{' '}
                        <span style={{ color: 'var(--gf-text-2)' }}>
                          {problem.file}{problem.line === undefined ? '' : `:${problem.line}`} · {problem.message}
                        </span>
                        {problem.snippet === undefined ? null : (
                          <span className={s.rootPath} style={{ display: 'block', marginTop: 2 }}>{problem.snippet}</span>
                        )}
                      </>
                    )
                    if (target === null) {
                      // 定位不到具体文件(空文件名、`(sdk)` 这种"位置")→ 照旧只显示文字,
                      // 不画成一个点不动的按钮(那会让人以为界面坏了)。
                      return <div key={i} style={{ fontSize: 12 }}>{body}</div>
                    }
                    return (
                      <button
                        key={i}
                        type="button"
                        className={s.problemRow}
                        onClick={() => (target.kind === 'scene' ? onOpenScene(target.label) : onOpenFile(target.path))}
                        title={target.kind === 'scene'
                          ? `打开场景编辑器并定位到 ${target.label}(这一行属于它)`
                          : `在文件检视器里打开 ${target.path}`}
                      >
                        {body}
                        <span className={s.problemJump}>{target.kind === 'scene' ? `→ ${target.label}` : `→ ${target.path}`}</span>
                      </button>
                    )
                  })}
                </div>
              </details>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

function SceneRow({ scene, open, busyKey, api, onToggle, onStamp, onRelocate, onOpen, onPlaytestFrom }: {
  scene: SceneProgressView
  open: boolean
  busyKey: string | null
  /** 只用来搭素材图的地址(`assetUrl`)—— 状态判读仍然只从 `scene` 来。 */
  api: GalfreeApi
  onToggle: () => void
  onStamp: (target: StampTarget) => void
  onRelocate: (label: string) => void
  onOpen: () => void
  onPlaytestFrom: () => void
}) {
  const sceneTarget: StampTarget = { kind: 'scene', label: scene.label }
  const sceneBusy = busyKey === stampKey(sceneTarget)
  /** 正在看的那张素材图(点槽名才展开;只显示一张,免得把一行撑成一堵墙)。 */
  const [previewSlot, setPreviewSlot] = useState<string | null>(null)
  return (
    <div>
      <div className={s.sceneRow}>
        <button
          type="button"
          className={`${s.button} ${s.ghost} ${s.tiny}`}
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'}场景 ${scene.label} 的素材槽`}
          onClick={onToggle}
        >
          {open ? '−' : '+'}
        </button>
        <span className={s.sceneLabel} title={scene.label}>{scene.label}</span>
        <span className={s.sceneWhere} title={`${scene.file}:${scene.line}`}>{scene.file}:{scene.line}</span>
        <span className={s.sceneMarks}>
          {scene.marks.map((mark) => (
            <Chip key={mark.code} tone={markTone(mark.severity)} num={mark.count} title={mark.detail}>
              {mark.label}
            </Chip>
          ))}
        </span>
        <span className={s.sceneStamp}>
          {scene.stamp === 'approved' ? (
            <Seal state="approved" />
          ) : !scene.stampable ? (
            <Chip tone="quiet" title={scene.stampableBlockedBy}>不可盖戳</Chip>
          ) : (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Seal state={scene.stamp === 'stale' ? 'stale' : 'pending'} />
              <button
                type="button"
                className={`${s.button} ${s.tiny}`}
                disabled={sceneBusy}
                onClick={() => onStamp(sceneTarget)}
                title={scene.stamp === 'stale' ? '内容已变,重新认可这一场' : '以人身份认可这一场(agent 无权盖)'}
              >
                {sceneBusy ? <Spinner /> : scene.stamp === 'stale' ? '重新盖戳' : '盖审读戳'}
              </button>
            </span>
          )}
        </span>
      </div>
      {open ? (
        <div className={s.sceneDetail}>
          <div className={s.chips}>
            {scene.slots.length === 0
              ? <span className={s.emptyHint}>这一场没有引用任何素材槽(没有 scene/show 语句)。</span>
              : scene.slots.map((slot) => {
                const target: StampTarget = { kind: 'slot', slot: slot.slot }
                const slotBusy = busyKey === stampKey(target)
                // 能不能盖、为什么不能,一律照接缝给的 `approvable` / `approvableBlockedBy` 说。
                const stampTitle = slot.approvable
                  ? `点一下 = 以人身份认可这张素材 · ${slot.assetPath}${slot.stamp === 'stale' ? '(内容已变,需重新认可)' : ''}`
                  : `${slot.approvableBlockedBy ?? '现在不能盖戳'} · ${slot.assetPath}`
                return (
                  <span key={slot.slot} className={[s.slotChip, slot.filled ? s.slotFilled : s.slotMissing].join(' ')}>
                    {/* **看**与**认可**是两个动作**(T39):槽名点开是看图(想看一眼不会顺手盖上戳),
                        右边那颗「印」才是盖戳 —— 它按 `approvable` 原样 disabled。 */}
                    <button
                      type="button"
                      className={s.slotName}
                      aria-expanded={previewSlot === slot.slot}
                      onClick={() => setPreviewSlot(previewSlot === slot.slot ? null : slot.slot)}
                      title={slot.filled ? `看这张图 · ${slot.assetPath}` : `看这个槽 · ${slot.assetPath}(${slot.approvableBlockedBy ?? '文件不存在'})`}
                    >
                      {slot.slot}
                    </button>
                    <button
                      type="button"
                      className={[s.slotStamp, slot.stamp === 'approved' ? s.slotStampOn : undefined].filter(Boolean).join(' ')}
                      disabled={!slot.approvable || slotBusy}
                      onClick={() => onStamp(target)}
                      title={stampTitle}
                      aria-label={`以人身份认可素材槽 ${slot.slot}`}
                    >
                      {slotBusy ? <Spinner /> : '印'}
                    </button>
                  </span>
                )
              })}
          </div>
          {/* 看的那一张(点槽名展开):文件不在就如实说"还没出图",不拿一张裂图糊弄人。 */}
          {previewSlot === null ? null : (() => {
            const slot = scene.slots.find((candidate) => candidate.slot === previewSlot)
            if (slot === undefined) return null
            return (
              <div className={s.slotPreview}>
                {slot.filled ? (
                  <img
                    className={s.slotPreviewImg}
                    src={api.assetUrl(slot.assetPath, slot.fingerprint)}
                    alt={slot.slot}
                    loading="lazy"
                  />
                ) : (
                  <div className={s.slotPreviewEmpty}>还没出图</div>
                )}
                <div className={s.slotPreviewMeta}>
                  <div className={s.rootPath}>{slot.assetPath}</div>
                  <div className={s.emptyHint}>
                    {slot.stamp === 'approved' ? '这张已经被人认可过。'
                      : slot.filled ? '有图,还没被人认可。'
                      : '文件还不存在 —— 出图之后这里就有图了。'}
                    看它不会盖戳;要认可点那颗「印」。
                  </div>
                  <div className={s.chips}>
                    <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => setPreviewSlot(null)}>收起</button>
                  </div>
                </div>
              </div>
            )
          })()}
          <div className={s.chips} style={{ marginTop: 8 }}>
            <Chip tone="quiet" num={scene.dialogueCount}>对白行</Chip>
            <button
              type="button"
              className={`${s.button} ${s.ghost} ${s.tiny}`}
              onClick={onOpen}
              title="打开场景编辑器:逐行改对白/图像引用,或切到源文本直接改 .rpy(两路同走网关)"
            >
              编辑这一场
            </button>
            <button
              type="button"
              className={`${s.button} ${s.ghost} ${s.tiny}`}
              onClick={onPlaytestFrom}
              title={`从 ${scene.label} 开始试玩:在副本里把入口指向这一场,用户项目不动。目标场不存在会崩出 traceback,所以"落对了"是可验证的。`}
            >
              从此场试玩
            </button>
            {scene.file.startsWith('scenes/')
              ? <Chip tone="quiet" title="这一场住在生成目录,可以让 agent 重生成">可生成</Chip>
              : (
                <span className={s.chips} style={{ gap: 6 }}>
                  <button
                    type="button"
                    className={`${s.button} ${s.ghost} ${s.tiny}`}
                    onClick={() => onRelocate(scene.label)}
                    title={`把 game/${scene.file} 里的这一段原样搬进 game/scenes/${scene.label}.rpy 后,这一场就可被生成器重写。段内容逐字不变,并留下一条快照。`}
                  >
                    搬进生成目录
                  </button>
                  <span className={s.emptyHint}>住在手写文件,生成器不越界</span>
                </span>
              )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
