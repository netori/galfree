/**
 * 客户端共享类型:视图对象由接缝派生,前端只读。
 *
 * 这里刻意不再定义一套"前端自己的进度模型" —— 进度是推导的(ADR-0008),
 * 客户端拿到什么就渲染什么,所以类型与 src/routes.ts 的响应形状一一对应,
 * 没有第二处真相。
 */
import type {
  BibleChapterView, BibleProgressView, BibleView, BranchGraphView, CharacterBoardEntryView, DialectProblemView, GenerationAttemptView, GenerationTaskView,
  ImageChannelView, NextActionView, ProgressView,
  SceneFormView, SceneProgressView, SceneRowView, SdkView, SlotBoardEntryView, SlotLedgerView,
  SlotProgressView, SnapshotEntry, StageSyncReport, StageView, StampBatchReport, StampPendingKind, StateView, TreeNode,
} from './api.ts'

export type {
  BibleChapterView, BibleProgressView, BibleView, BranchGraphView, CharacterBoardEntryView as CharacterBoardEntry, DialectProblemView,
  GenerationAttemptView, GenerationTaskView, ImageChannelView, NextActionView,
  ProgressView, SceneFormView, SceneProgressView, SceneRowView, SdkView, SlotBoardEntryView as SlotBoardEntry,
  SlotLedgerView, SlotProgressView, SnapshotEntry, StageSyncReport, StageView, StampBatchReport, StampPendingKind, StateView, TreeNode,
}

/** 盖戳目标:场景与素材槽共用一个判别联合,替代散落的 `scene:${x}` 魔法串。 */
export type StampTarget =
  | { kind: 'scene'; label: string }
  | { kind: 'slot'; slot: string }

export function stampKey(target: StampTarget): string {
  return target.kind === 'scene' ? `scene:${target.label}` : `slot:${target.slot}`
}

/**
 * 两个批量动作在 `busyKey` 里的 key —— 主面板设置、舞台板读它显示"忙在哪一件事上"。
 * 常量只有这一处:两处各写一遍字面量,迟早一处改了名,另一处的 spinner 就不转了。
 *
 *  · `STAMP_PENDING_KEY`:完整 key = `stamp-pending:<kind>`(kind = all / scene / slot / bible)。
 *  · `STAGE_SYNC_KEY`:整备舞台同时只可能有一个在跑。
 */
export const STAMP_PENDING_KEY = 'stamp-pending'
export const STAGE_SYNC_KEY = 'stage-sync'

export interface NoticeItem {
  id: number
  tone: 'bad' | 'warn'
  text: string
}

/** 印章样式由 `stamp` 直接决定 —— UI 不做第二次判断。 */
export type SealState = 'approved' | 'stale' | 'pending'
