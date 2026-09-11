/**
 * 角色登记簿(`.studio/characters.json`)—— 跨场景保持一致性的锚。
 *
 * 铁律(ADR-0009):`.studio/` **只放引用与制作信息,永不复制叙述内容**。
 * 所以这里存的是"怎么画出这张脸"的制作信息(外观设定卡 / 画风锚 / 参考图链),
 * 以及**对 `.rpy` 的引用**(`voice` = 剧本里 `define <var> = Character(...)` 的变量名),
 * 而不是台词、场景正文这类叙述内容 —— 那些的唯一真相永远是 `.rpy`。
 *
 * 与 stamps.ts 同款分工:读/序列化 + 一个纯列表变换;落盘一律由 ProjectService 走网关。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GalfreeError } from './error.ts'

/**
 * 外观设定卡:结构化字段,不是散文。
 * 结构化才能被图像子系统当一致性锚用;散文描述塞不出稳定的画风。
 */
export interface AppearanceCard {
  /** 发色/发型。 */
  hair?: string
  /** 瞳色。 */
  eyes?: string
  /** 服装。 */
  outfit?: string
  /** 体型/年龄感。 */
  build?: string
  /** 其他外观要点。 */
  notes?: string
}

/** 参考图链的一环:一张已经产出的图 + 它在槽清单里的来源。 */
export interface ReferenceImage {
  /** 项目内相对路径(如 game/images/xiao_tang-smile.png)。 */
  path: string
  /** 这个参考是从哪个素材槽来的(可缺省:人工挑的参考图)。 */
  slot?: string
  /** 人为这条参考写的备注(为什么挑它)。 */
  note?: string
}

export interface CharacterRecord {
  /** 稳定 id(slug);引用与引用检查都用它。 */
  id: string
  /** 显示名(可与 `.rpy` 里的 Character 显示名不同,便于改设定不改剧本)。 */
  name: string
  /** `.rpy` 里 `define <var> = Character("…")` 的变量名 —— 对剧本的**引用**。 */
  voice?: string
  appearance: AppearanceCard
  /** 画风锚:生成时强制带上的一致性提示词(图像子系统的输入)。 */
  styleAnchor?: string
  /** 参考图链(新→旧或旧→新皆可,顺序即人挑的顺序)。 */
  references: ReferenceImage[]
  /** 制作备注(人写给自己的,不是叙述内容)。 */
  note?: string
}

interface CharactersDocument {
  schemaVersion: 1
  characters: CharacterRecord[]
}

export const CHARACTERS_FILE = '.studio/characters.json'

/** 登记簿条目上限:防止把整部小说写进"设定卡"。 */
export const MAX_FIELD_CHARS = 600

/** 冒号前必须是合法标识符:它是 `.rpy` 变量名的引用。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export async function readCharacters(root: string): Promise<CharacterRecord[]> {
  try {
    const doc = JSON.parse(await readFile(join(root, CHARACTERS_FILE), 'utf8')) as CharactersDocument
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.characters)) throw new Error('shape')
    return doc.characters
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new GalfreeError('characters-corrupt', `角色登记簿无法解析:${String(error)}`)
  }
}

export function charactersDocument(characters: CharacterRecord[]): string {
  return `${JSON.stringify({ schemaVersion: 1, characters } satisfies CharactersDocument, null, 2)}\n`
}

/**
 * 校验一条登记簿条目。**在写之前拦**,而不是写进 `.studio/` 再让别人去猜:
 *  - id 必须是 slug,`voice` 必须是合法标识符(它引用 `.rpy` 变量);
 *  - 所有文本字段有长度上限(挡住"把叙述内容抄进设定卡"这条最可能的违规路径)。
 */
export function assertCharacterValid(record: CharacterRecord): void {
  if (!ID_RE.test(record.id)) {
    throw new GalfreeError('character-invalid', `角色 id 需匹配 ${ID_RE}:${record.id}`)
  }
  if (record.name.trim() === '') {
    throw new GalfreeError('character-invalid', '角色需要一个显示名')
  }
  if (record.voice !== undefined && record.voice !== '' && !IDENT_RE.test(record.voice)) {
    throw new GalfreeError('character-invalid', `voice 必须是 .rpy 里的标识符(如 xiao_tang):${record.voice}`)
  }
  const texts: Array<[string, string | undefined]> = [
    ['name', record.name],
    ['styleAnchor', record.styleAnchor],
    ['note', record.note],
    ['appearance.hair', record.appearance.hair],
    ['appearance.eyes', record.appearance.eyes],
    ['appearance.outfit', record.appearance.outfit],
    ['appearance.build', record.appearance.build],
    ['appearance.notes', record.appearance.notes],
  ]
  for (const [field, value] of texts) {
    if (value !== undefined && value.length > MAX_FIELD_CHARS) {
      throw new GalfreeError('character-invalid', `${field} 太长(${value.length} > ${MAX_FIELD_CHARS} 字):设定卡存制作信息,不存叙述内容`)
    }
  }
  for (const reference of record.references) {
    if (reference.path.trim() === '') {
      throw new GalfreeError('character-invalid', '参考图需要项目内相对路径')
    }
    if (reference.path.startsWith('/') || /^[A-Za-z]:/.test(reference.path) || reference.path.split('/').includes('..')) {
      throw new GalfreeError('character-invalid', `参考图必须是项目内相对路径(不许跳出项目):${reference.path}`)
    }
  }
}

/** 新增或覆盖一个角色(同 id 即再认可当前设定)。纯函数,落盘交给调用方走网关。 */
export function upsertCharacter(characters: CharacterRecord[], record: CharacterRecord): CharacterRecord[] {
  assertCharacterValid(record)
  const normalized: CharacterRecord = {
    ...record,
    name: record.name.trim(),
    references: [...record.references],
  }
  const rest = characters.filter((character) => character.id !== record.id)
  return [...rest, normalized]
}

/** 移除一个角色(不存在即原样返回,不报错 —— 幂等)。 */
export function removeCharacter(characters: CharacterRecord[], id: string): CharacterRecord[] {
  return characters.filter((character) => character.id !== id)
}

// ─── 素材槽账本(.studio/slots.json)────────────────────────────────────

/**
 * 素材槽的**制作信息**(人/agent 怎么把它画出来)。
 *
 * 槽本身**不从账本派生** —— 槽清单永远从 `.rpy` 的图像引用推导(ADR-0009:`.rpy` 是
 * 唯一真相)。账本只是挂在推导出来的槽上的制作备注:要谁出场、提示词、画风锚。
 * 因此"槽在账本里有、但 .rpy 里没人引用"= 悬空引用 = 校验错误。
 */
export interface SlotRecord {
  /** 槽名 = `tag 属性…`(与 .rpy 的 show/scene 语句一致)。 */
  slot: string
  /** 生成这张图必须保持一致的出场角色(引用登记簿 id)。 */
  requiresCharacters: string[]
  /** 生成提示词(图像子系统的输入)。 */
  prompt?: string
  /** 这一槽的画风锚(缺省 = 用角色的)。 */
  artStyleAnchor?: string
  /** 制作备注。 */
  note?: string
}

interface SlotsDocument {
  schemaVersion: 1
  slots: SlotRecord[]
}

export const SLOTS_FILE = '.studio/slots.json'

export async function readSlots(root: string): Promise<SlotRecord[]> {
  try {
    const doc = JSON.parse(await readFile(join(root, SLOTS_FILE), 'utf8')) as SlotsDocument
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.slots)) throw new Error('shape')
    // 容错历史骨架:模板早期只写 `{slot}` 没写 requiresCharacters。
    return doc.slots.map((slot) => ({ ...slot, requiresCharacters: slot.requiresCharacters ?? [] }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new GalfreeError('slots-corrupt', `素材槽账本无法解析:${String(error)}`)
  }
}

export function slotsDocument(slots: SlotRecord[]): string {
  return `${JSON.stringify({ schemaVersion: 1, slots } satisfies SlotsDocument, null, 2)}\n`
}

export function assertSlotValid(record: SlotRecord): void {
  if (record.slot.trim() === '') throw new GalfreeError('slot-invalid', '素材槽需要一个槽名(tag 属性…)')
  for (const [field, value] of [['prompt', record.prompt], ['artStyleAnchor', record.artStyleAnchor], ['note', record.note]] as Array<[string, string | undefined]>) {
    if (value !== undefined && value.length > MAX_FIELD_CHARS) {
      throw new GalfreeError('slot-invalid', `${field} 太长(${value.length} > ${MAX_FIELD_CHARS} 字):账本存制作信息,不存叙述内容`)
    }
  }
  for (const id of record.requiresCharacters) {
    if (!ID_RE.test(id)) throw new GalfreeError('slot-invalid', `requiresCharacters 需要登记簿 id:${id}`)
  }
}

/** 新增/覆盖一个槽的制作信息(纯函数;落盘交给调用方走网关)。 */
export function upsertSlot(slots: SlotRecord[], record: SlotRecord): SlotRecord[] {
  assertSlotValid(record)
  const rest = slots.filter((slot) => slot.slot !== record.slot)
  return [...rest, { ...record, requiresCharacters: [...record.requiresCharacters] }]
}

/** 移除一个槽的制作信息(幂等)。 */
export function removeSlot(slots: SlotRecord[], slot: string): SlotRecord[] {
  return slots.filter((entry) => entry.slot !== slot)
}
