/**
 * 快照(ADR-0011):写网关每批提交后的本地 git commit,作者标识 GALFree。
 * 划界:永不 push(不配 remote)、永不改写用户手动提交(只追加)。
 */
import { GalfreeError } from './error.ts'
import { runGit, runGitRaw } from './git.ts'
import type { WriteBatchReason } from './write-gateway.ts'

export interface SnapshotEntry {
  /** 查询的目标文件(相对项目根)。 */
  path: string
  /** 完整 commit hash。 */
  commit: string
  /** commit 标题(message 首行)。 */
  subject: string
  /** 作者名。 */
  author: string
  /** ISO 时间。 */
  at: string
}

/** 批次上下文 → commit message(发起侧/环节/场景/槽位 + 原因)。 */
export function snapshotMessage(reason: WriteBatchReason, batchId: number): string {
  const bits = [`origin:${reason.origin}`, `stage:${reason.reason}`]
  if (reason.scene !== undefined) bits.push(`scene:${reason.scene}`)
  if (reason.slot !== undefined) bits.push(`slot:${reason.slot}`)
  return `snapshot(galfree): ${bits.join(' ')} batch#${batchId}`
}

/** 追加一个快照提交(整树:add --all → 允许空提交,批次即事实)。 */
export async function commitSnapshot(root: string, reason: WriteBatchReason, batchId: number): Promise<void> {
  await runGit(root, ['add', '--all'])
  await runGit(root, ['commit', '--no-gpg-sign', '--allow-empty', '--author', 'GALFree <galfree@dsh.local>', '-m', snapshotMessage(reason, batchId)])
}

/** 单文件历史(最新在前)。 */
export async function fileHistory(root: string, relPath: string): Promise<SnapshotEntry[]> {
  const out = await runGit(root, ['log', '--format=%H%x00%s%x00%an%x00%cI%x00', '--', relPath])
  if (out.trim() === '') return []
  const entries: SnapshotEntry[] = []
  for (const chunk of out.split('\n').filter((line) => line.trim() !== '')) {
    const [commit, subject, author, at] = chunk.split('\0')
    if (commit === undefined || subject === undefined) continue
    entries.push({ path: relPath, commit, subject, author: author ?? '', at: at ?? '' })
  }
  return entries
}

/** 单文件两版本间 diff。 */
export async function fileDiff(root: string, relPath: string, fromCommit: string, toCommit: string): Promise<string> {
  return runGit(root, ['diff', fromCommit, toCommit, '--', relPath])
}

/**
 * 回滚一个文件到历史版本。**经写网关落盘**(CAS:目标文件的当前版本由调用方
 * 现读),回滚本身成为新快照(不改写历史)。
 */
export async function rollbackFile(
  root: string,
  relPath: string,
  toCommit: string,
  write: (ops: Array<{ path: string; content: string | null; expectVersion?: string }>, reason: WriteBatchReason) => Promise<WriteResultLike>,
  currentVersion: string,
): Promise<WriteResultLike> {
  let content: string
  try {
    content = await runGitRaw(root, ['show', `${toCommit}:${relPath}`])
  } catch {
    throw new GalfreeError('rollback-target-missing', `历史 ${toCommit} 中不存在 ${relPath}`)
  }
  return write([{ path: relPath, content, expectVersion: currentVersion }], { origin: 'workbench', reason: `rollback:${relPath}@${toCommit.slice(0, 8)}` })
}

/** 回滚写批的结果形状(与网关 WriteResult 兼容)。 */
export interface WriteResultLike {
  versions: Record<string, string>
  batchId: number
}
