/**
 * 客户端共享类型:视图对象由接缝派生,前端只读。
 *
 * 这里刻意不再定义一套"前端自己的进度模型" —— 进度是推导的(ADR-0008),
 * 客户端拿到什么就渲染什么,所以类型与 src/routes.ts 的响应形状一一对应,
 * 没有第二处真相。
 */
import type {
  BibleChapterView, BibleProgressView, BibleView, BranchGraphView, CharacterBoardEntryView, GenerationAttemptView, GenerationTaskView,
  ImageChannelView, ProgressView,
  SceneFormView, SceneProgressView, SceneRowView, SdkView, SlotBoardEntryView, SlotLedgerView,
  SlotProgressView, SnapshotEntry, StateView, TreeNode,
} from './api.ts'

export type {
  BibleChapterView, BibleProgressView, BibleView, BranchGraphView, CharacterBoardEntryView as CharacterBoardEntry,
  GenerationAttemptView, GenerationTaskView, ImageChannelView,
  ProgressView, SceneFormView, SceneProgressView, SceneRowView, SdkView, SlotBoardEntryView as SlotBoardEntry,
  SlotLedgerView, SlotProgressView, SnapshotEntry, StateView, TreeNode,
}

/** 盖戳目标:场景与素材槽共用一个判别联合,替代散落的 `scene:${x}` 魔法串。 */
export type StampTarget =
  | { kind: 'scene'; label: string }
  | { kind: 'slot'; slot: string }

export function stampKey(target: StampTarget): string {
  return target.kind === 'scene' ? `scene:${target.label}` : `slot:${target.slot}`
}

export interface NoticeItem {
  id: number
  tone: 'bad' | 'warn'
  text: string
}

/** 印章样式由 `stamp` 直接决定 —— UI 不做第二次判断。 */
export type SealState = 'approved' | 'stale' | 'pending'
