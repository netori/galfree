/**
 * 参考链(登记簿 → 任务参数)—— T16 兑现"跨批次同一张脸"这条承诺的地方。
 *
 * 角色登记簿里的 `references` 是**参考图链**:主视觉 → 表情/姿势差分。[`resolveReferenceChain`]
 * 把它解析成"这个槽这一次要带哪些参考",并**不碰磁盘、不碰网络**(存在性由调用方传进来),
 * 所以它既能给任务用,也能给板用,两边读到的是同一份判断。
 *
 * 四条规矩(都是踩过才知道的):
 *  1. **自引用无意义**:槽把自己的产物当参考 = 循环,直接排除并**如实标注**(不是静默丢掉);
 *  2. **文件不存在的参考发不出去**:远端拿不到一张不存在的图,所以它进 `missing`,
 *     由调用方按"如实降级"的规矩记进任务(绝不假装链生效);
 *  3. **顺序即优先**:登记簿里的顺序就是人挑的顺序,解析不重排(只去重);
 *  4. **登记簿里没有的角色**如实进 `unknownCharacters`(悬空引用由 `deriveSlots` 报 error,
 *     这里只保证"链不凭空多出一个角色")。
 */
import type { CharacterRecord } from './characters.ts'
import { slotAssetPath } from './slot-naming.ts'

/** 链上的一环:一张参考图 + 它的出处(引用,不复制设定卡)。 */
export interface ChainReference {
  /** 项目内相对路径。 */
  path: string
  /** 来自哪个角色的登记簿 id。 */
  character: string
  /** 登记簿里这条参考挂的槽(人登记时写的来源槽)。 */
  slot?: string
  /** 登记簿里这条参考的备注。 */
  note?: string
  /** 此刻磁盘上有没有这张图(没有 = 发不出去)。 */
  exists: boolean
}

export interface ReferenceChainView {
  slot: string
  /** 这个槽自己的约定产物路径(判自引用用)。 */
  assetPath: string
  /** 要带上的参考图(顺序 = 登记簿顺序,按路径去重;含尚不存在的那些)。 */
  references: ChainReference[]
  /** 其中文件已在磁盘上的(能真发出去的那些)。 */
  ready: ChainReference[]
  /** 引用了但文件还不存在的(面板与 agent 都据此如实提示)。 */
  missing: ChainReference[]
  /** 被排除的自引用(链里指回了这个槽自己的产物)。 */
  excludedSelf: string[]
  /** 提供参考的角色 id(顺序 = requiresCharacters)。 */
  characters: string[]
  /** `requiresCharacters` 里登记簿还没有的 id(链不会凭空多出角色)。 */
  unknownCharacters: string[]
}

export interface ResolveReferenceChainInput {
  slot: string
  /** 这个槽要求出场的角色(通常来自槽账本)。 */
  requiresCharacters: string[]
  characters: CharacterRecord[]
  /** 文件在不在 —— 由调用方读盘决定(本模块不碰磁盘)。 */
  exists: (path: string) => boolean
}

export function resolveReferenceChain(input: ResolveReferenceChainInput): ReferenceChainView {
  const assetPath = slotAssetPath(input.slot)
  const byId = new Map(input.characters.map((character) => [character.id, character]))
  const references: ChainReference[] = []
  const excludedSelf: string[] = []
  const characters: string[] = []
  const unknownCharacters: string[] = []
  const seen = new Set<string>()

  for (const id of input.requiresCharacters) {
    const record = byId.get(id)
    if (record === undefined) {
      if (!unknownCharacters.includes(id)) unknownCharacters.push(id)
      continue
    }
    if (!characters.includes(id)) characters.push(id)
    for (const reference of record.references) {
      // 自引用:槽自己的产物出现在链里 —— 排除并标注(排除是推导,标注是人能看见的事实)。
      if (reference.path === assetPath) {
        if (!excludedSelf.includes(reference.path)) excludedSelf.push(reference.path)
        continue
      }
      if (seen.has(reference.path)) continue
      seen.add(reference.path)
      references.push({
        path: reference.path,
        character: id,
        ...(reference.slot === undefined ? {} : { slot: reference.slot }),
        ...(reference.note === undefined ? {} : { note: reference.note }),
        exists: input.exists(reference.path),
      })
    }
  }

  return {
    slot: input.slot,
    assetPath,
    references,
    ready: references.filter((reference) => reference.exists),
    missing: references.filter((reference) => !reference.exists),
    excludedSelf,
    characters,
    unknownCharacters,
  }
}

/**
 * 差分批量的出图顺序:**被别的槽当参考引用的槽排在前面**。
 *
 * 依据是派生事实(谁的产物路径出现在别人的链里),不是"槽名里带 base 的先出"这种启发式
 * —— 名字骗人,引用不会。主视觉先落地,表情/姿势差分才有锚可携。
 *
 * 环(两个槽互相引用)不会死循环:回退到给进来的原顺序(诚实的退化,不假装排过)。
 */
export function sortSlotsByReference(input: {
  /** 要排序的槽(原顺序 = 稳定排序的兜底顺序)。 */
  slots: string[]
  /** 每个槽的链引用路径(通常来自 `resolveReferenceChain(...).references`)。 */
  referencesOf: (slot: string) => string[]
}): string[] {
  const pathToSlot = new Map(input.slots.map((slot) => [slotAssetPath(slot), slot]))
  const dependsOn = new Map<string, Set<string>>()
  for (const slot of input.slots) {
    const deps = new Set<string>()
    for (const path of input.referencesOf(slot)) {
      const upstream = pathToSlot.get(path)
      if (upstream !== undefined && upstream !== slot) deps.add(upstream)
    }
    dependsOn.set(slot, deps)
  }

  const ordered: string[] = []
  const remaining = [...input.slots]
  while (remaining.length > 0) {
    const ready = remaining.find((slot) => [...(dependsOn.get(slot) ?? [])].every((dep) => !remaining.includes(dep)))
    // 剩下的都在环里:按原顺序收尾(不丢槽,也不假装排过)。
    const next = ready ?? remaining[0]!
    ordered.push(next)
    remaining.splice(remaining.indexOf(next), 1)
  }
  return ordered
}
