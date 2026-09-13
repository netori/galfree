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
import { ModelPicker, rowsFromCatalog, sameRows, type ModelRow } from './model-picker.tsx'
import { AudioModelPicker } from './audio-model-picker.tsx'
import { audioRowsFromCatalog, sameAudioRows, type AudioModelRow } from './audio-catalog.ts'
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

/**
 * 一张卡的字段(与 Host 半的设置 schema 一一对应)。
 *
 * ⚠️ **这张表就是"保存会动哪些键"的清单**:`save()` 按它的键逐条 `set`/`unset`。
 * 所以 schema 里加了字段而这里没加 → 那个字段在保存时**既不会被写、也不会被清**;
 * 但反过来说,一旦面板要显示它,就必须同时进这张表,否则人改了保存不上。
 * (曾经的真实缺口:音频那四个键加进了 schema 却没进这张表 —— 面板上没有输入框,
 * 而且**在面板上点保存不会碰它们**;这一次补齐。)
 */
interface ChannelDraft {
  imageBaseUrl: string
  imageApiKey: string
  imageChannelName: string
  imageModels: string
  /** 音乐生成渠道(T27 / ADR-0012:三条生成线各自一条)。 */
  musicBaseUrl: string
  musicApiKey: string
  musicChannelName: string
  musicModels: string
  /** 语音(TTS)生成渠道 —— 与音乐那条**分开配**(上游与协议不重叠)。 */
  voiceBaseUrl: string
  voiceApiKey: string
  voiceChannelName: string
  voiceModels: string
  /** 发布输出目录(T18);留空 = 数据目录下的 publish/<项目名>。 */
  publishDir: string
}

const EMPTY_DRAFT: ChannelDraft = {
  imageBaseUrl: '', imageApiKey: '', imageChannelName: '', imageModels: '',
  musicBaseUrl: '', musicApiKey: '', musicChannelName: '', musicModels: '',
  voiceBaseUrl: '', voiceApiKey: '', voiceChannelName: '', voiceModels: '',
  publishDir: '',
}

/**
 * 这张卡管哪些键(**给守卫用**)。
 *
 * 为什么单列一个导出:`save()` 是按 `EMPTY_DRAFT` 的键逐条 `set`/`unset` 的,
 * 所以"面板管的键"与"Host 半 schema 的键"必须**逐一对应** ——
 * 少了就有一片设置没有任何界面(`T27` 的音频四个键真发生过:界面上看不到,
 * 于是人要手改设置文档;而那次我恰好又把它做成了"不碰"而不是"清掉",算运气好)。
 * 守卫直接比这两份清单,加字段忘了改界面就会红。
 */
export const SETTINGS_CARD_KEYS = Object.keys(EMPTY_DRAFT) as Array<keyof ChannelDraft>

/** 密钥字段:空值**不能** unset(空密钥是合法状态:本地服务通常不要密钥)。 */
const SECRET_FIELDS: ReadonlyArray<keyof ChannelDraft> = ['imageApiKey', 'musicApiKey', 'voiceApiKey']

/**
 * **旧一代**的音频渠道键(T27 那代:音乐与语音共用一条)。
 *
 * 2026-09-13 拆成 `music*` / `voice*` 两族之后,这四个键不在 schema 里了 ——
 * schema 会剥掉未知键,于是"配过音频渠道"的人升级后会看到两段空白。
 * 它们**不再被读取**,但设置文档里可能还留着;面板据此给一句提示(见 legend 那段注释)。
 * 这里只列名字,**不做迁移**:那个端点原本该算音乐还是语音,只有人知道。
 */
const LEGACY_AUDIO_KEYS = ['audioBaseUrl', 'audioApiKey', 'audioChannelName', 'audioModels'] as const

/** 模型目录示例:先给一条能跑的,人照着改(空目录会让建任务被拒)。 */
const MODEL_EXAMPLE = JSON.stringify([
  {
    id: 'your-image-model',
    label: '示例:先问清模型支持什么,再改这里',
    capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
  },
], null, 2)

/**
 * 音乐目录的示例:**一条真的能用的**(Suno 类聚合站)。
 *
 * 为什么给这么具体:那个适配器要的参数(`submit`/`record`/`model`)写在 `note` 里,
 * 不给示例的话人只能猜;而猜错的形态是"配置看着生效了、跑起来说不认这个形状"。
 */
const MUSIC_MODEL_EXAMPLE = JSON.stringify([
  {
    id: 'suno-generation',
    purpose: 'music',
    adapter: 'async-task',
    label: '音乐(聚合站;sunoapi 那种协议)',
    note: 'submit=/api/v1/generate;record=/api/v1/generate/record-info;model=V6',
    capabilities: { textToMusic: true, instrumental: true, lyrics: true, urlResult: true },
  },
], null, 2)

/** 语音目录的示例:**一条真的能用的**(本机 IndexTTS 那种服务)。 */
const VOICE_MODEL_EXAMPLE = JSON.stringify([
  {
    id: 'indextts-2.5',
    purpose: 'voice',
    adapter: 'sync-http',
    label: '本地 TTS(参考音频的音色)',
    note: 'speaker=default;audio=参考音频.mp3;lang=ZH',
    capabilities: { textToSpeech: true, voiceCloning: true, voiceId: true, audioReference: true },
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
  //
  // 注意:这里必须用 try 包住 —— 宿主对**未声明**的子服务(如 `remote.settings`)
  // 属性访问本身就是抛错(`cannot get property "remote.settings" without inject`),
  // 直接读它做判断会把"缺依赖"变成"崩溃"。
  const missing: string[] = []
  try {
    if ((ctx as { settingsScope?: unknown })?.settingsScope === undefined) missing.push('settingsScope')
    if ((ctx as { remote?: { settings?: unknown } })?.remote?.settings === undefined) missing.push('remote.settings')
  } catch (error) {
    missing.push(`访问服务时出错(${error instanceof Error ? error.message : String(error)})`)
  }
  if (missing.length > 0) {
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
  /** 模型选择器的状态:清单行(上游拉到的 + 手输的);目录 JSON 仍是唯一真相。 */
  const [choices, setChoices] = useState<ModelRow[]>(() => rowsFromCatalog(''))
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

  /**
   * 把"设置里已保存的目录"带进模型选择器。
   *
   * 三重防护,缺一不可(都在真浏览器里踩过):
   *  1. 人没在编辑目录时才同步(dirty 里有 imageModels 就跳过);
   *  2. 同一份文本只处理一次(lastCatalog);
   *  3. **内容没变就保持旧引用**(sameRows)—— 否则勾选回调改文本 → 文本变化又同步清单
   *     → 新数组 → 再渲染,自锁成死循环(界面看着在、按钮点不动)。
   */
  const lastCatalog = useRef<string | null>(null)
  useEffect(() => {
    if (dirty.current.has('imageModels')) return
    if (draft.imageModels === lastCatalog.current) return
    lastCatalog.current = draft.imageModels
    setChoices((current) => {
      const next = rowsFromCatalog(draft.imageModels)
      return sameRows(current, next) ? current : next
    })
  }, [draft.imageModels])

  const edit = (field: keyof ChannelDraft, text: string): void => {
    dirty.current.add(field)
    setDraft((current) => ({ ...current, [field]: text }))
    setStatus('idle')
    setMessage(null)
  }

  const problem = useMemo(() => modelsProblem(draft.imageModels), [draft.imageModels])
  /**
   * 两条音频目录的校验:与图像那条**同一把尺子**(坏 JSON / 不是数组当场说),
   * 但**不检查认不出的 purpose/adapter** —— 那两条是"整条跳过"的语义(见 Host 半的说明),
   * 在这里拦成报错反而与接缝不一致。
   */
  const audioProblem = useMemo(() => modelsProblem(draft.musicModels), [draft.musicModels])
  const voiceProblem = useMemo(() => modelsProblem(draft.voiceModels), [draft.voiceModels])

  /**
   * 两条音频渠道的**清单行**(与图像那条同一个机制,只是能力表按用途不同)。
   *
   * 那一圈"文本 → 清单 → 文本"的同步必须**按内容比对**才 setState(否则渲染自锁,
   * 见 `sameAudioRows` 的注释)—— 图像那条在这里栽过一次,这条照同一个态度写。
   */
  const [musicChoices, setMusicChoices] = useState<AudioModelRow[]>(() => audioRowsFromCatalog('music', EMPTY_DRAFT.musicModels))
  const [voiceChoices, setVoiceChoices] = useState<AudioModelRow[]>(() => audioRowsFromCatalog('voice', EMPTY_DRAFT.voiceModels))

  useEffect(() => {
    const next = audioRowsFromCatalog('music', draft.musicModels)
    setMusicChoices((current) => sameAudioRows(current, next) ? current : next)
  }, [draft.musicModels])
  useEffect(() => {
    const next = audioRowsFromCatalog('voice', draft.voiceModels)
    setVoiceChoices((current) => sameAudioRows(current, next) ? current : next)
  }, [draft.voiceModels])

  const overridden = (field: keyof ChannelDraft): boolean => scope.view?.user !== undefined && field in scope.view.user

  /**
   * 设置文档里**还留着**的旧音频渠道键(T27 那代的 `audioBaseUrl` 一族)。
   *
   * 读的是 `user` 那一层(用户实际写下的键),不是 resolved 值 —— schema 已经不认它们,
   * 所以 resolved 里看不到、而文档里还在。这四行代码是"配置静默失效"的唯一出口:
   * 不提示的话,人只会看到自己配的渠道不见了。
   */
  const legacyAudioKeys = LEGACY_AUDIO_KEYS.filter((key) =>
    (scope.view?.user as Record<string, unknown> | undefined)?.[key] !== undefined)

  const save = async (): Promise<void> => {
    const firstProblem = problem ?? audioProblem ?? voiceProblem
    if (firstProblem !== null) {
      setStatus('error')
      setMessage(firstProblem)
      return
    }
    setStatus('saving')
    setMessage(null)
    const ops = (Object.keys(EMPTY_DRAFT) as Array<keyof ChannelDraft>).map((field) => (
      draft[field].trim() === '' && !SECRET_FIELDS.includes(field)
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

          {/*
            旧音频渠道那四个键(`audioBaseUrl` 一族,2026-09-13 拆成音乐/语音两族之后
            已不在 schema 里)如果还留在设置文档里,**如实说一句** ——
            不说的话人只会看到"我配的渠道没了",而不知道为什么(那两个键现在既不被读、
            也不会被面板清掉)。**只提示、不迁移**:怎么分是人的决定(那个端点原本是音乐还是语音)。
          */}
          {legacyAudioKeys.length > 0 ? (
            <p className={s.warn}>
              设置文档里还有旧的音频渠道键({legacyAudioKeys.join('、')})—— 它们**已经不再被读取**。
              音乐与语音现在是**两条**渠道:把原来那组端点/密钥/模型目录**照原样搬到下面「音乐生成渠道」
              或「语音生成渠道」**对应那一段(搬完可以手改设置文档删掉旧的四个键;面板不会替你动它们)。
            </p>
          ) : null}

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

          <ModelPicker
            baseUrl={draft.imageBaseUrl}
            apiKey={draft.imageApiKey}
            rows={choices}
            disabled={status === 'saving' || !scope.writable}
            onChange={(next: ModelRow[], json: string) => {
              // 顺序要紧:先写文本(它会触发同步),**再**落选择状态 ——
              // 反过来的话,同步会把刚点的那一下覆盖掉(checkbox 会"弹回去")。
              edit('imageModels', json)
              setChoices(next)
            }}
          />

          <details className={s.field}>
            <summary className={s.hint}>高级:直接看/改目录 JSON(排查用)</summary>
            <textarea
              className={`${s.input} ${s.textarea}`}
              value={draft.imageModels}
              placeholder={MODEL_EXAMPLE}
              rows={7}
              onChange={(event) => {
                edit('imageModels', event.target.value)
                setChoices(rowsFromCatalog(event.target.value))
              }}
              aria-label="图像模型目录"
            />
            <span className={s.hint}>
              每个模型的能力是一份**全量快照**:写目录时五个字段都要给全(缺字段的条目会被按缺省口径读)。
            </span>
            {problem !== null ? <span className={s.error}>{problem}</span> : null}
          </details>

          <label className={s.field}>
            <span className={s.label}>发布输出目录(T18)</span>
            <input
              className={s.input}
              value={draft.publishDir}
              placeholder="留空 = 数据目录下的 publish/<项目名>"
              onChange={(event) => edit('publishDir', event.target.value)}
              aria-label="发布输出目录"
            />
            <span className={s.hint}>
              一键发布打出来的包放在这里,**每个项目各占一个子目录**。产物不进项目源树、不进快照;
              把目录配到项目里面会被如实拒绝(源树是唯一真相,不是构建垃圾场)。
            </span>
          </label>

          {/*
            ─── 音乐生成渠道(T27 / ADR-0012)────────────────────────────────
            三条生成线**各自一条渠道**:音乐与语音的上游与协议不重叠(音乐多是"提交 → 轮询 → 拿 URL",
            语音那条多半是本机服务)。合成一条的表现是"换了音乐上游,语音那半跟着坏"。
            端点填什么都行:聚合站 / 自建反代 / 本地服务走同一条路。
          */}
          <div className={s.divider} role="separator" aria-label="音乐生成渠道" />
          <h4 className={s.groupTitle}>音乐生成渠道</h4>
          <p className={s.hint} style={{ marginBottom: 8 }}>
            端点**可填任意基址**(聚合站 / 自建反代),插件不写死厂商。
            没配 = 建音乐任务如实拒绝(`no-music-channel`),面板上也会说清为什么。
            **语音那条在下面单独配** —— 两条互不影响。
          </p>

          <label className={s.field}>
            <span className={s.label}>端点(音乐上游基址)</span>
            <input
              className={s.input}
              value={draft.musicBaseUrl}
              placeholder="https://your-music-aggregator.example/v1"
              onChange={(event) => edit('musicBaseUrl', event.target.value)}
              aria-label="音乐渠道端点"
            />
            <span className={s.hint}>留空 = 没配音乐渠道。这时建音乐任务会如实拒绝(不假装能出)。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>
              密钥 <span className={s.badge}>明文存本机</span>
            </span>
            <input
              className={s.input}
              value={draft.musicApiKey}
              placeholder="聚合站给的 key"
              onChange={(event) => edit('musicApiKey', event.target.value)}
              aria-label="音乐渠道密钥"
            />
            <span className={s.hint}>只用于出网请求;不进项目目录、不进快照、不进任务账本。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>渠道名(随便填,只为在面板/账本里指认)</span>
            <input
              className={s.input}
              value={draft.musicChannelName}
              placeholder="音乐聚合站"
              onChange={(event) => edit('musicChannelName', event.target.value)}
              aria-label="音乐渠道名"
            />
          </label>

          <AudioModelPicker
            purpose="music"
            baseUrl={draft.musicBaseUrl}
            apiKey={draft.musicApiKey}
            rows={musicChoices}
            disabled={status === 'saving' || !scope.writable}
            onChange={(next: AudioModelRow[], json: string) => {
              // 顺序与图像那条一样:先写文本(它触发同步),**再**落选择状态 ——
              // 反过来会让刚点的那一下被同步覆盖(checkbox 弹回去)。
              edit('musicModels', json)
              setMusicChoices(next)
            }}
          />

          <details className={s.field}>
            <summary className={s.hint}>高级:直接看/改目录 JSON(排查用)</summary>
            <textarea
              className={`${s.input} ${s.textarea}`}
              value={draft.musicModels}
              placeholder={MUSIC_MODEL_EXAMPLE}
              rows={7}
              onChange={(event) => edit('musicModels', event.target.value)}
              aria-label="音乐模型目录"
            />
            <span className={s.hint}>
              `adapter` 只能是 `sync-http`(一次拿回)或 `async-task`(提交后轮询);
              **认不出的值会整条跳过**(不猜默认协议)。
              聚合站可在 `note` 里覆盖路径与模型名:`submit=…;record=…;model=V6`。
              <br />
              这一栏里**只该有音乐模型**(`purpose: "music"`)—— 混进语音的会被过滤掉,
              因为那条模型属于下面那条渠道。
            </span>
            {audioProblem !== null ? <span className={s.error}>{audioProblem}</span> : null}
          </details>

          {/*
            ─── 语音(TTS)生成渠道 ──────────────────────────────────────────
            典型形态是**本机服务**(IndexTTS 那种),与音乐那条八竿子打不着 —— 所以分开填。
          */}
          <div className={s.divider} role="separator" aria-label="语音生成渠道" />
          <h4 className={s.groupTitle}>语音(TTS)生成渠道</h4>
          <p className={s.hint} style={{ marginBottom: 8 }}>
            本地服务(如 IndexTTS 的 `app_api.py`)填 `http://127.0.0.1:9005` 即可。
            没配 = 建语音任务如实拒绝(`no-voice-channel`);但**不配也能做语音** ——
            走「语音批量清单」那条不花额度的路(导出 → 本地工具 → 按 id 导回)。
          </p>

          <label className={s.field}>
            <span className={s.label}>端点(语音服务基址)</span>
            <input
              className={s.input}
              value={draft.voiceBaseUrl}
              placeholder="http://127.0.0.1:9005(本地 TTS)"
              onChange={(event) => edit('voiceBaseUrl', event.target.value)}
              aria-label="语音渠道端点"
            />
            <span className={s.hint}>留空 = 没配语音渠道。这时建语音任务会如实拒绝(不假装能出)。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>
              密钥 <span className={s.badge}>明文存本机</span>
            </span>
            <input
              className={s.input}
              value={draft.voiceApiKey}
              placeholder="本地服务通常留空"
              onChange={(event) => edit('voiceApiKey', event.target.value)}
              aria-label="语音渠道密钥"
            />
            <span className={s.hint}>只用于出网请求;不进项目目录、不进快照、不进任务账本。</span>
          </label>

          <label className={s.field}>
            <span className={s.label}>渠道名(随便填,只为在面板/账本里指认)</span>
            <input
              className={s.input}
              value={draft.voiceChannelName}
              placeholder="本地 TTS"
              onChange={(event) => edit('voiceChannelName', event.target.value)}
              aria-label="语音渠道名"
            />
          </label>

          <AudioModelPicker
            purpose="voice"
            baseUrl={draft.voiceBaseUrl}
            apiKey={draft.voiceApiKey}
            rows={voiceChoices}
            disabled={status === 'saving' || !scope.writable}
            onChange={(next: AudioModelRow[], json: string) => {
              edit('voiceModels', json)
              setVoiceChoices(next)
            }}
          />

          <details className={s.field}>
            <summary className={s.hint}>高级:直接看/改目录 JSON(排查用)</summary>
            <textarea
              className={`${s.input} ${s.textarea}`}
              value={draft.voiceModels}
              placeholder={VOICE_MODEL_EXAMPLE}
              rows={7}
              onChange={(event) => edit('voiceModels', event.target.value)}
              aria-label="语音模型目录"
            />
            <span className={s.hint}>
              嗓子里写在 `note`:`speaker=default;audio=参考音频.wav;lang=ZH`。
              能力那一栏是 TTS 专有的(能不能克隆音色、能不能指定音色 id、收不收参考音频)。
              <br />
              这一栏里**只该有语音模型**(`purpose: "voice"`)—— 混进音乐的会被过滤掉。
            </span>
            {voiceProblem !== null ? <span className={s.error}>{voiceProblem}</span> : null}
          </details>

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
