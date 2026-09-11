/**
 * 工作台面板(最小壳 T1):当前项目名 + 文件树 + 新建/切换项目。
 * 正确性标准 = 正确渲染接缝(/api/galfree)吐出的状态;无 DOM 测试。
 */
import { useCallback, useEffect, useState } from 'react'
import { GalfreeApi } from './api.ts'
import type { StateView, TreeNode } from './api.ts'

function TreeView({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, paddingInlineStart: 0 }}>
      {nodes.map((node) => (
        <li key={node.path}>
          <span style={{ opacity: node.dir ? 1 : 0.75, userSelect: 'none' }}>
            {node.dir ? '▸ ' : ''}{node.name}
          </span>
          {node.dir && (node.children?.length ?? 0) > 0 ? (
            <div style={{ paddingInlineStart: 14 }}>
              <TreeView nodes={node.children!} />
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

  const refresh = useCallback(async () => {
    try {
      setState(await api.state())
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

      <section aria-label="文件树">
        <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>文件</div>
        {active !== null && !active.missing && state !== null
          ? <TreeView nodes={state.tree} />
          : <div style={{ opacity: 0.6 }}>(无项目或目录缺失)</div>}
      </section>
    </div>
  )
}
