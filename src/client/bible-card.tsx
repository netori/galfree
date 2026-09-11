/**
 * 设定集卡(T9):项目的第一记忆源。
 *
 * 面板这里的职责有限且明确 —— **它不生成内容**:
 *   · 主题/世界观/章节由**人**编辑(改动会让定稿戳自动待复审);
 *   · 人写大纲**逐字导入**(原文即权威;面板只负责原样送过去,不做任何"整理");
 *   · 「设定定稿」戳只由人盖(agent 那侧没有这个入口);
 *   · 下游生成只读**定稿版** —— 没定稿时这里就把话说清楚,而不是让 agent 偷偷用草稿。
 *
 * 章节点的是 label(引用),角色引用的是登记簿 id(单一真相):设定集里不复制正文,
 * 也不复制外观卡。
 */
import { useEffect, useState } from 'react'
import type { BibleChapterView, BibleView, ProgressView } from './types.ts'
import type { GalfreeApi } from './api.ts'
import { Chip, Notice, Seal, Spinner } from './ui.tsx'
import s from './panel.module.css'

export function BibleCard({ bibleStamp, api, hasProject, sceneLabels, onChanged, onNotice }: {
  /** 推导出来的戳状态(来自 /progress,不在面板里自己判)。 */
  bibleStamp: ProgressView['bible']
  api: GalfreeApi
  hasProject: boolean
  /** 剧本里现有的 label —— 章节挂靠的可选项(引用,不是自由文本)。 */
  sceneLabels: string[]
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [doc, setDoc] = useState<BibleView | null>(null)
  const [outline, setOutline] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ theme: '', world: '' })
  const [importing, setImporting] = useState(false)
  const [outlineDraft, setOutlineDraft] = useState('')

  const load = async (): Promise<void> => {
    if (!hasProject) { setDoc(null); setOutline(null); return }
    setLoading(true)
    try {
      const next = await api.bible()
      setDoc(next.bible)
      setOutline(next.outline)
      setDraft({ theme: next.bible.theme ?? '', world: next.bible.world ?? '' })
    } catch (loadError) {
      setError(`设定集读不到:${loadError instanceof Error ? loadError.message : String(loadError)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [api, hasProject])

  const patch = async (payload: Parameters<GalfreeApi['patchBible']>[0]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.patchBible(payload)
      await load()
      await onChanged()
    } catch (patchError) {
      setError(`存不了:${patchError instanceof Error ? patchError.message : String(patchError)}`)
    } finally {
      setBusy(false)
    }
  }

  const chapters: BibleChapterView[] = doc?.chapters ?? []

  return (
    <section className={s.card} aria-label="设定集">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>设定集</span>
        <span className={s.cardCount}>
          {hasProject
            ? `${chapters.length} 章 · 引用 ${doc?.characters.length ?? 0} 个角色 · 下游生成只认定稿版`
            : '第一记忆源'}
        </span>
        <span className={s.cardOps}>
          {hasProject ? <Seal state={bibleStamp.stamp === 'approved' ? 'approved' : bibleStamp.stamp === 'stale' ? 'stale' : 'pending'} pendingLabel="未定稿" /> : null}
          {hasProject && bibleStamp.stamp !== 'approved' ? (
            <button type="button" className={`${s.button} ${s.primary}`} disabled={busy || loading}
              title="以人身份认可这版设定;之后 agent 的生成才用它做记忆源"
              onClick={() => {
                setBusy(true)
                void api.stampBible().then(load).then(onChanged).catch((e) => setError(String(e))).finally(() => setBusy(false))
              }}>
              {busy ? <Spinner /> : '盖「设定定稿」戳'}
            </button>
          ) : null}
          <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => setEditing(!editing)}>
            {editing ? '收起编辑' : '编辑'}
          </button>
        </span>
      </div>

      <div className={s.cardBody}>
        {!hasProject ? (
          <div className={s.empty}>没有激活项目,或项目目录已不在磁盘上。</div>
        ) : loading ? (
          <div className={s.empty}><Spinner /> 读取设定集…</div>
        ) : (
          <>
            {bibleStamp.stamp === 'stale' ? (
              <div style={{ marginBottom: 10 }}>
                <Notice tone="warn">设定集改过了 —— 定稿戳已待复审,下游生成暂时拿不到上下文。</Notice>
              </div>
            ) : null}
            {!bibleStamp.outlineFingerprintOk ? (
              <div style={{ marginBottom: 10 }}>
                <Notice tone="bad">人写的原文与导入时记录不一致(被外部改过)。请人确认后再据它生成。</Notice>
              </div>
            ) : null}

            <div className={s.chips} style={{ marginBottom: 8 }}>
              <Chip tone={doc?.theme ? 'none' : 'warn'}>{doc?.theme ? `主题:${doc.theme}` : '还没有主题'}</Chip>
              <Chip tone={bibleStamp.hasOutline ? 'ok' : 'quiet'}>
                {bibleStamp.hasOutline ? `已导入大纲 · ${doc?.outline?.chars ?? 0} 字` : '未导入大纲'}
              </Chip>
              <Chip tone={chapters.length > 0 ? 'none' : 'warn'} num={chapters.length}>章节</Chip>
            </div>

            {doc?.world !== undefined && doc.world !== '' && !editing ? (
              <div className={s.rootPath} style={{ fontFamily: 'inherit' }}>{doc.world}</div>
            ) : null}

            {chapters.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                {chapters.map((chapter) => (
                  <div key={chapter.id} className={s.commitRow}>
                    <span className={s.commitHash}>{chapter.id}</span>
                    <span className={s.commitSubject}>
                      {chapter.title}
                      {chapter.outline === undefined ? null : <span style={{ color: 'var(--gf-text-3)' }}> · {chapter.outline}</span>}
                    </span>
                    <span className={s.commitWhen}>
                      {chapter.scenes.length === 0 ? '未挂场景' : chapter.scenes.map((label) => `#${label}`).join(' ')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={s.empty}>
                <div className={s.emptyTitle}>设定集还是空的</div>
                <div className={s.emptyHint}>
                  两条路:给一句话主题让 agent 起草,或把已有大纲整段导入(原文逐字保留、agent 只能补登记簿与骨架)。
                </div>
              </div>
            )}

            {editing ? (
              <div className={s.form} style={{ marginTop: 10 }}>
                <label className={`${s.field} ${s.fieldRoot}`}>
                  <span className={s.fieldLabel}>主题 · 一句话</span>
                  <input className={s.input} value={draft.theme} placeholder="雨天的重逢"
                    onChange={(e) => setDraft({ ...draft, theme: e.target.value })} />
                </label>
                <label className={`${s.field} ${s.fieldRoot}`}>
                  <span className={s.fieldLabel}>世界观 · 人的意图,不是正文</span>
                  <input className={s.input} value={draft.world} placeholder="现代都市,梅雨季;天台与图书馆反复出现"
                    onChange={(e) => setDraft({ ...draft, world: e.target.value })} />
                </label>
                <button type="button" className={`${s.button} ${s.primary}`} disabled={busy}
                  onClick={() => void patch({ theme: draft.theme, world: draft.world })}>
                  {busy ? <Spinner /> : '保存'}
                </button>
                <span className={s.formHint}>
                  章节挂在 label 上;角色设定在素材板的角色视图里维护(设定集只引用)。
                  {sceneLabels.length === 0 ? '' : ` 现有场景:${sceneLabels.slice(0, 6).join('、')}`}
                </span>
              </div>
            ) : null}

            <div className={s.form} style={{ marginTop: 10 }}>
              <button type="button" className={s.button} disabled={busy} onClick={() => {
                setImporting(!importing)
                if (!importing) setOutlineDraft(outline ?? '')
              }}>
                {importing ? '收起' : bibleStamp.hasOutline ? '重新导入大纲' : '导入大纲'}
              </button>
              {bibleStamp.hasOutline ? (
                <span className={s.emptyHint}>原文逐字保留在 {doc?.outline?.path};agent 不会改写它</span>
              ) : null}
            </div>

            {importing ? (
              <>
                <textarea
                  className={s.input}
                  style={{ width: '100%', minHeight: 140, marginTop: 8, fontFamily: 'var(--gf-mono)', fontSize: 12, lineHeight: 1.6 }}
                  value={outlineDraft}
                  placeholder="把你的大纲原样粘进来 —— 逐字保留,不会被整理或改写"
                  onChange={(e) => setOutlineDraft(e.target.value)}
                />
                <div className={s.form} style={{ marginTop: 6 }}>
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={busy || outlineDraft.trim() === ''}
                    onClick={() => {
                      setBusy(true)
                      setError(null)
                      void api.importOutline(outlineDraft)
                        .then(async (result) => { onNotice('warn', `已逐字导入 ${result.chars} 字原文;agent 之后只能补登记簿与骨架。`); setImporting(false); await load(); await onChanged() })
                        .catch((e) => setError(String(e)))
                        .finally(() => setBusy(false))
                    }}>
                    {busy ? <Spinner /> : '逐字导入'}
                  </button>
                  <span className={s.formHint}>导入后原文即权威;外部改动会被指纹发现并在板上如实报错。</span>
                </div>
              </>
            ) : null}

            {error !== null ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
