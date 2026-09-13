/**
 * 音频渠道的**模型选择器**(T27 续,2026-09-13)—— 与图像那条同一套路数。
 *
 * 为什么把这份界面单独写一份而不是硬塞进图像那个:`ModelPicker` 里有几处是**图像专有**的
 * ——"参考图字段形状(`image` 是数组还是单串)""尺寸参数""内联返回"这些在音频上不存在,
 * 而音频这边多出来的是"纯音乐 / 能收歌词 / 能克隆音色 / 音色 id"。
 * 硬塞进去的代价是那个组件里到处 `if (图像)`,而两边的能力表本来就不一样长。
 *
 * **共用的是口径,不是代码**:列表 = 上游拉到的全部(每个都带勾选框)、目录 = 勾上的那些;
 * 拉取与能力推断全在接缝(`audio-discovery.ts`),面板不复述领域判断。
 * "语音那条多半没有 `/models`"这件事也由接缝如实说清(它会指路下面的「手动添加」)。
 */
import { useState } from 'react'
import s from './settings-card.module.css'
import type { AudioAdapterChoice, AudioCapabilityKey, AudioModelRow } from './audio-catalog.ts'
import { AUDIO_ADAPTER_INFO, AUDIO_CAPABILITY_FIELDS, NO_AUDIO_CAPABILITIES, audioCatalogFromRows, audioRowFromManual } from './audio-catalog.ts'
import type { AudioModelCapabilities } from '../service/audio-generation.ts'

/** 上游拉回来的那一项(与 `/audio/channel/models` 的响应同形)。 */
interface DiscoveredAudioModelView {
  id: string
  label?: string
  likely: boolean
  inference: {
    capabilities: Record<string, boolean>
    adapter: string
    basis: string
    needsConfirmation: boolean
  }
}

export function AudioModelPicker({
  purpose, baseUrl, apiKey, rows, onChange, disabled,
}: {
  purpose: 'music' | 'voice'
  baseUrl: string
  apiKey: string
  rows: AudioModelRow[]
  /** 每次改动都回传新的清单行 + 由它生成的目录 JSON(唯一真相是 JSON)。 */
  onChange: (next: AudioModelRow[], json: string) => void
  disabled: boolean
}) {
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [extra, setExtra] = useState('')

  const commit = (next: AudioModelRow[]): void => { onChange(next, audioCatalogFromRows(purpose, next)) }
  const selectedCount = rows.filter((row) => row.selected).length
  const label = purpose === 'music' ? '音乐' : '语音'

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setError(null)
    setNote(null)
    try {
      const response = await fetch('/api/galfree/audio/channel/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, purpose }),
      })
      const text = await response.text()
      if (!response.ok) {
        // 上游/接缝的原话直接显示 —— 401 是密钥、404 是"这台服务没有 /models",人一眼能改。
        setError(`拉取失败(HTTP ${response.status}):${text.slice(0, 400)}`)
        return
      }
      const payload = JSON.parse(text) as { models: DiscoveredAudioModelView[]; total: number; endpoint: string }
      const unknown = payload.models.filter((model) => !model.likely).length
      setNote(`拉到 ${payload.total} 个模型(${unknown} 个看着不像${label}模型,排在后面,仍可勾选)。${selectedCount > 0 ? '你已勾的保留原样。' : '勾上你要用的那几个。'}`)
      // 拉取**不改变**已经勾过的行(能力也保留人的确认结果);新拉到的补进清单末尾。
      const next: AudioModelRow[] = [...rows]
      for (const model of payload.models) {
        if (next.some((row) => row.id === model.id)) continue
        next.push({
          id: model.id,
          ...(model.label === undefined ? {} : { label: model.label }),
          selected: false,
          capabilities: { ...NO_AUDIO_CAPABILITIES, ...(model.inference.capabilities as Partial<AudioModelCapabilities>) },
          needsConfirmation: model.inference.needsConfirmation,
          basis: model.inference.basis,
          likely: model.likely,
          adapter: model.inference.adapter as AudioAdapterChoice,
        })
      }
      commit(next)
    } catch (fetchError) {
      setError(`拉取失败:${fetchError instanceof Error ? fetchError.message : String(fetchError)}`)
    } finally {
      setFetching(false)
    }
  }

  const toggle = (id: string): void => {
    commit(rows.map((row) => (row.id === id ? { ...row, selected: !row.selected } : row)))
  }

  const setCapability = (id: string, key: AudioCapabilityKey, value: boolean): void => {
    commit(rows.map((row) => (row.id === id
      ? { ...row, capabilities: { ...row.capabilities, [key]: value }, needsConfirmation: false }
      : row)))
  }

  const setAdapter = (id: string, adapter: AudioAdapterChoice): void => {
    commit(rows.map((row) => (row.id === id ? { ...row, adapter } : row)))
  }

  const addManual = (): void => {
    const id = extra.trim()
    if (id === '') return
    if (rows.some((row) => row.id === id)) { setExtra(''); return }
    commit([...rows, audioRowFromManual(purpose, id)])
    setExtra('')
  }

  return (
    <div className={s.field}>
      <span className={s.label}>模型目录</span>
      <div className={s.actions}>
        <button type="button" className={s.primary} disabled={disabled || fetching || baseUrl.trim() === ''} onClick={() => void fetchModels()}>
          {fetching ? '获取中…' : '获取模型'}
        </button>
        <span className={s.hint}>
          {baseUrl.trim() === ''
            ? '先填上面的端点,再点「获取模型」'
            : `从 ${baseUrl.trim().replace(/\/+$/, '')}/models 拉清单`}
          {selectedCount > 0 ? ` · 已勾 ${selectedCount} 个` : ''}
        </span>
      </div>

      {note !== null ? <span className={s.hint}>{note}</span> : null}
      {error !== null ? <span className={s.error}>{error}</span> : null}

      {rows.length > 0 ? (
        <ul className={s.modelList}>
          {rows.map((row) => (
            <li key={row.id} className={s.modelRow}>
              <label className={s.modelHead}>
                <input
                  type="checkbox"
                  checked={row.selected}
                  disabled={disabled}
                  onChange={() => toggle(row.id)}
                  aria-label={`选用模型 ${row.id}`}
                />
                <span className={s.modelId}>{row.id}</span>
                {row.label !== undefined && row.label !== row.id ? <span className={s.hint}>{row.label}</span> : null}
                {row.manual === true ? <span className={s.badge}>手输</span> : null}
                {!row.likely ? <span className={s.badge}>不像{label}模型</span> : null}
                {row.selected && row.needsConfirmation ? <span className={s.warnBadge}>能力待确认</span> : null}
              </label>
              {row.selected ? (
                <>
                  <div className={s.caps}>
                    <label className={s.capItem} title={AUDIO_ADAPTER_INFO[row.adapter].hint}>
                      <span>协议</span>
                      <select
                        className={s.input}
                        style={{ maxWidth: 220 }}
                        value={row.adapter}
                        disabled={disabled}
                        onChange={(event) => setAdapter(row.id, event.target.value as AudioAdapterChoice)}
                        aria-label={`${row.id} 的上游协议`}
                      >
                        {(Object.keys(AUDIO_ADAPTER_INFO) as AudioAdapterChoice[]).map((key) => (
                          <option key={key} value={key}>{AUDIO_ADAPTER_INFO[key].label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={s.caps}>
                    {AUDIO_CAPABILITY_FIELDS[purpose].map((field) => (
                      <label key={field.key} className={s.capItem} title={field.hint}>
                        <input
                          type="checkbox"
                          checked={row.capabilities[field.key]}
                          disabled={disabled}
                          onChange={(event) => setCapability(row.id, field.key, event.target.checked)}
                          aria-label={`${row.id} 的 ${field.label}`}
                        />
                        <span>{field.label}</span>
                      </label>
                    ))}
                  </div>
                  <span className={s.hint}>{row.basis}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={s.actions}>
        <input
          className={s.input}
          style={{ maxWidth: 260 }}
          value={extra}
          placeholder={purpose === 'voice' ? '上游没列出来的模型 id / 服务名,手输' : '上游没列出来的模型 id,手输'}
          onChange={(event) => setExtra(event.target.value)}
          aria-label="手动添加模型 id"
        />
        <button type="button" className={s.button} disabled={disabled || extra.trim() === ''} onClick={addManual}>加进目录</button>
      </div>
      <span className={s.hint}>
        勾上的会写进设置里的 {purpose === 'music' ? 'musicModels' : 'voiceModels'}(保存后生效);**取消勾选 = 从目录移除**。
        {' '}
        {purpose === 'voice'
          ? '本机 TTS 服务(IndexTTS 那类)通常**没有 /models** —— 那时直接用左边的「手动添加」:把服务名当模型 id 填进来,再勾准它能不能克隆音色、收不收参考音频。'
          : '没认出来的模型默认只开「文生音乐」,协议默认异步:请按上游文档勾准它真实支持的 —— 勾多了上游不认,生成会失败(失败会如实进任务历史,不会静默)。'}
      </span>
    </div>
  )
}
