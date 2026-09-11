/**
 * 目录选择:两个入口,主次分明。
 *
 * **面板内目录浏览器恒可用** —— 数据来自 /picker/list,宿主 browse 后端在就用宿主的,
 * 不在就由插件自带底座兜底(理由见 src/service/directory-listing.ts 顶部:宿主后端是
 * 运行时动态装配的,那条链不该成为"能不能选文件夹"的单点)。
 *
 * **宿主屏幕上的 OS 选择器是增强** —— `native` 能力在时多给一个「开系统对话框」按钮,
 * 因为系统文件夹框对人更顺手;它不在也不影响主路径。它若报错(后端挂了/超时),
 * 面板直接把浏览器打开,不让人卡在一个点了没反应的按钮上。
 *
 * 手输路径随时可用,并会即时校验(不存在 / 不是文件夹都当场说清)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectoryListing, GalfreeApi, PickerCapability } from './api.ts'
import { GalfreeApiError } from './api.ts'
import { Chip, Notice, Spinner } from './ui.tsx'
import s from './panel.module.css'

/** 宿主浏览后端的封闭业务码 → 人能照着做的下一步。 */
function describePickerFailure(error: unknown): string {
  const message = error instanceof GalfreeApiError ? error.message : String(error)
  switch (error instanceof GalfreeApiError ? error.code : undefined) {
    case 'directory-unreadable':
      return `这个目录读不了(可能不存在或没有权限):${message}`
    case 'directory-exists':
      return `同名文件夹已经存在:${message}`
    case 'directory-create-failed':
      return `建文件夹失败:${message}`
    case 'picker-timeout':
      return message
    case 'picker-unsupported':
      return `这个宿主的系统对话框不可用(${message});用上面的「浏览…」在面板里选。`
    default:
      return message
  }
}

export function DirectoryPicker({ api, value, onPick, disabled }: {
  api: GalfreeApi
  /** 当前父目录输入框的值(给浏览器一个起始位置)。 */
  value: string
  onPick: (path: string) => void
  disabled: boolean
}) {
  const [capability, setCapability] = useState<PickerCapability | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [probe, setProbe] = useState<{ exists: boolean; isDirectory: boolean } | null>(null)

  useEffect(() => {
    let live = true
    void api.picker()
      .then((next) => { if (live) setCapability(next) })
      .catch(() => { if (live) setCapability(null) })
    return () => { live = false }
  }, [api])

  // 手输或选完之后校验一次:这个位置现在能不能放项目(不猜,问 host)。
  useEffect(() => {
    const trimmed = value.trim()
    if (trimmed === '') { setProbe(null); return }
    let live = true
    const timer = window.setTimeout(() => {
      void api.inspectPath(trimmed)
        .then((result) => { if (live) setProbe({ exists: result.exists, isDirectory: result.isDirectory }) })
        .catch(() => { if (live) setProbe(null) })
    }, 350)
    return () => { live = false; window.clearTimeout(timer) }
  }, [api, value])

  const pickNative = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const result = await api.pickDirectory()
      // 取消是正常结果:什么都不改,也不弹提示。
      if (!result.cancelled && result.path !== null) onPick(result.path)
    } catch (pickError) {
      const message = describePickerFailure(pickError)
      setError(message)
      // 系统对话框用不了 → 别让人卡住,直接把面板里的浏览器打开。
      setBrowsing(true)
    } finally {
      setPicking(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={s.button}
        disabled={disabled}
        onClick={() => setBrowsing(true)}
        title="在面板里逐层选文件夹,可新建文件夹"
      >
        浏览…
      </button>
      {capability?.native === true ? (
        <button
          type="button"
          className={s.button}
          disabled={disabled || picking}
          onClick={() => void pickNative()}
          title="打开系统的文件夹选择框"
        >
          {picking ? <><Spinner /> 等你在对话框里选…</> : '开系统对话框'}
        </button>
      ) : null}
      {probe !== null && value.trim() !== '' ? (
        <Chip tone={probe.isDirectory ? 'ok' : probe.exists ? 'warn' : 'quiet'} title={value.trim()}>
          {probe.isDirectory ? '目录存在' : probe.exists ? '这不是文件夹' : '路径还不存在(创建时会建)'}
        </Chip>
      ) : null}
      {error !== null ? (
        <div style={{ flexBasis: '100%' }}>
          <Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice>
        </div>
      ) : null}
      {browsing ? (
        <BrowseDialog
          api={api}
          startPath={value.trim()}
          onCancel={() => setBrowsing(false)}
          onConfirm={(path) => { setBrowsing(false); onPick(path) }}
        />
      ) : null}
    </>
  )
}

function BrowseDialog({ api, startPath, onCancel, onConfirm }: {
  api: GalfreeApi
  startPath: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const newNameRef = useRef<HTMLInputElement>(null)

  const open = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      setListing(await api.listDirectory(path))
    } catch (listError) {
      setError(describePickerFailure(listError))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void open(startPath === '' ? undefined : startPath) }, [open, startPath])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const createFolder = async (): Promise<void> => {
    if (listing === null || newName.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createDirectory(listing.path, newName.trim())
      setNewName('')
      setCreating(false)
      await open(created.path)
    } catch (createError) {
      setError(describePickerFailure(createError))
    } finally {
      setBusy(false)
    }
  }

  const parentPath = listing === null || listing.crumbs.length < 2
    ? null
    : listing.crumbs[listing.crumbs.length - 2]!.path
  const visibleEntries = (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden)

  return (
    <div className={s.dialogBackdrop} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className={s.dialog} role="dialog" aria-label="选择文件夹" aria-modal="true">
        <div className={s.dialogHead}>
          <span className={s.cardTitle}>选择文件夹</span>
          <span className={s.cardCount}>选中的文件夹会成为新建项目的父目录</span>
          <span className={s.cardOps}>
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => void open(listing?.home)} disabled={loading}>
              回主目录
            </button>
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={onCancel}>取消</button>
          </span>
        </div>

        <div className={s.dialogPath}>
          <button
            type="button"
            className={`${s.button} ${s.ghost} ${s.tiny}`}
            disabled={parentPath === null || loading}
            onClick={() => { if (parentPath !== null) void open(parentPath) }}
            title="上一层"
          >
            ↑ 上一层
          </button>
          <span className={s.crumbs}>
            {listing?.crumbs.map((crumb, index) => (
              <span key={crumb.path}>
                {index > 0 ? <span className={s.crumbSep}>/</span> : null}
                <button type="button" className={s.crumb} onClick={() => void open(crumb.path)}>{crumb.name || crumb.path}</button>
              </span>
            )) ?? <span className={s.emptyHint}>读取中…</span>}
          </span>
        </div>

        {error !== null ? <div style={{ padding: '0 14px 8px' }}><Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice></div> : null}

        <div className={s.dialogBody}>
          {loading ? (
            <div className={s.empty}><Spinner /> 读取目录…</div>
          ) : visibleEntries.length === 0 ? (
            <div className={s.empty}>
              <div className={s.emptyTitle}>这个目录里没有子文件夹</div>
              <div className={s.emptyHint}>可以直接选中它,或在下面新建一个。</div>
            </div>
          ) : (
            visibleEntries.map((entry) => (
              <button key={entry.path} type="button" className={s.dirRow} onClick={() => void open(entry.path)} title={entry.path}>
                <span className={s.treeIcon} aria-hidden="true">▸</span>
                <span className={s.treeName}>{entry.name}</span>
              </button>
            ))
          )}
          {listing?.truncated === true ? (
            <div className={s.emptyHint} style={{ padding: '8px 14px' }}>
              子文件夹太多,这一层被截断了(宿主上限)。用上面的路径或手输完整路径。
            </div>
          ) : null}
        </div>

        <div className={s.dialogFoot}>
          {creating ? (
            <div className={s.form} style={{ flex: 1 }}>
              <input
                ref={newNameRef}
                className={s.input}
                style={{ flex: '1 1 200px' }}
                placeholder="新文件夹名"
                value={newName}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void createFolder() }}
              />
              <button type="button" className={s.button} disabled={busy || newName.trim() === ''} onClick={() => void createFolder()}>
                {busy ? <Spinner /> : '创建'}
              </button>
              <button type="button" className={`${s.button} ${s.ghost}`} disabled={busy} onClick={() => { setCreating(false); setNewName('') }}>取消</button>
            </div>
          ) : (
            <>
              <button type="button" className={s.button} disabled={listing === null} onClick={() => { setCreating(true); setTimeout(() => newNameRef.current?.focus(), 0) }}>
                新建文件夹
              </button>
              <label className={s.checkLabel}>
                <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
                显示隐藏项
              </label>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {listing !== null ? <Chip tone="quiet" title={listing.path}>{listing.path}</Chip> : null}
                <button type="button" className={`${s.button} ${s.primary}`} disabled={listing === null} onClick={() => { if (listing !== null) onConfirm(listing.path) }}>
                  用这个文件夹
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
