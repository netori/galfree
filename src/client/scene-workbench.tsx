/**
 * 场景编辑器(T11)+ 分支图导航(T12)。
 *
 * T11:**两个视图,同一份真相**(`.rpy`)。表单逐行改(说话人/文本/图像引用),源文本模式
 * 直接改文件;两路都走网关(版本戳 + 快照 + 写日志),改完立刻重解析,面板拿到的永远是
 * 服务端推导出来的新状态。
 *
 * T12:分支图是**派生骨架的纯渲染** —— 节点 = 场景,边 = jump/call/菜单选项。
 * 图上编辑明确出范围(spec),它只做导航:点节点 → 打开那个场景的表单。
 * 子集外降级的场景在图上带只读徽标与原因(与舞台板同源)。
 *
 * 编辑器**不做判断**:能不能编辑(子集外只读 / 手写文件的归属)由接缝拒绝,这里只把
 * 拒绝原样呈现出来。
 */
import { useCallback, useEffect, useState } from 'react'
import type { GalfreeApi } from './api.ts'
import type { BranchGraphView, SceneFormView, SceneRowView } from './types.ts'
import { Chip, Notice, Spinner } from './ui.tsx'
import s from './panel.module.css'

export function SceneWorkbench({ api, sceneLabels, hasProject, focus, onFocusHandled, onChanged, onNotice }: {
  api: GalfreeApi
  /** 剧本里现有的 label(分支图/编辑器的入口列表)。 */
  sceneLabels: string[]
  hasProject: boolean
  /** 外部要求聚焦到某个场景(点舞台板/分支图时设置)。 */
  focus: string | null
  onFocusHandled: () => void
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [label, setLabel] = useState<string | null>(null)
  const [form, setForm] = useState<SceneFormView | null>(null)
  const [graph, setGraph] = useState<BranchGraphView | null>(null)
  const [mode, setMode] = useState<'form' | 'source'>('form')
  const [sourceDraft, setSourceDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [degraded, setDegraded] = useState<string | null>(null)

  const loadForm = useCallback(async (target: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.sceneForm(target)
      setForm(next)
      setSourceDraft(next.source)
      setLabel(target)
    } catch (loadError) {
      setForm(null)
      setError(`读不了这一场:${loadError instanceof Error ? loadError.message : String(loadError)}`)
    } finally {
      setBusy(false)
    }
  }, [api])

  const loadGraph = useCallback(async () => {
    if (!hasProject) { setGraph(null); return }
    try {
      setGraph(await api.sceneGraph())
    } catch {
      setGraph(null)
    }
  }, [api, hasProject])

  useEffect(() => { void loadGraph() }, [loadGraph])

  // 外部聚焦(点舞台板场景 / 点分支图节点)。
  useEffect(() => {
    if (focus === null) return
    void loadForm(focus)
    onFocusHandled()
  }, [focus, loadForm, onFocusHandled])

  const submit = async (edit: Record<string, unknown>): Promise<void> => {
    if (label === null) return
    setBusy(true)
    setError(null)
    setDegraded(null)
    try {
      const report = await api.editScene(label, edit)
      setForm(report.form)
      setSourceDraft(report.form.source)
      // 失败如实呈现(与 T10 同源):校验不过不假装成功。
      if (!report.validation.ok) {
        onNotice('warn', `${label} 已写入,但校验未通过(${report.issues.length} 个问题)—— 见下方清单。`)
      }
      await onChanged()
      await loadGraph()
    } catch (editError) {
      // 接缝的拒绝是可执行的指令(只读降级 / 先搬家),原样说给用户。
      const result = editError as { code?: string }
      if (result.code === 'scene-read-only') setDegraded('这一场用了方言子集外的语法,编辑器降级只读。')
      setError(editError instanceof Error ? editError.message : String(editError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={s.card} aria-label="场景编辑器与分支图">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>场景</span>
        <span className={s.cardCount}>
          {hasProject ? `${sceneLabels.length} 场 · 表单与源文本是同一份 .rpy 的两个视图` : '编辑器'}
        </span>
        <span className={s.cardOps}>
          {form !== null ? (
            <span className={s.tabs} role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'form'}
                className={[s.tab, mode === 'form' ? s.tabActive : undefined].filter(Boolean).join(' ')}
                onClick={() => setMode('form')}>逐行表单</button>
              <button type="button" role="tab" aria-selected={mode === 'source'}
                className={[s.tab, mode === 'source' ? s.tabActive : undefined].filter(Boolean).join(' ')}
                onClick={() => setMode('source')}>源文本</button>
            </span>
          ) : null}
          {form !== null ? (
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => { setForm(null); setLabel(null); setDegraded(null) }}>关闭</button>
          ) : null}
        </span>
      </div>

      <div className={s.cardBody}>
        {!hasProject ? (
          <div className={s.empty}>没有激活项目,或项目目录已不在磁盘上。</div>
        ) : (
          <>
            {/* T12:分支图导航(只读;点节点打开编辑器)。 */}
            {graph !== null && graph.nodes.length > 0 ? (
              <div style={{ marginBottom: 10 }}>
                <div className={s.chips} style={{ marginBottom: 6 }}>
                  <Chip tone="quiet" num={graph.nodes.length}>场景</Chip>
                  <Chip tone="quiet" num={graph.edges.length}>跳转/选择边</Chip>
                  {graph.degraded ? <Chip tone="warn" dot>含子集外降级</Chip> : null}
                  <span className={s.emptyHint}>图上编辑不在范围内:它只做导航,点节点打开那一场</span>
                </div>
                <div className={s.graph}>
                  {graph.nodes.map((node) => (
                    <button
                      key={node.label}
                      type="button"
                      className={[s.graphNode, node.readOnly ? s.graphNodeReadOnly : undefined, label === node.label ? s.graphNodeActive : undefined].filter(Boolean).join(' ')}
                      onClick={() => void loadForm(node.label)}
                      title={`${node.file}:${node.line}${node.reason === undefined ? '' : `\n${node.reason}`}`}
                    >
                      <span className={s.graphLabel}>{node.label}</span>
                      {node.readOnly ? <span className={s.graphBadge} title={node.reason}>只读</span> : null}
                      {node.stamp === 'approved' ? <span className={s.slotSealGlyph}>印</span> : null}
                    </button>
                  ))}
                </div>
                {graph.edges.length > 0 ? (
                  <div className={s.emptyHint} style={{ marginTop: 4 }}>
                    {graph.edges.slice(0, 8).map((edge, index) => (
                      <span key={`${edge.from}-${edge.to}-${index}`}>
                        {index > 0 ? ' · ' : ''}
                        {edge.from}→{edge.to}
                        {edge.prompt === undefined ? '' : `(${edge.via === 'menu' ? '选项' : edge.via})`}
                      </span>
                    ))}
                    {graph.edges.length > 8 ? ' …' : ''}
                  </div>
                ) : null}
              </div>
            ) : null}

            {form === null ? (
              <div className={s.empty}>
                <div className={s.emptyTitle}>选一场来编辑</div>
                <div className={s.emptyHint}>
                  {sceneLabels.length === 0
                    ? '还没有场景 —— 让 agent 生成第一场,或自己写进 game/script.rpy。'
                    : '点上面的分支图节点,或在舞台板里点场景。'}
                </div>
              </div>
            ) : (
              <>
                <div className={s.chips} style={{ marginBottom: 8 }}>
                  <Chip tone="quiet" title={form.path}>{form.path}</Chip>
                  {form.readOnly ? <Chip tone="warn" dot>只读降级</Chip> : null}
                  {form.file.startsWith('scenes/') ? <Chip tone="quiet">可生成</Chip> : <Chip tone="quiet">手写文件</Chip>}
                </div>
                {degraded !== null ? <div style={{ marginBottom: 8 }}><Notice tone="warn">{degraded}</Notice></div> : null}
                {form.readOnly && form.readOnlyReason !== undefined ? (
                  <div style={{ marginBottom: 8 }}><Notice tone="warn">{form.readOnlyReason} —— 表单只读;源文本模式仍可改(那是你的文件)。</Notice></div>
                ) : null}

                {mode === 'form' ? (
                  <div className={s.tree}>
                    {form.rows.map((row) => (
                      <FormRow key={row.line} row={row} disabled={busy || form.readOnly} onSubmit={submit} />
                    ))}
                  </div>
                ) : (
                  <>
                    <textarea
                      className={s.input}
                      style={{ width: '100%', minHeight: 220, fontFamily: 'var(--gf-mono)', fontSize: 12, lineHeight: 1.6 }}
                      value={sourceDraft}
                      onChange={(event) => setSourceDraft(event.target.value)}
                    />
                    <div className={s.form} style={{ marginTop: 6 }}>
                      <button type="button" className={`${s.button} ${s.primary}`} disabled={busy || sourceDraft === form.source}
                        onClick={() => void submit({ kind: 'replaceSource', source: sourceDraft })}>
                        {busy ? <Spinner /> : '写入(经网关)'}
                      </button>
                      <button type="button" className={s.button} disabled={busy} onClick={() => setSourceDraft(form.source)}>撤销改动</button>
                      <span className={s.formHint}>源文本模式直接改这个文件;写完会重解析,校验问题当场列出来。</span>
                    </div>
                  </>
                )}

                {error !== null ? (
                  <div style={{ marginTop: 8 }}><Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice></div>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/** 一行的编辑控件(按行类型给不同的东西;不可编辑的行只显示原文)。 */
function FormRow({ row, disabled, onSubmit }: {
  row: SceneRowView
  disabled: boolean
  onSubmit: (edit: Record<string, unknown>) => Promise<void>
}) {
  const [text, setText] = useState(row.text ?? '')
  const [speaker, setSpeaker] = useState(row.speaker ?? '')
  const [tag, setTag] = useState(row.tag ?? '')
  const [attributes, setAttributes] = useState((row.attributes ?? []).join(' '))
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState('')

  if (row.kind === 'blank') return <div className={s.formRowBlank} aria-hidden="true" />
  if (row.kind === 'comment') return <div className={s.formRowRaw} title="注释(原样保留)">{row.raw}</div>
  if (row.kind === 'unsupported' || row.kind === 'jump' || row.kind === 'call' || row.kind === 'return' || row.kind === 'menu') {
    return (
      <div className={s.formRowRaw} title={row.note ?? '结构行'}>
        {row.raw}
        <span className={s.emptyHint}> · {row.note ?? '结构行,改它请用源文本'}</span>
      </div>
    )
  }

  if (row.kind === 'dialogue') {
    const dirty = text !== (row.text ?? '') || speaker !== (row.speaker ?? '')
    return (
      <div className={s.formRowEdit}>
        <span className={s.formLineNo}>{row.line}</span>
        <input className={s.input} style={{ width: 110 }} value={speaker} placeholder="(旁白)" disabled={disabled}
          aria-label={`第 ${row.line} 行说话人`} onChange={(event) => setSpeaker(event.target.value)} />
        <input className={s.input} style={{ flex: 1 }} value={text} disabled={disabled}
          aria-label={`第 ${row.line} 行文本`} onChange={(event) => setText(event.target.value)} />
        <button type="button" className={`${s.button} ${s.tiny}`} disabled={disabled || !dirty}
          onClick={() => void onSubmit({ kind: 'setDialogue', line: row.line, speaker: speaker.trim() === '' ? null : speaker.trim(), text })}>
          存这一行
        </button>
        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={disabled}
          onClick={() => void onSubmit({ kind: 'deleteStatement', line: row.line })} title="删掉这一行">删</button>
        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={disabled}
          onClick={() => setAdding(!adding)} title="在这一行下面插一行">+</button>
        {adding ? (
          <span className={s.form} style={{ flexBasis: '100%' }}>
            <input className={s.input} style={{ flex: 1 }} value={added} placeholder='插一行,例如 alice "新台词。"'
              onChange={(event) => setAdded(event.target.value)} />
            <button type="button" className={`${s.button} ${s.primary} ${s.tiny}`} disabled={disabled || added.trim() === ''}
              onClick={() => void onSubmit({ kind: 'insertStatement', anchor: row.raw, source: added }).then(() => { setAdded(''); setAdding(false) })}>
              插入
            </button>
          </span>
        ) : null}
      </div>
    )
  }

  // image 行:tag + 属性(素材槽就是从这里派生的)。
  const dirtyImage = tag !== (row.tag ?? '') || attributes !== (row.attributes ?? []).join(' ')
  return (
    <div className={s.formRowEdit}>
      <span className={s.formLineNo}>{row.line}</span>
      <span className={s.chip} style={{ flex: 'none' }}>{row.role}</span>
      <input className={s.input} style={{ width: 120 }} value={tag} disabled={disabled} aria-label={`第 ${row.line} 行图像 tag`}
        onChange={(event) => setTag(event.target.value)} />
      <input className={s.input} style={{ flex: 1 }} value={attributes} placeholder="属性(空格分隔)"
        disabled={disabled} aria-label={`第 ${row.line} 行图像属性`} onChange={(event) => setAttributes(event.target.value)} />
      <button type="button" className={`${s.button} ${s.tiny}`} disabled={disabled || !dirtyImage}
        onClick={() => void onSubmit({
          kind: 'setImage', line: row.line, role: row.role ?? 'show', tag: tag.trim(),
          attributes: attributes.split(/\s+/).filter((token) => token !== ''),
        })}>
        存这一行
      </button>
      <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={disabled}
        onClick={() => void onSubmit({ kind: 'deleteStatement', line: row.line })}>删</button>
    </div>
  )
}
