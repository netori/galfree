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
  /** 有图但还没被人认可(纯推导;T15 的待复审队列读这一个布尔)。 */
  awaitingReview: boolean
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

/** 场景表单的一行(T11):可编辑字段按 kind 取用。 */
export interface SceneRowView {
  kind: string
  line: number
  raw: string
  speaker?: string | null
  text?: string
  role?: 'show' | 'scene' | 'hide'
  tag?: string
  attributes?: string[]
  target?: string
  transition?: string
  seconds?: number | null
  channel?: string
  /** 音频动作(T17):`stop` 行没有文件。 */
  action?: 'play' | 'stop'
  file?: string | null
  loop?: boolean
  choices?: string[]
  note?: string
}

/** 发布(T18):一次构建的产物与状态;产物在**项目源树之外**。 */
export interface PublishArtifactView {
  name: string
  path: string
  bytes: number
}

export interface PublishBlockerView {
  code: string
  label: string
  count?: number
  detail?: string
}

export interface PublishView {
  at: string
  ok: boolean
  destination: string
  packages: string[]
  artifacts: PublishArtifactView[]
  logTail: string
  /** 产物之后内容又变了 → 它代表的不再是当前这一版。 */
  stale: boolean
}

export interface PublishReadinessView {
  ready: boolean
  blockers: PublishBlockerView[]
  destination: string | null
  packages: string[]
  /** 上一次发布的推导视图(没发布过 = null)。 */
  last: PublishView | null
}

/** 一次构建的结果(与接缝的 `PublishRun` 同形)。 */
export interface PublishRunView {
  at: string
  ok: boolean
  packages: string[]
  destination: string
  artifacts: PublishArtifactView[]
  exitCode: number
  logTail: string
  fingerprint: string
}

/** `POST /publish` 的应答:前置结论 + 这一次真跑出来的结果(被阻止时 `run` 缺省)。 */
export interface PublishReportView extends PublishReadinessView {
  ok: boolean
  run?: PublishRunView
}

/** 音频文件池与引用处境(T17;池是派生的,没有手工登记)。 */
export interface AudioPoolView {
  files: Array<{ path: string; bytes: number }>
  references: Array<{
    ref: string
    action: 'play' | 'stop'
    channel: string
    scene: string
    file: string
    line: number
    snippet: string
    found: boolean
    resolved?: string
  }>
  missing: AudioPoolView['references']
  unused: string[]
}

/** 场景表单视图(行模型 + 源文本;两个视图同一份真相)。 */
export interface SceneFormView {
  label: string
  path: string
  file: string
  startLine: number
  endLine: number
  rows: SceneRowView[]
  readOnly: boolean
  readOnlyReason?: string
  source: string
}

/** 分支图(T12):派生骨架的只读视图。 */
export interface BranchGraphView {
  dialect: string
  degraded: boolean
  nodes: Array<{ label: string; file: string; line: number; readOnly: boolean; stamp: string; reason?: string }>
  edges: Array<{ from: string; to: string; via: 'jump' | 'menu' | 'call'; prompt?: string }>
  problems: Array<{ severity: string; file: string; line?: number; code: string; message: string }>
}

/** 项目级完整性处境(T13)。 */
export interface CompletenessView {
  entry: string | null
  orphans: string[]
  endingReachable: boolean
}

export interface NextActionView {
  /** 稳定机器码(面板按它决定要不要跳转,不依赖中文文案)。 */
  code: string
  /** 面向人的一句话(与 agent 读的是同一份)。 */
  label: string
  actor: 'agent' | 'human'
  detail?: string
  target?: { kind: 'bible' | 'scene' | 'slot' | 'audio' | 'playtest' | 'publish'; label?: string; slot?: string; scene?: string; line?: number }
}

export interface ProgressView {
  scenes: SceneProgressView[]
  /** 素材板:`.rpy` 派生的槽清单(挂账本 + 推导状态)。 */
  slots: SlotBoardEntryView[]
  /** 素材板:角色登记簿 + 推导出来的可见性。 */
  characters: CharacterBoardEntryView[]
  /** 设定集处境(戳 + 原文指纹比对)。 */
  bible: BibleProgressView
  /** 项目级完整性(入口 / 孤立场景 / 结局可达)。 */
  completeness: CompletenessView
  /** 音频文件池与引用处境(T17)。 */
  audio: AudioPoolView
  problems: DialectProblemView[]
  lint: { ok: boolean; errors: number; warnings: number }
  playtest: { at: string; state: 'pass' | 'fail' | 'stale'; exitCode: number; technicalPass: boolean; traceback: string | null; from: string | null } | null
  /** 「下一步」(T21):纯推导的行动清单(带 actor 与跳转目标)。 */
  nextActions: NextActionView[]
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

/** 渠道能力视图(T14;密钥永不回传,只有 `apiKeyConfigured`)。 */
export interface ImageChannelView {
  configured: boolean
  name?: string
  baseUrl?: string
  apiKeyConfigured: boolean
  models: Array<{ id: string; label?: string; note?: string; capabilities: Record<string, boolean> }>
}

/** 一次尝试的历史条目(只追加)。 */
export interface GenerationAttemptView {
  n: number
  startedAt: string
  finishedAt: string
  outcome: 'ok' | 'failed'
  error?: string
  fingerprint?: string
  bytes?: number
  /** 被这一次覆盖掉的那一版的指纹(T15:重 roll 保留上一产物为历史)。 */
  replacedFingerprint?: string
}

/** **拒收注记**(T16):人对某一版的否决理由,只追加、指向被拒的那一版。 */
export interface GenerationRejectionView {
  attempt: number
  fingerprint?: string
  note: string
  via: 'human' | 'agent'
  at: string
}

/** 槽位对比视图的一格(T16)。 */
export interface DifferentialCellView {
  slot: string
  assetPath: string
  role: 'main' | 'variant'
  filled: boolean
  stamp: string
  awaitingReview: boolean
  fingerprint: string
  /** 这一格最近一个任务的 id(重 roll 从它走;没有任务 = 缺省)。 */
  taskId?: string
  history: Array<{
    /** 这次尝试属于哪个任务(同一格可能先后有过多个任务)。 */
    taskId: string
    n: number
    outcome: 'ok' | 'failed'
    at: string
    fingerprint?: string
    replacedFingerprint?: string
    error?: string
    rejection?: { note: string; via: 'human' | 'agent'; at: string }
  }>
  degradation?: GenerationTaskView['degradation']
  lastError?: string
}

/** 槽位对比视图的一行 = 一个角色的差分网格(T16)。 */
export interface DifferentialRowView {
  character: string
  name: string
  styleAnchor?: string
  references: Array<{ path: string; exists: boolean; slot?: string; note?: string }>
  main: string | null
  cells: DifferentialCellView[]
}

export interface DifferentialGridView {
  characters: DifferentialRowView[]
}

/** 参考链处境(T16,纯读)。 */
export interface ReferenceChainView {
  slot: string
  assetPath: string
  references: Array<{ path: string; character: string; slot?: string; note?: string; exists: boolean }>
  ready: Array<{ path: string; character: string; exists: boolean }>
  missing: Array<{ path: string; character: string; exists: boolean }>
  excludedSelf: string[]
  characters: string[]
  unknownCharacters: string[]
}

/** 图像任务(T14):一级结构化对象;降级是**记在任务上**的事实。 */
export interface GenerationTaskView {
  id: string
  slot: string
  outputPath: string
  state: 'queued' | 'running' | 'awaiting-review' | 'failed'
  channel?: string
  model: string
  prompt: string
  requiresCharacters: string[]
  artStyleAnchor?: string
  size?: string
  quality?: string
  referenceImages: Array<{ path: string; note?: string }>
  degradation?: {
    code: string
    message: string
    droppedReferenceImages: Array<{ path: string; note?: string }>
    notes: string[]
  }
  attempts: GenerationAttemptView[]
  /** 拒收注记(只追加;老账本里可能缺省)。 */
  rejections?: GenerationRejectionView[]
  createdAt: string
  updatedAt: string
  lastError?: string
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

  /** 试玩(T13):`from` 给了就从这一场开始(副本里覆写 start;项目不动)。 */
  async playtest(from?: string): Promise<{ at: string; exitCode: number; technicalPass: boolean; traceback: string | null; from: string | null }> {
    const body = await readJson<{ run: { at: string; exitCode: number; technicalPass: boolean; traceback: string | null; from: string | null } }>(
      await fetch('/api/galfree/playtest', {
        method: 'POST',
        ...(from === undefined || from === ''
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from }) }),
      }),
    )
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

  /** 读一场的表单(逐行)+ 该文件源文本(T11 两个视图的数据源)。 */
  async sceneForm(label: string): Promise<SceneFormView> {
    return readJson(await fetch(`/api/galfree/scenes/form?label=${encodeURIComponent(label)}`))
  }

  /** 提交编辑(表单编辑或 replaceSource);返回编辑之后的判定 + 新表单。 */
  async editScene(label: string, edit: Record<string, unknown>): Promise<{
    path: string
    label: string
    parseOk: boolean
    validation: { ok: boolean; validator: string }
    issues: Array<{ severity: string; code: string; file: string; line?: number; message: string }>
    form: SceneFormView
  }> {
    return readJson(await fetch('/api/galfree/scenes/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, edit }),
    }))
  }

  /** 分支图(只读):节点 + 跳转/选择边 + 子集外降级标记。 */
  async sceneGraph(): Promise<BranchGraphView> {
    return readJson(await fetch('/api/galfree/scenes/graph'))
  }

  /** 音频文件池与引用处境(T17,纯读):池是派生的,没有任何手工登记。 */
  async audioPool(): Promise<AudioPoolView> {
    return readJson(await fetch('/api/galfree/audio'))
  }

  /** 发布前置检查(T18,纯读):能不能发、缺什么、会用到哪个输出目录。 */
  async publishReadiness(): Promise<PublishReadinessView> {
    return readJson(await fetch('/api/galfree/publish'))
  }

  /** 一键发布(T18):产物落**项目源树之外**;前置没过就如实阻止并列缺项。 */
  async publish(payload: { packages?: string[] } = {}): Promise<PublishReportView> {    return readJson(await fetch('/api/galfree/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  /**
   * 把手写文件里的一个 label 段**原样搬**进生成目录(段内容逐字不变)。
   * 生成物固定落在 `game/scenes/<label>.rpy`,所以搬完这一场才能被 agent 重生成。
   */
  async relocateScene(label: string): Promise<{ from: string; to: string }> {
    return readJson(await fetch('/api/galfree/scenes/relocate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }))
  }

  /** SDK 供给状态(T5;首次下载进度可见)。 */
  async sdk(): Promise<SdkView> {
    return readJson(await fetch('/api/galfree/sdk'))
  }

  // ─── 图像渠道与任务队列(T14)─────────────────────────────────────────

  /** 渠道能力(**不含密钥**:只回报配没配)。 */
  async imageChannel(): Promise<ImageChannelView> {
    return readJson(await fetch('/api/galfree/channel'))
  }

  /** 任务账本(读;最新在前)。T15 的动作面消费这里。 */
  async generationTasks(): Promise<{ tasks: GenerationTaskView[] }> {
    return readJson(await fetch('/api/galfree/tasks'))
  }

  /** 建一个任务(缺省立刻跑)。T15 的「生成此槽」底层。 */
  async createGenerationTask(payload: {
    slot: string
    model: string
    prompt: string
    size?: string
    quality?: string
    run?: boolean
  }): Promise<{ task: GenerationTaskView }> {
    return readJson(await fetch('/api/galfree/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  /** 把板上"待填"的槽展开成任务集并推进(T15 的「补全全部待填」底层)。 */
  async fillMissingSlots(payload: { model: string; run?: boolean }): Promise<{ tasks: GenerationTaskView[] }> {
    return readJson(await fetch('/api/galfree/tasks/fill-missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  /**
   * 重 roll 一个任务(保留历史,追加一次尝试)。
   * 给了 `prompt` 就**改词再出**(对话里"重 roll 得更夸张"是同一件事);
   * 给了 `note` 就是**人的拒收理由**(它进任务历史,只追加,指向被拒的那一版)。
   */
  async retryGenerationTask(id: string, patch: { prompt?: string; size?: string; note?: string } = {}): Promise<{ task: GenerationTaskView }> {
    return readJson(await fetch('/api/galfree/tasks/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    }))
  }

  /** **差分批量**(T16):一个角色的差分补齐 —— 主视觉先出,差分自动携参考链。 */
  async characterDifferentials(payload: { character: string; model: string; run?: boolean }): Promise<{ tasks: GenerationTaskView[] }> {
    return readJson(await fetch('/api/galfree/tasks/differentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }

  /** 槽位对比视图(T16,纯读):同角色差分网格 = 登记簿 + 槽位历史。 */
  async differentialGrid(): Promise<DifferentialGridView> {
    return readJson(await fetch('/api/galfree/differentials'))
  }

  /** 参考链处境(T16,纯读)。 */
  async referenceChain(slot: string): Promise<ReferenceChainView> {
    return readJson(await fetch(`/api/galfree/reference-chain?slot=${encodeURIComponent(slot)}`))
  }

  /**
   * 素材缩略图地址(T16)。带上版本戳:重 roll 换了图 → 版本变了 → 浏览器不会拿旧图糊弄人。
   * 文件不存在时该地址返回 404(面板据此显示"待填"而不是裂图)。
   */
  assetUrl(path: string, version?: string): string {
    const qs = new URLSearchParams({ path, ...(version === undefined || version === '' ? {} : { v: version }) })
    return `/api/galfree/asset?${qs.toString()}`
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
