/** 钉版 SDK 供给卡:状态 + 首次下载进度;下载中不重复触发。 */
import type { SdkView } from './types.ts'
import { Chip, Notice, Spinner } from './ui.tsx'
import s from './panel.module.css'
export function SdkCard({ sdk, ensuring, onEnsure }: {
  sdk: SdkView | null
  ensuring: boolean
  onEnsure: () => void
}) {
  const fraction = sdk?.provision.progress.fraction ?? 0
  const busy = sdk !== null && (sdk.provision.state === 'downloading' || sdk.provision.state === 'extracting')

  return (
    <section className={s.card} aria-label="钉版 SDK">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>钉版 SDK</span>
        <span className={s.cardCount}>试玩与真 lint 都用它;发版钉死版本(ADR-0006)</span>
        <span className={s.cardOps}>
          {sdk === null ? null : sdk.launcherReady ? (
            <Chip tone="ok" dot>{sdk.requested === 'override' ? '就绪 · 覆盖路径' : '就绪 · 钉版目录'}</Chip>
          ) : (
            <Chip tone={sdk.provision.state === 'failed' ? 'bad' : 'warn'} dot>{sdk.provision.state}</Chip>
          )}
        </span>
      </div>
      <div className={s.cardBody}>
        {sdk === null ? (
          <div className={s.empty}>读不到供给状态。</div>
        ) : (
          <>
            <div className={s.rootPath}>{sdk.dir}</div>
            {sdk.mismatch !== undefined ? (
              <div style={{ marginTop: 8 }}>
                <Chip tone="warn" title="覆盖路径的版本与钉版不一致:方言差异按警告处理,不阻塞">
                  方言差异:实际 {sdk.mismatch.actual} ≠ 钉版 {sdk.mismatch.pinned}
                </Chip>
              </div>
            ) : null}
            {sdk.version !== undefined ? <div className={s.rootPath}>版本 {sdk.version}</div> : null}
            {!sdk.launcherReady ? (
              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className={s.button} disabled={busy || ensuring} onClick={onEnsure}>
                  {ensuring || busy ? <><Spinner /> 下载中…</> : sdk.provision.state === 'failed' ? '重试下载' : '下载 SDK'}
                </button>
                <span className={s.emptyHint}>
                  {sdk.provision.progress.message ?? (busy ? '正在下载钉版 SDK…' : '首次试玩前需要下载(约 155MB)')}
                  {fraction > 0 && fraction < 1 ? ` · ${Math.round(fraction * 100)}%` : ''}
                </span>
              </div>
            ) : null}
            {fraction > 0 && fraction < 1 ? (
              <div className={s.meter}><div className={s.meterFill} style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
            ) : null}
            {sdk.provision.error !== undefined ? (
              <div style={{ marginTop: 8 }}><Notice tone="bad">{sdk.provision.error}</Notice></div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
