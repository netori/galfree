/**
 * /api/galfree 路由族的浏览器端客户端 —— 唯一数据通道(同源 fetch)。
 * 视图类型与 src/routes.ts 的响应形状对齐(接缝状态的呈现层)。
 */
export interface ProjectView {
  id: string
  name: string
  title: string
  root: string
  createdAt: string
  active: boolean
  missing: boolean
}

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  children?: TreeNode[]
}

export interface StateView {
  projects: ProjectView[]
  activeId: string | null
  tree: TreeNode[]
  activeRoot: string | null
  activeMissing: boolean
  gatewayErrors: Array<{ batchId: number; kind: string; message: string; at: string }>
}

export class GalfreeApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'GalfreeApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GalfreeApiError(`HTTP ${response.status}: 非 JSON 响应`)
  }
  if (!response.ok) {
    const message = typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : `HTTP ${response.status}`
    const code = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : undefined
    throw new GalfreeApiError(message, code)
  }
  return body as T
}

export interface SnapshotEntry {
  path: string
  commit: string
  subject: string
  author: string
  at: string
}

export interface SlotProgressView {
  slot: string
  assetPath: string
  filled: boolean
  fingerprint: string
  stamp: string
  /** 人能否盖戳 —— 由接缝判定,UI 不复述规则。 */
  approvable: boolean
  approvableBlockedBy?: string
}

/** 舞台上那一行要显示的派生事实(由推导引擎给出,UI 只渲染)。 */
export interface SceneMarkView {
  code: string
  severity: 'info' | 'warn' | 'error'
  label: string
  count?: number
  detail?: string
}

export interface SceneProgressView {
  label: string
  file: string
  line: number
  readOnly: boolean
  missingDialogue: boolean
  dialogueCount: number
  slots: SlotProgressView[]
  missingSlots: string[]
  stamp: string
  stampable: boolean
  stampableBlockedBy?: string
  lintErrors: number
  marks: SceneMarkView[]
}

/** 方言子集外的结构问题(如实上板,不吞)。 */
export interface DialectProblemView {
  severity: 'error' | 'warning'
  file: string
  line?: number
  code: string
  message: string
  snippet?: string
}

export interface ProgressView {
  scenes: SceneProgressView[]
  problems: DialectProblemView[]
  lint: { ok: boolean; errors: number; warnings: number }
  playtest: { at: string; state: 'pass' | 'fail' | 'stale'; exitCode: number; technicalPass: boolean; traceback: string | null } | null
  summary: { scenes: number; missingDialogue: number; missingSlots: number; lintErrors: number; awaitingReview: number; degraded: number; playtestFail: number; playtestNotRun: number }
  degraded: boolean
}

export interface SdkView {
  requested: 'override' | 'pinned' | string
  dir: string
  launcherReady: boolean
  version?: string
  mismatch?: { pinned: string; actual: string }
  provision: { state: string; progress: { fraction: number; message?: string }; error?: string }
}

export class GalfreeApi {
  async state(): Promise<StateView> {
    return readJson<StateView>(await fetch('/api/galfree/state'))
  }

  async progress(): Promise<ProgressView> {
    return readJson<ProgressView>(await fetch('/api/galfree/progress'))
  }

  async stampScene(label: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/stamps/scene', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }))
  }

  async playtest(): Promise<{ at: string; exitCode: number; technicalPass: boolean; traceback: string | null }> {
    const body = await readJson<{ run: { at: string; exitCode: number; technicalPass: boolean; traceback: string | null } }>(await fetch('/api/galfree/playtest', { method: 'POST' }))
    return body.run
  }

  async createProject(name: string, title?: string, projectsRoot?: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/projects/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, title, projectsRoot }),
    }))
  }

  /**
   * 切换激活项目。spec 原把切换 UI 划在 v1 外(US29「切换 UI 后补」);
   * 本入口经发起人明确批准解除该延迟,只动注册表激活位,不写任何项目文件。
   */
  async activateProject(project: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/projects/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project }),
    }))
  }

  /** 文件当前内容(只读预览;读走网关口径 = 磁盘为真)。 */
  async fileContent(path: string): Promise<{ path: string; content: string; version: string; bytes: number }> {
    return readJson(await fetch(`/api/galfree/files/content?path=${encodeURIComponent(path)}`))
  }

  /** 回滚一个文件到历史版本(本身是一次写,走网关 → 自动产生回滚快照)。 */
  async rollbackFile(path: string, to: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/snapshots/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, to }),
    }))
  }

  /** SDK 供给状态(T5;首次下载进度可见)。 */
  async sdk(): Promise<SdkView> {
    return readJson(await fetch('/api/galfree/sdk'))
  }

  /** 素材槽级审读戳(T15 前补:接缝早就有 stampSlot,缺的是入口)。 */
  async stampSlot(slot: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/stamps/slot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot }),
    }))
  }

  async sdkEnsure(): Promise<{ state: string; error: string | null; progress: { fraction: number; message?: string } }> {
    return readJson(await fetch('/api/galfree/sdk/ensure', { method: 'POST' }))
  }

  async snapshots(relPath: string): Promise<SnapshotEntry[]> {
    const body = await readJson<{ history: SnapshotEntry[] }>(await fetch(`/api/galfree/snapshots?path=${encodeURIComponent(relPath)}`))
    return body.history
  }

  async snapshotDiff(relPath: string, from: string, to: string): Promise<string> {
    const qs = new URLSearchParams({ path: relPath, from, to }).toString()
    const body = await readJson<{ diff: string }>(await fetch(`/api/galfree/snapshots/diff?${qs}`))
    return body.diff
  }
}
