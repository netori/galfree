/**
 * 音频生成卡(T27 / ADR-0012)—— **音乐与语音各一张**。
 *
 * 为什么要两张:它们各自一条渠道(上游与协议不重叠),"点了会花几条请求"也必须分开看 ——
 * 音乐那张卡上的"排队 3 条"不该把语音的任务算进来(点它的「跑队列」也不会去跑语音)。
 * 判断在 `audio-board.ts` 的纯函数里(可守卫),这里只渲染。
 *
 * 两张卡共用这一个组件(`purpose` 决定标题与措辞);**语音那张**还多带一段
 * 「语音批量清单」—— 那是"没有 TTS 渠道也能把语音做出来"的那条不花额度的路。
 */
import { useCallback, useEffect, useState } from 'react'
import { GalfreeApi } from './api.ts'
import type { AudioChannelView, AudioTaskView, VoiceAnchorBoardView } from './api.ts'
import { Chip, Notice, Spinner, relativeTime } from './ui.tsx'
import { audioPurposeLabel, summarizeAudioBoard, summarizeVoiceAnchors, type AudioPurpose } from './audio-board.ts'
import s from './panel.module.css'

/** 任务状态 → 人话 + 颜色。 */
const STATE_LABEL: Record<AudioTaskView['state'], string> = {
  queued: '排队',
  running: '执行中',
  'awaiting-review': '待复审',
  failed: '失败',
}

/**
 * 把文本当文件给人下载(语音清单要交到本地 TTS 手上,光弹一句提示不够)。
 *
 * 用 Blob + 临时 `<a download>`:这是面板里唯一一处需要"给人一个文件"的地方,
 * 不值得为它引一套文件系统接缝;失败也不静默(调用方会收到异常并如实报)。
 */
function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function AudioCard({ purpose, api, hasProject, onNotice, onChanged }: {
  purpose: AudioPurpose
  api: GalfreeApi
  hasProject: boolean
  onNotice: (tone: 'bad' | 'warn', text: string) => void
  onChanged?: () => Promise<void> | void
}) {
  const label = audioPurposeLabel(purpose)
  const [channel, setChannel] = useState<AudioChannelView | null>(null)
  const [tasks, setTasks] = useState<AudioTaskView[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (quiet = false) => {
    try {
      const channels = await api.audioChannels()
      setChannel(channels[purpose])
      setTasks(hasProject ? await api.audioTasks(purpose) : [])
    } catch (error) {
      // 读不到就如实降级(不画成"一个任务都没有")。
      setChannel(null)
      setTasks([])
      if (!quiet) onNotice('warn', `${label.title}通道读不到:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [api, hasProject, onNotice, purpose, label.title])

  useEffect(() => { void refresh(true) }, [refresh])

  const summary = summarizeAudioBoard(
    purpose,
    channel === null ? null : {
      configured: channel.configured,
      apiKeyConfigured: channel.apiKeyConfigured,
      models: channel.models.map((model) => ({ id: model.id, purpose: model.purpose, capabilities: model.capabilities })),
    },
    tasks,
  )

  /** 跑队列:这一下会真发 `summary.queued` 条上游请求 —— **只跑本用途的**(接缝按 purpose 建队列)。 */
  const run = async (): Promise<void> => {
    const spend = summary.queued
    setBusy(true)
    try {
      const ran = await api.runAudioQueue(purpose)
      const failed = ran.filter((task) => task.state === 'failed').length
      if (failed > 0) {
        onNotice('warn', `跑了 ${ran.length} 条,其中 ${failed} 条失败(点开任务看上游原话)。`)
      } else {
        onNotice('warn', `跑了 ${ran.length} 条,都成了待复审 —— 听一遍再决定要不要重 roll。`)
      }
      await refresh()
      await onChanged?.()
    } catch (error) {
      onNotice('bad', `跑队列没成(${spend} 条没发出去):${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // ─── 新建任务(T33):与 agent 的 `galfree_generate_audio` 同一条写路 ────
  //
  // 面板这一半的意义:人不必先教会 agent 才能出一条曲子(ADR-0002:面板是人用的那半)。
  // **成本**在按钮上写着:勾了「立刻跑」= 这一下真发 1 条;不勾 = 入队,等「跑队列」一次看清条数。
  const [draft, setDraft] = useState({ outputPath: '', model: '', prompt: '', dialogueId: '', loop: false, run: false })

  const createTask = async (): Promise<void> => {
    setBusy(true)
    try {
      const task = await api.createAudioTask({
        outputPath: draft.outputPath.trim(),
        model: draft.model,
        prompt: draft.prompt,
        purpose,
        ...(draft.dialogueId.trim() === '' ? {} : { dialogueId: draft.dialogueId.trim() }),
        ...(purpose === 'music' ? { loop: draft.loop } : {}),
        run: draft.run,
      })
      if (task.state === 'failed') {
        onNotice('bad', `建了但没跑成:${task.lastError ?? '(看账本)'}`)
      } else if (task.state === 'queued') {
        onNotice('warn', `已入队:${task.outputPath} —— 点「跑队列」才会真发请求。`)
      } else {
        onNotice('warn', `跑完了:${task.outputPath} —— 试听在试玩里,认可靠人盖场景戳。`)
      }
      setDraft({ ...draft, outputPath: '', prompt: '' })
      await refresh()
      await onChanged?.()
    } catch (error) {
      // 接缝的拒绝是**可执行的指令**(没配渠道 / 模型不在目录 / 路径形状),原样显示。
      onNotice('bad', `建任务没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const reroll = async (task: AudioTaskView): Promise<void> => {
    setBusy(true)
    try {
      await api.retryAudioTask({ id: task.id, run: true })
      await refresh()
      await onChanged?.()
    } catch (error) {
      onNotice('bad', `重 roll 没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // ─── 声音锚(T32):**只有语音那张卡**带这一段 ─────────────────────────
  //
  // 这一票回答的是"每个角色怎么保持同一把嗓子":音色只由参考样本决定,而参考样本是
  // **服务端音色库里的文件名**(名字见「读音色库」,改在「角色视图」)。
  // 这里只显示处境:还有谁没有档案(那几句会听起来跟别人一样)、谁要的样本不在库里。
  const [anchors, setAnchors] = useState<VoiceAnchorBoardView | null>(null)

  const loadAnchors = useCallback(async (): Promise<void> => {
    if (!hasProject || purpose !== 'voice') { setAnchors(null); return }
    try {
      setAnchors(await api.voiceAnchors())
    } catch {
      setAnchors(null)
    }
  }, [api, hasProject, purpose])

  useEffect(() => { void loadAnchors() }, [loadAnchors])

  const anchorSummary = purpose === 'voice' ? summarizeVoiceAnchors(anchors) : null

  // ─── 语音批量清单(T29):**只有语音那张卡**带这一段 ─────────────────
  //
  // 没有 TTS 渠道也能用:导出清单 → 交给任何"文本 → 音频文件"的工具 → 按 id 导回。
  // 「还欠 N 条」是这里唯一要看的数 —— 缺的那些在试玩里就是"这一句没声音"。
  const [voice, setVoice] = useState<{ rows: number; missingVoiceFiles: number } | null>(null)
  const [dropDir, setDropDir] = useState('')

  const loadVoice = useCallback(async (): Promise<void> => {
    if (!hasProject || purpose !== 'voice') { setVoice(null); return }
    try {
      const batch = await api.voiceBatch()
      setVoice({ rows: batch.rows, missingVoiceFiles: batch.missingVoiceFiles })
    } catch {
      setVoice(null)
    }
  }, [api, hasProject, purpose])

  useEffect(() => { void loadVoice() }, [loadVoice])

  const exportVoice = async (): Promise<void> => {
    setBusy(true)
    try {
      const batch = await api.voiceBatch('csv')
      if (batch.csv === undefined || batch.csv === '') {
        onNotice('bad', '清单导出没拿到内容(看面板日志)。')
        return
      }
      // **真的把文件给出去**:CSV 里是台词原文 + id,而 id 就是文件名 ——
      // 那是"交给本地 TTS 批量跑"那条路唯一要的东西(只弹一句提示等于把这条路断了)。
      downloadText(batch.csv, 'voice-batch.csv')
      onNotice('warn', `清单导出了 ${batch.rows} 行(台词原文 + id):把它交给本地 TTS 批量跑,产物按 <id>.ogg 命名。`)
    } catch (error) {
      onNotice('bad', `导出清单没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const importVoice = async (): Promise<void> => {
    setBusy(true)
    try {
      const report = await api.importVoiceFiles(dropDir)
      onNotice(report.missing.length === 0 ? 'warn' : 'bad',
        `收进来 ${report.imported.length} 条;还欠 ${report.missing.length} 条`
        + `${report.duplicates.length > 0 ? `;重复 ${report.duplicates.length}` : ''}`
        + `${report.unknownFiles.length > 0 ? `;对不上 id 的 ${report.unknownFiles.length}` : ''}。`)
      await loadVoice()
      await onChanged?.()
    } catch (error) {
      onNotice('bad', `导回没成:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={s.card} aria-label={label.title} id={purpose === 'music' ? 'gf-audio-card' : 'gf-voice-card'} tabIndex={-1}>
      <div className={s.cardHead}>
        <span className={s.cardTitle}>{label.title}</span>
        <span className={s.cardCount}>
          {channel?.configured === true
            ? `${channel.name ?? '已配渠道'} · ${channel.models.length} 个模型`
            : `没配${label.title}渠道`}
        </span>
      </div>
      <div className={s.cardBody}>
        {loading ? (
          <div className={s.empty}><Spinner /> 正在读{label.title}通道…</div>
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

            {/* 声音锚处境(T32,只有语音这张卡):还差谁没有嗓子 —— 那几句会听起来跟别人一样。 */}
            {anchorSummary !== null && anchors !== null ? (
              <div className={s.chips} style={{ marginBottom: 10 }}>
                <Chip tone={anchorSummary.missing.length === 0 ? 'ok' : 'warn'} num={anchors.rows.length}
                  title="登记在册的角色数">
                  角色
                </Chip>
                <Chip tone={anchorSummary.complete ? 'ok' : 'warn'} num={anchors.withProfile} dot
                  title="有音色档案 = 建语音任务时会自动带上参考样本(同一把嗓子)">
                  有嗓子
                </Chip>
                <span className={s.emptyHint} style={{ flex: 1 }}>
                  {anchorSummary.warning ?? '每个角色都有自己的音色档案 —— 跨场跨批次都是同一把嗓子'}
                </span>
                <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => void loadAnchors()}>
                  刷新
                </button>
              </div>
            ) : null}

            {tasks.length === 0 ? (
              <div className={s.empty}>
                <div className={s.emptyTitle}>还没有{label.title}任务</div>
                <div className={s.emptyHint}>
                  {purpose === 'music'
                    ? '音乐从**任务**走:在下面「新建任务」建一条(或让 agent 用 galfree_generate_audio 建)。任务出一条、落一次盘、进一次快照;试听在试玩里完成。'
                    : '语音从**两条路**走:在下面「新建任务」建(或让 agent 建),或者走「语音批量清单」——后者不需要 TTS 渠道。'}
                </div>
              </div>
            ) : (
              <div>
                {tasks.slice(0, 20).map((task) => (
                  <div key={task.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '4px 0' }}>
                    <Chip tone={task.state === 'failed' ? 'bad' : task.state === 'awaiting-review' ? 'ok' : 'warn'} dot>
                      {STATE_LABEL[task.state]}
                    </Chip>
                    <code>{task.outputPath}</code>
                    <span style={{ opacity: 0.6 }}>{task.model}</span>
                    {task.dialogueId !== null ? <span style={{ opacity: 0.6 }}>id {task.dialogueId}</span> : null}
                    {/* **这条用的是哪段参考**(T32):同一把嗓子唯一可核对的那一栏。 */}
                    {task.voiceSample !== undefined ? (
                      <span title={`参考样本(服务端音色库里的文件名);角色 ${task.voiceId ?? '(未登记)'}`} style={{ opacity: 0.75 }}>
                        音色 <code>{task.voiceSample}</code>
                      </span>
                    ) : task.purpose === 'voice' ? (
                      <span style={{ color: 'var(--gf-warn, #a80)' }} title={task.degradation?.message ?? '这条没有音色档案'}>没有音色</span>
                    ) : null}
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

            {/* 「新建任务」(T33):面板这一半与 agent 的 `galfree_generate_audio` **同一条写路**
                —— 建出来的都是同一份账本里的一条,「跑队列(N 条)」把两边一起算。 */}
            <div className={s.form} style={{ marginTop: 12, borderTop: '1px solid var(--gf-line, #333)', paddingTop: 10 }}>
              <div className={s.chips} style={{ marginBottom: 8 }}>
                <span className={s.cardTitle} style={{ fontSize: 12 }}>新建任务</span>
                <span className={s.emptyHint} style={{ flex: 1 }}>
                  {purpose === 'music'
                    ? '制作指令写**风格/情绪/场景**(如"雨夜的天台,钢琴与弦乐,慢速");产物要落在 game/ 下,别处引擎找不到'
                    : '提示词写**要念的台词原文**;对话 id 给了就按它自动携音色档案(T32 的声音锚)'}
                </span>
              </div>
              <div className={s.chips} style={{ marginBottom: 6 }}>
                <input
                  className={s.input}
                  style={{ flex: 2, minWidth: 220 }}
                  value={draft.outputPath}
                  placeholder={purpose === 'music' ? 'game/audio/bgm/rain.ogg' : 'game/voice/<对话id>.ogg'}
                  onChange={(event) => setDraft({ ...draft, outputPath: event.target.value })}
                  aria-label={`${label.title}任务的目标路径`}
                />
                <select
                  className={s.input}
                  style={{ flex: 1, minWidth: 140 }}
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  aria-label={`${label.title}任务的模型`}
                >
                  <option value="">{channel === null || channel.models.length === 0 ? '(这条渠道没有模型)' : '选模型…'}</option>
                  {(channel?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.label ?? model.id}</option>
                  ))}
                </select>
                {purpose === 'voice' ? (
                  <input
                    className={s.input}
                    style={{ flex: 1, minWidth: 140 }}
                    value={draft.dialogueId}
                    placeholder="对话 id(可省)"
                    title="填了就按台词派生的说话人自动携音色档案;id 见下面的清单"
                    onChange={(event) => setDraft({ ...draft, dialogueId: event.target.value })}
                    aria-label="语音任务的对话 id"
                  />
                ) : null}
              </div>
              <div className={s.chips} style={{ marginBottom: 6 }}>
                <input
                  className={s.input}
                  style={{ flex: 3, minWidth: 240 }}
                  value={draft.prompt}
                  placeholder={purpose === 'music' ? '雨夜的天台,钢琴与弦乐,慢速' : '这句台词原文'}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                  aria-label={`${label.title}任务的提示词`}
                />
                {purpose === 'music' ? (
                  <label className={s.emptyHint} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={draft.loop} onChange={(event) => setDraft({ ...draft, loop: event.target.checked })} />
                    循环
                  </label>
                ) : null}
                <label className={s.emptyHint} style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  title="立刻跑 = 这一下真发一条上游请求(音乐最贵)">
                  <input type="checkbox" checked={draft.run} onChange={(event) => setDraft({ ...draft, run: event.target.checked })} />
                  立刻跑
                </label>
                <button
                  type="button"
                  className={`${s.button} ${s.primary}`}
                  disabled={busy || draft.outputPath.trim() === '' || draft.model === '' || draft.prompt.trim() === ''}
                  onClick={() => void createTask()}
                  title={draft.run ? '建完立刻跑:会真发 1 条上游请求' : '只入队,等下面「跑队列」'}
                >
                  {busy ? <Spinner /> : draft.run ? '建并跑(1 条请求)' : '建任务(入队)'}
                </button>
              </div>
              <span className={s.formHint} style={{ flexBasis: '100%' }}>
                建出来的是**同一份账本**里的一条(与 agent 用 galfree_generate_audio 建的没有区别)——
                下面那颗「跑队列」会真发**本卡排队中的全部**请求,点之前先看清条数。
              </span>
            </div>

            {purpose === 'voice' && voice !== null && voice.rows > 0 ? (
              <div className={s.form} style={{ marginTop: 12, borderTop: '1px solid var(--gf-line, #333)', paddingTop: 10 }}>
                <div className={s.chips} style={{ marginBottom: 8 }}>
                  <Chip tone={voice.missingVoiceFiles === 0 ? 'ok' : 'warn'} num={voice.missingVoiceFiles} dot title="按 dialogue id 数出来的还缺几份语音文件">
                    待生成
                  </Chip>
                  <span className={s.emptyHint} style={{ flex: 1 }}>
                    清单 {voice.rows} 行 · id **就是文件名**(`game/voice/&lt;id&gt;.ogg`,与 `config.auto_voice` 同口径)
                  </span>
                  <button type="button" className={s.button} disabled={busy} onClick={() => void exportVoice()}>
                    导出清单(CSV)
                  </button>
                </div>
                <div className={s.chips} style={{ alignItems: 'center' }}>
                  <input
                    className={s.input}
                    style={{ flex: 1 }}
                    value={dropDir}
                    placeholder="本地 TTS 产物的绝对目录(文件名 = id)"
                    onChange={(event) => setDropDir(event.target.value)}
                    aria-label="语音导回目录"
                  />
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={busy || dropDir.trim() === ''} onClick={() => void importVoice()}>
                    导回语音
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
