/**
 * 差分对比面(T16,素材板的第三个 tab)—— 同角色差分网格。
 *
 * 三条纪律(与接缝同源,面板不自己判断):
 *  · **网格是派生的**:格子来自登记簿 + 槽账本,主视觉由"登记簿的参考链指到了谁"决定
 *    (面板不按槽名猜),历史版本与拒收理由来自任务账本;
 *  · **不假装**:待填的格子显示"待填"而不是一张旧图/裂图;链上缺哪张、降级丢了什么,
 *    按接缝原话显示;
 *  · **拒收理由是人说的话**:填了才记(`via: human`),留空就是不记 —— 面板不替人编理由。
 */
import { useCallback, useEffect, useState } from 'react'
import type { DifferentialCellView, DifferentialGridView, GalfreeApi } from './api.ts'
import { Chip, Spinner } from './ui.tsx'
import s from './panel.module.css'

const STAMP_LABEL: Record<string, string> = {
  none: '未认可', pending: '待认可', approved: '已过审', stale: '待复审', missing: '未填',
}

export function DifferentialBoard({ api, hasProject, onChanged, onNotice }: {
  api: GalfreeApi
  hasProject: boolean
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [grid, setGrid] = useState<DifferentialGridView | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!hasProject) { setGrid(null); return }
    try {
      setGrid(await api.differentialGrid())
    } catch { setGrid(null) }
  }, [api, hasProject])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!hasProject) return
    let alive = true
    void (async () => {
      try {
        const channel = await api.imageChannel()
        if (!alive) return
        setModels(channel.models.map((entry) => entry.id))
        setModel((current) => (current === '' ? (channel.models[0]?.id ?? '') : current))
      } catch { /* 读不到渠道就少一个入口,网格照常显示 */ }
    })()
    return () => { alive = false }
  }, [api, hasProject])

  const fillCharacter = async (character: string): Promise<void> => {
    setBusy(`fill:${character}`)
    try {
      await api.characterDifferentials({ character, model, run: true })
      await load()
      await onChanged()
    } catch (error) {
      // 接缝的拒绝是可执行的指令(角色没登记 / 模型不在目录):原样说给人。
      onNotice('bad', `补全「${character}」的差分没执行:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  if (!hasProject) return null
  if (grid === null) return <div className={s.emptyHint}>正在读差分网格…</div>
  if (grid.characters.length === 0) {
    return (
      <div className={s.empty}>
        <div className={s.emptyTitle}>登记簿还是空的</div>
        <div className={s.emptyHint}>差分的根是「角色登记簿」:先在「角色视图」里登记角色(含参考链),这里才长得出网格。</div>
      </div>
    )
  }

  return (
    <>
      <div className={s.chips} style={{ marginBottom: 10, alignItems: 'center' }}>
        <span className={s.emptyHint}>出图模型</span>
        <select className={s.input} style={{ maxWidth: 220 }} value={model} onChange={(event) => setModel(event.target.value)} aria-label="差分出图用的模型">
          {models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <span className={s.emptyHint}>
          主视觉先出,表情/姿势差分会自动携登记簿的参考链 —— 跨批次保持一致靠它,不是靠重写一遍外观描述。
        </span>
      </div>

      {grid.characters.map((row) => {
        const missing = row.cells.filter((cell) => !cell.filled).length
        return (
          <div key={row.character} className={s.diffRow}>
            <div className={s.chips} style={{ alignItems: 'center', marginBottom: 8 }}>
              <span className={s.sceneLabel}>{row.name}</span>
              <Chip tone="quiet">{row.character}</Chip>
              {row.main === null
                ? <Chip tone="warn" title="登记簿的参考链没有指到任何一个槽的产物:差分没有锚">没有主视觉</Chip>
                : <Chip tone="ok" title="登记簿的参考链指到了它">主视觉:{row.main}</Chip>}
              <button
                type="button"
                className={`${s.button} ${s.primary} ${s.tiny}`}
                disabled={busy !== null || missing === 0 || model === ''}
                title={missing === 0 ? '这个角色的槽都填满了(不满意就逐格重 roll)' : `给这个角色 ${missing} 个待填槽各建一个任务并跑完`}
                onClick={() => void fillCharacter(row.character)}
              >
                {busy === `fill:${row.character}` ? <><Spinner /> 出图中…</> : `补全差分(${missing})`}
              </button>
            </div>

            <div className={s.emptyHint} style={{ marginBottom: 8 }}>
              参考链(差分的锚):
              {row.references.length === 0
                ? '(空 —— 差分只能靠 prompt 里的外观描述,跨批次一致性没有保障)'
                : row.references.map((reference) => (
                  <span key={reference.path} style={{ marginLeft: 8 }}>
                    <Chip
                      tone={reference.exists ? 'ok' : 'warn'}
                      title={reference.exists ? `${reference.path} 已在磁盘上` : `${reference.path} 还不存在:这张图没出之前,链带不上它`}
                    >
                      {reference.exists ? '有图' : '缺图'}
                    </Chip>
                    <span style={{ marginLeft: 4 }}>{reference.path}</span>
                    {reference.note === undefined ? null : <span className={s.emptyHint}>({reference.note})</span>}
                  </span>
                ))}
            </div>

            <div className={s.diffGrid}>
              {row.cells.map((cell) => (
                <CellCard key={cell.slot} api={api} cell={cell} onChanged={async () => { await load(); await onChanged() }} onNotice={onNotice} />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** 一格:缩略图 + 状态 + 版本谱系 + 重 roll(可带**人的拒收理由**)。 */
function CellCard({ api, cell, onChanged, onNotice }: {
  api: GalfreeApi
  cell: DifferentialCellView
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const reroll = async (): Promise<void> => {
    if (cell.taskId === undefined) return
    setBusy(true)
    try {
      await api.retryGenerationTask(cell.taskId, {
        // 留空 = 沿用原词(那是"再抽一次");拒收理由留空 = 不记理由(面板不替人编)。
        ...(prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      setPrompt('')
      setNote('')
      await onChanged()
    } catch (error) {
      onNotice('bad', `重 roll「${cell.slot}」没执行:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const rejections = cell.history.filter((entry) => entry.rejection !== undefined)

  return (
    <div className={s.diffCell}>
      {cell.filled
        ? <img className={s.diffThumb} src={api.assetUrl(cell.assetPath, cell.fingerprint)} alt={cell.slot} loading="lazy" />
        : <div className={`${s.diffThumb} ${s.diffThumbEmpty}`}>待填</div>}

      <div className={s.chips} style={{ gap: 4 }}>
        <Chip tone={cell.role === 'main' ? 'accent' : 'quiet'}>{cell.role === 'main' ? '主视觉' : '差分'}</Chip>
        <Chip tone={cell.filled ? 'ok' : 'warn'}>{cell.filled ? '已填' : '待填'}</Chip>
        <Chip tone={cell.stamp === 'approved' ? 'ok' : cell.stamp === 'stale' ? 'warn' : 'quiet'}>
          {STAMP_LABEL[cell.stamp] ?? cell.stamp}
        </Chip>
      </div>

      <div className={s.emptyHint} style={{ wordBreak: 'break-all' }}>{cell.slot}</div>

      {cell.degradation !== undefined ? (
        <div className={s.emptyHint} title={cell.degradation.message}>已降级:{cell.degradation.message}</div>
      ) : null}
      {cell.lastError !== undefined ? (
        <div className={s.emptyHint} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>上次失败:{cell.lastError}</div>
      ) : null}

      {cell.history.length > 0 ? (
        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : `历史(${cell.history.length})`}
        </button>
      ) : null}

      {open ? (
        <div className={s.emptyHint} style={{ fontFamily: 'ui-monospace, monospace' }}>
          {cell.history.map((entry) => (
            <div key={entry.n}>
              #{entry.n} {entry.outcome === 'ok' ? `${(entry.fingerprint ?? '').slice(0, 8)} 字节` : `失败:${entry.error ?? '未知'}`}
              {entry.replacedFingerprint === undefined ? '' : ` · 替换掉 ${entry.replacedFingerprint.slice(0, 8)}`}
              {entry.rejection === undefined ? '' : ` · 被打回:${entry.rejection.note}(${entry.rejection.via === 'human' ? '人' : 'agent'}记)`}
            </div>
          ))}
        </div>
      ) : null}

      {rejections.length > 0 && !open ? (
        <div className={s.emptyHint}>被打回过:{rejections.at(-1)!.rejection!.note}</div>
      ) : null}

      {cell.taskId !== undefined ? (
        <div className={s.form} style={{ marginTop: 4 }}>
          <input
            className={s.input}
            value={prompt}
            placeholder="重 roll 新词(留空 = 沿用原词)"
            onChange={(event) => setPrompt(event.target.value)}
            aria-label={`槽 ${cell.slot} 的新提示词`}
          />
          <input
            className={s.input}
            value={note}
            placeholder="这张为什么不行(拒收理由,留空 = 不记)"
            onChange={(event) => setNote(event.target.value)}
            aria-label={`槽 ${cell.slot} 的拒收理由`}
          />
          <button type="button" className={`${s.button} ${s.tiny}`} disabled={busy} onClick={() => void reroll()}>
            {busy ? <Spinner /> : '重 roll'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
