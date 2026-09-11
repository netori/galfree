/**
 * 工作台的小件:状态标记、印章、提示条、diff 视图。
 * 全部只消费宿主主题令牌(var(--gf-*)),不写内联颜色 —— 深浅主题自动跟随。
 */
import type { ReactNode } from 'react'
import s from './panel.module.css'

export type Tone = 'ok' | 'warn' | 'bad' | 'quiet' | 'accent' | 'none'

const TONE_CLASS: Record<Tone, string | undefined> = {
  ok: s.ok,
  warn: s.warn,
  bad: s.bad,
  quiet: s.quiet,
  accent: s.accent,
  none: undefined,
}

/** 一行状态标记:`label` 后接一个等宽数字,数字用 chipNum 对齐。 */
export function Chip({ tone = 'none', num, dot = false, title, children }: {
  tone?: Tone
  num?: ReactNode
  dot?: boolean
  title?: string
  children: ReactNode
}) {
  return (
    <span className={[s.chip, TONE_CLASS[tone]].filter(Boolean).join(' ')} title={title}>
      {dot ? <span className={s.chipDot} /> : null}
      <span>{children}</span>
      {num !== undefined ? <span className={s.chipNum}>{num}</span> : null}
    </span>
  )
}

/**
 * 审读戳 = 印章。approved 是朱砂实印(人已认可),stale 是虚线待重盖
 * (内容已变,ADR-0008),pending 是空位(还没盖过)。
 */
export function Seal({ state, pendingLabel = '待审读' }: { state: 'approved' | 'stale' | 'pending' | 'none' | 'missing'; pendingLabel?: string }) {
  if (state === 'approved') {
    return <span className={s.seal} title="人已盖审读戳,且内容未再变动"><span className={s.sealGlyph}>印</span>已审读</span>
  }
  if (state === 'stale') {
    return <span className={[s.seal, s.sealStale].join(' ')} title="盖过戳,但内容已变 → 需人重新审读"><span className={s.sealGlyph}>印</span>待复审</span>
  }
  return <span className={[s.seal, s.sealPending].join(' ')} title="没有人盖上审读戳"><span className={s.sealGlyph}>印</span>{pendingLabel}</span>
}

export function Spinner() {
  return <span className={s.spinner} aria-hidden="true" />
}

/** 顶部提示条:错误/警告如实呈现,可关闭。 */
export function Notice({ tone, children, onDismiss }: { tone: 'bad' | 'warn'; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={[s.notice, tone === 'bad' ? s.noticeBad : s.noticeWarn].join(' ')} role={tone === 'bad' ? 'alert' : 'status'}>
      <span className={s.noticeText}>{children}</span>
      {onDismiss !== undefined ? (
        <button type="button" className={s.noticeDismiss} onClick={onDismiss} aria-label="关闭提示">✕</button>
      ) : null}
    </div>
  )
}

/** 简易 diff 着色:+/− 行、@@ 块头、diff/index 元信息各归其色。 */
export function DiffView({ text, maxChars = 60_000 }: { text: string; maxChars?: number }) {
  if (text.trim() === '') return <div className={s.empty}>(无差异内容)</div>
  const truncated = text.length > maxChars
  const lines = (truncated ? text.slice(0, maxChars) : text).split('\n')
  return (
    <pre className={s.diff}>
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? s.diffAdd
          : line.startsWith('-') && !line.startsWith('---') ? s.diffDel
          : line.startsWith('@@') ? s.diffHunk
          : /^(diff|index|---|\+\+\+)\b/.test(line) ? s.diffMeta
          : undefined
        return <div key={i} className={cls}>{line === '' ? '\u00a0' : line}</div>
      })}
      {truncated ? <div className={s.diffMeta}>…(内容过长,已截断)</div> : null}
    </pre>
  )
}

/** 相对时间:今天 → "14:03";更早 → "3天前" / 日期。 */
export function relativeTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso
  const diffMs = Date.now() - then.getTime()
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return then.toLocaleDateString()
}
