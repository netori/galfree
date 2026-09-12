/**
 * 槽位对比视图(纯函数)—— T16 AC2:同角色差分网格,**渲染自登记簿 + 槽位历史**。
 *
 * 这个模块只做一件事:把三份已有的事实摆到一起 ——
 *  - **登记簿**(谁是主视觉、链上还有哪些参考、哪些文件真的在磁盘上);
 *  - **槽账本 / 派生槽**(这个角色要出哪几格、哪格填了、哪格待复审);
 *  - **任务账本**(每一格历史上出过哪几版、哪一版被人打回过、为什么)。
 *
 * 它不读盘、不写盘、不判断"这张好不好看":主观认可是审读戳(ADR-0008),
 * 这里只把客观事实摆成人能对比的一张网。
 */
import type { SlotBoardEntry, StampState, CharacterBoardEntry } from './progress.ts'
import type { GenerationDegradation, GenerationTask } from './images.ts'

/** 一次尝试在网格里的形态(成功看指纹,失败看原因,被拒看理由)。 */
export interface DifferentialHistoryEntry {
  n: number
  outcome: 'ok' | 'failed'
  at: string
  fingerprint?: string
  /** 这一次覆盖掉的那一版的指纹(版本谱系靠它接起来)。 */
  replacedFingerprint?: string
  error?: string
  /** 人对**这一版**的拒收理由(按尝试号对回 `rejections`)。 */
  rejection?: { note: string; via: 'human' | 'agent'; at: string }
}

export interface DifferentialCell {
  slot: string
  assetPath: string
  /** 主视觉 = 登记簿的参考链指到了这一格的产物;其余是差分。 */
  role: 'main' | 'variant'
  filled: boolean
  stamp: StampState
  awaitingReview: boolean
  /** 当前产物指纹(缺 = `absent`)。 */
  fingerprint: string
  /** 这一格最近一个任务的 id(没有任务 = 缺省;重 roll 要从它走)。 */
  taskId?: string
  /** 槽位历史(来自该槽最近一个任务;老到新)。 */
  history: DifferentialHistoryEntry[]
  /** 最近任务上的降级说明(缺省 = 没降级)。 */
  degradation?: GenerationDegradation
  lastError?: string
}

/** 链上的一环 + 它此刻在不在磁盘上(不在 = 差分这次带不上它)。 */
export interface DifferentialReference {
  path: string
  exists: boolean
  slot?: string
  note?: string
}

export interface DifferentialRow {
  character: string
  name: string
  styleAnchor?: string
  references: DifferentialReference[]
  /** 主视觉那一格的槽名(登记簿没指认出来 = null)。 */
  main: string | null
  cells: DifferentialCell[]
}

export interface DifferentialGrid {
  characters: DifferentialRow[]
}

export interface BuildDifferentialGridInput {
  /** 登记簿 + 派生可见性(来自 `progress.characters`)。 */
  characters: CharacterBoardEntry[]
  /** 派生槽 + 账本 + 推导状态(来自 `progress.slots`)。 */
  slots: SlotBoardEntry[]
  /** 任务账本,**最新在前**(与 `generationTasks()` 同序)。 */
  tasks: GenerationTask[]
  /** 链上的图此刻在不在(存在性由调用方读盘;这里不碰磁盘)。 */
  exists: (path: string) => boolean
}

export function buildDifferentialGrid(input: BuildDifferentialGridInput): DifferentialGrid {
  // 每个槽最近一个任务(账本最新在前,所以第一个命中的就是)。
  const latestTaskOf = new Map<string, GenerationTask>()
  for (const task of input.tasks) if (!latestTaskOf.has(task.slot)) latestTaskOf.set(task.slot, task)

  const characters: DifferentialRow[] = input.characters.map((character) => {
    const references: DifferentialReference[] = character.references.map((reference) => ({
      path: reference.path,
      exists: input.exists(reference.path),
      ...(reference.slot === undefined ? {} : { slot: reference.slot }),
      ...(reference.note === undefined ? {} : { note: reference.note }),
    }))
    const referencePaths = new Set(references.map((reference) => reference.path))

    const cells: DifferentialCell[] = input.slots
      .filter((slot) => slot.ledger?.requiresCharacters.includes(character.id) === true)
      .map((slot) => {
        const task = latestTaskOf.get(slot.slot)
        const rejections = task?.rejections ?? []
        return {
          slot: slot.slot,
          assetPath: slot.assetPath,
          // 主视觉由登记簿指认:链里指到了这一格的产物 —— 不是靠槽名猜。
          // 主视觉由登记簿指认:链里指到了这一格的产物 —— 不是靠槽名猜。
          role: referencePaths.has(slot.assetPath) ? 'main' as const : 'variant' as const,
          filled: slot.filled,
          stamp: slot.stamp,
          awaitingReview: slot.awaitingReview,
          fingerprint: slot.fingerprint,
          ...(task === undefined ? {} : { taskId: task.id }),
          history: (task?.attempts ?? []).map((attempt) => {
            const rejection = rejections.find((entry) => entry.attempt === attempt.n)
            return {
              n: attempt.n,
              outcome: attempt.outcome,
              at: attempt.finishedAt,
              ...(attempt.fingerprint === undefined ? {} : { fingerprint: attempt.fingerprint }),
              ...(attempt.replacedFingerprint === undefined ? {} : { replacedFingerprint: attempt.replacedFingerprint }),
              ...(attempt.error === undefined ? {} : { error: attempt.error }),
              ...(rejection === undefined ? {} : { rejection: { note: rejection.note, via: rejection.via, at: rejection.at } }),
            }
          }),
          ...(task?.degradation === undefined ? {} : { degradation: task.degradation }),
          ...(task?.lastError === undefined ? {} : { lastError: task.lastError }),
        }
      })

    return {
      character: character.id,
      name: character.name,
      ...(character.styleAnchor === undefined ? {} : { styleAnchor: character.styleAnchor }),
      references,
      main: cells.find((cell) => cell.role === 'main')?.slot ?? null,
      cells,
    }
  })

  return { characters }
}
