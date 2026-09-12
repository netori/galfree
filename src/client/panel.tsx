/**
 * GALFree 工作台面板 —— 制作现场的控制台(装配层)。
 *
 * 这里只做三件事:拉接缝状态、把状态分发给各卡、把人的动作送回接缝。
 * 判断在哪:
 *   · 进度/标记/能不能盖戳 —— 推导引擎(src/service/progress.ts)
 *   · 写与回滚             —— 网关(src/service/write-gateway.ts)
 *   · 面板职责             —— 只渲染(ADR-0002:独占逻辑零 UI 化)
 * 视觉语言(舞台 / 印章 / 素材槽)见 panel.module.css 顶部注释。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GalfreeApi, GalfreeApiError } from './api.ts'
import type { NextActionView, ProgressView, SdkView, StateView, StampTarget } from './types.ts'
import { stampKey } from './types.ts'
import { Chip, Notice, Spinner, relativeTime } from './ui.tsx'
import { StageBoard } from './stage-board.tsx'
import { AssetBoard } from './asset-board.tsx'
import { BibleCard } from './bible-card.tsx'
import { SceneWorkbench } from './scene-workbench.tsx'
import { PublishCard } from './publish-card.tsx'
import { FileInspector } from './file-inspector.tsx'
import { DirectoryPicker } from './directory-picker.tsx'
import { ProjectSwitcher } from './project-switcher.tsx'
import { SdkCard } from './sdk-card.tsx'
import s from './panel.module.css'

interface NoticeItem {
  id: number
  tone: 'bad' | 'warn'
  text: string
}

function describeError(error: unknown): string {
  if (error instanceof GalfreeApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export function WorkbenchPanel() {
  const api = useMemo(() => new GalfreeApi(), [])
  const [state, setState] = useState<StateView | null>(null)
  const [progress, setProgress] = useState<ProgressView | null>(null)
  const [sdk, setSdk] = useState<SdkView | null>(null)
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [draft, setDraft] = useState({ name: '', title: '', projectsRoot: '' })
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)

  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ensuring, setEnsuring] = useState(false)
  /** 点舞台板场景 → 打开场景编辑器定位到它(T11/T12 的联动)。 */
  const [focusScene, setFocusScene] = useState<string | null>(null)

  const noticeSeq = useRef(0)
  const pushNotice = useCallback((tone: 'bad' | 'warn', text: string) => {
    noticeSeq.current += 1
    const id = noticeSeq.current
    setNotices((current) => (current.some((n) => n.text === text) ? current : [...current, { id, tone, text }]))
  }, [])

  /**
   * 「下一步」上那颗按钮:把推导给的 `target` 翻译成"滚到哪一格 / 打开哪一场"(T21)。
   *
   * 面板**不判断该做什么**(那是 `nextActions` 的事),只负责把人带到他该看的地方:
   * 场景 / 音频 → 场景编辑器;槽 → 素材板;设定集 → 设定集卡;试玩 → 那颗按钮;
   * 发布 → 发布卡。认不出的 kind **明说**,不静默什么都不做 —— 静默失败会让人以为界面坏了。
   */
  const jumpTo = useCallback((target: NextActionView['target']) => {
    if (target === undefined) return
    // 场景 / 音频两类都"打开那一场"(音频的行号给 agent 用,面板不做行内高亮)。
    const sceneLabel = target.kind === 'scene' ? target.label : target.kind === 'audio' ? target.scene : null
    if (sceneLabel !== null) setFocusScene(sceneLabel)
    const anchor = target.kind === 'scene' || target.kind === 'audio' ? 'gf-scene-workbench'
      : target.kind === 'slot' ? 'gf-asset-board'
      : target.kind === 'bible' ? 'gf-bible-card'
      : target.kind === 'publish' ? 'gf-publish-card'
      : target.kind === 'playtest' ? 'gf-playtest-button'
      : null
    if (anchor === null) {
      pushNotice('warn', `这一步没有可跳转的位置(${String(target.kind)})—— 在上面那条里照着做就行。`)
      return
    }
    const element = document.getElementById(anchor)
    if (element === null) return
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // 锚点都带 `tabIndex={-1}`,所以程序化 focus 有意义(首屏阅读器会跟过去)。
    if (element instanceof HTMLElement) element.focus({ preventScroll: true })
  }, [pushNotice])

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
          // 目录在两次请求之间被挪走是正常竞态:如实降级,不当故障刷屏。
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

  // 首屏 + 激活项目变化:重取。SSE 推送优先,8s 轮询兜底(页面隐藏时暂停)。
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
    const timer = window.setInterval(() => void refresh({ quiet: true }), 2500)
    return () => window.clearInterval(timer)
  }, [playing, refresh])

  // 默认父目录首帧带出一次(之后不再覆盖人的输入 —— 人改过就以人的为准)。
  const prefilledRoot = useRef(false)
  useEffect(() => {
    const fallback = state?.defaultProjectsRoot ?? ''
    if (prefilledRoot.current || fallback === '') return
    prefilledRoot.current = true
    setDraft((current) => (current.projectsRoot === '' ? { ...current, projectsRoot: fallback } : current))
  }, [state?.defaultProjectsRoot])

  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      await api.createProject(draft.name.trim(), draft.title.trim() || undefined, draft.projectsRoot.trim() || undefined)
      setDraft((current) => ({ ...current, name: '', title: '' }))
      setShowCreate(false)
      await refresh()
    } catch (error) {
      pushNotice('bad', `新建失败:${describeError(error)}`)
    } finally {
      setCreating(false)
    }
  }

  /** 父目录回落到默认值后,面板要能说清"到底会建到哪"。 */
  const defaultRoot = state?.defaultProjectsRoot ?? ''
  const resolvedRoot = draft.projectsRoot.trim() !== '' ? draft.projectsRoot.trim() : defaultRoot
  const separator = resolvedRoot.includes('\\') ? '\\' : '/'

  const activate = async (id: string): Promise<void> => {
    setSwitching(true)
    try {
      await api.activateProject(id)
      await refresh()
    } catch (error) {
      pushNotice('bad', `切换失败:${describeError(error)}`)
    } finally {
      setSwitching(false)
    }
  }

  const stamp = async (target: StampTarget): Promise<void> => {
    const key = stampKey(target)
    setBusyKey(key)
    try {
      if (target.kind === 'scene') await api.stampScene(target.label)
      else await api.stampSlot(target.slot)
      await refresh()
    } catch (error) {
      pushNotice('bad', `盖戳失败(${target.kind === 'scene' ? target.label : target.slot}):${describeError(error)}`)
    } finally {
      setBusyKey(null)
    }
  }

  /** 把手写文件里的段原样搬进生成目录(T10),搬完这一场才能被 agent 重生成。 */
  const relocate = async (label: string): Promise<void> => {
    setBusyKey(`relocate:${label}`)
    try {
      const moved = await api.relocateScene(label)
      pushNotice('warn', `${label} 已原样搬进 ${moved.to}(段内容逐字未改,并留下一条快照)。现在可以让 agent 重生成它了。`)
      await refresh()
    } catch (error) {
      pushNotice('bad', `搬家失败(${label}):${describeError(error)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const runPlaytest = async (from?: string): Promise<void> => {
    setPlaying(true)
    try {
      await api.playtest(from)
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
  const active = projects.find((project) => project.id === state?.activeId) ?? null
  const hasProject = active !== null && !active.missing

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
            <ProjectSwitcher projects={projects} activeId={state?.activeId ?? null} switching={switching} onActivate={(id) => void activate(id)} />
            <button
              type="button"
              className={s.button}
              onClick={() => void refresh()}
              disabled={loading}
              title={refreshedAt === null ? '重新读取状态' : `上次读取 ${refreshedAt.toLocaleTimeString()}`}
            >
              {loading ? <Spinner /> : '刷新'}
            </button>
            <button type="button" className={`${s.button} ${s.primary}`} onClick={() => setShowCreate((value) => !value)} aria-expanded={showCreate}>
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
                  <span className={s.fieldLabel}>
                    父目录{defaultRoot === '' ? ' · 还没配默认位置,先选一个' : ' · 已带出默认位置'}
                  </span>
                  <input
                    className={s.input}
                    placeholder="点右边「选择文件夹…」,或直接粘路径"
                    value={draft.projectsRoot}
                    onChange={(e) => setDraft({ ...draft, projectsRoot: e.target.value })}
                  />
                </label>
                <DirectoryPicker
                  api={api}
                  value={draft.projectsRoot}
                  disabled={creating}
                  onPick={(path) => setDraft((current) => ({ ...current, projectsRoot: path }))}
                />
                <button
                  type="button"
                  className={`${s.button} ${s.primary}`}
                  disabled={creating || draft.name.trim() === '' || resolvedRoot === ''}
                  onClick={() => void create()}
                >
                  {creating ? <><Spinner /> 创建中…</> : '创建并激活'}
                </button>
                <span className={s.formHint}>
                  项目名只允许小写字母、数字、- 与 _,创建后即成为当前项目。
                  {resolvedRoot === ''
                    ? ' 先选一个父目录,或在设置 → 插件 → GALFree 里配默认父目录。'
                    : ` 将创建到 ${resolvedRoot}${draft.name.trim() === '' ? `${separator}<项目名>` : `${separator}${draft.name.trim()}`}`}
                </span>
              </div>
            </div>
          </section>
        ) : null}

        <StageBoard
          progress={progress}
          busyKey={busyKey}
          playing={playing}
          onStamp={(target) => void stamp(target)}
          onPlaytest={() => void runPlaytest()}
          onPlaytestFrom={(label) => void runPlaytest(label)}
          onRelocate={(label) => void relocate(label)}
          onOpenScene={(label) => setFocusScene(label)}
          onJump={(target) => jumpTo(target)}
          hasProject={hasProject}
        />

        <BibleCard
          bibleStamp={progress?.bible ?? { stamp: 'none', chapters: 0, characters: 0, hasOutline: false, outlineFingerprintOk: true }}
          api={api}
          hasProject={hasProject}
          sceneLabels={(progress?.scenes ?? []).map((scene) => scene.label)}
          onChanged={() => refresh()}
          onNotice={pushNotice}
        />

        <AssetBoard
          characters={progress?.characters ?? []}
          slots={progress?.slots ?? []}
          api={api}
          hasProject={hasProject}
          onChanged={() => refresh()}
          onNotice={pushNotice}
        />

        <SceneWorkbench
          api={api}
          sceneLabels={(progress?.scenes ?? []).map((scene) => scene.label)}
          hasProject={hasProject}
          focus={focusScene}
          onFocusHandled={() => setFocusScene(null)}
          onChanged={() => refresh()}
          onNotice={pushNotice}
          // 池的内容变了(有人往 game/audio 丢/删文件)就重读 —— 与推导状态同一条观察链。
          audioPoolKey={progress === null
            ? ''
            : `${progress.audio.files.map((file) => file.path).join(',')}|${progress.audio.missing.map((reference) => reference.ref).join(',')}`}
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

        <PublishCard
          api={api}
          hasProject={hasProject}
          onChanged={() => refresh()}
          onNotice={pushNotice}
        />

        <FileInspector
          tree={state?.tree ?? []}
          api={api}
          hasProject={hasProject}
          onNotice={pushNotice}
        />

        <SdkCard sdk={sdk} ensuring={ensuring} onEnsure={() => void ensureSdk()} />
      </div>
    </div>
  )
}
