/**
 * 界面换皮卡(T31 / #39)—— 给 Ren'Py **自带的界面生成器**一组参数。
 *
 * 三条纪律(与接缝同源,面板不自己判断):
 *  · **这不是 AI 出图**:`game/gui/*.png` 那一整套是引擎按九宫格模板画的,所以入口是
 *    "主色 / 辅色 / 明暗 / 分辨率"四个参数,面板给的就是这四个;
 *  · **整套替换要如实说清**(AC 要求):要动多少文件读的是接缝的 `previewTheme`
 *    (面板不自己数),换之前放在按钮旁边;
 *  · **好不好看只有人能说**:换完只提示"跑一次试玩看一眼",不替人拍板。
 */
import { useCallback, useEffect, useState } from 'react'
import type { GalfreeApi, ThemePaletteView, ThemeSpecInput, ThemeView } from './api.ts'
import { Chip, Notice, Spinner, relativeTime } from './ui.tsx'
import s from './panel.module.css'

/**
 * 几套现成的配色(不是"预设主题"的数据库,而是**给个起点**):人点一下就填进输入框,
 * 之后照样能改。值都取自引擎那套推导的常见搭配。
 */
const PRESETS: Array<{ name: string; accent: string; boring: string; light: boolean }> = [
  { name: '雨夜(青)', accent: '#00b8c3', boring: '#000000', light: false },
  { name: '薄暮(粉)', accent: '#c94f7c', boring: '#1b1b22', light: false },
  { name: '苔绿', accent: '#2e7d5b', boring: '#10161a', light: false },
  { name: '暖阳(亮)', accent: '#c2703f', boring: '#f2ece2', light: true },
]

export function ThemeCard({ api, hasProject, onChanged, onNotice }: {
  api: GalfreeApi
  hasProject: boolean
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [view, setView] = useState<ThemeView | null>(null)
  const [accent, setAccent] = useState('#00b8c3')
  const [boring, setBoring] = useState('#000000')
  const [light, setLight] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 预演结果(要动多少)—— 换之前摆给人看。 */
  const [plan, setPlan] = useState<{ images: number; extraWrites: number; added: number; replaced: number; removed: string[] } | null>(null)

  /**
   * 分辨率**永远跟着项目走**(那是 `gui.rpy` 里 `gui.init` 说了算的真相)。
   *
   * 为什么不让人在这里选:整套界面图是按它缩放的,选错了引擎**不报错**、只是画面歪;
   * 而"改项目分辨率"是另一件事(要重排 `gui.scale` 那一整套)。所以这里只做两件事 ——
   * 把当前分辨率**原样带上**(不带的话接缝会按基准 1280×720 兜底,1080p 项目直接吃拒绝),
   * 以及把"现在是多少"显示给人看。
   */
  const currentSpec = (): ThemeSpecInput => ({
    accent,
    boring,
    light,
    ...(view === null ? {} : { width: view.resolution.width, height: view.resolution.height }),
  })

  const load = useCallback(async (): Promise<void> => {
    if (!hasProject) { setView(null); return }
    try {
      const next = await api.theme()
      setView(next)
      // 已经换过皮:输入框跟着现状走(人打开面板看到的就是"现在这一套")。
      if (next.applied !== null) {
        setAccent(next.applied.accent)
        setBoring(next.applied.boring)
        setLight(next.applied.light)
      }
    } catch (loadError) {
      setView(null)
      setError(`读不到主题状态:${loadError instanceof Error ? loadError.message : String(loadError)}`)
    }
  }, [api, hasProject])

  useEffect(() => { void load() }, [load])

  // 参数一改就作废上一次预演 —— 留着旧的数字比没有还坏(那说的不是这一套)。
  useEffect(() => { setPlan(null) }, [accent, boring, light])

  const preview = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPlan(await api.previewTheme(currentSpec()))
    } catch (previewError) {
      setPlan(null)
      setError(themeErrorText(previewError, '预演没成'))
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const report = await api.applyTheme(currentSpec())
      onNotice('warn', `换皮完成:${report.images} 张界面图 + 颜色 define,同一条快照(#${report.batchId})。请人跑一次试玩看一眼 —— 好不好看只有人能说。`)
      setPlan(null)
      await load()
      await onChanged()
    } catch (applyError) {
      setError(themeErrorText(applyError, '换皮没成'))
    } finally {
      setBusy(false)
    }
  }

  if (!hasProject) return null
  const palette = view?.palette ?? null

  return (
    <section className={s.card} id="gf-theme-card" tabIndex={-1} aria-label="界面换皮">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>界面换皮</span>
        <span className={s.cardCount}>
          {view === null ? '—' : view.appliedAt === null ? '生成器默认那套' : `换于 ${relativeTime(view.appliedAt)}`}
        </span>
        <span className={s.cardOps}>
          <button type="button" className={s.button} disabled={busy} onClick={() => void preview()}>
            预演(要动多少)
          </button>
          <button
            type="button"
            className={`${s.button} ${s.primary}`}
            disabled={busy}
            title="跑一次钉版 SDK 的界面生成器,把整套界面图经写网关写进项目(一条快照,可回滚)"
            onClick={() => void apply()}
          >
            {busy ? <><Spinner /> 换皮中…</> : '换皮'}
          </button>
        </span>
      </div>

      <div className={s.cardBody}>
        <div className={s.chips} style={{ marginBottom: 8, alignItems: 'center' }}>
          <Chip tone={view?.applied === null ? 'quiet' : 'ok'}>{view?.label ?? '读取中…'}</Chip>
          {view?.stale === true ? (
            <Chip tone="warn" title="记录的分辨率与项目现在的不一致:整套图是按旧尺寸出的">要按新分辨率重出</Chip>
          ) : null}
          {/* 分辨率只读显示:界面图整套按它缩放,而**改项目分辨率是另一件事**
              (要重排 gui.scale 那一整套)—— 所以这里只把它带上、说清是多少。 */}
          <Chip tone="quiet" title="整套界面图是按这个分辨率缩放出来的(改它要动 gui.rpy 里那一整套 gui.scale)">
            {view === null ? '分辨率读取中…' : `${view.resolution.width}×${view.resolution.height}`}
          </Chip>
        </div>

        <div className={s.chips} style={{ marginBottom: 8, alignItems: 'center' }}>
          <span className={s.emptyHint} style={{ flex: 'none' }}>主色</span>
          <input
            className={s.input}
            style={{ maxWidth: 110 }}
            value={accent}
            onChange={(event) => setAccent(event.target.value)}
            aria-label="主色(accent)"
          />
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#00b8c3'}
            onChange={(event) => setAccent(event.target.value)}
            aria-label="挑一个主色"
            style={{ width: 36, height: 26, padding: 0, border: 'none', background: 'none' }}
          />
          <span className={s.emptyHint} style={{ flex: 'none' }}>辅色</span>
          <input
            className={s.input}
            style={{ maxWidth: 110 }}
            value={boring}
            onChange={(event) => setBoring(event.target.value)}
            aria-label="辅色(boring,文本框与底衬那一族)"
          />
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(boring) ? boring : '#000000'}
            onChange={(event) => setBoring(event.target.value)}
            aria-label="挑一个辅色"
            style={{ width: 36, height: 26, padding: 0, border: 'none', background: 'none' }}
          />
          <label className={s.emptyHint} style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
            <input type="checkbox" checked={light} onChange={(event) => setLight(event.target.checked)} />
            亮色主题
          </label>
        </div>

        <div className={s.chips} style={{ marginBottom: 8, alignItems: 'center' }}>
          <span className={s.emptyHint} style={{ flex: 'none' }}>现成配色</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={s.button}
              style={{ borderLeft: `4px solid ${preset.accent}` }}
              title={`${preset.accent} / 辅色 ${preset.boring}${preset.light ? ' / 亮色' : ''}`}
              onClick={() => { setAccent(preset.accent); setBoring(preset.boring); setLight(preset.light) }}
            >
              {preset.name}
            </button>
          ))}
        </div>

        {palette !== null ? <PaletteStrip palette={palette} /> : null}

        {plan !== null ? (
          <div style={{ marginTop: 8 }}>
            <Notice tone={plan.removed.length > 0 ? 'warn' : 'bad'}>
              <strong>整套替换</strong>:这一下要写 {plan.images} 张界面图({plan.replaced} 张覆盖 + {plan.added} 张新增),
              另加 {plan.extraWrites} 份(`gui.rpy` 的颜色 define 与 `.studio/theme.json`)
              {plan.removed.length === 0 ? '' : `,并删掉 ${plan.removed.length} 个旧图(${plan.removed.slice(0, 6).join('、')}${plan.removed.length > 6 ? ' …' : ''})`}
              。同一条快照,可回滚 —— 但<strong>界面会整体换一副样子</strong>。
            </Notice>
          </div>
        ) : null}

        <div className={s.emptyHint} style={{ marginTop: 8 }}>
          游戏内界面<strong>不是 AI 出的图</strong>:那一整套(`game/gui/`,五十来张)是 Ren'Py 自带的界面生成器
          按九宫格模板画的,所以这里给的是参数(主色 / 辅色 / 明暗)。
          分辨率取项目当前那个(上面那颗 chip)—— 整套图按它缩放,对不上会被如实拒绝。
          <br />
          封面 / 主菜单背景 / 窗口图标是<strong>例外</strong>:生成器不覆盖那三张,走上面「封面」那一段。
          <br />
          换完请人跑一次试玩看一眼 —— <strong>好不好看只有人能说</strong>。
        </div>

        {error !== null ? (
          <div style={{ marginTop: 8 }}><Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice></div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * 接缝抛的错码 → 人看得懂的一句话。
 *
 * 面板**不自己复述规则**(比如"分辨率要跟项目一致"),只把接缝那句话端出来 ——
 * 规则活两份的话,迟早有一份会与接缝分叉。
 */
function themeErrorText(error: unknown, fallback: string): string {
  const code = (error as { code?: string }).code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'theme-unavailable') return '这台宿主没有装配界面生成器端口:换皮跑不了(不假装换好了)。'
  // 分辨率对不上时把接缝的原话端出来 —— 它已经说清了"要么按项目分辨率、要么先改项目分辨率"。
  if (code === 'theme-resolution-mismatch') return message
  if (code === 'sdk-not-ready') return `${message}`
  return `${fallback}:${message}`
}

/** 那一整套颜色(引擎会写进 `gui.rpy` 的 define 就是这些)。 */
function PaletteStrip({ palette }: { palette: ThemePaletteView }) {
  const swatches: Array<[string, string]> = [
    ['主色', palette.accent], ['hover', palette.hover], ['muted', palette.muted],
    ['hover muted', palette.hoverMuted], ['标题', palette.title], ['菜单底', palette.menu],
    ['正文', palette.text], ['选项', palette.choice],
  ]
  return (
    <div className={s.chips} style={{ marginBottom: 4, alignItems: 'center' }}>
      {swatches.map(([name, value]) => (
        <span
          key={name}
          className={s.emptyHint}
          title={`${name} ${value}`}
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}
        >
          <span style={{
            display: 'inline-block', width: 14, height: 14, borderRadius: 3,
            background: value, border: '1px solid rgba(0,0,0,.25)',
          }} />
          {name}
        </span>
      ))}
    </div>
  )
}
