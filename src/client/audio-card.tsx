/**
 * 音频生成卡(T27 / ADR-0012):把**渠道处境 + 任务队列**摆到台面上。
 *
 * 为什么要有这一张:音乐与 TTS 都**按次计费**(TTS 更是按台词行),所以"点了会花几条请求"
 * 必须在点之前看得见。判断在 `audio-board.ts` 的纯函数里(可守卫),这里只渲染。
 */
import { useCallback, useEffect, useState } from 'react'
import { GalfreeApi } from './api.ts'
import type { AudioChannelView, AudioTaskView } from './api.ts'
import { Chip, Notice, Spinner, relativeTime } from './ui.tsx'
import { summarizeAudioBoard } from './audio-board.ts'
import s from './panel.module.css'

/** 任务状态 → 人话 + 颜色。 */
const STATE_LABEL: Record<AudioTaskView['state'], string> = {
  queued: '排队',
  running: '执行中',
  'awaiting-review': '待复审',
  failed: '失败',
}

export function AudioCard({ api, hasProject, onNotice }: {
  api: GalfreeApi
  hasProject: boolean
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [channel, setChannel] = useState<AudioChannelView | null>(null)
  const [tasks, setTasks] = useState<AudioTaskView[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (quiet = false) => {
    try {
      const next = await api.audioChannel()
      setChannel(next)
      setTasks(hasProject ? await api.audioTasks() : [])
    } catch (error) {
      // 读不到就如实降级(不画成"一个任务都没有")。
      setChannel(null)
      setTasks([])
      if (!quiet) onNotice('warn', `音频通道读不到:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [api, hasProject, onNotice])

  useEffect(() => { void refresh(true) }, [refresh])

  const summary = summarizeAudioBoard(
    channel === null ? null : {
      configured: channel.configured,
      apiKeyConfigured: channel.apiKeyConfigured,
      models: channel.models.map((model) => ({ id: model.id, purpose: model.purpose, capabilities: model.capabilities })),
    },
    tasks,
  )

  /** 跑队列:这一下会真发 `summary.queued` 条上游请求。 */
  const run = async (): Promise<void> => {
    const spend = summary.queued
    setBusy(true)
    try {
      const ran = await api.runAudioQueue()
      const failed = ran.filter((task) => task.state === 'failed').length
      if (failed > 0) {
        onNotice('warn', `跑了 ${ran.length} 条,其中 ${failed} 条失败(点开任务看上游原话)。`)
      } else {
        onNotice('warn', `跑了 ${ran.length} 条,都成了待复审 —— 听一遍再决定要不要重 roll。`)
      }
      await refresh()
    } catch (error) {
      onNotice('bad', `跑队列没成(${spend} 条没发出去):${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const reroll = async (task: AudioTaskView): Promise<void> => {
    setBusy(true)
    try {
      await api.retryAudioTask({ id: task.id, run: true })
      await refresh()
    } catch (error) {
      onNotice('bad', `重 roll 没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // ─── 语音批量清单(T29):不花上游额度的那条路 ─────────────────────
  //
  // 没有 TTS 渠道也能用:导出清单 → 交给任何"文本 → 音频文件"的工具 → 按 id 导回。
  // 「还欠 N 条」是这里唯一要看的数 —— 缺的那些在试玩里就是"这一句没声音"。
  const [voice, setVoice] = useState<{ rows: number; missingVoiceFiles: number } | null>(null)
  const [dropDir, setDropDir] = useState('')

  const loadVoice = useCallback(async (): Promise<void> => {
    if (!hasProject) { setVoice(null); return }
    try {
      const batch = await api.voiceBatch()
      setVoice({ rows: batch.rows, missingVoiceFiles: batch.missingVoiceFiles })
    } catch { setVoice(null) }
  }, [api, hasProject])

  useEffect(() => { void loadVoice() }, [loadVoice])

  /** 导出清单:直接塞进下载(浏览器存成文件),不经过剪贴板 —— 清单可能上百行。 */
  const exportBatch = async (): Promise<void> => {
    setBusy(true)
    try {
      const batch = await api.voiceBatch('csv')
      const blob = new Blob([batch.csv ?? ''], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'voice-batch.csv'
      anchor.click()
      URL.revokeObjectURL(url)
      onNotice('warn', `清单导出好了(${batch.rows} 行,还欠 ${batch.missingVoiceFiles} 条)。文件名就是 id,导回时照它命名。`)
    } catch (error) {
      onNotice('bad', `清单导出没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const importBatch = async (): Promise<void> => {
    if (dropDir.trim() === '') return
    setBusy(true)
    try {
      const report = await api.importVoiceFiles(dropDir.trim())
      const parts = [`收进 ${report.imported.length} 条`]
      if (report.missing.length > 0) parts.push(`还欠 ${report.missing.length} 条`)
      if (report.duplicates.length > 0) parts.push(`重复 ${report.duplicates.length} 个`)
      if (report.unknownFiles.length > 0) parts.push(`对不上 id 的 ${report.unknownFiles.length} 个`)
      onNotice(report.unknownFiles.length > 0 || report.missing.length > 0 ? 'warn' : 'warn', `导入完成:${parts.join('、')}。`)
      await loadVoice()
    } catch (error) {
      onNotice('bad', `导入没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={s.card} aria-label="音频生成" id="gf-audio-card" tabIndex={-1}>
      <div className={s.cardHead}>
        <span className={s.cardTitle}>音频生成</span>
        <span className={s.cardCount}>
          {channel?.configured === true
            ? `${channel.name ?? '已配渠道'} · ${channel.models.length} 个模型`
            : '没配渠道'}
        </span>
      </div>
      <div className={s.cardBody}>
        {loading ? (
          <div className={s.empty}><Spinner /> 正在读音频通道…</div>
        ) : (
          <>
            {/* **先说不为什么,再给按钮**(判断在纯函数里)。 */}
            {summary.blockedBy !== null ? <Notice tone="warn">{summary.blockedBy}</Notice> : null}

            <div className={s.chips} style={{ marginBottom: 10 }}>
              <Chip tone={summary.queued === 0 ? 'ok' : 'warn'} num={summary.queued} dot title="还排着队的任务数 —— 点「跑队列」会真发这么多条上游请求">排队</Chip>
              <Chip tone={summary.running === 0 ? 'ok' : 'warn'} num={summary.running} dot>执行中</Chip>
              <Chip tone={summary.awaitingReview === 0 ? 'ok' : 'warn'} num={summary.awaitingReview} dot title="出好了、等人听">待复审</Chip>
              <Chip tone={summary.failed === 0 ? 'ok' : 'bad'} num={summary.failed} dot title="失败留在账本里,重试是人的动作">失败</Chip>
              <button
                type="button"
                className={`${s.button} ${s.primary}`}
                disabled={busy || !summary.canRun}
                onClick={() => void run()}
                title={summary.canRun ? `会发出 ${summary.queued} 条上游请求` : (summary.blockedBy ?? '没有排队中的任务')}
              >
                {busy ? <><Spinner /> 跑着…</> : `跑队列${summary.queued > 0 ? `(${summary.queued} 条)` : ''}`}
              </button>
            </div>

            {tasks.length === 0 ? (              <div className={s.empty}>
                <div className={s.emptyTitle}>还没有音频生成任务</div>
                <div className={s.emptyHint}>
                  音乐与语音都从**任务**走:由 agent 建(galfree_* 工具)或在这里看队列。
                  任务出一条、落一次盘、进一次快照;试听在试玩里完成。
                </div>
              </div>
            ) : (
              <div>
                {tasks.slice(0, 20).map((task) => (
                  <div key={task.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '4px 0' }}>
                    <Chip tone={task.state === 'failed' ? 'bad' : task.state === 'awaiting-review' ? 'ok' : 'warn'} dot>
                      {STATE_LABEL[task.state]}
                    </Chip>
                    <span style={{ opacity: 0.75 }}>{task.purpose === 'voice' ? '语音' : '音乐'}</span>
                    <code>{task.outputPath}</code>
                    <span style={{ opacity: 0.6 }}>{task.model}</span>
                    {task.dialogueId !== null ? <span style={{ opacity: 0.6 }}>id {task.dialogueId}</span> : null}
                    <span style={{ opacity: 0.5 }}>{task.attempts.length} 次 · {relativeTime(task.updatedAt)}</span>
                    {task.state === 'failed' && task.lastError !== undefined ? (
                      <span style={{ color: 'var(--gf-bad, #c33)' }} title={task.lastError}>{task.lastError.slice(0, 60)}</span>
                    ) : null}
                    {task.attempts.length > 0 ? (
                      <button type="button" className={s.button} disabled={busy} onClick={() => void reroll(task)} title="改词再来一次(会真发一条上游请求)">
                        重 roll
                      </button>
                    ) : null}
                  </div>
                ))}
                {tasks.length > 20 ? <div style={{ opacity: 0.6, paddingTop: 6 }}>还有 {tasks.length - 20} 条,见账本 `.studio/audio-tasks.json`</div> : null}
              </div>
            )}

            {/*
              语音批量清单(T29):**没有 TTS 渠道也能把语音做出来**的那条路。
              导出清单 → 交给任何"文本 → 音频文件"的工具 → 按 id 导回。
              「还欠 N 条」是这里唯一要看的数:缺的那些在试玩里就是"这一句没声音"。
            */}
            {voice !== null && voice.rows > 0 ? (
              <div className={s.form} style={{ marginTop: 12, borderTop: '1px solid var(--gf-line, #333)', paddingTop: 10 }}>
                <div className={s.chips} style={{ marginBottom: 8 }}>
                  <Chip tone={voice.missingVoiceFiles === 0 ? 'ok' : 'warn'} num={voice.missingVoiceFiles} dot
                    title="还没生成语音的对白条数(清单里的 missing)">语音待生成</Chip>
                  <span className={s.emptyHint}>共 {voice.rows} 句对白 · 文件名就是 id(`&lt;id&gt;.ogg`)</span>
                </div>
                <label className={s.field}>
                  <span className={s.fieldLabel}>本地 TTS 产出目录(绝对路径;文件名 = id)</span>
                  <input className={s.input} placeholder="D:\\tts-out" value={dropDir}
                    onChange={(event) => setDropDir(event.target.value)} />
                </label>
                <button type="button" className={s.button} disabled={busy} onClick={() => void exportBatch()}
                  title="下载 CSV 清单(场景/行号/说话人/台词/id/目标文件名)—— 台词原文就在里面,交给任何文本转语音的工具即可">
                  {busy ? <Spinner /> : '导出清单'}
                </button>
                <button type="button" className={`${s.button} ${s.primary}`}
                  disabled={busy || dropDir.trim() === ''} onClick={() => void importBatch()}
                  title="按文件名认 id,经写网关收进 game/voice/;缺哪个、多哪个、对不上 id 的都会逐条报">
                  导回语音
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
