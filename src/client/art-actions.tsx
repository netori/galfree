/**
 * 素材板的**出图动作面**(T15)—— 生成此槽 / 补全全部待填 / 只重 roll 该槽。
 *
 * 三条纪律(与接缝同源,面板不自己判断):
 *  - **进度是推出来的**:任务状态读的是接缝的任务账本(`/tasks`),不是面板自己的账;
 *  - **不假装**:没配渠道、模型没选、槽对不上,都按接缝的原话显示出来;
 *  - **重 roll 保留历史**:每个任务都能展开看它的尝试历史(含被替换掉的那一版的指纹)。
 */
import { useCallback, useEffect, useState } from 'react'
import type { GalfreeApi, GenerationTaskView, ImageChannelView } from './api.ts'
import { Chip, Spinner } from './ui.tsx'
import s from './panel.module.css'

const STATE_LABEL: Record<string, string> = {
  queued: '排队中', running: '出图中', 'awaiting-review': '待复审', failed: '失败',
}

/** 任务状态徽标:出图进度在板上是一枚徽标,不是一个数字。 */
export function StateChip({ state }: { state: string }) {
  const tone = state === 'awaiting-review' ? 'ok' : state === 'failed' ? 'bad' : 'warn'
  return <Chip tone={tone}>{STATE_LABEL[state] ?? state}</Chip>
}

/** 一次尝试的摘要:成功看指纹,失败看原因(原文,不美化)。 */
function attemptSummary(attempt: GenerationTaskView['attempts'][number]): string {
  if (attempt.outcome === 'failed') return `#${attempt.n} 失败:${attempt.error ?? '未知原因'}`
  const head = `#${attempt.n} 成功 · ${attempt.bytes ?? 0} 字节 · ${(attempt.fingerprint ?? '').slice(0, 8)}`
  return attempt.replacedFingerprint === undefined ? head : `${head} · 替换掉 ${attempt.replacedFingerprint.slice(0, 8)}`
}

/** 出图工具栏:选模型 + 补全全部待填 + 进度概览。 */
export function ArtToolbar({ api, hasProject, missingCount, onChanged, onNotice }: {
  api: GalfreeApi
  hasProject: boolean
  missingCount: number
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [channel, setChannel] = useState<ImageChannelView | null>(null)
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!hasProject) { setChannel(null); return }
    let alive = true
    void (async () => {
      try {
        const next = await api.imageChannel()
        if (!alive) return
        setChannel(next)
        // 默认选第一个模型(省一步点击);人改过就听人的。
        setModel((current) => (current === '' ? (next.models[0]?.id ?? '') : current))
      } catch { if (alive) setChannel(null) }
    })()
    return () => { alive = false }
  }, [api, hasProject])

  const fillAll = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.fillMissingSlots({ model, run: true })
      const failed = result.tasks.filter((task) => task.state === 'failed')
      if (failed.length > 0) {
        onNotice('warn', `${result.tasks.length} 个槽跑完,其中 ${failed.length} 个失败(板上可看原因)。`)
      }
      await onChanged()
    } catch (error) {
      // 接缝的拒绝是**可执行的指令**(先配渠道 / 模型不在目录里),原样说给人。
      onNotice('bad', `补全待填没执行:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [api, model, onChanged, onNotice])

  if (!hasProject) return null

  if (channel === null || !channel.configured) {
    return (
      <div className={s.emptyHint} style={{ marginBottom: 10 }}>
        {channel === null
          ? '正在读渠道…'
          : '还没配置图像渠道 —— 到「设置 → GALFree」填端点与密钥、点「获取模型」勾选模型,回来就能出图。缺渠道时这里会如实拒绝,不会假装能出。'}
      </div>
    )
  }
  if (channel.models.length === 0) {
    return (
      <div className={s.emptyHint} style={{ marginBottom: 10 }}>
        渠道配了,但模型目录是空的 —— 到「设置 → GALFree」点「获取模型」勾一个,这里才有可用的模型。
      </div>
    )
  }

  return (
    <div className={s.chips} style={{ marginBottom: 10, alignItems: 'center' }}>
      <span className={s.emptyHint}>模型</span>
      <select className={s.input} style={{ maxWidth: 220 }} value={model} onChange={(event) => setModel(event.target.value)} aria-label="出图用的模型">
        {channel.models.map((entry) => (
          <option key={entry.id} value={entry.id}>{entry.label === undefined ? entry.id : `${entry.label}(${entry.id})`}</option>
        ))}
      </select>
      <button
        type="button"
        className={`${s.button} ${s.primary}`}
        disabled={busy || model === '' || missingCount === 0}
        title={missingCount === 0 ? '没有待填的槽' : `给板上 ${missingCount} 个待填槽各建一个任务并跑完`}
        onClick={() => void fillAll()}
      >
        {busy ? <><Spinner /> 出图中…</> : `补全全部待填(${missingCount})`}
      </button>
      {missingCount === 0 ? <span className={s.emptyHint}>没有待填的槽</span> : null}
    </div>
  )
}

/** 一个槽的出图动作:生成 / 重 roll + 任务进度 + 重试历史。 */
export function SlotArtActions({ slot, task, api, disabled, onChanged, onNotice }: {
  slot: string
  task: GenerationTaskView | undefined
  api: GalfreeApi
  disabled: boolean
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [openHistory, setOpenHistory] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const channel = await api.imageChannel()
        if (!alive) return
        setModels(channel.models.map((entry) => entry.id))
        setModel((current) => (current === '' ? (channel.models[0]?.id ?? '') : current))
      } catch { /* 渠道读不到就少一个入口,面板照常工作 */ }
    })()
    return () => { alive = false }
  }, [api])

  const run = async (kind: 'create' | 'reroll'): Promise<void> => {
    setBusy(true)
    try {
      if (kind === 'create') {
        await api.createGenerationTask({ slot, model, prompt: prompt.trim() === '' ? `${slot} 的素材` : prompt.trim(), run: true })
      } else if (task !== undefined) {
        // 改词重 roll:填了就换词,空着就沿用原词(那是"再抽一次")。
        await api.retryGenerationTask(task.id, prompt.trim() === '' ? {} : { prompt: prompt.trim() })
      }
      await onChanged()
    } catch (error) {
      onNotice('bad', `${kind === 'create' ? '生成' : '重 roll'}「${slot}」没执行:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const canCreate = models.length > 0 && model !== '' && task === undefined
  const canReroll = task !== undefined

  return (
    <div className={s.form} style={{ marginTop: 8 }}>
      <div className={s.chips} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {task !== undefined ? <StateChip state={task.state} /> : null}
        {task?.degradation !== undefined ? (
          <Chip tone="warn" title={task.degradation.message}>已降级</Chip>
        ) : null}
        <input
          className={s.input}
          style={{ maxWidth: 300 }}
          value={prompt}
          placeholder={task === undefined ? '给上游的制作指令(留空按槽名凑一句)' : '重 roll 的新词(留空 = 沿用原词)'}
          onChange={(event) => setPrompt(event.target.value)}
          aria-label={`槽 ${slot} 的出图提示词`}
        />
        {models.length > 1 && task === undefined ? (
          <select className={s.input} style={{ maxWidth: 180 }} value={model} onChange={(event) => setModel(event.target.value)} aria-label={`槽 ${slot} 用的模型`}>
            {models.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        ) : null}
        {canCreate ? (
          <button type="button" className={`${s.button} ${s.primary}`} disabled={busy || disabled} onClick={() => void run('create')}>
            {busy ? <Spinner /> : '生成此槽'}
          </button>
        ) : null}
        {canReroll ? (
          <button type="button" className={s.button} disabled={busy || disabled} onClick={() => void run('reroll')}>
            {busy ? <Spinner /> : '重 roll'}
          </button>
        ) : null}
        {task !== undefined && task.attempts.length > 0 ? (
          <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} aria-expanded={openHistory} onClick={() => setOpenHistory(!openHistory)}>
            {openHistory ? '收起历史' : `历史(${task.attempts.length})`}
          </button>
        ) : null}
      </div>

      {task?.degradation !== undefined ? (
        <div className={s.emptyHint} style={{ marginTop: 4 }}>{task.degradation.message}</div>
      ) : null}
      {task?.lastError !== undefined ? (
        <div className={s.emptyHint} style={{ marginTop: 4, color: 'var(--dsw-alias-state-error-primary)' }}>
          上次失败:{task.lastError}
        </div>
      ) : null}

      {openHistory && task !== undefined ? (
        <div className={s.commitRow} style={{ marginTop: 6, display: 'block' }}>
          <div className={s.emptyHint} style={{ marginBottom: 4 }}>
            重试历史(只追加)。被替换掉的上一版留在写批前的快照里:拿指纹去「文件 → 快照历史」能找回那一版。
          </div>
          {task.attempts.map((attempt) => (
            <div key={attempt.n} className={s.emptyHint} style={{ fontFamily: 'ui-monospace, monospace' }}>
              {attemptSummary(attempt)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
