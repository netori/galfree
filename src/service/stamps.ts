/**
 * 审读戳账本(`.studio/stamps.json`)。戳只由人盖(seam 守卫:agent 一律拒绝);
 * **戳记内容指纹**——重生成(内容指纹变化)时,盖过的戳在推导中自动呈现为
 * "待复审(stale)",不改写历史条目(ADR-0008:客观算得出的一律推导)。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GalfreeError } from './error.ts'

export interface StampRecord {
  /** 目标:`scene:<label>` 或 `slot:<槽id>`。 */
  target: string
  /** 盖戳时该目标的内容指纹(场景=语句哈希;槽=素材文件哈希)。 */
  fingerprint: string
  /** 盖戳时间(信息字段;失效判定只看指纹)。 */
  at: string
}

interface StampsDocument {
  schemaVersion: 1
  stamps: StampRecord[]
}

export const STAMPS_FILE = '.studio/stamps.json'

export async function readStamps(root: string): Promise<StampRecord[]> {
  try {
    const doc = JSON.parse(await readFile(join(root, STAMPS_FILE), 'utf8')) as StampsDocument
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.stamps)) throw new Error('shape')
    return doc.stamps
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new GalfreeError('stamps-corrupt', `审读戳账本无法解析:${String(error)}`)
  }
}

export function stampsDocument(stamps: StampRecord[]): string {
  return JSON.stringify({ schemaVersion: 1, stamps } satisfies StampsDocument, null, 2) + '\n'
}

/** 人盖戳:同一 target 覆盖旧记录(再盖即再认可当前指纹)。 */
export function withStamp(stamps: StampRecord[], target: string, fingerprint: string): StampRecord[] {
  const rest = stamps.filter((stamp) => stamp.target !== target)
  return [...rest, { target, fingerprint, at: new Date().toISOString() }]
}

/** 戳目标 id 拼装(唯一命名,推导与盖戳共用)。 */
export const sceneTarget = (label: string): string => `scene:${label}`
export const slotTarget = (slot: string): string => `slot:${slot}`
