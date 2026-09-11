/**
 * 推导进度引擎(ADR-0008):阶段板 = (项目文件 + 结构解析 + 校验 + 审读戳)
 * 的**纯函数推导** —— 可全量重算、幂等,任何侧不得手改进度字段。
 *
 * 客观可算的一律推导:缺对白、素材槽缺没缺(文件在不在)、lint 过没过、
 * 戳过没盖过 / 盖了但内容又变了(待复审)。算不出的(主观认可)才是戳。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DialectProblem, SceneNode, Statement } from './rpy/dialect.ts'
import { readStamps, sceneTarget, slotTarget } from './stamps.ts'

export type StampState = 'none' | 'pending' | 'approved' | 'stale' | 'missing'

export interface SlotProgress {
  slot: string
  /** 约定素材路径(相对项目根);由槽名派生。 */
  assetPath: string
  filled: boolean
  /** 素材文件指纹(内容哈希),缺=absent。 */
  fingerprint: string
  stamp: StampState
}

export interface SceneProgress {
  label: string
  file: string
  line: number
  /** 子集外语法 → 只读降级(与 T4 同源)。 */
  readOnly: boolean
  missingDialogue: boolean
  dialogueCount: number
  slots: SlotProgress[]
  missingSlots: string[]
  /** 场景级审读戳状态。 */
  stamp: StampState
  lintErrors: number
}

export interface ProgressSummary {
  scenes: number
  missingDialogue: number
  missingSlots: number
  lintErrors: number
  /** 盖过戳但内容已变(待复审)的戳数(场景 + 槽)。 */
  awaitingReview: number
  degraded: number
}

export interface ProgressSnapshot {
  scenes: SceneProgress[]
  /** 顶层(非场景内)结构问题。 */
  problems: DialectProblem[]
  lint: { ok: boolean; errors: number; warnings: number }
  summary: ProgressSummary
  degraded: boolean
}

/** 槽名 → 约定素材路径:`tag attr1 attr2` → game/images/tag-attr1-attr2.png。 */
export function slotAssetPath(slot: string): string {
  const slug = slot.trim().split(/\s+/).join('-')
  return `game/images/${slug}.png`
}

/** 槽名:tag + 属性(空格分隔),与解析器 image 语句一致。 */
export function slotName(statement: Extract<Statement, { kind: 'image' }>): string {
  return [statement.tag, ...statement.attributes].join(' ')
}

/** 场景内容指纹:语句结构(去行号)+ label,稳定可重算。 */
export function sceneFingerprint(scene: { label: string; statements: Statement[] }): string {
  const canonical = JSON.stringify({
    label: scene.label,
    statements: scene.statements.map(stripLine),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

function stripLine<T extends { line: number }>(statement: T): Omit<T, 'line'> {
  const { line: _line, ...rest } = statement
  return rest as Omit<T, 'line'>
}

async function assetFingerprint(root: string, assetPath: string): Promise<string> {
  try {
    const bytes = await readFile(join(root, ...assetPath.split('/')))
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  } catch {
    return 'absent'
  }
}

export interface ProgressInputs {
  /** 解析出的场景(来自 parseRpy)。 */
  scenes: SceneNode[]
  /** 顶层结构问题(来自 parseRpy.problems)。 */
  problems: DialectProblem[]
}

/** 纯推导:读磁盘(戳账本 + 素材文件指纹)+ 已解析结构 → 进度快照。 */
export async function computeProgress(root: string, inputs: ProgressInputs): Promise<ProgressSnapshot> {
  const stamps = await readStamps(root)
  const byTarget = new Map(stamps.map((s) => [s.target, s]))

  const seenSlots = new Set<string>()
  const sceneProgress: SceneProgress[] = []
  for (const scene of inputs.scenes) {
    const slotNames: string[] = []
    for (const statement of scene.statements) {
      if (statement.kind === 'image' && (statement.role === 'show' || statement.role === 'scene')) {
        const name = slotName(statement)
        if (name.trim() !== '' && !slotNames.includes(name)) slotNames.push(name)
      }
    }
    const slots: SlotProgress[] = []
    for (const name of slotNames) {
      seenSlots.add(name)
      const assetPath = slotAssetPath(name)
      const fingerprint = await assetFingerprint(root, assetPath)
      const filled = fingerprint !== 'absent'
      const record = byTarget.get(slotTarget(name))
      let stamp: StampState
      if (record === undefined) stamp = filled ? 'pending' : 'missing'
      else stamp = record.fingerprint === fingerprint ? 'approved' : 'stale'
      slots.push({ slot: name, assetPath, filled, fingerprint, stamp })
    }
    const dialogueCount = scene.statements.filter((s) => s.kind === 'dialogue').length
    const sceneRecord = byTarget.get(sceneTarget(scene.label))
    const sceneFp = sceneFingerprint(scene)
    const sceneStamp: StampState = sceneRecord === undefined ? 'none' : sceneRecord.fingerprint === sceneFp ? 'approved' : 'stale'
    const lintErrors = scene.problems.filter((p) => p.severity === 'error').length
    sceneProgress.push({
      label: scene.label,
      file: scene.file,
      line: scene.line,
      readOnly: scene.readOnly,
      missingDialogue: dialogueCount === 0,
      dialogueCount,
      slots,
      missingSlots: slots.filter((s) => !s.filled).map((s) => s.slot),
      stamp: sceneStamp,
      lintErrors,
    })
  }

  // 全局素材槽缺失汇总:跨场景同名槽只计一次(去重后按缺失计)。
  const uniqueSlots = new Map<string, SlotProgress>()
  for (const scene of sceneProgress) for (const slot of scene.slots) if (!uniqueSlots.has(slot.slot)) uniqueSlots.set(slot.slot, slot)

  const lintErrors = inputs.problems.filter((p) => p.severity === 'error').length
    + sceneProgress.reduce((sum, scene) => sum + scene.lintErrors, 0)
  const lintWarnings = inputs.problems.filter((p) => p.severity === 'warning').length

  const awaitingReview = sceneProgress.filter((s) => s.stamp === 'stale').length
    + [...uniqueSlots.values()].filter((s) => s.stamp === 'stale').length

  const summary: ProgressSummary = {
    scenes: sceneProgress.length,
    missingDialogue: sceneProgress.filter((s) => s.missingDialogue).length,
    missingSlots: [...uniqueSlots.values()].filter((s) => !s.filled).length,
    lintErrors,
    awaitingReview,
    degraded: sceneProgress.filter((s) => s.readOnly).length,
  }

  return {
    scenes: sceneProgress,
    problems: inputs.problems,
    lint: { ok: lintErrors === 0, errors: lintErrors, warnings: lintWarnings },
    summary,
    degraded: summary.degraded > 0 || inputs.problems.length > 0,
  }
}
