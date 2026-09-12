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
 */
import { useState } from 'react'
import type { NextActionView, ProgressView, SceneProgressView, StampTarget } from './types.ts'
import { stampKey } from './types.ts'
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
          <Chip tone={action.actor === 'human' ? 'warn' : 'ok'} title={action.actor === 'human' ? '要人来做的:主观判断 / 认可 / 拍板' : 'agent 能自己做的'}>
            {action.actor === 'human' ? '请人' : 'agent'}
          </Chip>
          <span className={s.nextActionLabel}>{action.label}</span>
          {action.detail !== undefined ? <span className={s.nextActionDetail}>{action.detail}</span> : null}
          {action.target !== undefined ? (
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => onJump(action.target)}>
              {action.target.kind === 'scene' ? '打开这一场' : action.target.kind === 'slot' ? '看这个槽' : '去处理'}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function StageBoard({ progress, busyKey, playing, onStamp, onPlaytest, onPlaytestFrom, onRelocate, onOpenScene, onJump, hasProject }: {
  progress: ProgressView | null
  /** 正在盖戳的目标 key(stampKey 的产物);null = 空闲。 */
  busyKey: string | null
  playing: boolean
  onStamp: (target: StampTarget) => void
  onPlaytest: () => void
  /** 从这一场开始试玩(T13)。 */
  onPlaytestFrom: (label: string) => void
  /** 把手写文件里的段搬进生成目录(T10):搬完这一场才能被重生成。 */
  onRelocate: (label: string) => void
  /** 打开场景编辑器定位到这一场(T11)。 */
  onOpenScene: (label: string) => void
  /** 「下一步」那条上的跳转(T21):面板把它翻译成滚动 / 打开。 */
  onJump: (target: NextActionView['target']) => void
  hasProject: boolean
}) {
  const summary = progress?.summary ?? null
  const [openScene, setOpenScene] = useState<string | null>(null)
  const errorCount = progress === null ? 0 : progress.lint.errors
  const warningCount = progress === null ? 0 : progress.lint.warnings

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
                    : progress.playtest.state === 'pass' ? `技术通过 · ${relativeTime(progress.playtest.at)}`
                    : progress.playtest.state === 'fail' ? `有报错 · 退出码 ${progress.playtest.exitCode}`
                    : `已过期 · ${relativeTime(progress.playtest.at)}`}
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
              <button type="button" className={s.button} id="gf-playtest-button" disabled={playing} onClick={onPlaytest}
                title="用钉版 SDK 启动本项目;SDK 未就绪时先下载">
                {playing ? <><Spinner /> 运行中…</> : '启动试玩'}
              </button>
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
                  结构问题 {errorCount} 错 · {warningCount} 警告
                </summary>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {progress.problems.map((problem, i) => (
                    <div key={i} style={{ fontSize: 12 }}>
                      <Chip tone={problem.severity === 'error' ? 'bad' : 'warn'}>{problem.code}</Chip>{' '}
                      <span style={{ color: 'var(--gf-text-2)' }}>
                        {problem.file}{problem.line === undefined ? '' : `:${problem.line}`} · {problem.message}
                      </span>
                      {problem.snippet === undefined ? null : (
                        <div className={s.rootPath} style={{ marginTop: 2 }}>{problem.snippet}</div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

function SceneRow({ scene, open, busyKey, onToggle, onStamp, onRelocate, onOpen, onPlaytestFrom }: {
  scene: SceneProgressView
  open: boolean
  busyKey: string | null
  onToggle: () => void
  onStamp: (target: StampTarget) => void
  onRelocate: (label: string) => void
  onOpen: () => void
  onPlaytestFrom: () => void
}) {
  const sceneTarget: StampTarget = { kind: 'scene', label: scene.label }
  const sceneBusy = busyKey === stampKey(sceneTarget)
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
                const title = slot.approvable
                  ? `点一下 = 以人身份认可这张素材 · ${slot.assetPath}${slot.stamp === 'stale' ? '(内容已变,需重新认可)' : ''}`
                  : `${slot.approvableBlockedBy ?? '现在不能盖戳'} · ${slot.assetPath}`
                if (!slot.approvable) {
                  return (
                    <span
                      key={slot.slot}
                      className={[s.slotChip, slot.filled ? s.slotFilled : s.slotMissing].join(' ')}
                      title={title}
                    >
                      <span className={s.slotText}>{slot.slot}</span>
                      {slot.stamp === 'approved' ? <span className={s.slotSealGlyph}>印</span> : null}
                    </span>
                  )
                }
                return (
                  <button
                    key={slot.slot}
                    type="button"
                    className={[s.slotChip, s.slotFilled].join(' ')}
                    disabled={slotBusy}
                    onClick={() => onStamp(target)}
                    title={title}
                  >
                    <span className={s.slotText}>{slot.slot}</span>
                    {slotBusy ? <Spinner /> : <span className={s.slotSealGlyph}>印</span>}
                  </button>
                )
              })}
          </div>
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
