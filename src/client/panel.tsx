/**
 * 工作台面板(最小壳 T1):当前项目名 + 文件树 + 新建/切换项目。
 * 正确性标准 = 正确渲染接缝(/api/galfree)吐出的状态;无 DOM 测试。
 */
import { useCallback, useEffect, useState } from 'react'
import { GalfreeApi } from './api.ts'
import type { ProgressView, SnapshotEntry, StateView, TreeNode } from './api.ts'

function Chip({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'bad' }) {
  const bg = tone === 'ok' ? 'rgba(60,160,90,0.15)' : tone === 'warn' ? 'rgba(220,160,40,0.18)' : 'rgba(200,60,60,0.18)'
  return <span style={{ background: bg, borderRadius: 10, padding: '2px 8px', fontSize: 12 }}>{label}</span>
}

function TreeView({ nodes, onSelect, selected }: { nodes: TreeNode[]; onSelect?: (path: string) => void; selected?: string }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, paddingInlineStart: 0 }}>
      {nodes.map((node) => (
        <li key={node.path}>
          {!node.dir ? (
            <button
              type="button"
              onClick={() => onSelect?.(node.path)}
              style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: selected === node.path ? 700 : 400 }}
            >
              {node.name}
            </button>
          ) : (
            <span style={{ opacity: 0.8, userSelect: 'none' }}>▸ {node.name}</span>
          )}
          {node.dir && (node.children?.length ?? 0) > 0 ? (
            <div style={{ paddingInlineStart: 14 }}>
              <TreeView nodes={node.children!} onSelect={onSelect} selected={selected} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function WorkbenchPanel() {
  const api = new GalfreeApi()
  const [state, setState] = useState<StateView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ name: '', title: '', projectsRoot: '' })
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [history, setHistory] = useState<SnapshotEntry[]>([])
  const [diff, setDiff] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressView | null>(null)

  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path)
    setDiff(null)
    try {
      setHistory(await api.snapshots(path))
    } catch (e) {
      setError(String(e))
      setHistory([])
    }
  }, [api])

  const refresh = useCallback(async () => {
    try {
      setState(await api.state())
      try {
        setProgress(await api.progress())
      } catch {
        setProgress(null)
      }
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 推送优先:SSE(网关观察到外部修改即推);轮询 8s 仅做兜底。
    let source: EventSource | undefined
    try {
      source = new EventSource('/api/galfree/events')
      source.onmessage = () => void refresh()
    } catch {
      source = undefined
    }
    const timer = window.setInterval(() => void refresh(), 8000)
    return () => {
      window.clearInterval(timer)
      source?.close()
    }
  }, [refresh, state?.activeId])

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.createProject(draft.name, draft.title || undefined, draft.projectsRoot || undefined)
      setDraft({ name: '', title: '', projectsRoot: '' })
      await refresh()
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const active = state?.projects.find((p) => p.id === state.activeId) ?? null

  return (
    <div style={{ padding: '16px 20px', overflow: 'auto', height: '100%', boxSizing: 'border-box', fontSize: 13 }}>
      <h2 style={{ margin: '0 0 4px' }}>GALFree 工作台</h2>
      {error !== null ? <div role="alert" style={{ color: 'crimson', margin: '8px 0' }}>{error}</div> : null}

      <section aria-label="当前项目" style={{ marginBlock: 12 }}>
        {active === null
          ? <div>还没有激活项目。从模板新建一个:</div>
          : (
            <div>
              <div style={{ fontWeight: 600 }}>
                {active.title}
                {active.missing ? <span style={{ color: 'crimson', marginLeft: 8 }}>目录缺失</span> : null}
              </div>
              <div style={{ opacity: 0.7, wordBreak: 'break-all' }}>{active.root}</div>
            </div>
          )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input aria-label="项目名(slug)" placeholder="项目名(小写字母/数字/-/_)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ width: 200 }} />
          <input aria-label="标题" placeholder="标题(可缺省)" value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ width: 140 }} />
          <input aria-label="父目录" placeholder="父目录(或走默认设置)" value={draft.projectsRoot}
            onChange={(e) => setDraft({ ...draft, projectsRoot: e.target.value })} style={{ width: 240 }} />
          <button type="button" disabled={busy || draft.name === ''} onClick={() => void create()}>
            {busy ? '创建中…' : '新建项目'}
          </button>
        </div>
      </section>

      {state !== null && state.projects.length > 0 ? (
        <section aria-label="项目列表" style={{ marginBlock: 12 }}>
          <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>项目</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {state.projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={p.active}
                  onClick={() => void api.activate(p.id).then(refresh)}
                  style={{ background: 'none', border: 0, cursor: p.active ? 'default' : 'pointer', padding: '2px 0', fontWeight: p.active ? 700 : 400 }}
                >
                  {p.title}{p.missing ? '(缺失)' : ''}{p.active ? ' ✓' : ''}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="阶段板(推导)">
        <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>阶段板 · 推导进度</div>
        {progress === null ? <div style={{ opacity: 0.6 }}>(无项目)</div> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBlockEnd: 8 }}>
            <Chip label={`lint ${progress.lint.ok ? '通过' : `${progress.lint.errors} 错`}`} tone={progress.lint.ok ? 'ok' : 'bad'} />
            <Chip label={`缺对白 ${progress.summary.missingDialogue}`} tone={progress.summary.missingDialogue ? 'warn' : 'ok'} />
            <Chip label={`缺素材 ${progress.summary.missingSlots}`} tone={progress.summary.missingSlots ? 'warn' : 'ok'} />
            <Chip label={`待复审 ${progress.summary.awaitingReview}`} tone={progress.summary.awaitingReview ? 'warn' : 'ok'} />
            {progress.degraded ? <Chip label="含只读降级" tone="warn" /> : null}
          </div>
        )}
        {progress !== null && progress.scenes.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {progress.scenes.map((scene) => (
              <li key={scene.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <code>{scene.label}</code>
                <span style={{ opacity: 0.7 }}>
                  {scene.readOnly ? '只读·' : ''}{scene.missingDialogue ? '缺对白·' : ''}{scene.missingSlots.length ? `缺素材${scene.missingSlots.length}·` : ''}
                  {scene.stamp === 'approved' ? '已审读' : scene.stamp === 'stale' ? '待复审' : scene.stamp === 'pending' ? '待审读' : '—'}
                </span>
                {scene.stamp !== 'approved' && !scene.readOnly ? (
                  <button type="button" onClick={() => { void api.stampScene(scene.label).then(refresh).catch((e) => setError(String(e))) }}>盖审读戳</button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-label="文件树">
        <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>文件(点击看快照历史)</div>
        {active !== null && !active.missing && state !== null
          ? <TreeView nodes={state.tree} onSelect={(p) => void selectFile(p)} selected={selectedFile ?? undefined} />
          : <div style={{ opacity: 0.6 }}>(无项目或目录缺失)</div>}
      </section>

      {selectedFile !== null ? (
        <section aria-label="快照历史" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>快照历史 · {selectedFile}</div>
          {history.length === 0 ? <div style={{ opacity: 0.6 }}>(无历史)</div> : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {history.map((entry) => (
                <li key={entry.commit} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <code style={{ opacity: 0.7 }}>{entry.commit.slice(0, 8)}</code>
                  <span style={{ flex: 1 }}>{entry.subject}</span>
                  <button type="button" onClick={() => {
                    const idx = history.indexOf(entry)
                    const prev = history[idx + 1]
                    if (prev === undefined) return
                    void api.snapshotDiff(selectedFile, prev.commit, entry.commit).then(setDiff).catch((e) => setError(String(e)))
                  }}>diff</button>
                </li>
              ))}
            </ul>
          )}
          {diff !== null ? (
            <pre style={{ background: 'rgba(127,127,127,0.08)', padding: 8, overflowX: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap' }}>{diff}</pre>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
