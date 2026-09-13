/**
 * 素材板(T8):角色视图 + 槽视图 —— **纯渲染派生对象,没有出图动作**(出图是 T14/T15)。
 *
 * 判断都在接缝里:
 *   · 槽清单 → 从 `.rpy` 图像引用派生(`deriveSlots`);
 *   · 槽状态(待填/已填/待复审/已过审)→ 推导(文件在不在 + 指纹比对 + 戳账本);
 *   · 角色在剧本里有没有 → 推导(解析出的 Character 与登记簿对账);
 *   · 悬空引用 → 推导进 problems,lint 汇总与舞台板同源。
 * 这个组件只负责把这些讲清楚,并把人/agent 写制作信息的动作送回接缝。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CharacterBoardEntry, ImageChannelView, SlotBoardEntry } from './types.ts'
import type { CharacterDraft, GalfreeApi, GenerationTaskView } from './api.ts'
import { ArtToolbar, SlotArtActions, StateChip } from './art-actions.tsx'
import { DifferentialBoard } from './differential-board.tsx'
import { Chip, Notice, Spinner } from './ui.tsx'
import s from './panel.module.css'

const STAMP_LABEL: Record<string, string> = {
  none: '未认可', pending: '待认可', approved: '已过审', stale: '待复审', missing: '未填',
}

/**
 * 渠道处境(T14):**只读**一行 —— 面板不藏"到底能不能出图"这件事。
 * 没配渠道、目录里没模型,都在这里如实说;出图按钮属 T15。
 */
function ChannelStatus({ api, hasProject }: { api: GalfreeApi; hasProject: boolean }) {
  const [channel, setChannel] = useState<ImageChannelView | null>(null)

  useEffect(() => {
    if (!hasProject) { setChannel(null); return }
    let alive = true
    void (async () => {
      try {
        const next = await api.imageChannel()
        if (alive) setChannel(next)
      } catch {
        if (alive) setChannel(null)
      }
    })()
    return () => { alive = false }
  }, [api, hasProject])

  if (!hasProject || channel === null) return null

  if (!channel.configured) {
    return (
      <div className={s.emptyHint} style={{ marginBottom: 10 }}>
        还没配置图像渠道 —— 到「设置 → 插件 → 插件配置」里的 GALFree 卡填端点、密钥与模型目录。
        缺渠道时出图动作会如实拒绝,不会假装能出。
      </div>
    )
  }
  return (
    <div className={s.emptyHint} style={{ marginBottom: 10 }}>
      渠道:{channel.name ?? channel.baseUrl} · 模型 {channel.models.length} 个
      {channel.apiKeyConfigured ? '' : ' · 没配密钥'}
      {channel.models.length === 0 ? '(目录是空的:填 imageModels 之前,建任务会被拒)' : ''}
    </div>
  )
}

export function AssetBoard({ characters, slots, api, hasProject, onChanged, onNotice }: {
  characters: CharacterBoardEntry[]
  slots: SlotBoardEntry[]
  api: GalfreeApi
  hasProject: boolean
  /** 写完账本 → 让主面板重取派生状态(推导会立刻反映出来)。 */
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [tab, setTab] = useState<'slots' | 'characters' | 'differentials'>('slots')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 出图任务账本(T15):进度与重试历史都读它 —— 与 agent 工具面同源。 */
  const [tasks, setTasks] = useState<GenerationTaskView[]>([])
  /** 封面/主菜单/图标(T30)的草案:目标 + 模型 + 提示词。 */
  const [coverDraft, setCoverDraft] = useState({ target: 'main_menu', model: '', prompt: '' })
  /** 封面规格表(从接缝读;尺寸不在面板里写死 —— 那张表是唯一出处)。 */
  const [coverTargets, setCoverTargets] = useState<Array<{ id: string; path: string; expected: string; note: string }>>([])

  /** 封面:读**规格表**(路径与尺寸的唯一出处是接缝;面板不写死)。 */
  useEffect(() => {
    if (!hasProject) { setCoverTargets([]); return }
    let alive = true
    void (async () => {
      try {
        const specs = await api.coverTargets()
        if (alive) setCoverTargets(specs)
      } catch { /* 读不到规格就不显示那一段(面板主体照常) */ }
    })()
    return () => { alive = false }
  }, [api, hasProject])

  /** 建一个封面任务并立刻跑 —— 会真花一次上游额度,所以按钮上写明是"出图"而不是"排队"。 */
  const createCover = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.createCoverTask({ ...coverDraft, prompt: coverDraft.prompt.trim(), run: true })
      onNotice('warn', '封面任务跑了 —— 请人看一眼("这封面行不行"只有人能说);不满意可重 roll 并记下理由。')
      await loadTasks()
      await onChanged()
    } catch (cause) {
      onNotice('bad', `封面没出成:${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const missing = slots.filter((slot) => !slot.filled)
  const awaiting = slots.filter((slot) => slot.stamp === 'stale')

  const loadTasks = useCallback(async (): Promise<void> => {
    if (!hasProject) { setTasks([]); return }
    try {
      const result = await api.generationTasks()
      setTasks(result.tasks)
    } catch { /* 读不到任务就当没有:面板主体照常 */ }
  }, [api, hasProject])

  useEffect(() => { void loadTasks() }, [loadTasks])

  /** 有任务在排队/执行时轮询 —— 进度是推出来的,面板不自己攒状态。 */
  const inFlight = tasks.some((task) => task.state === 'queued' || task.state === 'running')
  useEffect(() => {
    if (!inFlight) return
    const timer = window.setInterval(() => { void loadTasks(); void onChanged() }, 2500)
    return () => window.clearInterval(timer)
  }, [inFlight, loadTasks, onChanged])

  /** 槽 → 它最近一个任务(账本最新在前,所以第一个命中的就是)。 */
  const taskFor = (slot: string): GenerationTaskView | undefined => tasks.find((task) => task.slot === slot)

  return (
    <section className={s.card} id="gf-asset-board" tabIndex={-1} aria-label="素材板">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>素材板</span>
        <span className={s.cardCount}>
          {hasProject ? `${slots.length} 槽 · ${characters.length} 角色 · 槽清单派生自 .rpy` : '账本形态'}
        </span>
        <span className={s.cardOps}>
          <span className={s.tabs} role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'slots'}
              className={[s.tab, tab === 'slots' ? s.tabActive : undefined].filter(Boolean).join(' ')}
              onClick={() => setTab('slots')}>槽视图</button>
            <button type="button" role="tab" aria-selected={tab === 'characters'}
              className={[s.tab, tab === 'characters' ? s.tabActive : undefined].filter(Boolean).join(' ')}
              onClick={() => setTab('characters')}>角色视图</button>
            <button type="button" role="tab" aria-selected={tab === 'differentials'}
              className={[s.tab, tab === 'differentials' ? s.tabActive : undefined].filter(Boolean).join(' ')}
              onClick={() => setTab('differentials')}>差分对比</button>
          </span>
        </span>
      </div>

      <div className={s.cardBody}>
        {!hasProject ? (
          <div className={s.empty}>没有激活项目,或项目目录已不在磁盘上。</div>
        ) : tab === 'slots' ? (
          <>
            <div className={s.chips} style={{ marginBottom: 10 }}>
              <Chip tone={missing.length === 0 ? 'ok' : 'warn'} num={missing.length} dot>待填</Chip>
              <Chip tone={awaiting.length === 0 ? 'ok' : 'warn'} num={awaiting.length} dot>待复审</Chip>
              {inFlight ? <Chip tone="warn" dot>出图中</Chip> : null}
              <span className={s.emptyHint}>出图由 Host 直连执行,不消耗对话回合</span>
            </div>
            <ChannelStatus api={api} hasProject={hasProject} />
            {coverTargets.length > 0 ? (
              // 封面 / 主菜单 / 图标(T30):这三张是 Ren'Py 的界面生成器**不覆盖**的那三张。
              // 规格(路径与尺寸)全从接缝读 —— 面板不写死,免得两处各说一个尺寸。
              <div className={s.form} style={{ marginBottom: 10 }}>
                <label className={s.field}>
                  <span className={s.fieldLabel}>封面 / 主菜单 / 图标</span>
                  <select className={s.input} value={coverDraft.target}
                    onChange={(event) => setCoverDraft({ ...coverDraft, target: event.target.value })}>
                    {coverTargets.map((target) => (
                      <option key={target.id} value={target.id}>{target.id} · {target.expected}</option>
                    ))}
                  </select>
                </label>
                <label className={s.field}>
                  <span className={s.fieldLabel}>模型 id</span>
                  <input className={s.input} placeholder="见上面的渠道模型清单" value={coverDraft.model}
                    onChange={(event) => setCoverDraft({ ...coverDraft, model: event.target.value })} />
                </label>
                <label className={s.field}>
                  <span className={s.fieldLabel}>提示词(风格 / 情绪 / 画面)</span>
                  <input className={s.input} placeholder="雨天的天台,主视觉,冷色调" value={coverDraft.prompt}
                    onChange={(event) => setCoverDraft({ ...coverDraft, prompt: event.target.value })} />
                </label>
                <button type="button" className={`${s.button} ${s.primary}`}
                  disabled={busy || coverDraft.model.trim() === '' || coverDraft.prompt.trim() === ''}
                  onClick={() => void createCover()}
                  title="建任务并**立刻跑** —— 会真花一次上游额度">
                  {busy ? <Spinner /> : '出封面(立刻跑)'}
                </button>
              </div>
            ) : null}
            <ArtToolbar
              api={api}
              hasProject={hasProject}
              missingCount={missing.length}
              onChanged={async () => { await loadTasks(); await onChanged() }}
              onNotice={onNotice}
            />
            {slots.length === 0 ? (
              <div className={s.empty}>
                <div className={s.emptyTitle}>还没有素材槽</div>
                <div className={s.emptyHint}>槽从剧本的 scene/show 语句派生 —— 写一场戏,它自己就出现了。</div>
              </div>
            ) : (
              <div>
                {slots.map((slot) => (
                  <SlotRow
                    key={slot.slot}
                    slot={slot}
                    task={taskFor(slot.slot)}
                    api={api}
                    busy={busy}
                    onBusy={setBusy}
                    onError={setError}
                    onChanged={async () => { await loadTasks(); await onChanged() }}
                    onNotice={onNotice}
                  />
                ))}
              </div>
            )}
          </>
        ) : tab === 'characters' ? (
          <CharacterView
            characters={characters}
            api={api}
            busy={busy}
            onBusy={setBusy}
            onError={setError}
            onChanged={onChanged}
          />
        ) : (
          <DifferentialBoard
            api={api}
            hasProject={hasProject}
            onChanged={onChanged}
            onNotice={onNotice}
          />
        )}

        {error !== null ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="bad" onDismiss={() => setError(null)}>{error}</Notice>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** 一个槽:名字/路径/状态 + 账本制作信息 + **出图动作**(T15)。 */
function SlotRow({ slot, task, api, busy, onBusy, onError, onChanged, onNotice }: {
  slot: SlotBoardEntry
  task: GenerationTaskView | undefined
  api: GalfreeApi
  busy: boolean
  onBusy: (value: boolean) => void
  onError: (message: string | null) => void
  onChanged: () => Promise<void> | void
  onNotice: (tone: 'bad' | 'warn', text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => ({
    prompt: slot.ledger?.prompt ?? '',
    artStyleAnchor: slot.ledger?.artStyleAnchor ?? '',
    requiresCharacters: (slot.ledger?.requiresCharacters ?? []).join(', '),
  }))

  const save = async (): Promise<void> => {
    onBusy(true)
    onError(null)
    try {
      await api.upsertSlot({
        slot: slot.slot,
        prompt: draft.prompt.trim(),
        artStyleAnchor: draft.artStyleAnchor.trim(),
        requiresCharacters: draft.requiresCharacters.split(',').map((id) => id.trim()).filter((id) => id !== ''),
      })
      await onChanged()
    } catch (error) {
      onError(`槽「${slot.slot}」存不了:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      onBusy(false)
    }
  }

  return (
    <div>
      <div className={s.sceneRow}>
        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'}槽 ${slot.slot} 的制作信息`} onClick={() => setOpen(!open)}>
          {open ? '−' : '+'}
        </button>
        <span className={s.sceneLabel} title={slot.slot}>{slot.slot}</span>
        <span className={s.sceneWhere} title={`${slot.origin.file}:${slot.origin.line}`}>
          {slot.origin.file}:{slot.origin.line}
        </span>
        <span className={s.sceneMarks}>
          <Chip tone={slot.filled ? 'ok' : 'warn'}>{slot.filled ? '已填' : '待填'}</Chip>
          <Chip tone={slot.stamp === 'approved' ? 'ok' : slot.stamp === 'stale' ? 'warn' : 'quiet'}>
            {STAMP_LABEL[slot.stamp] ?? slot.stamp}
          </Chip>
          {slot.origin.scenes.map((scene) => <Chip key={scene} tone="quiet">{scene}</Chip>)}
        </span>
        <span className={s.sceneStamp}>
          {task !== undefined ? <StateChip state={task.state} /> : null}
          {slot.ledger === undefined ? <Chip tone="quiet">未挂制作信息</Chip> : <Chip tone="none">已挂账</Chip>}
        </span>
      </div>
      {open ? (
        <div className={s.sceneDetail}>
          <div className={s.rootPath}>{slot.assetPath}</div>
          <div className={s.chips} style={{ marginTop: 6 }}>
            <span className={s.emptyHint}>
              {slot.filled
                ? '素材文件已在磁盘上,所以板上是"已填";换一张就用「重 roll」,它会把上一版记进历史。'
                : '素材文件还不存在时,板上就是"待填";出图后自动变"已填"。'}
            </span>
          </div>
          {/* T15:出图动作面(生成此槽 / 重 roll / 重试历史)。 */}
          <SlotArtActions
            slot={slot.slot}
            task={task}
            api={api}
            disabled={busy}
            onChanged={onChanged}
            onNotice={onNotice}
          />
          <div className={s.form} style={{ marginTop: 8 }}>
            <label className={`${s.field} ${s.fieldRoot}`}>
              <span className={s.fieldLabel}>生成提示词 · 图像子系统的输入</span>
              <input className={s.input} value={draft.prompt} placeholder="小棠微笑,半身,校服,柔和逆光"
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </label>
            <label className={`${s.field} ${s.fieldRoot}`}>
              <span className={s.fieldLabel}>画风锚 · 留空则用角色的</span>
              <input className={s.input} value={draft.artStyleAnchor} placeholder="clean anime lineart, soft cel shading"
                onChange={(e) => setDraft({ ...draft, artStyleAnchor: e.target.value })} />
            </label>
            <label className={`${s.field} ${s.fieldRoot}`}>
              <span className={s.fieldLabel}>出场角色 · 登记簿 id,逗号分隔</span>
              <input className={s.input} value={draft.requiresCharacters} placeholder="xiao_tang"
                onChange={(e) => setDraft({ ...draft, requiresCharacters: e.target.value })} />
            </label>
            <button type="button" className={`${s.button} ${s.primary}`} disabled={busy} onClick={() => void save()}>
              {busy ? <Spinner /> : slot.ledger === undefined ? '挂上制作信息' : '更新制作信息'}
            </button>
            {slot.ledger !== undefined ? (
              <button type="button" className={s.button} disabled={busy} onClick={() => {
                onBusy(true)
                void api.removeSlot(slot.slot).then(onChanged).catch((e) => onError(String(e))).finally(() => onBusy(false))
              }}>移除账本</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 角色视图:登记簿 + 推导出来的"剧本里有没有它 / 哪些槽要它出场" + **参考链编辑**(T16)。
 *
 * 参考链是差分一致性的根:**主视觉出好之后,人在这里把它登记进链** —— 之后这个角色
 * 所有的表情/姿势差分建任务时都会自动带上它(见「差分对比」页)。链只存路径与备注,
 * 不是图片内容;路径跳不出项目(接缝会拦)。
 */
function CharacterView({ characters, api, busy, onBusy, onError, onChanged }: {
  characters: CharacterBoardEntry[]
  api: GalfreeApi
  busy: boolean
  onBusy: (value: boolean) => void
  onError: (message: string | null) => void
  onChanged: () => Promise<void> | void
}) {
  const [draft, setDraft] = useState<CharacterDraft>({ id: '', name: '', voice: '', styleAnchor: '', hair: '', eyes: '', outfit: '' })
  const [adding, setAdding] = useState(characters.length === 0)
  /** 正在编辑参考链的角色 id(一次只开一个:链是短列表,不需要同时开一堆)。 */
  const [chainFor, setChainFor] = useState<string | null>(null)
  const [chainText, setChainText] = useState('')

  const save = async (): Promise<void> => {
    onBusy(true)
    onError(null)
    try {
      await api.upsertCharacter({
        id: draft.id.trim(),
        name: draft.name.trim(),
        voice: draft.voice.trim(),
        appearance: {
          ...(draft.hair.trim() === '' ? {} : { hair: draft.hair.trim() }),
          ...(draft.eyes.trim() === '' ? {} : { eyes: draft.eyes.trim() }),
          ...(draft.outfit.trim() === '' ? {} : { outfit: draft.outfit.trim() }),
        },
        styleAnchor: draft.styleAnchor.trim(),
      })
      setDraft({ id: '', name: '', voice: '', styleAnchor: '', hair: '', eyes: '', outfit: '' })
      setAdding(false)
      await onChanged()
    } catch (error) {
      onError(`角色存不了:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      onBusy(false)
    }
  }

  /** 保存这个角色的参考链:整条替换(空行忽略;`路径 | 备注` 两段式)。 */
  const saveChain = async (character: CharacterBoardEntry): Promise<void> => {
    onBusy(true)
    onError(null)
    try {
      const references = chainText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [path, note] = line.split('|').map((part) => part.trim())
          return { path: path ?? '', ...(note === undefined || note === '' ? {} : { note }) }
        })
      await api.upsertCharacter({
        id: character.id,
        name: character.name,
        ...(character.voice === undefined ? {} : { voice: character.voice }),
        appearance: character.appearance,
        ...(character.styleAnchor === undefined ? {} : { styleAnchor: character.styleAnchor }),
        references,
      })
      setChainFor(null)
      await onChanged()
    } catch (error) {
      onError(`「${character.name}」的参考链存不了:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      onBusy(false)
    }
  }

  return (
    <>
      <div className={s.chips} style={{ marginBottom: 10 }}>
        <Chip tone="quiet" num={characters.length}>登记在册</Chip>
        <span className={s.emptyHint}>登记簿是跨场景一致性的锚(同一张脸);它只存制作信息,不存台词</span>
        <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} onClick={() => setAdding(!adding)}>
          {adding ? '收起' : '新增角色'}
        </button>
      </div>

      {characters.length === 0 && !adding ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>登记簿还是空的</div>
          <div className={s.emptyHint}>剧本里的角色会被推导成"未登记"缺口;在这里补上外观设定卡与画风锚。</div>
        </div>
      ) : null}

      {characters.map((character) => (
        <div key={character.id}>
          <div className={s.sceneRow}>
            <span className={s.sceneLabel} title={character.id}>{character.name}</span>
            <span className={s.sceneWhere} title={character.voice === undefined ? '未绑定剧本角色' : `剧本变量 ${character.voice}`}>
              {character.voice ?? '未绑定'}
            </span>
            <span className={s.sceneMarks}>
              {character.defined
                ? <Chip tone="ok" title={character.definedAt === undefined ? undefined : `${character.definedAt.file}:${character.definedAt.line}`}>
                  剧本里有{character.scriptDisplayName === undefined ? '' : `(${character.scriptDisplayName})`}
                </Chip>
                : <Chip tone="warn">剧本里还没有它</Chip>}
              {Object.entries(character.appearance).filter(([, value]) => value !== undefined && value !== '').slice(0, 3).map(([key, value]) => (
                <Chip key={key} tone="quiet" title={`${key}: ${value}`}>{value}</Chip>
              ))}
              {character.slots.length > 0 ? <Chip tone="none" num={character.slots.length}>要用它的槽</Chip> : null}
              {character.styleAnchor === undefined || character.styleAnchor === '' ? <Chip tone="warn">缺画风锚</Chip> : null}
              {/* 参考链处境:链空 = 差分没有锚(不是错,但人该知道)。 */}
              {character.references.length === 0
                ? <Chip tone="warn" title="参考链是空的:这个角色的差分只能靠 prompt 描述保持一致">参考链空</Chip>
                : <Chip tone="ok" num={character.references.length} title={character.references.map((reference) => reference.path).join('\n')}>参考链</Chip>}
            </span>
            <span className={s.sceneStamp}>
              <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={busy}
                aria-expanded={chainFor === character.id}
                onClick={() => {
                  if (chainFor === character.id) { setChainFor(null); return }
                  setChainFor(character.id)
                  // 打开时把现有链填进输入框(每行一条:`路径 | 备注`)。
                  setChainText(character.references.map((reference) => (reference.note === undefined ? reference.path : `${reference.path} | ${reference.note}`)).join('\n'))
                }}>
                {chainFor === character.id ? '收起参考链' : '参考链'}
              </button>
              <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={busy} onClick={() => {
                onBusy(true)
                void api.removeCharacter(character.id).then(onChanged).catch((e) => onError(String(e))).finally(() => onBusy(false))
              }}>移除</button>
            </span>
          </div>

          {chainFor === character.id ? (
            <div className={s.sceneDetail}>
              <label className={`${s.field} ${s.fieldRoot}`}>
                <span className={s.fieldLabel}>参考图链 · 每行一条,可写“路径 | 备注”</span>
                <textarea
                  className={s.input}
                  style={{ minHeight: 72, width: '100%', fontFamily: 'ui-monospace, monospace' }}
                  value={chainText}
                  placeholder={'game/images/xiao_tang-base.png | 主视觉\n(先在剧本里 show 出这些槽并出图,链才带得上它们)'}
                  onChange={(event) => setChainText(event.target.value)}
                  aria-label={`角色 ${character.id} 的参考图链`}
                />
              </label>
              <div className={s.form} style={{ marginTop: 6 }}>
                <button type="button" className={`${s.button} ${s.primary}`} disabled={busy} onClick={() => void saveChain(character)}>
                  {busy ? <Spinner /> : '保存参考链'}
                </button>
                <span className={s.formHint}>
                  链上的图是「差分的锚」:出这个角色的表情/姿势差分时会自动带上它(远端收到的是图片本体,不是项目内路径)。
                  只登记「已经出好」的那张;引用了不存在的文件会在板上如实标「缺图」。
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ))}

      {adding ? (
        <div className={s.form} style={{ marginTop: 10 }}>
          <label className={`${s.field} ${s.fieldName}`}>
            <span className={s.fieldLabel}>id · slug</span>
            <input className={s.input} value={draft.id} placeholder="xiao_tang"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldName}`}>
            <span className={s.fieldLabel}>显示名</span>
            <input className={s.input} value={draft.name} placeholder="小棠"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldTitle}`}>
            <span className={s.fieldLabel}>剧本变量 · 可选</span>
            <input className={s.input} value={draft.voice} placeholder="xiao_tang"
              onChange={(e) => setDraft({ ...draft, voice: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldTitle}`}>
            <span className={s.fieldLabel}>发型/发色</span>
            <input className={s.input} value={draft.hair} placeholder="黑色长直发"
              onChange={(e) => setDraft({ ...draft, hair: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldTitle}`}>
            <span className={s.fieldLabel}>瞳色</span>
            <input className={s.input} value={draft.eyes} placeholder="琥珀色"
              onChange={(e) => setDraft({ ...draft, eyes: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldTitle}`}>
            <span className={s.fieldLabel}>服装</span>
            <input className={s.input} value={draft.outfit} placeholder="深蓝水手服"
              onChange={(e) => setDraft({ ...draft, outfit: e.target.value })} />
          </label>
          <label className={`${s.field} ${s.fieldRoot}`}>
            <span className={s.fieldLabel}>画风锚 · 生成时强制带上</span>
            <input className={s.input} value={draft.styleAnchor} placeholder="clean anime lineart, soft cel shading"
              onChange={(e) => setDraft({ ...draft, styleAnchor: e.target.value })} />
          </label>
          <button type="button" className={`${s.button} ${s.primary}`}
            disabled={busy || draft.id.trim() === '' || draft.name.trim() === ''} onClick={() => void save()}>
            {busy ? <Spinner /> : '登记'}
          </button>
          <span className={s.formHint}>
            id 只允许小写字母/数字/-/_;外观卡存制作信息,长度有上限(挡住把正文抄进设定卡)。
          </span>
        </div>
      ) : null}
    </>
  )
}
