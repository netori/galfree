/**
 * 模型选择器(T14 续)—— 把"手写目录 JSON"换成"拉取 → 勾选"。
 *
 * 一条要紧的语义(第一版写错过,靠渲染回路抓出来):
 * **列表 = 上游拉到的全部模型(每个都带勾选框);目录 = 被勾上的那些。**
 * 如果把"已选中的模型"当成列表本身,没勾的模型就**根本不显示**,人也就无从勾选 ——
 * 界面看着能用,实际只能勾到已经勾过的东西。
 *
 * 分工:
 *  - **这层只管界面**;拉取与能力推断的判断全在接缝(`/channel/models` → discovery.ts),
 *    面板不复述"哪个家族支持参考链"这类领域判断。
 *  - 已知家族的能力由接缝标为**确定**;没认出来的标为**待确认**,并显式提示人勾选 ——
 *    "支持参考链"这种话没验过就不能替上游说(说了就是发出上游看不懂的请求)。
 *  - **不隐藏**非图像模型:模型命名千奇百怪,藏起来人就没法手选,最后兜底的还是人。
 */
import { useState } from 'react'
import s from './settings-card.module.css'

/** 能力字段的固定顺序与中文名(全量快照字段,写目录时必须给全)。 */
const CAPABILITY_FIELDS: Array<{ key: CapabilityKey; label: string; hint: string }> = [
  { key: 'textToImage', label: '文生图', hint: '按提示词直接出图(几乎都有)' },
  { key: 'imageToImage', label: '图生图', hint: '能收一张参考图做改动' },
  { key: 'referenceChain', label: '参考链', hint: '能收多张参考图、跨批次保持一致(最少见的一个)' },
  { key: 'aspectRatioParam', label: '尺寸参数', hint: '认 size/宽高比参数' },
  { key: 'b64Json', label: '内联返回', hint: '返回里直接给图片数据(b64_json)' },
]

export type CapabilityKey = 'textToImage' | 'imageToImage' | 'referenceChain' | 'aspectRatioParam' | 'b64Json'

export type CapabilitySet = Record<CapabilityKey, boolean>

/** 上游协议:同步(OpenAI 兼容)还是异步任务制。 */
export type AdapterChoice = 'openai-compatible' | 'async-task'

/** 协议的中文名(面板显示;提交路径随协议变,一并写在这里免得两处不一致)。 */
export const ADAPTER_INFO: Record<AdapterChoice, { label: string; submitPath: string; hint: string }> = {
  'openai-compatible': {
    label: '同步(OpenAI 兼容)',
    submitPath: '/images/generations',
    hint: 'OpenAI 那种:**复数** `images`,一次调用直接回图片(b64_json)。',
  },
  'async-task': {
    label: '异步任务制(提交后轮询)',
    submitPath: '/image/generations',
    hint: 'one-api / new-api 系网关:**单数** `image`,提交后回任务 id,要轮询到终态再取 `result_url`。',
  },
}

/** 清单里的一行:上游拉到的(或手输的)+ 是否勾上 + 它的能力 + 协议。 */
export interface ModelRow {
  id: string
  label?: string
  note?: string
  selected: boolean
  capabilities: CapabilitySet
  /** 能力是保守默认(要人确认)还是已知家族给的。 */
  needsConfirmation: boolean
  basis: string
  imageLikely: boolean
  /** 手输进来的(上游没列)。 */
  manual?: boolean
  /** 这个模型走哪个上游协议。 */
  adapter: AdapterChoice
}

export interface DiscoveredModelView {
  id: string
  label?: string
  imageLikely: boolean
  inference: { capabilities: CapabilitySet; family?: string; basis: string; needsConfirmation: boolean }
}

const EMPTY_CAPS: CapabilitySet = { textToImage: false, imageToImage: false, referenceChain: false, aspectRatioParam: false, b64Json: false }

/** 保守默认:只文生图 + 尺寸参数 + 内联返回(其余没验过不开)。 */
export const CONSERVATIVE_CAPS: CapabilitySet = { ...EMPTY_CAPS, textToImage: true, aspectRatioParam: true, b64Json: true }

/** 拉到的模型 → 清单行(默认不勾:目录由人决定,不是"拉到就全用")。 */
export function rowFrom(model: DiscoveredModelView): ModelRow {
  return {
    id: model.id,
    ...(model.label === undefined ? {} : { label: model.label }),
    selected: false,
    capabilities: { ...EMPTY_CAPS, ...model.inference.capabilities },
    needsConfirmation: model.inference.needsConfirmation,
    basis: model.inference.basis,
    imageLikely: model.imageLikely,
    adapter: 'openai-compatible',
  }
}

/** 已保存的目录文本 → 清单行(都算勾上;面板打开时把现状带出来)。 */
export function rowsFromCatalog(text: string): ModelRow[] {
  if (text.trim() === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id as string,
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
        selected: true,
        capabilities: { ...EMPTY_CAPS, ...(entry.capabilities as Partial<CapabilitySet> | undefined ?? {}) },
        // 已保存的能力是人定过的,不再算"待确认"。
        needsConfirmation: false,
        basis: '已保存的目录',
        imageLikely: true,
        adapter: entry.adapter === 'async-task' ? 'async-task' as const : 'openai-compatible' as const,
      }))
  } catch {
    return []
  }
}

/** 清单行 → 目录 JSON(**只写勾上的**;协议非默认时才写 adapter/paths)。 */
export function catalogFromRows(rows: ModelRow[]): string {
  return JSON.stringify(rows.filter((row) => row.selected).map((row) => ({
    id: row.id,
    ...(row.label === undefined || row.label === '' ? {} : { label: row.label }),
    ...(row.note === undefined || row.note === '' ? {} : { note: row.note }),
    capabilities: { ...row.capabilities },
    ...(row.adapter === 'openai-compatible' ? {} : {
      // 协议与它的默认路径一起写死:换协议时路径必须跟着换(单数 vs 复数),
      // 让人只勾一次、不用再去记路径 —— "声明而不是猜"这条也适用于路径。
      adapter: row.adapter,
      paths: { submit: ADAPTER_INFO[row.adapter].submitPath },
      async: {
        submitPath: ADAPTER_INFO[row.adapter].submitPath,
        pollPath: `${ADAPTER_INFO[row.adapter].submitPath}/{taskId}`,
        pollIntervalMs: 3000,
        pollMaxAttempts: 60,
      },
    }),
  })), null, 2)
}

/**
 * 两份清单行是否等价(**按内容比**)。
 *
 * 这是防"渲染自锁"的那道闸:勾选回调会改 `imageModels` 文本,而文本变化又会
 * 反过来同步清单 —— 如果同步时无脑 `setState(新数组)`,每次渲染都触发下一次渲染,
 * 主线程被占死(界面看着在,按钮点不动)。所以内容没变就**原样返回旧引用**。
 */
export function sameRows(a: ModelRow[], b: ModelRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.selected !== y.selected || x.label !== y.label || x.note !== y.note || x.adapter !== y.adapter) return false
    for (const key of Object.keys(EMPTY_CAPS) as CapabilityKey[]) {
      if (x.capabilities[key] !== y.capabilities[key]) return false
    }
  }
  return true
}

export function ModelPicker({
  baseUrl, apiKey, rows, onChange, disabled,
}: {
  baseUrl: string
  apiKey: string
  rows: ModelRow[]
  /** 每次改动都回传新的清单行 + 由它生成的目录 JSON(唯一真相是 JSON)。 */
  onChange: (next: ModelRow[], json: string) => void
  disabled: boolean
}) {
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [extra, setExtra] = useState('')

  const commit = (next: ModelRow[]): void => { onChange(next, catalogFromRows(next)) }
  const selectedCount = rows.filter((row) => row.selected).length

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setError(null)
    setNote(null)
    try {
      const response = await fetch('/api/galfree/channel/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      })
      const text = await response.text()
      if (!response.ok) {
        // 上游/接缝的原话直接显示 —— 401 是密钥、404 是端点,人一眼能改。
        setError(`拉取失败(HTTP ${response.status}):${text.slice(0, 400)}`)
        return
      }
      const payload = JSON.parse(text) as { models: DiscoveredModelView[]; total: number; endpoint: string }
      const unknown = payload.models.filter((model) => !model.imageLikely).length
      setNote(`拉到 ${payload.total} 个模型(${unknown} 个看着不像图像模型,排在后面,仍可勾选)。${selectedCount > 0 ? '你已勾的保留原样。' : '勾上你要用的那几个。'}`)
      // 拉取**不改变**已经勾过的行(能力也保留人的确认结果);新拉到的补进清单末尾。
      const next: ModelRow[] = []
      for (const row of rows) next.push(row)
      for (const model of payload.models) {
        if (next.some((row) => row.id === model.id)) continue
        next.push(rowFrom(model))
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

  const setCapability = (id: string, key: CapabilityKey, value: boolean): void => {
    commit(rows.map((row) => (row.id === id
      ? { ...row, capabilities: { ...row.capabilities, [key]: value }, needsConfirmation: false }
      : row)))
  }

  /** 换协议:路径与轮询参数由 `catalogFromRows` 跟着一起写,人不用记路径。 */
  const setAdapter = (id: string, adapter: AdapterChoice): void => {
    commit(rows.map((row) => (row.id === id ? { ...row, adapter } : row)))
  }

  const addManual = (): void => {
    const id = extra.trim()
    if (id === '') return
    if (rows.some((row) => row.id === id)) { setExtra(''); return }
    commit([...rows, {
      id,
      selected: true,
      capabilities: { ...CONSERVATIVE_CAPS },
      needsConfirmation: true,
      basis: '手动添加:能力按最保守的口径填,请勾准它真实支持的',
      imageLikely: true,
      manual: true,
      adapter: 'openai-compatible',
    }])
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
                {!row.imageLikely ? <span className={s.badge}>不像图像模型</span> : null}
                {row.selected && row.needsConfirmation ? <span className={s.warnBadge}>能力待确认</span> : null}
              </label>
              {row.selected ? (
                <>
                  <div className={s.caps}>
                    <label className={s.capItem} title={ADAPTER_INFO[row.adapter].hint}>
                      <span>协议</span>
                      <select
                        className={s.input}
                        style={{ maxWidth: 220 }}
                        value={row.adapter}
                        disabled={disabled}
                        onChange={(event) => setAdapter(row.id, event.target.value as AdapterChoice)}
                        aria-label={`${row.id} 的上游协议`}
                      >
                        {(Object.keys(ADAPTER_INFO) as AdapterChoice[]).map((key) => (
                          <option key={key} value={key}>{ADAPTER_INFO[key].label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={s.caps}>
                    {CAPABILITY_FIELDS.map((field) => (
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
                  <span className={s.hint}>
                    {row.basis}
                    {row.adapter === 'async-task' ? ` · 走 ${ADAPTER_INFO[row.adapter].submitPath}(提交后轮询)` : ''}
                  </span>
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
          placeholder="上游没列出来的模型 id,手输"
          onChange={(event) => setExtra(event.target.value)}
          aria-label="手动添加模型 id"
        />
        <button type="button" className={s.button} disabled={disabled || extra.trim() === ''} onClick={addManual}>加进目录</button>
      </div>
      <span className={s.hint}>
        勾上的会写进设置里的 imageModels(保存后生效);**取消勾选 = 从目录移除**。
        没认出来的模型默认只开「文生图」:请按上游文档勾准它真实支持的能力 ——
        勾多了上游不认,出图会失败(失败会如实进任务历史,不会静默)。
      </span>
    </div>
  )
}
