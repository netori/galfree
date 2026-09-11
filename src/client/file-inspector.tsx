/**
 * 文件检视器:一行 = 选中文件 → 当前内容 / 快照历史 / diff / 回滚。
 *
 * 把"选文件"这条链路收在一个组件里,而不是让主面板同时管树、内容、历史、diff
 * 四份状态 —— 主面板只管刷新接缝状态(workbench-panel.tsx)。
 *
 * 回滚是**写**:它经接缝的 snapshotRollback 走网关落盘,并自动产生一条回滚快照
 * (ADR-0004/0011)。界面上必须说清这一点,并且要人确认 —— 它会覆盖磁盘上的当前内容。
 */
import { useState } from 'react'
import type { GalfreeApi, SnapshotEntry, TreeNode } from './api.ts'
import { Chip, DiffView, Spinner, relativeTime } from './ui.tsx'
import s from './panel.module.css'

export function FileInspector({ tree, api, hasProject, onNotice }: {
  tree: TreeNode[]
  api: GalfreeApi
  hasProject: boolean
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'content' | 'history'>('content')

  const [content, setContent] = useState<{ text: string; version: string; bytes: number } | null>(null)
  const [contentState, setContentState] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle')
  const [history, setHistory] = useState<SnapshotEntry[]>([])
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLabel, setDiffLabel] = useState('')
  const [pendingRollback, setPendingRollback] = useState<SnapshotEntry | null>(null)
  const [rollingBack, setRollingBack] = useState(false)

  const visible = filterTree(tree, filter.trim().toLowerCase())
  const dirPaths = collectDirs(tree)
  const allExpanded = dirPaths.length > 0 && dirPaths.every((path) => expanded.has(path))
  const filtering = filter.trim() !== ''

  const toggleDir = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const select = async (path: string): Promise<void> => {
    setSelected(path)
    setDiff(null)
    setDiffLabel('')
    setPendingRollback(null)
    setTab('content')
    setContent(null)
    setContentState('loading')
    setHistory([])
    try {
      const [file, snaps] = await Promise.all([api.fileContent(path), api.snapshots(path)])
      setContent({ text: file.content, version: file.version, bytes: file.bytes })
      setContentState(file.version === 'absent' ? 'missing' : 'idle')
      setHistory(snaps)
    } catch (error) {
      setContentState('error')
      onNotice('bad', `读不了这个文件:${describe(error)}`)
    }
  }

  const showDiff = async (entry: SnapshotEntry, previous: SnapshotEntry): Promise<void> => {
    if (selected === null) return
    setDiffLabel(`${previous.commit.slice(0, 8)} → ${entry.commit.slice(0, 8)}`)
    try {
      setDiff(await api.snapshotDiff(selected, previous.commit, entry.commit))
    } catch (error) {
      onNotice('bad', `diff 读不到:${describe(error)}`)
    }
  }

  const rollback = async (entry: SnapshotEntry): Promise<void> => {
    if (selected === null) return
    setRollingBack(true)
    try {
      await api.rollbackFile(selected, entry.commit)
      setPendingRollback(null)
      onNotice('warn', `${selected} 已回滚到 ${entry.commit.slice(0, 8)};回滚本身也产生了一条快照。`)
      await select(selected)
    } catch (error) {
      onNotice('bad', `回滚失败:${describe(error)}`)
    } finally {
      setRollingBack(false)
    }
  }

  return (
    <section className={s.card} aria-label="文件">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>文件</span>
        <span className={s.cardCount}>点文件名看内容与快照;点目录展开</span>
        <span className={s.cardOps}>
          <input
            className={s.input}
            style={{ width: 150, padding: '5px 10px', fontSize: 12 }}
            placeholder="筛选…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="筛选文件"
          />
          <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => setExpanded(allExpanded ? new Set() : new Set(dirPaths))} disabled={tree.length === 0}>
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
              nodes={visible}
              depth={0}
              selected={selected}
              onSelect={(path) => void select(path)}
              expanded={expanded}
              onToggleDir={toggleDir}
              forceOpen={filtering}
            />
          </div>
        )}
      </div>

      {selected !== null ? (
        <div className={s.row}>
          <div className={s.cardHead} style={{ padding: 0, minHeight: 0, marginBottom: 8 }}>
            <span className={s.cardTitle} style={{ fontFamily: 'var(--gf-mono)', fontSize: 12 }}>{selected}</span>
            <span className={s.cardOps}>
              <span className={s.tabs} role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'content'}
                  className={[s.tab, tab === 'content' ? s.tabActive : undefined].filter(Boolean).join(' ')}
                  onClick={() => setTab('content')}>内容</button>
                <button type="button" role="tab" aria-selected={tab === 'history'}
                  className={[s.tab, tab === 'history' ? s.tabActive : undefined].filter(Boolean).join(' ')}
                  onClick={() => setTab('history')}>
                  快照{history.length > 0 ? ` ${history.length}` : ''}
                </button>
              </span>
              <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => { setSelected(null); setContent(null); setHistory([]); setDiff(null) }}>
                关闭
              </button>
            </span>
          </div>

          {tab === 'content' ? (
            contentState === 'loading' ? (
              <div className={s.empty}><Spinner /> 读取中…</div>
            ) : contentState === 'missing' ? (
              <div className={s.empty}>
                <div className={s.emptyTitle}>这个文件还不存在</div>
                <div className={s.emptyHint}>模板的空目录用 .gitkeep 占位;真实素材与剧本落盘后才有内容。</div>
              </div>
            ) : contentState === 'error' ? (
              <div className={s.empty}>读不到内容(见上方提示)。</div>
            ) : content === null ? null : (
              <>
                <div className={s.chips}>
                  <Chip tone="quiet" num={`${content.bytes} B`}>当前内容</Chip>
                  <Chip tone="quiet" title="网关口径的版本戳(内容哈希);写批靠它做 CAS">
                    v{content.version.slice(0, 8)}
                  </Chip>
                </div>
                <pre className={s.preview}>
                  {content.text === '' ? <span className={s.emptyHint}>(空文件)</span> : content.text.split('\n').map((line, i) => (
                    <div key={i} className={s.previewLine}>
                      <span className={s.previewNo}>{i + 1}</span>
                      <span className={s.previewText}>{line === '' ? '\u00a0' : line}</span>
                    </div>
                  ))}
                </pre>
              </>
            )
          ) : (
            <>
              {history.length === 0 ? (
                <div className={s.empty}>
                  <div className={s.emptyTitle}>这个文件还没有快照</div>
                  <div className={s.emptyHint}>写批落盘后会自动产生一条 commit;没写过就没有历史。</div>
                </div>
              ) : history.map((entry, index) => {
                const previous = history[index + 1]
                const confirming = pendingRollback?.commit === entry.commit
                return (
                  <div key={entry.commit}>
                    <div className={s.commitRow}>
                      <span className={s.commitHash}>{entry.commit.slice(0, 8)}</span>
                      <span className={s.commitSubject}>{entry.subject}</span>
                      <span className={s.commitWhen}>{relativeTime(entry.at)}</span>
                      {previous === undefined ? (
                        <span className={s.commitWhen} title="最早的快照,没有可比的上一版">首版</span>
                      ) : (
                        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => void showDiff(entry, previous)}>
                          与上一版比
                        </button>
                      )}
                      <button
                        type="button"
                        className={`${s.button} ${s.ghost} ${s.tiny}`}
                        onClick={() => setPendingRollback(confirming ? null : entry)}
                      >
                        回滚到此版
                      </button>
                    </div>
                    {confirming ? (
                      <div className={s.confirm}>
                        <span>
                          把 <code style={{ fontFamily: 'var(--gf-mono)' }}>{selected}</code> 恢复到{' '}
                          <code style={{ fontFamily: 'var(--gf-mono)' }}>{entry.commit.slice(0, 8)}</code>?
                          磁盘上的当前内容会被覆盖;回滚本身会留下一条新快照,历史不改写,随时可以再回滚。
                        </span>
                        <button type="button" className={`${s.button} ${s.primary}`} disabled={rollingBack} onClick={() => void rollback(entry)}>
                          {rollingBack ? <><Spinner /> 回滚中…</> : '确认回滚'}
                        </button>
                        <button type="button" className={s.button} disabled={rollingBack} onClick={() => setPendingRollback(null)}>取消</button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {diff !== null ? (
                <>
                  <div className={s.cardCount} style={{ marginTop: 10 }}>diff {diffLabel}</div>
                  <DiffView text={diff} />
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
