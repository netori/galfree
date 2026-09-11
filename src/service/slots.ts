/**
 * 素材槽派生(纯函数)—— T8 兑现 ADR-0009 铁律的地方。
 *
 * **槽清单从 `.rpy` 的图像引用推导**,不从 `.studio/` 派生(`.rpy` 是叙述与分支结构的
 * 唯一真相)。`.studio/slots.json` 只往上**挂制作信息**(要谁出场、提示词、画风锚)。
 *
 * 悬空引用是两个方向的,都算校验错误:
 *  1. 账本挂了制作信息,但 `.rpy` 里没有任何语句引用这个槽 → `dangling-slot-ref`;
 *  2. 账本要求某角色出场,但登记簿里没有这个 id → `dangling-character-ref`。
 *
 * 反方向("`.rpy` 里有 `define X = Character(...)` 但登记簿没登记")**只是 warning**:
 * 剧本可以先写、设定后补,那是工作周期而不是结构缺陷。
 */
import type { DialectProblem, ParsedScript, SceneNode, Statement } from './rpy/dialect.ts'
import type { CharacterRecord, SlotRecord } from './characters.ts'
import { slotAssetPath, slotName } from './slot-naming.ts'

/** 槽第一次被引用的位置:板的定位能力(出错时人要知道去哪改)。 */
export interface SlotOrigin {
  file: string
  line: number
  /** 触发这次引用的原始语句(引用,不是内容副本)。 */
  snippet: string
  /** 引用过这个槽的场景 label。 */
  scenes: string[]
}

export interface DerivedSlot {
  slot: string
  assetPath: string
  origin: SlotOrigin
  /** 账本挂上来的制作信息(缺省 = 没挂过)。 */
  ledger?: SlotRecord
}

export interface DeriveSlotsInput {
  /** 完整解析结果(场景 + 角色定义),用于派生与对账。 */
  parsed: Pick<ParsedScript, 'scenes' | 'characters'>
  ledger: SlotRecord[]
  /** 角色登记簿(判 `dangling-character-ref` 用)。 */
  characters: CharacterRecord[]
}

export interface DeriveSlotsResult {
  slots: DerivedSlot[]
  /** 悬空引用 + 登记对账(纯派生,不落盘)。 */
  problems: DialectProblem[]
}

/** 从场景语句里抽出待填槽引用(show/scene;hide 不是待填槽)。 */
function slotReferences(scene: SceneNode): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = []
  for (const statement of scene.statements) {
    if (statement.kind !== 'image') continue
    if (statement.role !== 'show' && statement.role !== 'scene') continue
    const name = slotName(statement)
    if (name.trim() === '' || found.some((entry) => entry.name === name)) continue
    found.push({ name, line: statement.line })
  }
  return found
}

/** 语句原文(定位用):从场景原始文本块里按行号取那一行。 */
function lineOf(scene: SceneNode, line: number): string {
  const offset = line - scene.line
  return scene.text.split('\n')[offset]?.trim() ?? ''
}

export function deriveSlots(input: DeriveSlotsInput): DeriveSlotsResult {
  const ledgerBySlot = new Map(input.ledger.map((record) => [record.slot, record]))
  const order: string[] = []
  const bySlot = new Map<string, DerivedSlot>()

  for (const scene of input.parsed.scenes) {
    for (const reference of slotReferences(scene)) {
      const existing = bySlot.get(reference.name)
      if (existing === undefined) {
        order.push(reference.name)
        bySlot.set(reference.name, {
          slot: reference.name,
          assetPath: slotAssetPath(reference.name),
          origin: {
            file: scene.file,
            line: reference.line,
            snippet: lineOf(scene, reference.line),
            scenes: [scene.label],
          },
        })
      } else if (!existing.origin.scenes.includes(scene.label)) {
        existing.origin.scenes.push(scene.label)
      }
    }
  }

  const problems: DialectProblem[] = []

  // 挂账本 + 方向一:账本里有、剧本里没有 → 悬空。
  for (const record of input.ledger) {
    const derived = bySlot.get(record.slot)
    if (derived === undefined) {
      problems.push({
        severity: 'error',
        file: '.studio/slots.json',
        code: 'dangling-slot-ref',
        message: `素材槽账本挂了「${record.slot}」的制作信息,但 .rpy 里没有任何 show/scene 引用它(悬空引用)`,
        snippet: record.slot,
      })
      continue
    }
    derived.ledger = record
  }

  // 方向二:账本要求的角色不在登记簿里 → 悬空。
  // 定位落在**引用这个槽的那条 .rpy 语句**上(而不是账本文件):人是在剧本里用到了
  // 这个槽,问题才会在运行时咬人 —— 板要能指回那一行。
  const knownCharacters = new Set(input.characters.map((character) => character.id))
  for (const record of input.ledger) {
    const derived = bySlot.get(record.slot)
    for (const id of record.requiresCharacters) {
      if (knownCharacters.has(id)) continue
      const where = derived?.origin
      problems.push({
        severity: 'error',
        file: where?.file ?? '.studio/slots.json',
        ...(where === undefined ? {} : { line: where.line }),
        code: 'dangling-character-ref',
        message: `素材槽「${record.slot}」要求角色「${id}」出场,但角色登记簿里没有这个 id(悬空引用)`
          + (where === undefined ? '' : `;槽在 ${where.file}:${where.line} 被引用`),
        snippet: where?.snippet ?? record.slot,
      })
    }
  }

  // 反方向(只是 warning):.rpy 里有 Character 定义,登记簿却还没登记。
  const registeredVoices = new Set(
    input.characters.map((character) => character.voice).filter((voice): voice is string => voice !== undefined && voice !== ''),
  )
  for (const defined of input.parsed.characters) {
    if (registeredVoices.has(defined.var)) continue
    problems.push({
      severity: 'warning',
      file: defined.file,
      line: defined.line,
      code: 'unregistered-character',
      message: `剧本里的角色「${defined.var}」还没进角色登记簿(设定可后补,但跨场景一致性锚会缺)`,
      snippet: defined.var,
    })
  }

  return { slots: order.map((slot) => bySlot.get(slot)!), problems }
}
