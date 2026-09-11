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
  /** 新建项目的默认父目录(空 = 未配置,面板要显式提醒先选一个)。 */
  defaultProjectsRoot: string
}

/** 目录选择能力(宿主 `ctx.directoryPicker` 的形态)。 */
export interface PickerCapability {
  kind: 'native' | 'browse' | 'none' | string
  note?: string
  /** 面板内目录浏览器恒可用(宿主后端缺席时由插件自带底座兜底)。 */
  browse: boolean
  /** 宿主屏幕上的 OS 选择器是否可用(有则更好,不是前置条件)。 */
  native: boolean
  defaultProjectsRoot: string
}

/** 一层目录(只含子目录;按名排序)。 */
export interface DirectoryListing {
  path: string
  home: string
  crumbs: Array<{ name: string; path: string }>
  entries: Array<{ name: string; path: string; hidden: boolean }>
  truncated: boolean
  /** host = 宿主 browse 后端;plugin = 插件自带底座。 */
  source?: 'host' | 'plugin'
}

/** 素材槽账本条目(制作信息;槽清单本身从 .rpy 派生)。 */
export interface SlotLedgerView {
  slot: string
  requiresCharacters: string[]
  prompt?: string
  artStyleAnchor?: string
  note?: string
}

/** 登记角色的草稿(面板表单的形状)。 */
export interface CharacterDraft {
  id: string
  name: string
  voice: string
  styleAnchor: string
  hair: string
  eyes: string
  outfit: string
}

export interface CharacterUpsertPayload {
  id: string
  name: string
  voice?: string
  appearance: Record<string, string>
  styleAnchor?: string
  references?: Array<{ path: string; slot?: string; note?: string }>
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

/** 章节:标题 + 梗概 + 覆盖的 label(引用,不是正文)。 */
export interface BibleChapterView {
  id: string
  title: string
  outline?: string
  scenes: string[]
}

/** 设定集(T9):第一记忆源 —— 主题 / 世界观 / 章节 / 对登记簿与原文的引用。 */
export interface BibleView {
  schemaVersion: 1
  theme?: string
  world?: string
  chapters: BibleChapterView[]
  outline: { path: string; fingerprint: string; chars: number; importedAt: string } | null
  characters: Array<{ id: string }>
  updatedAt: string
}

/** 设定集在板上的处境:戳与原文指纹都是推导的。 */
export interface BibleProgressView {
  stamp: string
  chapters: number
  characters: number
  hasOutline: boolean
  outlineFingerprintOk: boolean
}

/** 角色登记簿条目(素材板角色视图的数据源)。 */
export interface CharacterRecordView {
  id: string
  name: string
  voice?: string
  appearance: Record<string, string>
  styleAnchor?: string
  references: Array<{ path: string; slot?: string; note?: string }>
  note?: string
}

export interface ProgressView {
  scenes: SceneProgressView[]
  /** 素材板:`.rpy` 派生的槽清单(挂账本 + 推导状态)。 */
  slots: SlotBoardEntryView[]
  /** 素材板:角色登记簿 + 推导出来的可见性。 */
  characters: CharacterBoardEntryView[]
  /** 设定集处境(戳 + 原文指纹比对)。 */
  bible: BibleProgressView
  problems: DialectProblemView[]
  lint: { ok: boolean; errors: number; warnings: number }
  playtest: { at: string; state: 'pass' | 'fail' | 'stale'; exitCode: number; technicalPass: boolean; traceback: string | null } | null
  summary: { scenes: number; missingDialogue: number; missingSlots: number; lintErrors: number; awaitingReview: number; degraded: number; playtestFail: number; playtestNotRun: number }
  degraded: boolean
}

/** 素材槽账本条目(制作信息;槽清单本身从 .rpy 派生)。 */
export interface SlotLedgerView {
  slot: string
  requiresCharacters: string[]
  prompt?: string
  artStyleAnchor?: string
  note?: string
}

/** 槽的完整视图 = 推导状态 + 账本 + 定位。 */
export interface SlotBoardEntryView extends SlotProgressView {
  ledger?: SlotLedgerView
  origin: { file: string; line: number; snippet: string; scenes: string[] }
}

/** 角色的完整视图 = 登记簿 + 推导出来的可见性。 */
export interface CharacterBoardEntryView {
  id: string
  name: string
  voice?: string
  appearance: Record<string, string>
  styleAnchor?: string
  references: Array<{ path: string; slot?: string; note?: string }>
  note?: string
  defined: boolean
  scriptDisplayName?: string
  definedAt?: { file: string; line: number }
  slots: string[]
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

  /** 目录选择能力:面板据此决定入口形态(OS 选择器 / 应用内浏览 / 隐藏)。 */
  async picker(): Promise<PickerCapability> {
    return readJson(await fetch('/api/galfree/picker'))
  }

  /**
   * 打开宿主屏幕上的 OS 目录选择器。取消 → `{ path: null, cancelled: true }`。
   * 原生对话框会一直等到人操作,所以这条请求的等待时间由人的操作决定。
   */
  async pickDirectory(): Promise<{ path: string | null; cancelled: boolean }> {
    return readJson(await fetch('/api/galfree/picker/pick', { method: 'POST' }))
  }

  /** 应用内浏览:列举一层目录(不给 path 则列举宿主账户家目录)。 */
  async listDirectory(path?: string): Promise<DirectoryListing> {
    const qs = path === undefined || path === '' ? '' : `?path=${encodeURIComponent(path)}`
    return readJson(await fetch(`/api/galfree/picker/list${qs}`))
  }

  /** 应用内浏览:在父目录下建一个子目录(单段名),返回新目录。 */
  async createDirectory(parent: string, name: string): Promise<{ path: string; name: string }> {
    return readJson(await fetch('/api/galfree/picker/create-directory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: parent, name }),
    }))
  }

  /** 手输路径的即时校验:这个位置现在是不是一个能放项目的目录。 */
  async inspectPath(path: string): Promise<{ path: string; exists: boolean; isDirectory: boolean }> {
    return readJson(await fetch(`/api/galfree/picker/inspect?path=${encodeURIComponent(path)}`))
  }

  /** 素材板账本(读):角色登记簿 + 槽账本。 */
  async cast(): Promise<{ characters: CharacterUpsertPayload[]; slots: SlotLedgerView[] }> {
    return readJson(await fetch('/api/galfree/cast'))
  }

  /** 登记/更新一个角色(经网关写 → 自动快照)。 */
  async upsertCharacter(payload: CharacterUpsertPayload): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/cast/characters/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  async removeCharacter(id: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/cast/characters/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }))
  }

  /** 给一个槽挂/改制作信息(经网关写 → 自动快照)。 */
  async upsertSlot(payload: SlotLedgerView): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/cast/slots/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  async removeSlot(slot: string): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/cast/slots/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot }),
    }))
  }

  // ─── 设定集(T9)───────────────────────────────────────────────────────

  async bible(): Promise<{ bible: BibleView; outline: string | null }> {
    return readJson(await fetch('/api/galfree/bible'))
  }

  /** 局部更新设定集(主题/世界观/章节)。改动会让定稿戳待复审。 */
  async patchBible(patch: { theme?: string; world?: string; chapters?: BibleChapterView[] }): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/bible/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  }

  /** 导入人写大纲:**逐字保留**,只记指纹。 */
  async importOutline(text: string): Promise<{ chars: number }> {
    return readJson(await fetch('/api/galfree/bible/import-outline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }))
  }

  /** 盖「设定定稿」戳(只有人能盖)。 */
  async stampBible(): Promise<void> {
    await readJson<unknown>(await fetch('/api/galfree/bible/stamp', { method: 'POST' }))
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
