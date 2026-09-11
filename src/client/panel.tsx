/**
 * GALFree 工作台面板 —— 制作现场的控制台。
 *
 * 正确性标准仍是接缝契约:这里只渲染 /api/galfree 吐出的状态,不自己判断进度
 * (进度是推导的;ADR-0008)。本文件负责的是"把推导结果讲清楚":
 *   · 舞台板 —— 场景是舞台单元,一眼看出哪一幕缺东西、哪一幕的戳过期了
 *   · 印章   —— 审读戳的视觉形态:**人**留下的印(agent 无权,接缝层已守)
 *   · 素材槽 —— 它就在场景行上,填没填、盖没盖,不用展开就知道
 *   · 快照   —— 每个写批一条 commit,diff 内联在历史下方
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GalfreeApi, GalfreeApiError } from './api.ts'
import type {
  ProgressView, SceneProgressView, SdkView, SnapshotEntry, StateView, TreeNode,
} from './api.ts'
import { Chip, DiffView, Notice, Seal, Spinner, relativeTime } from './ui.tsx'
import s from './panel.module.css'

/** 一次提示:错误与警告都进同一个通道,顶部一条一条列出来。 */
interface NoticeItem {
  id: number
  tone: 'bad' | 'warn'
  text: string
}

function describeError(error: unknown): string {
  if (error instanceof GalfreeApiError) return error.message
  return String(error)
}

export function WorkbenchPanel() {
  const api = useMemo(() => new GalfreeApi(), [])
  const [state, setState] = useState<StateView | null>(null)
  const [progress, setProgress] = useState<ProgressView | null>(null)
  const [sdk, setSdk] = useState<SdkView | null>(null)
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)

  // 新建项目表单
  const [showCreate, setShowCreate] = useState(false)
  const [draft, setDraft] = useState({ name: '', title: '', projectsRoot: '' })
  const [creating, setCreating] = useState(false)

  // 文件树
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [history, setHistory] = useState<SnapshotEntry[]>([])
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLabel, setDiffLabel] = useState<string>('')

  // 动作中的目标(label / slot),用于局部 loading
  const [stamping, setStamping] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ensuring, setEnsuring] = useState(false)

  const noticeSeq = useRef(0)
  const pushNotice = useCallback((tone: 'bad' | 'warn', text: string) => {
    noticeSeq.current += 1
    const id = noticeSeq.current
    setNotices((current) => (current.some((n) => n.text === text && n.tone === tone) ? current : [...current, { id, tone, text }]))
  }, [])

  const refresh = useCallback(async (options?: { quiet?: boolean }) => {
    try {
      const next = await api.state()
      setState(next)
      if (next.activeId === null || next.activeMissing) {
        setProgress(null)
      } else {
        try {
          setProgress(await api.progress())
        } catch (error) {
          // 目录在两次请求之间被挪走是正常竞态:如实降级,不当成故障刷屏。
          setProgress(null)
          if (!options?.quiet) pushNotice('warn', `进度读不到:${describeError(error)}`)
        }
      }
      setRefreshedAt(new Date())
    } catch (error) {
      pushNotice('bad', `状态读不到:${describeError(error)}`)
    } finally {
      setLoading(false)
    }
  }, [api, pushNotice])

  const loadSdk = useCallback(async () => {
    try {
      setSdk(await api.sdk())
    } catch {
      setSdk(null)
    }
  }, [api])

  // 首屏 + 激活项目变化:重取;SSE 推送优先,8s 轮询仅兜底(页面隐藏时暂停)。
  useEffect(() => {
    void refresh()
    void loadSdk()
    let source: EventSource | undefined
    try {
      source = new EventSource('/api/galfree/events')
      source.onmessage = () => void refresh({ quiet: true })
    } catch {
      source = undefined
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh({ quiet: true })
      void loadSdk()
    }, 8000)
    return () => {
      window.clearInterval(timer)
      source?.close()
    }
  }, [refresh, loadSdk, state?.activeId])

  // 试玩进行中:进度是推导的,跑完要重新读一次(能推就推,不靠人点刷新)。
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      void refresh({ quiet: true })
      void loadSdk()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [playing, refresh, loadSdk])

  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path)
    setDiff(null)
    setDiffLabel('')
    try {
      setHistory(await api.snapshots(path))
    } catch (error) {
      setHistory([])
      pushNotice('bad', `快照历史读不到:${describeError(error)}`)
    }
  }, [api, pushNotice])

  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      await api.createProject(draft.name.trim(), draft.title.trim() || undefined, draft.projectsRoot.trim() || undefined)
      setDraft({ name: '', title: '', projectsRoot: '' })
      setShowCreate(false)
      await refresh()
    } catch (error) {
      pushNotice('bad', `新建失败:${describeError(error)}`)
    } finally {
      setCreating(false)
    }
  }

  const stampScene = async (label: string): Promise<void> => {
    setStamping(`scene:${label}`)
    try {
      await api.stampScene(label)
      await refresh()
    } catch (error) {
      pushNotice('bad', `盖戳失败(${label}):${describeError(error)}`)
    } finally {
      setStamping(null)
    }
  }

  const stampSlot = async (slot: string): Promise<void> => {
    setStamping(`slot:${slot}`)
    try {
      await api.stampSlot(slot)
      await refresh()
    } catch (error) {
      pushNotice('bad', `盖戳失败(${slot}):${describeError(error)}`)
    } finally {
      setStamping(null)
    }
  }

  const runPlaytest = async (): Promise<void> => {
    setPlaying(true)
    try {
      await api.playtest()
      await refresh()
    } catch (error) {
      pushNotice('bad', `试玩失败:${describeError(error)}`)
    } finally {
      setPlaying(false)
      await refresh({ quiet: true })
    }
  }

  const ensureSdk = async (): Promise<void> => {
    setEnsuring(true)
    try {
      await api.sdkEnsure()
    } catch (error) {
      pushNotice('bad', `SDK 供给失败:${describeError(error)}`)
    } finally {
      setEnsuring(false)
      await loadSdk()
    }
  }

  const projects = state?.projects ?? []
  const active = projects.find((p) => p.id === state?.activeId) ?? null
  const visibleTree = useMemo(() => filterTree(state?.tree ?? [], filter.trim().toLowerCase()), [state?.tree, filter])
  const dirPaths = useMemo(() => collectDirs(state?.tree ?? []), [state?.tree])
  const allExpanded = dirPaths.length > 0 && dirPaths.every((path) => expanded.has(path))
  const sdkBusy = sdk !== null && (sdk.provision.state === 'downloading' || sdk.provision.state === 'extracting')

  const toggleDir = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className={s.panel}>
      <div className={s.column}>
        <header className={s.header}>
          <div className={s.headerMain}>
            <div className={s.eyebrow}>GALFree 工作台</div>
            {active === null ? (
              <h1 className={`${s.title} ${s.titleEmpty}`}>还没有项目</h1>
            ) : (
              <>
                <h1 className={s.title}>
                  {active.title}
                  {active.missing ? <Chip tone="bad">目录缺失</Chip> : null}
                </h1>
                <div className={s.rootPath}>{active.root}</div>
              </>
            )}
          </div>
          <div className={s.headerAside}>
            {projects.length > 0 ? <Chip tone="quiet" num={projects.length}>项目</Chip> : null}
            <button
              type="button"
              className={s.button}
              onClick={() => { void refresh() }}
              disabled={loading}
              title={refreshedAt === null ? '重新读取状态' : `上次读取 ${refreshedAt.toLocaleTimeString()}`}
            >
              {loading ? <Spinner /> : '刷新'}
            </button>
            <button type="button" className={`${s.button} ${s.primary}`} onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
              {showCreate ? '收起' : '新建项目'}
            </button>
          </div>
        </header>

        {notices.map((notice) => (
          <Notice key={notice.id} tone={notice.tone} onDismiss={() => setNotices((current) => current.filter((n) => n.id !== notice.id))}>
            {notice.text}
          </Notice>
        ))}

        {showCreate || projects.length === 0 ? (
          <section className={s.card} aria-label="新建项目">
            <div className={s.cardHead}>
              <span className={s.cardTitle}>从模板新建</span>
              <span className={s.cardCount}>v1 只从模板新建(Ren'Py 目录 + .studio 契约骨架 + 初始快照)</span>
            </div>
            <div className={s.cardBody}>
              <div className={s.form}>
                <label className={`${s.field} ${s.fieldName}`}>
                  <span className={s.fieldLabel}>项目名 · 目录名</span>
                  <input
                    className={s.input}
                    placeholder="my-first-game"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && draft.name !== '' && !creating) void create() }}
                  />
                </label>
                <label className={`${s.field} ${s.fieldTitle}`}>
                  <span className={s.fieldLabel}>标题 · 可留空</span>
                  <input
                    className={s.input}
                    placeholder="我的第一部"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </label>
                <label className={`${s.field} ${s.fieldRoot}`}>
                  <span className={s.fieldLabel}>父目录 · 留空用默认设置</span>
                  <input
                    className={s.input}
                    placeholder="D:\\galgame"
                    value={draft.projectsRoot}
                    onChange={(e) => setDraft({ ...draft, projectsRoot: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className={`${s.button} ${s.primary}`}
                  disabled={creating || draft.name.trim() === ''}
                  onClick={() => void create()}
                >
                  {creating ? <><Spinner /> 创建中…</> : '创建并激活'}
                </button>
                <span className={s.formHint}>项目名只允许小写字母、数字、- 与 _,创建后即成为当前项目。</span>
              </div>
            </div>
          </section>
        ) : null}

        <StageBoard
          progress={progress}
          busyLabel={stamping}
          playing={playing}
          onStampScene={(label) => void stampScene(label)}
          onStampSlot={(slot) => void stampSlot(slot)}
          onPlaytest={() => void runPlaytest()}
          hasProject={active !== null && !active.missing}
        />

        {state !== null && state.gatewayErrors.length > 0 ? (
          <section className={s.card} aria-label="网关故障">
            <div className={s.cardHead}>
              <span className={s.cardTitle}>网关故障</span>
              <span className={s.cardCount}>写批成功但快照/回滚/监听出了问题 · 如实上板</span>
            </div>
            <div className={s.cardBody}>
              {state.gatewayErrors.slice(-5).map((entry, i) => (
                <div key={`${entry.batchId}-${i}`} className={s.commitRow}>
                  <span className={[s.chip, s.warn].join(' ')}>{entry.kind}</span>
                  <span className={s.commitSubject}>batch {entry.batchId} · {entry.message}</span>
                  <span className={s.commitWhen}>{relativeTime(entry.at)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <FileTree
          tree={visibleTree}
          filter={filter}
          onFilter={setFilter}
          selected={selectedFile}
          onSelect={(path) => void selectFile(path)}
          expanded={expanded}
          onToggleDir={toggleDir}
          allExpanded={allExpanded}
          onToggleAll={() => setExpanded(allExpanded ? new Set() : new Set(dirPaths))}
          hasProject={active !== null && !active.missing}
        />

        {selectedFile !== null ? (
          <SnapshotPanel
            path={selectedFile}
            history={history}
            diff={diff}
            diffLabel={diffLabel}
            onDiff={(entry, previous) => {
              setDiffLabel(`${previous.commit.slice(0, 8)} → ${entry.commit.slice(0, 8)}`)
              void api.snapshotDiff(selectedFile, previous.commit, entry.commit)
                .then(setDiff)
                .catch((error) => pushNotice('bad', `diff 读不到:${describeError(error)}`))
            }}
            onClose={() => { setSelectedFile(null); setHistory([]); setDiff(null) }}
          />
        ) : null}

        <SdkCard sdk={sdk} busy={sdkBusy} ensuring={ensuring} onEnsure={() => void ensureSdk()} />
      </div>
    </div>
  )
}

/* ─── 舞台板 ─────────────────────────────────────────────────────────── */

function sceneMarks(scene: SceneProgressView): Array<{ tone: 'ok' | 'warn' | 'bad' | 'quiet'; label: string; title: string }> {
  const marks: Array<{ tone: 'ok' | 'warn' | 'bad' | 'quiet'; label: string; title: string }> = []
  if (scene.readOnly) marks.push({ tone: 'quiet', label: '只读降级', title: '这一场用了方言子集外的语法,结构只按能解析的部分算' })
  if (scene.missingDialogue) marks.push({ tone: 'warn', label: '缺对白', title: '这一场没有任何对白行' })
  if (scene.lintErrors > 0) marks.push({ tone: 'bad', label: `lint ${scene.lintErrors}`, title: `${scene.lintErrors} 个 error 级问题落在这一场` })
  if (scene.slots.length > 0 && scene.missingSlots.length === 0) marks.push({ tone: 'ok', label: `素材 ${scene.slots.length} 齐`, title: '本场引用的素材槽都已有文件' })
  if (scene.missingSlots.length > 0) marks.push({ tone: 'warn', label: `缺素材 ${scene.missingSlots.length}`, title: scene.missingSlots.join('、') })
  if (marks.length === 0) marks.push({ tone: 'ok', label: '结构完整', title: '对白、素材、lint 都齐' })
  return marks
}

function StageBoard({ progress, busyLabel, playing, onStampScene, onStampSlot, onPlaytest, hasProject }: {
  progress: ProgressView | null
  busyLabel: string | null
  playing: boolean
  onStampScene: (label: string) => void
  onStampSlot: (slot: string) => void
  onPlaytest: () => void
  hasProject: boolean
}) {
  const summary = progress?.summary ?? null
  const [openScene, setOpenScene] = useState<string | null>(null)

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
                  {progress.lint.ok ? 'lint 通过' : `lint ${progress.lint.errors} 错`}
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
                </Chip>
              ) : null}
              <button type="button" className={s.button} disabled={playing} onClick={onPlaytest}
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
            <div className={s.emptyHint}>{hasProject ? '稍后刷新重试;若一直如此看下面的提示条。' : '新建或激活一个项目后,这里会列出每一场戏的状态。'}</div>
          </div>
        ) : (
          <>
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
                {progress.scenes.map((scene) => {
                  const expandedScene = openScene === scene.label
                  const stampBusy = busyLabel === `scene:${scene.label}`
                  return (
                    <div key={`${scene.file}:${scene.label}`}>
                      <div className={s.sceneRow}>
                        <button
                          type="button"
                          className={`${s.button} ${s.ghost} ${s.tiny}`}
                          aria-expanded={expandedScene}
                          onClick={() => setOpenScene(expandedScene ? null : scene.label)}
                        >
                          {expandedScene ? '−' : '+'}
                        </button>
                        <span className={s.sceneLabel} title={scene.label}>{scene.label}</span>
                        <span className={s.sceneWhere} title={`${scene.file}:${scene.line}`}>{scene.file}:{scene.line}</span>
                        <span className={s.sceneMarks}>
                          {sceneMarks(scene).map((mark) => (
                            <Chip key={mark.label} tone={mark.tone} title={mark.title}>{mark.label}</Chip>
                          ))}
                        </span>
                        <span className={s.sceneStamp}>
                          {scene.stamp === 'approved' ? (
                            <Seal state="approved" />
                          ) : scene.readOnly ? (
                            <Chip tone="quiet" title="只读降级:子集外语法,先改回子集内再谈定稿">不可盖戳</Chip>
                          ) : (
                            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                              <Seal state={scene.stamp === 'stale' ? 'stale' : 'pending'} />
                              <button type="button" className={`${s.button} ${s.tiny}`} disabled={stampBusy}
                                onClick={() => onStampScene(scene.label)}
                                title={scene.stamp === 'stale' ? '内容已变,重新认可这一场' : '以人身份认可这一场(agent 无权盖)'}>
                                {stampBusy ? <Spinner /> : scene.stamp === 'stale' ? '重新盖戳' : '盖审读戳'}
                              </button>
                            </span>
                          )}
                        </span>
                      </div>
                      {expandedScene ? (
                        <div className={s.sceneDetail}>
                          <div className={s.chips}>
                            {scene.slots.length === 0
                              ? <span className={s.emptyHint}>这一场没有引用任何素材槽(没有 scene/show 语句)。</span>
                              : scene.slots.map((slot) => {
                                const slotBusy = busyLabel === `slot:${slot.slot}`
                                const sealable = slot.filled && slot.stamp !== 'approved'
                                const sealGlyph = slot.stamp === 'approved'
                                  ? <span className={s.slotSealGlyph} title="人已认可这张素材">印</span>
                                  : null
                                if (!sealable) {
                                  return (
                                    <span
                                      key={slot.slot}
                                      className={[s.slotChip, slot.filled ? s.slotFilled : s.slotMissing].join(' ')}
                                      title={`${slot.assetPath}${slot.filled ? (slot.stamp === 'approved' ? ' · 已认可' : '') : ' · 文件还没生成'}`}
                                    >
                                      <span className={s.slotText}>{slot.slot}</span>
                                      {sealGlyph}
                                    </span>
                                  )
                                }
                                return (
                                  <button
                                    key={slot.slot}
                                    type="button"
                                    className={[s.slotChip, s.slotFilled].join(' ')}
                                    disabled={slotBusy}
                                    onClick={() => onStampSlot(slot.slot)}
                                    title={`点一下 = 以人身份认可这张素材 · ${slot.assetPath}${slot.stamp === 'stale' ? '(内容已变,需重新认可)' : ''}`}
                                  >
                                    <span className={s.slotText}>{slot.slot}</span>
                                    {slotBusy ? <Spinner /> : <span className={s.slotSealGlyph}>印</span>}
                                  </button>
                                )
                              })}
                          </div>
                          <div className={s.chips} style={{ marginTop: 8 }}>
                            <Chip tone="quiet" num={scene.dialogueCount}>对白行</Chip>
                            {scene.stamp === 'stale' ? <Chip tone="warn">盖过戳,内容已变</Chip> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}

            {progress.problems.length > 0 ? (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--gf-text-2)' }}>
                  结构问题 {progress.problems.filter((p) => p.severity === 'error').length} 错 ·{' '}
                  {progress.problems.filter((p) => p.severity === 'warning').length} 警告
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

/* ─── 文件树 ─────────────────────────────────────────────────────────── */

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (query === '') return nodes
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const node of list) {
      const self = node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
      if (node.dir) {
        const children = walk(node.children ?? [])
        if (self || children.length > 0) out.push({ ...node, children })
      } else if (self) {
        out.push(node)
      }
    }
    return out
  }
  return walk(nodes)
}

function collectDirs(nodes: TreeNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.dir) {
      into.push(node.path)
      collectDirs(node.children ?? [], into)
    }
  }
  return into
}

function FileTree({ tree, filter, onFilter, selected, onSelect, expanded, onToggleDir, allExpanded, onToggleAll, hasProject }: {
  tree: TreeNode[]
  filter: string
  onFilter: (value: string) => void
  selected: string | null
  onSelect: (path: string) => void
  expanded: Set<string>
  onToggleDir: (path: string) => void
  allExpanded: boolean
  onToggleAll: () => void
  hasProject: boolean
}) {
  const filtering = filter.trim() !== ''
  return (
    <section className={s.card} aria-label="文件">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>文件</span>
        <span className={s.cardCount}>点文件名看快照历史与 diff · 点目录展开</span>
        <span className={s.cardOps}>
          <input
            className={s.input}
            style={{ width: 150, padding: '5px 10px', fontSize: 12 }}
            placeholder="筛选…"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            aria-label="筛选文件"
          />
          <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={onToggleAll} disabled={tree.length === 0}>
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
        </span>
      </div>
      <div className={s.cardBody}>
        {!hasProject ? (
          <div className={s.empty}>没有激活项目,或项目目录已不在磁盘上。</div>
        ) : tree.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>{filtering ? '没有匹配的文件' : '项目目录是空的'}</div>
            <div className={s.emptyHint}>{filtering ? '换个关键词,或清空筛选。' : '模板至少应该含有 game/script.rpy。'}</div>
          </div>
        ) : (
          <div className={s.tree}>
            <TreeNodes
              nodes={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              expanded={expanded}
              onToggleDir={onToggleDir}
              forceOpen={filtering}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function TreeNodes({ nodes, depth, selected, onSelect, expanded, onToggleDir, forceOpen }: {
  nodes: TreeNode[]
  depth: number
  selected: string | null
  onSelect: (path: string) => void
  expanded: Set<string>
  onToggleDir: (path: string) => void
  forceOpen: boolean
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = forceOpen || expanded.has(node.path)
        const hasChildren = (node.children?.length ?? 0) > 0
        return (
          <div key={node.path} className={depth === 0 ? undefined : s.treeScope}>
            <button
              type="button"
              className={[s.treeRow, node.dir ? undefined : (selected === node.path ? s.treeRowSelected : undefined)].filter(Boolean).join(' ')}
              onClick={() => (node.dir ? onToggleDir(node.path) : onSelect(node.path))}
              aria-expanded={node.dir ? open : undefined}
              title={node.path}
            >
              {node.dir
                ? <span className={[s.treeChevron, open ? undefined : s.treeChevronClosed].filter(Boolean).join(' ')} aria-hidden="true" />
                : <span className={s.treeIcon} aria-hidden="true">{selected === node.path ? '▸' : '·'}</span>}
              <span className={[s.treeName, node.dir ? s.treeDirName : undefined].filter(Boolean).join(' ')}>
                {node.name}{node.dir ? '/' : ''}
              </span>
            </button>
            {node.dir && open && hasChildren ? (
              <TreeNodes
                nodes={node.children!}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                expanded={expanded}
                onToggleDir={onToggleDir}
                forceOpen={forceOpen}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/* ─── 快照历史 ───────────────────────────────────────────────────────── */

function SnapshotPanel({ path, history, diff, diffLabel, onDiff, onClose }: {
  path: string
  history: SnapshotEntry[]
  diff: string | null
  diffLabel: string
  onDiff: (entry: SnapshotEntry, previous: SnapshotEntry) => void
  onClose: () => void
}) {
  return (
    <section className={s.card} aria-label="快照历史">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>快照历史</span>
        <span className={s.cardCount}>{path}</span>
        <span className={s.cardOps}>
          <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={onClose}>关闭</button>
        </span>
      </div>
      <div className={s.cardBody}>
        {history.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>这个文件还没有快照</div>
            <div className={s.emptyHint}>写批落盘后会自动产生一条 commit;没写过就没有历史。</div>
          </div>
        ) : (
          history.map((entry, index) => {
            const previous = history[index + 1]
            return (
              <div key={entry.commit} className={s.commitRow}>
                <span className={s.commitHash}>{entry.commit.slice(0, 8)}</span>
                <span className={s.commitSubject}>{entry.subject}</span>
                <span className={s.commitWhen}>{relativeTime(entry.at)}</span>
                {previous === undefined ? (
                  <span className={s.commitWhen} title="最早的快照,没有可比的上一版">首版</span>
                ) : (
                  <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => onDiff(entry, previous)}>
                    与上一版比
                  </button>
                )}
              </div>
            )
          })
        )}
        {diff !== null ? (
          <>
            <div className={s.cardCount} style={{ marginTop: 10 }}>diff {diffLabel}</div>
            <DiffView text={diff} />
          </>
        ) : null}
      </div>
    </section>
  )
}

/* ─── SDK ────────────────────────────────────────────────────────────── */

function SdkCard({ sdk, busy, ensuring, onEnsure }: {
  sdk: SdkView | null
  busy: boolean
  ensuring: boolean
  onEnsure: () => void
}) {
  const fraction = sdk?.provision.progress.fraction ?? 0
  return (
    <section className={s.card} aria-label="钉版 SDK">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>钉版 SDK</span>
        <span className={s.cardCount}>试玩与真 lint 都用它;发版钉死版本(ADR-0006)</span>
        <span className={s.cardOps}>
          {sdk === null ? null : sdk.launcherReady ? (
            <Chip tone="ok" dot>{sdk.requested === 'override' ? '就绪 · 覆盖路径' : '就绪 · 钉版目录'}</Chip>
          ) : (
            <Chip tone={sdk.provision.state === 'failed' ? 'bad' : 'warn'} dot>{sdk.provision.state}</Chip>
          )}
        </span>
      </div>
      <div className={s.cardBody}>
        {sdk === null ? (
          <div className={s.empty}>读不到供给状态。</div>
        ) : (
          <>
            <div className={s.rootPath}>{sdk.dir}</div>
            {sdk.mismatch !== undefined ? (
              <div style={{ marginTop: 8 }}>
                <Chip tone="warn" title="覆盖路径的版本与钉版不一致:方言差异按警告处理,不阻塞">
                  方言差异:实际 {sdk.mismatch.actual} ≠ 钉版 {sdk.mismatch.pinned}
                </Chip>
              </div>
            ) : null}
            {sdk.version !== undefined ? <div className={s.rootPath}>版本 {sdk.version}</div> : null}
            {!sdk.launcherReady ? (
              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className={s.button} disabled={busy || ensuring} onClick={onEnsure}>
                  {ensuring || busy ? <><Spinner /> 下载中…</> : sdk.provision.state === 'failed' ? '重试下载' : '下载 SDK'}
                </button>
                <span className={s.emptyHint}>
                  {sdk.provision.progress.message ?? (busy ? '正在下载钉版 SDK…' : '首次试玩前需要下载(约 155MB)')}
                  {fraction > 0 && fraction < 1 ? ` · ${Math.round(fraction * 100)}%` : ''}
                </span>
              </div>
            ) : null}
            {fraction > 0 && fraction < 1 ? (
              <div className={s.meter}><div className={s.meterFill} style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
            ) : null}
            {sdk.provision.error !== undefined ? (
              <div style={{ marginTop: 8 }}><Notice tone="bad">{sdk.provision.error}</Notice></div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
