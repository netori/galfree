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
  stamp: string
}

export interface SceneProgressView {
  label: string
  file: string
  line: number
  readOnly: boolean
  missingDialogue: boolean
  slots: SlotProgressView[]
  missingSlots: string[]
  stamp: string
  lintErrors: number
}

export interface ProgressView {
  scenes: SceneProgressView[]
  lint: { ok: boolean; errors: number; warnings: number }
  playtest: { at: string; state: 'pass' | 'fail' | 'stale'; exitCode: number; technicalPass: boolean; traceback: string | null } | null
  summary: { scenes: number; missingDialogue: number; missingSlots: number; lintErrors: number; awaitingReview: number; degraded: number; playtestFail: number; playtestNotRun: number }
  degraded: boolean
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

  async activate(id: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/projects/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }))
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
