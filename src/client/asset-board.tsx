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
import { useMemo, useState } from 'react'
import type { CharacterBoardEntry, SlotBoardEntry } from './types.ts'
import type { CharacterDraft, GalfreeApi } from './api.ts'
import { Chip, Notice, Spinner } from './ui.tsx'
import s from './panel.module.css'

const STAMP_LABEL: Record<string, string> = {
  none: '未认可', pending: '待认可', approved: '已过审', stale: '待复审', missing: '未填',
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
  const [tab, setTab] = useState<'slots' | 'characters'>('slots')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const missing = slots.filter((slot) => !slot.filled)
  const awaiting = slots.filter((slot) => slot.stamp === 'stale')

  return (
    <section className={s.card} aria-label="素材板">
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
              <span className={s.emptyHint}>出图动作属 T14/T15,这里只有账本</span>
            </div>
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
                    api={api}
                    busy={busy}
                    onBusy={setBusy}
                    onError={setError}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <CharacterView
            characters={characters}
            api={api}
            busy={busy}
            onBusy={setBusy}
            onError={setError}
            onChanged={onChanged}
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

/** 一个槽:名字/路径/状态 + 账本制作信息(要谁出场、提示词、画风锚)。 */
function SlotRow({ slot, api, busy, onBusy, onError, onChanged }: {
  slot: SlotBoardEntry
  api: GalfreeApi
  busy: boolean
  onBusy: (value: boolean) => void
  onError: (message: string | null) => void
  onChanged: () => Promise<void> | void
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
          {slot.ledger === undefined ? <Chip tone="quiet">未挂制作信息</Chip> : <Chip tone="none">已挂账</Chip>}
        </span>
      </div>
      {open ? (
        <div className={s.sceneDetail}>
          <div className={s.rootPath}>{slot.assetPath}</div>
          <div className={s.chips} style={{ marginTop: 6 }}>
            <span className={s.emptyHint}>素材文件还不存在时,板上就是"待填";出图后自动变"已填"。</span>
          </div>
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

/** 角色视图:登记簿 + 推导出来的"剧本里有没有它 / 哪些槽要它出场"。 */
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
        <div key={character.id} className={s.sceneRow}>
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
          </span>
          <span className={s.sceneStamp}>
            <button type="button" className={`${s.button} ${s.ghost} ${s.tiny}`} disabled={busy} onClick={() => {
              onBusy(true)
              void api.removeCharacter(character.id).then(onChanged).catch((e) => onError(String(e))).finally(() => onBusy(false))
            }}>移除</button>
          </span>
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
