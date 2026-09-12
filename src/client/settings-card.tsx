/**
 * 图像渠道设置界面(T14)—— 设置左侧导航里的一个独立分区「GALFree」。
 *
 * 为什么是独立分区,而不是挤进「插件配置」标签页:那个标签页把
 * `settings.plugin.item` 的注册表与**宿主自己的命名空间清单**交叉比对来决定渲染谁,
 * 插件拿不到那套过滤依据(实测:卡注册进去了,那个标签页里仍然不出现)。
 * 而宿主自己的功能页(「Agent 预设」等)走的是另一条路 —— 直接贡献一个
 * `settings.section`,设置左侧就多一项,**完全不依赖任何枚举**。本插件走这条。
 *
 * 写入走宿主既有的一套:读 `ctx.settingsScope.describe()` 的共享镜像拿
 * 「当前值 + revision」,保存时提交 `ctx.remote.settings.mutate(ns, ops, revision)`
 * —— revision 围栏保证并发改动被拒而不是被静默覆盖。**密钥明文**按 ADR-0010
 * 存本机设置文档:界面上如实写明这一点,不含糊。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import s from './settings-card.module.css'

/** 与 Host 半 `CONFIG_NAMESPACE` 同一个命名空间(两端必须一致)。 */
export const SETTINGS_NAMESPACE = 'dsh-galfree'

/** 卡片渲染所需的宿主服务(运行时注入;此处按名取用,不引宿主内部包)。 */
interface SettingsCardContext {
  settingsScope: {
    describe: () => {
      getSnapshot: () => unknown
      subscribe: (listener: () => void) => () => void
      ensure: () => Promise<void> | void
      acceptView: (view: unknown) => void
    }
  }
  remote: {
    settings: {
      mutate: (
        ns: string,
        ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>,
        revision: number | undefined,
      ) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
    }
  }
}

/** 一张卡的字段(与 Host 半的设置 schema 一一对应)。 */
interface ChannelDraft {
  imageBaseUrl: string
  imageApiKey: string
  imageChannelName: string
  imageModels: string
}

const EMPTY_DRAFT: ChannelDraft = { imageBaseUrl: '', imageApiKey: '', imageChannelName: '', imageModels: '' }

/** 模型目录示例:先给一条能跑的,人照着改(空目录会让建任务被拒)。 */
const MODEL_EXAMPLE = JSON.stringify([
  {
    id: 'your-image-model',
    label: '示例:先问清模型支持什么,再改这里',
    capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
  },
], null, 2)

interface NamespaceView {
  value?: Partial<ChannelDraft>
  user?: Partial<ChannelDraft>
  revision?: number
  writable?: boolean
}

interface ScopeState {
  loaded: boolean
  writable: boolean
  revision: number | undefined
  view: NamespaceView | null
}

/** 从镜像快照里挑出本命名空间 + 可写性(镜像在 loaded=false 时还没答案)。 */
function readScope(snapshot: unknown): ScopeState {
  const shape = snapshot as { view?: { writable?: boolean; namespaces?: NamespaceView[] }; status?: string } | null
  const view = shape?.view?.namespaces?.find((entry) => (entry as { ns?: string }).ns === SETTINGS_NAMESPACE) ?? null
  return {
    loaded: shape?.view !== undefined,
    writable: shape?.view?.writable !== false,
    revision: view?.revision,
    view,
  }
}

/**
 * 两份 scope 内容是否等价。
 *
 * 镜像是宿主持有的,**每次读都可能给出新的对象身份**;如果无脑 `setState(新对象)`,
 * 每次渲染都会再触发一次渲染 —— 主线程被这圈循环占死,页面看着在、按钮点不动
 * (我在这上面栽过一次,靠渲染回路里的点击超时才发现)。所以按**内容**比对。
 */
function sameScope(a: ScopeState, b: ScopeState): boolean {
  if (a.loaded !== b.loaded || a.writable !== b.writable || a.revision !== b.revision) return false
  const av = a.view?.value ?? {}
  const bv = b.view?.value ?? {}
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)])
  for (const key of keys) {
    if ((av as Record<string, unknown>)[key] !== (bv as Record<string, unknown>)[key]) return false
  }
  return true
}

/** JSON 文本的校验:坏 JSON 当场说,不让它悄悄写进设置文档。 */
function modelsProblem(text: string): string | null {
  if (text.trim() === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return '模型目录必须是一个 JSON 数组'
    return null
  } catch (error) {
    return `JSON 解析不了:${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 兜住渲染期崩溃:**把错误显示出来,而不是让设置右侧一片空白**。
 * 宿主对席位组件崩掉的处理是把内容兜掉(界面表现=空白),那对排障最不友好 ——
 * 空白看不出是"没做"还是"坏了"。有了它,坏了就看得见。
 */
class SectionBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <section className={s.card} aria-label="GALFree 图像渠道">
        <header className={s.head}>
          <h3 className={s.title}>GALFree · 图像渠道</h3>
        </header>
        <p className={s.error}>这个设置界面渲染失败了(如实报出来,而不是留一片空白):{this.state.error}</p>
        <p className={s.hint}>请把上面这行原文报告给插件作者;项目的出图功能不受影响。</p>
      </section>
    )
  }
}

export function ChannelSettingsCard({ ctx }: { ctx: SettingsCardContext }) {
  // 依赖缺失时**不许白屏**:说清缺什么。设置分区是用户看得见的地方,
  // 一片空白会让人以为"功能没做",而真相是"装配缺了一个服务"。
  if (ctx?.settingsScope === undefined || ctx?.remote?.settings === undefined) {
    const missing = [
      ctx?.settingsScope === undefined ? 'settingsScope' : null,
      ctx?.remote?.settings === undefined ? 'remote.settings' : null,
    ].filter((entry): entry is string => entry !== null)
    return (
      <section className={s.card} aria-label="GALFree 图像渠道">
        <header className={s.head}>
          <h3 className={s.title}>GALFree · 图像渠道</h3>
        </header>
        <p className={s.error}>
          这个宿主没有给本插件装配设置服务(缺:{missing.join('、')})。渠道暂时没法在这里配 ——
          请把这一条报告给插件作者,不要以为是自己填错了。
        </p>
      </section>
    )
  }
  return <ChannelSettingsForm ctx={ctx} />
}

function ChannelSettingsForm({ ctx }: { ctx: SettingsCardContext }) {
  const describe = ctx.settingsScope.describe()
  const [scope, setScope] = useState<ScopeState>(() => readScope(describe.getSnapshot()))
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  /** 正在编辑的字段标记:镜像每次刷新都不要覆盖人正在敲的字。 */
  const dirty = useRef(new Set<keyof ChannelDraft>())

  const syncFromMirror = useCallback((state: ScopeState) => {
    setScope((current) => (sameScope(current, state) ? current : state))
    const value = state.view?.value
    if (value === undefined) return
    setDraft((current) => {
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(EMPTY_DRAFT) as Array<keyof ChannelDraft>) {
        if (dirty.current.has(key)) continue
        const incoming = value[key] ?? ''
        if (next[key] !== incoming) { next[key] = incoming; changed = true }
      }
      // 内容没变就返回原对象:避免"渲染 → setState → 渲染"的自我循环。
      return changed ? next : current
    })
  }, [])

  useEffect(() => {
    let alive = true
    const refresh = (): void => { if (alive) syncFromMirror(readScope(describe.getSnapshot())) }
    const stop = describe.subscribe(refresh)
    void Promise.resolve(describe.ensure()).then(refresh).catch(() => { /* 未加载就渲染缺失态 */ })
    refresh()
    return () => { alive = false; stop() }
  }, [describe, syncFromMirror])

  const edit = (field: keyof ChannelDraft, text: string): void => {
    dirty.current.add(field)
    setDraft((current) => ({ ...current, [field]: text }))
    setStatus('idle')
    setMessage(null)
  }

  const problem = useMemo(() => modelsProblem(draft.imageModels), [draft.imageModels])
  const overridden = (field: keyof ChannelDraft): boolean => scope.view?.user !== undefined && field in scope.view.user

  const save = async (): Promise<void> => {
    if (problem !== null) {
      setStatus('error')
      setMessage(problem)
      return
    }
    setStatus('saving')
    setMessage(null)
    const ops = (Object.keys(EMPTY_DRAFT) as Array<keyof ChannelDraft>).map((field) => (
      draft[field].trim() === '' && field !== 'imageApiKey'
        ? { op: 'unset' as const, path: [field] }
        : { op: 'set' as const, path: [field], value: draft[field] }
    ))
    try {
      const response = await ctx.remote.settings.mutate(SETTINGS_NAMESPACE, ops, scope.revision)
      if (!response.ok) {
        setStatus('error')
        setMessage(`设置没被接受(可能别处刚改过):${describeError(response.error)}`)
        return
      }
      describe.acceptView(response.value)
      dirty.current.clear()
      setStatus('saved')
      setMessage('已保存。渠道改动对下一次出图立刻生效(不用重启)。')
      syncFromMirror(readScope(describe.getSnapshot()))
    } catch (error) {
      setStatus('error')
      setMessage(`保存失败:${describeError(error)}`)
    }
  }

  return (
    <section className={s.card} aria-label="GALFree 图像渠道">
      <header className={s.head}>
        <h3 className={s.title}>GALFree · 图像渠道</h3>
        <p className={s.desc}>
          素材出图走这里配的端点(Host 直连,不消耗对话回合)。密钥明文存在本机设置文档里
          (ADR-0010 的知情选择):它不进项目目录、不进快照、不进任务账本。
        </p>
      </header>

      {!scope.loaded ? (
        <p className={s.hint}>正在读取设置…</p>
      ) : (
        <div className={s.body}>
          {!scope.writable ? <p className={s.warn}>这个部署把设置存成只读,改不了。</p> : null}

          <label className={s.field}>
            <span className={s.label}>端点(OpenAI 兼容基址)</span>
            <input
              className={s.input}
              value={draft.imageBaseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => edit('imageBaseUrl', event.target.value)}
              aria-label="图像渠道端点"
            />
            <span className={s.hint}>留空 = 没配渠道。这时出图动作会如实拒绝(不假装能出)。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>
              密钥 <span className={s.badge}>明文存本机</span>
            </span>
            <input
              className={s.input}
              value={draft.imageApiKey}
              placeholder="sk-…"
              onChange={(event) => edit('imageApiKey', event.target.value)}
              aria-label="图像渠道密钥"
            />
            <span className={s.hint}>只用于出网请求;工作台只会告诉人「配没配」,不回显它。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>渠道名(随便填,只为在面板/账本里指认)</span>
            <input
              className={s.input}
              value={draft.imageChannelName}
              placeholder="主渠道"
              onChange={(event) => edit('imageChannelName', event.target.value)}
              aria-label="图像渠道名"
            />
          </label>

          <label className={s.field}>
            <span className={s.label}>模型目录(JSON 数组)</span>
            <textarea
              className={`${s.input} ${s.textarea}`}
              value={draft.imageModels}
              placeholder={MODEL_EXAMPLE}
              rows={7}
              onChange={(event) => edit('imageModels', event.target.value)}
              aria-label="图像模型目录"
            />
            <span className={s.hint}>
              每个模型都要声明能力,因为「协议不合要如实降级」只能靠声明判断,猜会静默发错请求。
              缺省口径:文生图 / 尺寸参数 / b64 为真;参考链 / 图生图为假(能力宁可少说)。
              <button type="button" className={s.link} onClick={() => edit('imageModels', MODEL_EXAMPLE)}>
                填入示例
              </button>
            </span>
            {problem !== null ? <span className={s.error}>{problem}</span> : null}
          </label>

          <div className={s.actions}>
            <button
              type="button"
              className={s.primary}
              disabled={status === 'saving' || !scope.writable}
              onClick={() => void save()}
            >
              {status === 'saving' ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className={s.button}
              disabled={status === 'saving'}
              onClick={() => {
                dirty.current.clear()
                setStatus('idle')
                setMessage(null)
                syncFromMirror(readScope(describe.getSnapshot()))
              }}
            >
              放弃改动
            </button>
            {overridden('imageBaseUrl') ? <span className={s.hint}>端点已被你覆盖(不是默认值)</span> : null}
          </div>

          {message !== null ? (
            <p className={status === 'error' ? s.error : s.ok}>{message}</p>
          ) : null}
        </div>
      )}
    </section>
  )
}

function describeError(error: unknown): string {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const shape = error as { code?: unknown; message?: unknown }
  if (typeof shape.message === 'string') return shape.code === undefined ? shape.message : `[${String(shape.code)}] ${shape.message}`
  return JSON.stringify(error)
}

/**
 * 注册成设置里的一个独立分区。
 *
 * 两条都必要:`settings.section` 让它出现在设置左侧导航;里面的表单本体由
 * 组件自己渲染。**不**注册 `settings.plugin.item` —— 那会让同一件事在两处
 * 界面里可改(第二配置面),而它恰恰又不显示,没必要。
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject: (name: string, build: () => () => void) => unknown
      register: (options: Record<string, unknown>, component: unknown) => () => void
    }
  }).slots

  const settings = ctx as unknown as SettingsCardContext

  ctx.effect(
    () => slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'galfree',
      order: 40,
      label: () => 'GALFree',
    }, () => (
      <SectionBoundary>
        <ChannelSettingsCard ctx={settings} />
      </SectionBoundary>
    ))) as () => void,
    'dsh-galfree: image channel settings section',
  )
}
