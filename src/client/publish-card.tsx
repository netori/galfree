/**
 * 发布卡(T18)—— 一键把项目打成可发行物(钉版 SDK 的 `build_dists`)。
 *
 * 三条纪律(与接缝同源,面板不自己判断):
 *  · **能不能发看推导板**:阻塞项(lint 错 / 素材缺 / 音频悬空 / SDK 未就绪)由接缝给,
 *    面板只渲染 —— 不在前端重算一遍规则;
 *  · **产物在源树之外**:面板把输出目录原样显示出来(路径可复制),并说明"项目里不会多出文件";
 *  · **不美化失败**:构建失败的日志原话显示出来;产物之后内容又变了就标"已陈旧"。
 */
import { useCallback, useEffect, useState } from 'react'
import type { GalfreeApi, PublishReadinessView } from './api.ts'
import { Chip, Notice, Spinner, relativeTime } from './ui.tsx'
import s from './panel.module.css'

export function PublishCard({ api, hasProject, onChanged, onNotice }: {
  api: GalfreeApi
  hasProject: boolean
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [readiness, setReadiness] = useState<PublishReadinessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 构建日志(失败时给人看上游原话;成功为空)。 */
  const [log, setLog] = useState<string | null>(null)
  /**
   * 要打哪些包(T18 票面:"PC(**可选 Android**)")。
   * Android 需要另装 Android SDK —— 打不出来时日志原话会显示出来,不吞。
   */
  const [packages, setPackages] = useState<string[]>(['pc'])

  const load = useCallback(async (): Promise<void> => {
    if (!hasProject) { setReadiness(null); return }
    try {
      setReadiness(await api.publishReadiness())
    } catch (loadError) {
      setReadiness(null)
      setError(`读不到发布状态:${loadError instanceof Error ? loadError.message : String(loadError)}`)
    }
  }, [api, hasProject])

  useEffect(() => { void load() }, [load])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setLog(null)
    try {      const report = await api.publish({ packages })
      setLog(report.run?.ok === false ? report.run.logTail : null)
      if (!report.ok) {
        // 被阻止 / 构建失败:如实说,不说"发布完成"。
        onNotice('warn', report.blockers.length > 0
          ? `发布被拦下:${report.blockers.map((blocker) => blocker.label).join(';')}`
          : '构建失败:看下方日志原文。')
      }
      await load()
      await onChanged()
    } catch (runError) {
      const code = (runError as { code?: string }).code
      setError(code === 'publish-unavailable'
        ? '这台宿主没有装配发布端口:装不上就老实说,不假装能出片。'
        : `发布没执行:${runError instanceof Error ? runError.message : String(runError)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!hasProject) return null
  const last = readiness?.last ?? null

  return (
    <section className={s.card} id="gf-publish-card" tabIndex={-1} aria-label="发布">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>发布</span>
        <span className={s.cardCount}>
          {last === null ? '还没发布过' : `${relativeTime(last.at)} · ${last.ok ? '成功' : '失败'}`}
        </span>
        <span className={s.cardOps}>
          <select
            className={s.input}
            style={{ maxWidth: 190 }}
            value={packages.join(',')}
            onChange={(event) => setPackages(event.target.value.split(','))}
            aria-label="要打哪些包"
          >
            <option value="pc">pc(Windows + Linux)</option>
            <option value="pc,android">pc + android(需 Android SDK)</option>
          </select>
          <button
            type="button"
            className={`${s.button} ${s.primary}`}
            disabled={busy || readiness === null || !readiness.ready}
            title={readiness !== null && !readiness.ready ? '前置没过:先按下面列出的缺项修' : '用钉版 SDK 打包(产物在项目之外)'}
            onClick={() => void run()}
          >
            {busy ? <><Spinner /> 构建中…</> : `一键发布(${packages.join('+')})`}
          </button>
        </span>
      </div>

      <div className={s.cardBody}>
        {readiness === null ? (
          <div className={s.empty}>没有激活项目,或项目目录已不在磁盘上。</div>
        ) : (
          <>
            <div className={s.chips} style={{ marginBottom: 8, alignItems: 'center' }}>
              {readiness.ready
                ? <Chip tone="ok">可以发布</Chip>
                : <Chip tone="bad" num={readiness.blockers.length}>前置未过</Chip>}
              <Chip tone="quiet" title={readiness.destination ?? undefined}>输出目录</Chip>
              <span className={s.emptyHint} style={{ wordBreak: 'break-all' }}>
                {readiness.destination ?? '(没有装配发布端口)'}
              </span>
            </div>

            {!readiness.ready ? (
              <div style={{ marginBottom: 8 }}>
                <Notice tone="warn">
                  前置还没过,**不会**开始构建(宁可不发,也不出一个缺素材的包):
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {readiness.blockers.map((blocker) => (
                      <li key={blocker.code}>
                        {blocker.label}
                        {blocker.detail === undefined ? null : <span className={s.emptyHint}>({blocker.detail})</span>}
                      </li>
                    ))}
                  </ul>
                </Notice>
              </div>
            ) : null}

            <div className={s.emptyHint} style={{ marginBottom: 8 }}>
              产物落在**项目源树之外**的输出目录里:项目目录一个字节都不多、不进 git 快照。
              平台上传与在线分发不做(那是 spec 的出范围项)——这一键只把可发行物放到磁盘上。
            </div>

            {last !== null ? (
              <div>
                <div className={s.chips} style={{ marginBottom: 6 }}>
                  <Chip tone={last.ok ? 'ok' : 'bad'}>{last.ok ? '上次构建成功' : '上次构建失败'}</Chip>
                  <Chip tone="quiet">{last.packages.join(' / ')}</Chip>
                  {last.stale ? <Chip tone="warn" title="产物之后项目内容又改了">产物已陈旧</Chip> : null}
                </div>
                {last.artifacts.length > 0 ? (
                  last.artifacts.map((artifact) => (
                    <div key={artifact.path} className={s.commitRow}>
                      <span className={s.sceneLabel} style={{ flex: 'none' }}>{artifact.name}</span>
                      <span className={s.sceneWhere} title={artifact.path} style={{ wordBreak: 'break-all' }}>{artifact.path}</span>
                      <span className={s.sceneStamp}><Chip tone="quiet">{Math.round(artifact.bytes / 1024 / 1024 * 10) / 10} MB</Chip></span>
                    </div>
                  ))
                ) : (
                  <div className={s.emptyHint}>{last.ok ? '(这次没有新产物)' : '这次没有产出任何文件'}</div>
                )}
              </div>
            ) : (
              <div className={s.empty}>
                <div className={s.emptyTitle}>还没发布过</div>
                <div className={s.emptyHint}>前置全绿时点上面的按钮:会用钉版 SDK 打出 pc 包(Windows + Linux)。</div>
              </div>
            )}

            {log !== null ? (
              <pre className={s.traceback} style={{ marginTop: 8 }}>{log}</pre>
            ) : null}
            {error !== null ? (
              <div style={{ marginTop: 8 }}><Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice></div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
