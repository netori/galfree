/**
 * 素材槽命名(纯函数)—— 槽名与约定素材路径的**唯一出处**。
 *
 * 单独成文是因为它被三处共用:推导引擎(progress)、槽派生(slots)、盖戳守卫
 * (project-service 校验"未填不能盖")。三处若各写一份,迟早漂移成"这个槽到底指哪张图"
 * 的分歧。
 */
import type { Statement } from './rpy/dialect.ts'

/** 槽名:tag + 属性(与解析器 image 语句一致)。 */
export function slotName(statement: Extract<Statement, { kind: 'image' }>): string {
  return [statement.tag, ...statement.attributes].join(' ')
}

/** 槽名 → 约定素材路径:`tag attr1 attr2` → `game/images/tag-attr1-attr2.png`。 */
export function slotAssetPath(slot: string): string {
  return `game/images/${slot.trim().split(/\s+/).join('-')}.png`
}
