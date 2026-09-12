/**
 * 项目服务(Seam —— 唯一测试接缝,spec "Seam" 节)。
 *
 * Host 侧深接口:T1 注册表 + 模板新建;T2 写网关(项目内容的唯一写通道)与
 * 外部观察。后续环节在同一对象上生长(结构解析、推导进度、校验回路、图像
 * 队列、快照、试玩)。agent 工具与工作台 Client 只是两个薄适配器,消费这里
 * 的状态,不另立真相源。
 */
import { access, mkdir, readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GalfreeError } from './error.ts'
import { runGit } from './git.ts'
import { ProjectRegistry, type RegistryEntry } from './registry.ts'
import { commitSnapshot, fileDiff, fileHistory, rollbackFile, type SnapshotEntry } from './snapshot.ts'
import { PROJECT_NAME_RE, TEMPLATE_CJK_FONT, TEMPLATE_UI_FILES, renderTemplateFiles, renderUiPatch, templateKeepFiles } from './template.ts'
import { FakeValidator } from './validation/template-validator.ts'
import { deriveGraph, parseRpy } from './rpy/parse.ts'
import { readRpyFiles } from './rpy/files.ts'
import type { ParsedScript } from './rpy/dialect.ts'
import type { BranchGraph } from './rpy/dialect.ts'
import type { DialectProblem } from './rpy/dialect.ts'
import { computeProgress, sceneFingerprint, slotAssetPath, type ProgressSnapshot } from './progress.ts'
import { readStamps, sceneTarget, slotTarget, stampsDocument, withStamp, type StampRecord } from './stamps.ts'
import {
  CHARACTERS_FILE, SLOTS_FILE, charactersDocument, readCharacters, readSlots, removeCharacter,
  removeSlot, slotsDocument, upsertCharacter, upsertSlot,
  type CharacterRecord, type SlotRecord,
} from './characters.ts'
import { deriveSlots } from './slots.ts'
import { resolveReferenceChain, sortSlotsByReference, type ReferenceChainView } from './reference-chain.ts'
import { buildDifferentialGrid, type DifferentialGrid } from './differentials.ts'
import { deriveCompleteness, type CompletenessReport } from './completeness.ts'
import {
  BIBLE_FILE, OUTLINE_FILE, applyBiblePatch, bibleDocument, bibleFingerprint, buildGenerationContext,
  outlineRef, readBible, readOutline,
  type BibleDocument, type BiblePatch, type GenerationContext,
} from './bible.ts'
import { BIBLE_STAMP_TARGET } from './stamps.ts'
import { composeSceneFile, extractSceneBlock, gatewayPathOf, scenesPathOf } from './scene-file.ts'
import { applySceneEdit, buildSceneForm, type SceneEdit, type SceneFormModel } from './scene-form.ts'
import { contentFingerprint, launchPlaytest, playtestDocument, readPlaytest, PLAYTEST_FILE, type PlaytestPorts, type PlaytestRun } from './playtest.ts'
import {
  IMAGE_TASKS_FILE, MAX_REJECTION_NOTE_CHARS, adapterFor, dataUrlOf, degradeInput, downloadResultImage,
  emptyTasksDocument, findTask, imageModels,
  parseTasksDocument, tasksDocument, upsertTask,
  type CreateGenerationTaskInput, type GenerationTask, type GenerationAttempt, type GenerationRejection,
  type ImageChannelSettings, type ImageHttpClient,
} from './images.ts'
import { ABSENT, fileFingerprint, fingerprint } from './hash.ts'
import { WriteGateway, type ChangeEvent, type FileSnapshot, type GatewayError, type WriteLogEntry, type WriteOp, type WriteResult } from './write-gateway.ts'
import type { WriteBatchReason } from './write-gateway.ts'
import type { ValidationReport } from './validation/contract.ts'

export interface ProjectInfo {
  id: string
  name: string
  title: string
  /** 项目根目录绝对路径。 */
  root: string
  createdAt: string
  /** 当前激活标志(由注册表派生,不是独立存储)。 */
  active: boolean
  /** 磁盘上目录已被挪走/删除 → true(如实报告,不伪装可写)。 */
  missing: boolean
}

export interface CreateProjectInput {
  /** 父目录(项目目录将建在 projectsRoot/<name>/)。 */
  projectsRoot: string
  /** slug 项目名。 */
  name: string
  /** 显示标题;缺省等于 name。 */
  title?: string
  /**
   * 钉版 SDK 目录:里面的 GUI 模板(`gui/game/*.rpy`)会被整份拷进新项目。
   * 缺省 = 用服务装配时注入的界面文件来源(见 `ProjectServiceOptions.uiTemplate`)。
   */
  sdkDir?: string
}

/** 逐场生成的输入(T10)。 */
export interface GenerateSceneInput {
  /** 场景 label(标识符;生成物落在 game/scenes/<label>.rpy)。 */
  label: string
  /** 生成的 `.rpy` 段落(含 `label <label>:` 起头;只允许方言子集)。 */
  source: string
  /** 这一场的大纲位(供 agent 自己组织上下文用;接缝只做透传记录)。 */
  outline?: string | undefined
  /** 续接目标(下一场的 label);给了就校验它存在。 */
  nextLabel?: string | null
  /**
   * 是否要求"定稿设定集"作为上下文。true 时没定稿直接拒绝 ——
   * 生成必须先有权威记忆源(T9 的门禁在这里复用,而不是另立一条)。
   */
  requireContext?: boolean
  /** 生成物的目标路径;只接受规范路径(传别的就是归属违规)。 */
  targetPath?: string
}

/** 场景表单视图:行模型 + 源文本(T11 的两个视图,同一份真相)。 */
export interface SceneFormView extends SceneFormModel {
  /** 项目内相对路径(如 game/scenes/scene_one.rpy)。 */
  path: string
  /** `game/` 相对口径(与解析器的 file 一致)。 */
  file: string
  /** 该文件当前全文(源文本模式的输入)。 */
  source: string
}

/** 编辑之后的结果:与 GenerateSceneReport 同形状(面板/agent 复用同一套判定)。 */
export interface EditSceneReport {
  path: string
  label: string
  parseOk: boolean
  validation: ValidationReport
  issues: DialectProblem[]
  progress: ProgressSnapshot
  editedAt: string
}

/** 逐场生成的结果:写完当场判定的全套事实。 */
export interface GenerateSceneReport {
  path: string
  label: string
  action: 'created' | 'regenerated'
  /** 子集能否解析(含子集外降级 → false)。 */
  parseOk: boolean
  /** 校验回路结果(快带假验证器 / 生产合成验证器)。 */
  validation: ValidationReport
  /** 本次生成相关的问题(目标文件 + 全局结构问题)。 */
  issues: DialectProblem[]
  /** 写完之后的推导板快照(板立刻反映)。 */
  progress: ProgressSnapshot
  /** 定稿设定集上下文(requireContext 时;否则 null)。 */
  context: GenerationContext | null
  wroteAt: string
}

/**
 * 验证器端口:服务把"校验激活项目"委托给它。默认假验证器(快测);
 * 生产可注入合成端口(假 lint + 就绪时真 SDK lint 合并),让 SDK 验证真正生效。
 */
export type ValidatorPort = (project: ProjectInfo) => Promise<ValidationReport>

export interface ProjectServiceOptions {
  /** 插件数据目录(注册表等宿主侧状态落这里)。 */
  dataDir: string
  /** 注入验证器端口(缺省 = 假验证器;T5 生产注入假+真合成)。 */
  validator?: ValidatorPort
  /** 试玩端口(T7;缺省 = SDK 未就绪的诚实失败)。 */
  playtest?: PlaytestPorts
  /**
   * 图像子系统端口(T14):出网客户端 + 渠道读取。**缺省 = 没配渠道**,
   * 于是"出图"这条路如实拒绝(`no-image-channel`),而不是假装有。
   * 快带注入打出本地假上游的真 HTTP 实现;生产注入 `createNodeHttpClient()`
   * 与读设置文档的 `channel()`。
   */
  images?: ImagePorts
  /**
   * 界面模板来源(新建项目时从哪儿取 `screens.rpy` / `gui.rpy` 等)。
   *
   * 生产 = 钉版 SDK 的 `gui/game/`(随设置实时解析);快带 = 假 SDK 夹具。
   * 缺省实现按 `CreateProjectInput.sdkDir` 现取 —— 两个入口最终都落到
   * "读 SDK 的 GUI 模板",没有第二套界面来源。
   */
  uiTemplate?: (sdkDir: string | undefined) => Promise<{ files: Array<{ path: string; content: string }>; fontFiles: Array<{ path: string; content: Uint8Array }> }>
}

/** 图像子系统的注入端口(T14)。 */
export interface ImagePorts {
  /** 出网(生产 fetch / 快带假上游)。 */
  http: ImageHttpClient
  /** 当前渠道设置;`null` = 还没配。每次现读(设置可能刚被改)。 */
  channel: () => ImageChannelSettings | null
}

export class ProjectService {
  #registry: ProjectRegistry
  #validator: ValidatorPort
  #playtestPorts: PlaytestPorts
  #imagePorts: ImagePorts | null
  #uiTemplate: (sdkDir: string | undefined) => Promise<{ files: Array<{ path: string; content: string }>; fontFiles: Array<{ path: string; content: Uint8Array }> }>
  #gateways = new Map<string, Promise<WriteGateway>>()
  /** 图像任务账本的写串行(与网关的串行合起来构成"读-改-写"原子性)。 */
  #taskQueue: Promise<unknown> = Promise.resolve()

  constructor(options: ProjectServiceOptions) {
    this.#registry = new ProjectRegistry(join(options.dataDir, 'registry.json'))
    this.#validator = options.validator ?? (async (project) => new FakeValidator().validate(join(project.root, 'game')))
    this.#playtestPorts = options.playtest ?? { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) }
    this.#imagePorts = options.images ?? null
    this.#uiTemplate = options.uiTemplate ?? ((sdkDir) => this.#uiFilesFrom(sdkDir))
  }

  // ─── 注册表与模板新建(T1)────────────────────────────────────────────

  async createProject(input: CreateProjectInput): Promise<ProjectInfo> {
    if (!PROJECT_NAME_RE.test(input.name)) {
      throw new GalfreeError('invalid-name', `项目名需匹配 ${PROJECT_NAME_RE}:只允许小写字母/数字/下划线/连字符,以字母或数字开头`)
    }
    const title = input.title ?? input.name
    const root = join(input.projectsRoot, input.name)

    // 不静默覆盖既有目录(可能是人的项目)。
    try {
      await access(root)
      throw new GalfreeError('project-exists', `目标目录已存在,拒绝覆盖:${root}`)
    } catch (error) {
      if (error instanceof GalfreeError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }

    const id = randomUUID()
    const createdAt = new Date().toISOString()

    // 先把模板内容取齐**再建目录**:界面文件缺失要拒绝得干干净净
    // (否则磁盘上会留一个空壳目录,人以为"建了一半")。
    // 模板内容一律经网关落盘(网关是唯一写通道)。
    const ui = await this.#uiTemplate(input.sdkDir)
    const files = [
      ...renderTemplateFiles({ name: input.name, title, id }),
      ...templateKeepFiles(),
      // 中文字体:拷进项目(相对路径引用才有效;绝对路径会被静默回退)。
      ...ui.fontFiles,
      // 中文字体/界面变量补丁。
      renderUiPatch(ui.fontFiles.length > 0),
      // 界面文件从**钉版 SDK 的 GUI 模板**整份拷(见 template.ts 的说明:少了 screens.rpy,
      // 连关窗确认都会崩)。取不到 → 如实抛 sdk-ui-missing,不静默拼凑。
      ...ui.files,
    ]

    await mkdir(root, { recursive: true })
    const gateway = this.#newGateway(root)
    await gateway.writeBatch(
      files.map((file): WriteOp => ({ path: file.path, content: file.content, expectVersion: ABSENT })),
      { origin: 'workbench', reason: 'scaffold' },
    )
    this.#gateways.set(id, Promise.resolve(gateway))

    try {
      await this.#initGit(root, input.name)
    } catch (error) {
      throw new GalfreeError('git-init-failed', `模板 git 初始化失败:${String(error)}`)
    }

    await this.#registry.add({ id, name: input.name, title, path: root, createdAt })
    // 新建即进入当前工作项目(v1 无切换 UI;激活位随建随切)。
    await this.#registry.setActive(id)
    return this.#toInfo(id)
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const entries = await this.#registry.list()
    return Promise.all(entries.map((entry) => this.#toInfo(entry.id)))
  }

  async getProject(id: string): Promise<ProjectInfo | null> {
    if ((await this.#registry.get(id)) === undefined) return null
    return this.#toInfo(id)
  }

  async getActiveProject(): Promise<ProjectInfo | null> {
    const id = await this.#registry.activeId()
    return id === null ? null : this.#toInfo(id)
  }

  /** 设置激活项目(数据模型 v1 就位;切换 UI 留后续票)。 */
  async setActive(id: string): Promise<void> {
    await this.#registry.setActive(id)
  }

  // ─── 写网关(T2)─────────────────────────────────────────────────────

  /** 读项目文件 + 当前版本戳(网关口径:磁盘为真)。 */
  async readProjectFile(projectRef: string, relPath: string): Promise<FileSnapshot> {
    return (await this.#gatewayFor(projectRef)).read(relPath)
  }

  /**
   * 按**字节**读一个项目文件(T16:面板要显示素材缩略图)。
   *
   * 走同一个网关口径(磁盘为真 + 内容哈希版本戳),只是不做 utf8 解码 ——
   * 版本戳因此既能给缓存失效用(重 roll 换了一张 → 版本变了),也不会把 PNG 读坏。
   * 这是**读**,不产生写,也不给写开旁路。
   */
  async readProjectBytes(projectRef: string, relPath: string): Promise<{ bytes: Uint8Array | null; version: string }> {
    return await (await this.#gatewayFor(projectRef)).readBytes(relPath)
  }

  /** 经网关提交一个原子写批(串行 + CAS)。 */
  async writeProjectFiles(projectRef: string, ops: WriteOp[], reason: WriteBatchReason): Promise<WriteResult> {
    return (await this.#gatewayFor(projectRef)).writeBatch(ops, reason)
  }

  /** 订阅变更(网关写 = internal;外部编辑器/git 改动 = external → 工作台刷新)。 */
  observeChanges(projectRef: string, listener: (change: ChangeEvent) => void): () => void {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void this.#gatewayFor(projectRef).then((gw) => {
      if (!disposed) unsubscribe = gw.observe(listener)
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }

  /** 写日志插桩(断言无旁路写)。 */
  async writeLog(projectRef: string): Promise<WriteLogEntry[]> {
    const gateway = await this.#gatewayFor(projectRef)
    return [...gateway.log]
  }

  /** 网关批处理的非致命故障(快照失败/回滚失败/监听降级)——状态层如实呈现。 */
  async gatewayErrors(projectRef: string): Promise<GatewayError[]> {
    const gateway = await this.#gatewayFor(projectRef)
    return [...gateway.errors]
  }

  // ─── 快照(T3)───────────────────────────────────────────────────────

  /** 单文件快照历史(最新在前)。 */
  async snapshotHistory(projectRef: string, relPath: string): Promise<SnapshotEntry[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return fileHistory(entry.path, relPath)
  }

  /** 单文件两版本间 diff。 */
  async snapshotDiff(projectRef: string, relPath: string, fromCommit: string, toCommit: string): Promise<string> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return fileDiff(entry.path, relPath, fromCommit, toCommit)
  }

  /** 回滚一个文件到历史版本(经网关写 → 自动产生回滚快照)。 */
  async snapshotRollback(projectRef: string, relPath: string, toCommit: string): Promise<WriteResult> {
    const entry = await this.#resolve(projectRef)
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(relPath)
    return rollbackFile(
      entry.path,
      relPath,
      toCommit,
      (ops, reason) => gateway.writeBatch(ops, reason),
      current.version,
    )
  }

  /** 校验回路:对当前激活项目跑验证器端口(默认假;生产可合成真 SDK)。 */
  async validateActiveProject(): Promise<ValidationReport> {
    const active = await this.getActiveProject()
    if (active === null) throw new GalfreeError('no-active-project', '没有激活项目可校验')
    if (active.missing) throw new GalfreeError('project-missing', `项目目录已不存在:${active.root}`)
    return this.#validator(active)
  }

  /** 分支骨架(派生视图:可缓存、全量重算;ADR-0009 `.rpy` 为尊)。 */
  async branchGraph(projectRef: string): Promise<BranchGraph> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return deriveGraph(parseRpy(await readRpyFiles(join(entry.path, 'game'))))
  }

  // ─── 推导进度 + 审读戳(T6)───────────────────────────────────────────

  /**
   * 阶段板:纯推导(文件 + 解析 + 校验 + 戳 + 试玩事实),可全量重算、幂等、无手写通道。
   *
   * 素材槽也从这里出去:槽清单派生自 `.rpy` 的图像引用,账本(制作信息)与登记簿
   * (一致性锚)挂上去;悬空引用并入 problems → 与 lint 同源进板(ADR-0009 铁律)。
   */
  async progress(projectRef: string): Promise<ProgressSnapshot> {
    const graph = await this.branchGraph(projectRef)
    const entry = await this.#resolve(projectRef)
    const [ledger, characters, parsed, playtest, bible, outlineText] = await Promise.all([
      readSlots(entry.path),
      readCharacters(entry.path),
      this.#parseScript(projectRef),
      readPlaytest(entry.path),
      readBible(entry.path),
      readOutline(entry.path),
    ])
    const derived = deriveSlots({ parsed, ledger, characters })
    // 项目级完整性(T13):孤立场景 / 结局不可达,外加把全局问题**定位到场景**。
    const completeness = deriveCompleteness(graph)
    return computeProgress(entry.path, {
      scenes: graph.scenes,
      problems: [...graph.problems, ...completeness.problems, ...derived.problems],
      derivedSlots: derived.slots,
      characters,
      definedCharacters: parsed.characters,
      completeness: {
        entry: completeness.entry,
        orphans: completeness.orphans,
        endingReachable: completeness.endingReachable,
      },
      bible: {
        fingerprint: bibleFingerprint(bible),
        chapters: bible.chapters.length,
        characters: bible.characters.length,
        hasOutline: bible.outline !== null,
        outlineFingerprint: outlineText === null ? null : fingerprint(outlineText),
        outlineRef: bible.outline === null ? null : { fingerprint: bible.outline.fingerprint },
      },
      playtest: { last: playtest?.last ?? null, currentFingerprint: contentFingerprint(graph) },
    })
  }

  /** 解析项目的全部 `.rpy`(场景 + 顶层角色定义);`branchGraph` 与槽派生共用。 */
  async #parseScript(projectRef: string): Promise<ParsedScript> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return parseRpy(await readRpyFiles(join(entry.path, 'game')))
  }

  /**
   * 一键试玩(T7/T13):钉版 SDK 启动当前项目、退出回传;运行事实经网关落 `.studio/playtest.json`
   * 并进快照。技术通过是推导(退出码/日志),不是人盖的戳。
   *
   * `fromLabel` 给了就**从这一场开始**(T13):在副本里覆写 start 跳过去 —— 用户项目一个
   * 字节都不动。目标场不存在会在启动时崩出 traceback,所以"落对了"这件事有可红的信号。
   */
  async playtestStart(projectRef: string, fromLabel: string | null = null): Promise<PlaytestRun> {
    const graph = await this.branchGraph(projectRef)
    const entry = await this.#resolve(projectRef)
    if (fromLabel !== null && !graph.scenes.some((scene) => scene.label === fromLabel)) {
      throw new GalfreeError('unknown-scene', `场景 ${fromLabel} 不存在,无法从它开始试玩`)
    }
    const gateway = await this.#gatewayFor(projectRef)
    const run = await launchPlaytest(this.#playtestPorts, entry.path, contentFingerprint(graph), fromLabel)
    const ledger = (await readPlaytest(entry.path)) ?? { schemaVersion: 1 as const, last: null, history: [] }
    const next = { schemaVersion: 1 as const, last: run, history: [...ledger.history, run] }
    const current = await gateway.read(PLAYTEST_FILE)
    await gateway.writeBatch(
      [{ path: PLAYTEST_FILE, content: playtestDocument(next), expectVersion: current.version }],
      { origin: 'workbench', reason: 'playtest' },
    )
    return run
  }

  /**
   * 项目级完整性(读,T13):入口 / 可达 / 孤立场景 / 结局可达 + 已定位到场景的问题。
   * 纯推导,可全量重算 —— 与板上的其他判断同源。
   */
  async completeness(projectRef: string): Promise<CompletenessReport> {
    const graph = await this.branchGraph(projectRef)
    return deriveCompleteness(graph)
  }

  /** 审读戳账本(历史记录,含失效者)。 */
  async stampRecords(projectRef: string): Promise<StampRecord[]> {
    const entry = await this.#resolve(projectRef)
    return readStamps(entry.path)
  }

  /**
   * 人盖场景戳。**agent 一律拒绝**(stamp-forbidden,ADR-0008):seam 的这个
   * 操作对应真实的人为动作(工作台点击),没有任何 agent 侧入口。
   */
  async stampScene(projectRef: string, label: string, actor: { via: 'human' | 'agent' }): Promise<void> {
    this.#requireHuman(actor)
    const graph = await this.branchGraph(projectRef)
    const scene = graph.scenes.find((s) => s.label === label)
    if (scene === undefined) throw new GalfreeError('unknown-scene', `场景 ${label} 不存在`)
    await this.#putStamp(projectRef, sceneTarget(label), sceneFingerprint(scene))
  }

  /** 人盖素材槽戳;槽未填(素材文件不存在)时拒绝(slot-not-filled)。 */
  /**
   * 人盖素材槽戳;槽未填(素材文件不存在)时拒绝(slot-not-filled)。
   */
  async stampSlot(projectRef: string, slot: string, actor: { via: 'human' | 'agent' }): Promise<void> {
    this.#requireHuman(actor)
    const entry = await this.#resolve(projectRef)
    const fp = await fileFingerprint(entry.path, slotAssetPath(slot))
    if (fp === ABSENT) throw new GalfreeError('slot-not-filled', `素材槽未填,不能盖审读戳:${slot}`)
    await this.#putStamp(projectRef, slotTarget(slot), fp)
  }

  // ─── 角色登记簿 + 素材槽账本(T8)─────────────────────────────────────

  /**
   * 角色登记簿(读)。落盘在 `.studio/characters.json`,**只放制作信息与对 `.rpy` 的
   * 引用,永不复制叙述内容**(ADR-0009 铁律)。
   */
  async characters(projectRef: string): Promise<CharacterRecord[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return readCharacters(entry.path)
  }

  /** 新增/覆盖一个角色(经网关写 → 自动快照)。agent 侧同样可用:这是设定,不是人的主观认可。 */
  async upsertCharacter(projectRef: string, record: CharacterRecord): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(CHARACTERS_FILE)
    const characters = await this.characters(projectRef)
    await gateway.writeBatch(
      [{ path: CHARACTERS_FILE, content: charactersDocument(upsertCharacter(characters, record)), expectVersion: current.version }],
      { origin: 'agent', reason: 'cast' },
    )
  }

  /** 移除一个角色(经网关写 → 自动快照)。 */
  async removeCharacter(projectRef: string, id: string): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(CHARACTERS_FILE)
    const characters = await this.characters(projectRef)
    await gateway.writeBatch(
      [{ path: CHARACTERS_FILE, content: charactersDocument(removeCharacter(characters, id)), expectVersion: current.version }],
      { origin: 'workbench', reason: 'cast' },
    )
  }

  /** 素材槽账本(读):**只存制作信息**,槽清单本身永远从 `.rpy` 派生。 */
  async slotLedger(projectRef: string): Promise<SlotRecord[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return readSlots(entry.path)
  }

  /**
   * 给一个槽挂/改制作信息(经网关写 → 自动快照)。
   *
   * 这里**不校验槽是否在 `.rpy` 里存在** —— 挂账先于写剧本是正常工作顺序;
   * 悬空由推导在板上如实报错(`dangling-slot-ref`),而不是在写入时拦住。
   */
  async upsertSlot(projectRef: string, record: SlotRecord): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(SLOTS_FILE)
    const ledger = await this.slotLedger(projectRef)
    await gateway.writeBatch(
      [{ path: SLOTS_FILE, content: slotsDocument(upsertSlot(ledger, record)), expectVersion: current.version }],
      { origin: 'agent', reason: 'slot' },
    )
  }

  /** 移除一个槽的制作信息(经网关写 → 自动快照;幂等)。 */
  async removeSlot(projectRef: string, slot: string): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(SLOTS_FILE)
    const ledger = await this.slotLedger(projectRef)
    await gateway.writeBatch(
      [{ path: SLOTS_FILE, content: slotsDocument(removeSlot(ledger, slot)), expectVersion: current.version }],
      { origin: 'workbench', reason: 'slot' },
    )
  }

  // ─── 逐场剧本生成(T10)──────────────────────────────────────────────

  /**
   * 生成/重生成一场戏:**一个写批 = 一个快照**,写完当场判定,把结果如实交回。
   *
   * 归属规则(本票钉死):一个 label 只归一个文件。
   *  - `game/script.rpy` 是**手写/模板**的家,生成器不动它;
   *  - `game/scenes/<label>.rpy` 是**生成**的家;
   *  - 想生成一个还活在别处的 label → 如实拒绝并指出它在哪,让调用方先搬走。
   *    否则同一个 label 会被定义两处,真正的运行时会死在重复定义上 —— 而"真跑起来"
   *    正是本项目的验收方式,不能让生成器悄悄制造这种项目。
   *
   * 生成"失败"(语法错/悬空跳转)也**照常落盘并如实上报**:内容进了仓库、快照可回滚,
   * 板立刻显示问题;假装成功才是真正的事故。
   */
  async generateScene(projectRef: string, input: GenerateSceneInput): Promise<GenerateSceneReport> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const label = input.label.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
      throw new GalfreeError('invalid-label', `场景 label 必须是标识符:${input.label}`)
    }
    if (input.source.trim() === '') throw new GalfreeError('empty-scene', '场景内容不能为空')

    const canonical = scenesPathOf(label)
    const targetPath = input.targetPath ?? canonical
    if (targetPath !== canonical) {
      throw new GalfreeError('scene-not-canonical', `生成物固定落在 game/${canonical};不能写到 ${targetPath}`)
    }

    // 归属检查:这个 label 现在住在哪?(scene.file 与 canonical 同为 game/ 相对口径)
    const parsed = await this.#parseScript(projectRef)
    const existing = parsed.scenes.find((scene) => scene.label === label)
    if (existing !== undefined && existing.file !== canonical) {
      throw new GalfreeError(
        'scene-label-elsewhere',
        `label ${label} 现在住在 game/${existing.file},不在生成目录。` +
        `要重生成它,先把那一段搬进 game/${canonical}(手写文件归人管,生成器不越界)。`,
      )
    }
    const nextLabel = input.nextLabel ?? null
    if (nextLabel !== null && !parsed.scenes.some((scene) => scene.label === nextLabel)) {
      throw new GalfreeError('unknown-next-label', `续接目标 label 不存在:${nextLabel}`)
    }

    // 上下文门禁:要求时只给定稿版(T9 的同一道门,不偷偷用草稿)。
    const context = input.requireContext === true ? await this.generationContext(projectRef) : null

    // 若目标文件里已有**别的** label,保住它们(手写/追加都可能发生);只替换本场那一段。
    const gatewayPath = gatewayPathOf(canonical)
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(gatewayPath)
    const composed = composeSceneFile(label, input.source, current.content, nextLabel)

    // 一个写批 = 一个快照。
    await gateway.writeBatch(
      [{ path: gatewayPath, content: composed, expectVersion: current.version }],
      { origin: 'agent', reason: 'scene', scene: label },
    )

    // 写完当场判定:校验回路 + 推导板一起刷新。
    const [validation, progress, parsedAfter] = await Promise.all([
      this.validateActiveProject(),
      this.progress(projectRef),
      this.#parseScript(projectRef),
    ])
    const scene = parsedAfter.scenes.find((candidate) => candidate.label === label)
    const issues: DialectProblem[] = [
      ...parsedAfter.problems,
      ...(scene?.problems ?? []),
    ].filter((problem) => problem.file === canonical || problem.code === 'no-start-label')

    return {
      path: gatewayPath,
      label,
      action: existing === undefined ? 'created' : 'regenerated',
      parseOk: scene !== undefined && !scene.readOnly,
      validation,
      issues,
      progress,
      context,
      wroteAt: new Date().toISOString(),
    }
  }

  // ─── 场景编辑器(T11)────────────────────────────────────────────────

  /**
   * 读出一场的**表单**(逐行:说话人 / 文本 / 图像引用 / 结构行),附带源文本全文。
   *
   * 表单与源文本是两个视图,同一份真相(`.rpy`);表单里连注释与空行都如实列出来 ——
   * 否则编辑一次就会把它们吃掉。
   */
  async sceneForm(projectRef: string, label: string): Promise<SceneFormView> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const parsed = await this.#parseScript(projectRef)
    const scene = parsed.scenes.find((candidate) => candidate.label === label)
    if (scene === undefined) throw new GalfreeError('unknown-scene', `场景 ${label} 不存在`)
    const path = gatewayPathOf(scene.file)
    const text = await readFile(join(entry.path, path), 'utf8')
    const model = buildSceneForm(text, scene)
    return { ...model, path, source: text, file: scene.file }
  }

  /**
   * 编辑一场:**一个写批 = 一个快照**,写完当场判定(与 T10 同一形状)。
   *
   * 两条路:
   *  - **表单编辑**(setDialogue / setImage / insert / delete):只对**生成目录**里的
   *    场景开放 —— 结构编辑的前提是这一场归生成器管;手写文件的场景要先搬家。
   *  - **源文本模式**(replaceSource):"直接改我自己的文件",不受归属限制,但同样走网关
   *    (版本戳 + 快照 + 写日志),且写完如实报告解析/校验结果。
   */
  async editScene(projectRef: string, input: { label: string; edit: SceneEdit }): Promise<EditSceneReport> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const parsed = await this.#parseScript(projectRef)
    const scene = parsed.scenes.find((candidate) => candidate.label === input.label)
    if (scene === undefined) throw new GalfreeError('unknown-scene', `场景 ${input.label} 不存在`)

    const canonical = scenesPathOf(input.label)
    const isRaw = input.edit.kind === 'replaceSource'
    if (!isRaw && scene.file !== canonical) {
      throw new GalfreeError(
        'scene-not-editable',
        `${input.label} 住在 game/${scene.file}(手写文件),结构编辑只对生成目录里的场景开放。` +
        `先把它搬进 game/${canonical},或用源文本模式直接改这个文件。`,
      )
    }
    if (scene.readOnly && !isRaw) {
      throw new GalfreeError(
        'scene-read-only',
        `这一场用了方言子集外的语法,编辑器降级只读:${scene.problems.find((p) => p.severity === 'warning')?.message ?? ''}`,
      )
    }

    const path = gatewayPathOf(scene.file)
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(path)
    const next = applySceneEdit(current.content, input.edit)

    await gateway.writeBatch(
      [{ path, content: next, expectVersion: current.version }],
      { origin: 'workbench', reason: 'edit', scene: input.label },
    )
    return this.#sceneEditReport(projectRef, input.label, path)
  }

  // ─── 设定集工作周期(T9)──────────────────────────────────────────────

  /** 编辑之后的判定报告(与 T10 的 generateScene 同形状,面板/agent 可以复用)。 */
  async #sceneEditReport(projectRef: string, label: string, path: string): Promise<EditSceneReport> {
    const [validation, progress, parsedAfter] = await Promise.all([
      this.validateActiveProject(),
      this.progress(projectRef),
      this.#parseScript(projectRef),
    ])
    const scene = parsedAfter.scenes.find((candidate) => candidate.label === label)
    const relative = path.replace(/^game\//, '')
    const issues: DialectProblem[] = [
      ...parsedAfter.problems,
      ...(scene?.problems ?? []),
    ].filter((problem) => problem.file === relative || problem.code === 'no-start-label')
    return {
      path,
      label,
      parseOk: scene !== undefined && !scene.readOnly,
      validation,
      issues,
      progress,
      editedAt: new Date().toISOString(),
    }
  }

  /**
   * 把 `game/script.rpy` 里的一个 label 段**原样搬**进生成目录(`game/scenes/<label>.rpy`)。
   *
   * 为什么需要这一步:模板项目把 `label start:` 写在 `script.rpy` 里,而生成物固定落在
   * `game/scenes/`(一 label 一文件)。要让 `start` 变成"可生成的场景",它得先搬家 ——
   * 而这一步**只能由人发起**(它是重写人的手写文件),所以它是独立的一次写批。
   *
   * 语义严格限定为"搬家":段内容逐字不变(含注释与空行),只是换个文件住;
   * 目标文件已存在就拒绝(不覆盖既有内容)。
   */
  async relocateScene(projectRef: string, label: string, actor: { via: 'human' | 'agent' }): Promise<{ from: string; to: string }> {
    this.#requireHuman(actor)
    const parsed = await this.#parseScript(projectRef)
    const scene = parsed.scenes.find((candidate) => candidate.label === label)
    if (scene === undefined) throw new GalfreeError('unknown-scene', `场景 ${label} 不存在`)
    const canonical = scenesPathOf(label)
    if (scene.file === canonical) {
      throw new GalfreeError('scene-already-canonical', `${label} 已经在生成目录里:game/${canonical}`)
    }

    const gateway = await this.#gatewayFor(projectRef)
    const sourcePath = gatewayPathOf(scene.file)
    const sourceCurrent = await gateway.read(sourcePath)
    const targetPath = gatewayPathOf(canonical)
    const targetCurrent = await gateway.read(targetPath)
    if (targetCurrent.version !== ABSENT) {
      throw new GalfreeError('scene-target-exists', `目标文件已存在,拒绝覆盖:${targetPath}`)
    }

    const { moved, remainder } = extractSceneBlock(sourceCurrent.content, label)
    // 一个写批:源文件去掉那段 + 目标文件拿到那段 —— 原子,快照粒度 = 一次搬家。
    await gateway.writeBatch(
      [
        { path: sourcePath, content: remainder, expectVersion: sourceCurrent.version },
        { path: targetPath, content: moved, expectVersion: ABSENT },
      ],
      { origin: 'workbench', reason: 'relocate', scene: label },
    )
    return { from: sourcePath, to: targetPath }
  }

  /** 设定集(读):主题 / 世界观 / 章节 / 对登记簿的引用 / 大纲引用。 */
  async bible(projectRef: string): Promise<BibleDocument> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return readBible(entry.path)
  }

  /** 人写原文(读);没导入过则为 null。 */
  async bibleOutline(projectRef: string): Promise<string | null> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return readOutline(entry.path)
  }

  /**
   * 部分更新设定集(经网关写 → 自动快照)。
   *
   * `characters` 给的是**对登记簿的引用与设定内容**:服务会顺手把角色写进登记簿
   * (T9:"同步写登记簿"),设定集里只留 id —— 同一张脸只有一处说明。
   * agent 可以调(它是设定,不是人的主观认可);改动会让定稿戳自动待复审。
   */
  async writeBible(projectRef: string, patch: BiblePatch & { characters?: CharacterRecord[] }, actor: { via: 'human' | 'agent' }): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const entry = await this.#resolve(projectRef)

    // 1) 角色设定先落到登记簿(它是家),设定集只记引用。
    const records = patch.characters ?? []
    for (const record of records) {
      const current = await gateway.read(CHARACTERS_FILE)
      const characters = await readCharacters(entry.path)
      await gateway.writeBatch(
        [{ path: CHARACTERS_FILE, content: charactersDocument(upsertCharacter(characters, record)), expectVersion: current.version }],
        { origin: actor.via === 'human' ? 'workbench' : 'agent', reason: 'cast' },
      )
    }

    // 2) 设定集本体(引用 + 意图)。
    const before = await gateway.read(BIBLE_FILE)
    const current = await readBible(entry.path)
    const next = applyBiblePatch(current, {
      ...(patch.theme === undefined ? {} : { theme: patch.theme }),
      ...(patch.world === undefined ? {} : { world: patch.world }),
      ...(patch.chapters === undefined ? {} : { chapters: patch.chapters }),
      ...(records.length === 0 ? {} : { characters: [...new Set([...current.characters.map((ref) => ref.id), ...records.map((record) => record.id)])].map((id) => ({ id })) }),
    })
    await gateway.writeBatch(
      [{ path: BIBLE_FILE, content: bibleDocument(next), expectVersion: before.version }],
      { origin: actor.via === 'human' ? 'workbench' : 'agent', reason: 'bible' },
    )
  }

  /**
   * 大纲模式:导入人写的原文。
   *
   * **原文即权威**:这里只做一件事 —— 逐字落盘,并记下它的指纹与长度。
   * 任何"顺手改写/整理"都是违规;agent 之后的动作只允许补登记簿与派生骨架。
   */
  async importOutline(projectRef: string, text: string): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const entry = await this.#resolve(projectRef)
    const outlineBefore = await gateway.read(OUTLINE_FILE)
    await gateway.writeBatch(
      [{ path: OUTLINE_FILE, content: text, expectVersion: outlineBefore.version }],
      { origin: 'workbench', reason: 'outline' },
    )
    const bibleBefore = await gateway.read(BIBLE_FILE)
    const current = await readBible(entry.path)
    const next: BibleDocument = { ...current, outline: outlineRef(text), updatedAt: new Date().toISOString() }
    await gateway.writeBatch(
      [{ path: BIBLE_FILE, content: bibleDocument(next), expectVersion: bibleBefore.version }],
      { origin: 'workbench', reason: 'outline' },
    )
  }

  /** 人盖/复审"设定定稿"戳;agent 一律拒绝(与场景戳同一条守卫)。 */
  async stampBible(projectRef: string, actor: { via: 'human' | 'agent' }): Promise<void> {
    this.#requireHuman(actor)
    const doc = await this.bible(projectRef)
    await this.#putStamp(projectRef, BIBLE_STAMP_TARGET, bibleFingerprint(doc))
  }

  /**
   * 下游生成用的上下文:只给**定稿版**。没盖定稿戳(或盖过但内容又变了)就抛错,
   * 不偷偷用草稿 —— 这样"设定集是第一记忆源"才是可断言的,而不是口头约定。
   */
  async generationContext(projectRef: string): Promise<GenerationContext> {
    const entry = await this.#resolve(projectRef)
    const [doc, characters, outlineText, stamps] = await Promise.all([
      this.bible(projectRef),
      this.characters(projectRef),
      this.bibleOutline(projectRef),
      this.stampRecords(projectRef),
    ])
    const record = stamps.find((stamp) => stamp.target === BIBLE_STAMP_TARGET)
    if (record === undefined) throw new GalfreeError('bible-not-final', '设定集还没有盖"设定定稿"戳:下游生成只用定稿版')
    if (record.fingerprint !== bibleFingerprint(doc)) {
      throw new GalfreeError('bible-not-final', '设定集盖过定稿戳,但之后又改过(待复审):请人重新审读后再生成')
    }
    void entry
    return buildGenerationContext({ bible: doc, characters, outlineText })
  }

  // ─── 图像子系统:渠道 + 任务队列(T14,Host 直连 ADR-0010)─────────────

  /**
   * 当前渠道 + 它的模型目录(给面板与 agent 看"能用什么")。
   * **不含密钥**:`apiKeyConfigured` 只说配没配,不回传密钥本身。
   */
  async imageChannel(): Promise<{
    configured: boolean
    name?: string
    baseUrl?: string
    apiKeyConfigured: boolean
    models: Array<{ id: string; label?: string; note?: string; adapter: string; capabilities: unknown }>
  }> {
    const channel = this.#imagePorts?.channel() ?? null
    if (channel === null) return { configured: false, apiKeyConfigured: false, models: [] }
    return {
      configured: true,
      ...(channel.name === undefined ? {} : { name: channel.name }),
      baseUrl: channel.baseUrl,
      apiKeyConfigured: channel.apiKey !== undefined && channel.apiKey !== '',
      models: channel.models.map((model) => ({
        id: model.id,
        ...(model.label === undefined ? {} : { label: model.label }),
        ...(model.note === undefined ? {} : { note: model.note }),
        // **协议也要报**:排查"为什么出不了图"时这是第一个要看的事实
        // (同步 vs 异步任务制,提交路径的单复数跟着变)。曾经这里没报,只能靠猜。
        adapter: model.adapter,
        capabilities: model.capabilities,
      })),
    }
  }

  /** 任务账本(读):全部任务,最新的在前。 */
  async generationTasks(projectRef: string): Promise<GenerationTask[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const document = await this.#readTasks(projectRef)
    return [...document.tasks].reverse()
  }

  async generationTask(projectRef: string, id: string): Promise<GenerationTask | null> {
    const document = await this.#readTasks(projectRef)
    return findTask(document, id) ?? null
  }

  /**
   * **参考链视图**(T16,纯读):这个槽这一次会带上哪些参考图、各自从哪个角色的登记簿来、
   * 哪张文件还不存在、哪条被当成自引用排除了。
   *
   * 面板与 agent 读的是同一份判断 —— 链不是"账本上的一行字",而是可核查的处境。
   */
  async referenceChain(projectRef: string, slot: string): Promise<ReferenceChainView> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const [characters, ledger] = await Promise.all([readCharacters(entry.path), readSlots(entry.path)])
    const record = ledger.find((candidate) => candidate.slot === slot)
    return await this.#resolveChain(entry.path, slot, record?.requiresCharacters ?? [], characters)
  }

  /**
   * **槽位对比视图**(T16,纯读):同角色差分网格 —— 格子、主视觉、链上的参考、
   * 每一格的历史版本与拒收理由。
   *
   * 渲染自**登记簿 + 槽位历史**(票面 AC2),不产生任何写;面板与 agent 读同一份。
   */
  async differentialGrid(projectRef: string): Promise<DifferentialGrid> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const progress = await this.progress(projectRef)
    const tasks = await this.generationTasks(projectRef)
    // 链上的图在不在:一次问清(同一路径只查一次),再交给纯函数。
    const existing = await this.#existingPaths(
      entry.path,
      progress.characters.flatMap((character) => character.references.map((reference) => reference.path)),
    )
    return buildDifferentialGrid({
      characters: progress.characters,
      slots: progress.slots,
      tasks,
      exists: (path) => existing.has(path),
    })
  }

  /** 解析一个槽的参考链(纯函数 + 一次读盘得出的存在性表)。 */
  async #resolveChain(
    root: string,
    slot: string,
    requiresCharacters: string[],
    characters: CharacterRecord[],
  ): Promise<ReferenceChainView> {
    const byId = new Map(characters.map((character) => [character.id, character]))
    const candidates = requiresCharacters.flatMap((id) => (byId.get(id)?.references ?? []).map((reference) => reference.path))
    const existing = await this.#existingPaths(root, candidates)
    return resolveReferenceChain({
      slot,
      requiresCharacters,
      characters,
      exists: (path) => existing.has(path),
    })
  }

  /**
   * "链上的图在不在"的**唯一实现**:一串候选路径 → 存在的那些(同批同路径只查一次)。
   * 板上"已填"与链上"就绪"因此同口径(都是"文件指纹 ≠ ABSENT")。
   */
  async #existingPaths(root: string, paths: string[]): Promise<Set<string>> {
    const existing = new Set<string>()
    for (const path of new Set(paths)) {
      if ((await fileFingerprint(root, path)) !== ABSENT) existing.add(path)
    }
    return existing
  }

  /**
   * 建一个素材槽生成任务(全结构化对象)。
   *
   * 三道门如实拦:没配渠道 / 模型不在目录里 / 槽不在 `.rpy` 派生的清单里
   * —— 最后这条尤其重要:出图的目标路径是**槽位的约定路径**(由槽名派生),
   * 对着一个不存在的槽出图,产出的文件永远没人引用(悬空引用)。
   */
  async createGenerationTask(projectRef: string, input: CreateGenerationTaskInput): Promise<GenerationTask> {
    const created = await this.#mutateTasks(projectRef, async (document, writers) => {
      const entry = await this.#resolve(projectRef)
      await this.#assertPresent(entry)
      const { channel, model } = this.#requireModel(input.model)
      const slot = input.slot.trim()
      if (slot === '') throw new GalfreeError('invalid-slot', '目标槽不能为空')

      const outputPath = slotAssetPath(slot)
      const [parsed, ledger, characters] = await Promise.all([
        this.#parseScript(projectRef),
        readSlots(entry.path),
        readCharacters(entry.path),
      ])
      const derived = deriveSlots({ parsed, ledger, characters })
      if (!derived.slots.some((candidate) => candidate.slot === slot)) {
        throw new GalfreeError('unknown-slot', `槽「${slot}」不在 .rpy 派生的槽清单里:先在剧本里用 show/scene 引用它,或改用已有的槽`, {
          known: derived.slots.map((candidate) => candidate.slot),
        })
      }

      // 登记簿上下文:没显式给就按槽账本的要求带(生成强制携带登记簿上下文,ADR-0010)。
      const ledgerRecord = ledger.find((record) => record.slot === slot)
      const requiresCharacters = input.requiresCharacters ?? ledgerRecord?.requiresCharacters ?? []
      const artStyleAnchor = input.artStyleAnchor ?? ledgerRecord?.artStyleAnchor

      // **参考链(T16)**:显式给了就用给的;没给就从登记簿自动携链(主视觉 → 差分)。
      const chain = input.referenceImages === undefined
        ? await this.#resolveChain(entry.path, slot, requiresCharacters, characters)
        : null

      // 链上文件还不存在的那些**发不出去**:分成"要带的"与"此刻还没有的"两摞,
      // 由 `degradeInput` 按如实降级的规矩记进任务(不假装链生效)。
      const requested = input.referenceImages ?? (chain?.references ?? []).map((reference) => ({
        path: reference.path,
        ...(reference.note === undefined ? {} : { note: reference.note }),
      }))
      const absent: Array<{ path: string; note?: string }> = []
      for (const reference of requested) {
        const exists = chain === null
          ? (await fileFingerprint(entry.path, reference.path)) !== ABSENT
          : chain.ready.some((onDisk) => onDisk.path === reference.path)
        if (!exists) absent.push(reference)
      }

      // 协议不合 → 当场降级并留下说明(AC3)。
      const degraded = degradeInput(model, {
        ...(input.size === undefined ? {} : { size: input.size }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
        referenceImages: requested,
        ...(absent.length === 0 ? {} : { missingReferenceImages: absent }),
      })

      const at = new Date().toISOString()
      const task: GenerationTask = {
        schemaVersion: 1,
        id: randomUUID(),
        slot,
        outputPath,
        state: 'queued',
        ...(channel.name === undefined ? {} : { channel: channel.name }),
        model: model.id,
        prompt: input.prompt,
        requiresCharacters,
        ...(artStyleAnchor === undefined ? {} : { artStyleAnchor }),
        ...(degraded.effective.size === undefined ? {} : { size: degraded.effective.size }),
        ...(degraded.effective.quality === undefined ? {} : { quality: degraded.effective.quality }),
        referenceImages: degraded.effective.referenceImages,
        ...(degraded.degradation === undefined ? {} : { degradation: degraded.degradation }),
        attempts: [],
        rejections: [],
        createdAt: at,
        updatedAt: at,
      }
      writers.push(task)
      return task
    })

    if (input.run !== true) return created
    const ran = await this.runGenerationTask(projectRef, created.id)
    return ran ?? created
  }

  /**
   * 把板上"待填"的槽展开成任务集(AC4 的"补全全部待填"底层)。
   *
   * 展开依据是**推导**(槽清单 + 文件在不在),不是人维护的待办表 ——
   * 所以剧本改了、素材出了,这里自动跟着变。
   *
   * 出图顺序与差分批量同一套(T16):**被引用者先出**,并且 `run:true` 时
   * **建一个跑一个** —— 主视觉先落地,它的差分建任务时链才是真的
   * (先建齐再统一跑的话,差分建任务那一刻主视觉还不存在,链会被如实标成缺链)。
   */
  async createTasksForMissingSlots(
    projectRef: string,
    options: { model: string; prompts?: Record<string, string>; run?: boolean },
  ): Promise<GenerationTask[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    // 先过渠道与模型这两道门:**没有槽要填**也要拦。
    // (曾经这里是"循环里才校验",于是"没配渠道 + 槽刚好都填满"会静默返回空数组 ——
    //  人以为"补全全都跑完了",实际一个任务都没建。静默失败比报错坏得多。)
    this.#requireModel(options.model)
    const progress = await this.progress(projectRef)
    return await this.#createOrderedTasks(projectRef, entry.path, {
      slots: progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot),
      model: options.model,
      ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
      ...(options.run === undefined ? {} : { run: options.run }),
    })
  }

  /**
   * **差分批量**(T16):把一个角色在板上还没出图的槽一次补齐。
   *
   * 与"补全全部待填"共用同一条闸门(`#createOrderedTasks`):顺序由**派生事实**决定
   * (谁的产物出现在别人的参考链里,谁先出),`run:true` 时建一个跑一个 ——
   * 主视觉先落地,表情/姿势差分建任务时它已经在磁盘上,链才是真的。
   * `run:false` 只入队:链按**建任务那一刻**的磁盘状态解析(主视觉还没出 → 如实标缺链)。
   */
  async createDifferentialTasks(
    projectRef: string,
    options: { character: string; model: string; run?: boolean },
  ): Promise<GenerationTask[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    // 三道门先过(没渠道 / 模型不在目录 / 角色不在登记簿),**一个槽都不缺也要拦** ——
    // "看着跑完了其实什么都没做"是这套里最坏的一种失败。
    this.#requireModel(options.model)
    const ledger = await readSlots(entry.path)
    const characters = await readCharacters(entry.path)
    if (!characters.some((character) => character.id === options.character)) {
      throw new GalfreeError('unknown-character', `角色登记簿里没有「${options.character}」:先把角色登记上,参考链才有家`, {
        known: characters.map((character) => character.id),
      })
    }

    const owned = new Set(ledger.filter((slot) => slot.requiresCharacters.includes(options.character)).map((slot) => slot.slot))
    const progress = await this.progress(projectRef)
    return await this.#createOrderedTasks(projectRef, entry.path, {
      slots: progress.slots.filter((slot) => owned.has(slot.slot) && !slot.filled).map((slot) => slot.slot),
      model: options.model,
      // 差分批量**默认就跑**:这条回路的全部意义在于"主视觉先出、差分才有锚",
      // 只入队的话链要等人再点一次才生效。
      run: options.run ?? true,
    })
  }

  /**
   * 两个批量动作共用的闸门:**排序 → 建一个跑一个**。
   *
   * 排序 = 按"谁的产物出现在别人的参考链里"(主视觉 → 差分),依据是派生事实,
   * 不是槽名启发式。`run:true` 时才逐个跑 —— 那正是链能生效的原因(见上面两处注释)。
   */
  async #createOrderedTasks(
    projectRef: string,
    root: string,
    input: { slots: string[]; model: string; prompts?: Record<string, string>; run?: boolean },
  ): Promise<GenerationTask[]> {
    if (input.slots.length === 0) return []
    const [characters, ledger] = await Promise.all([readCharacters(root), readSlots(root)])
    const requiresOf = (slot: string): string[] => ledger.find((candidate) => candidate.slot === slot)?.requiresCharacters ?? []
    const chains = new Map<string, ReferenceChainView>()
    for (const slot of input.slots) chains.set(slot, await this.#resolveChain(root, slot, requiresOf(slot), characters))
    const ordered = sortSlotsByReference({
      slots: input.slots,
      referencesOf: (slot) => (chains.get(slot)?.references ?? []).map((reference) => reference.path),
    })

    const tasks: GenerationTask[] = []
    for (const slot of ordered) {
      const record = ledger.find((candidate) => candidate.slot === slot)
      const prompt = input.prompts?.[slot] ?? record?.prompt ?? ''
      tasks.push(await this.createGenerationTask(projectRef, {
        slot,
        model: input.model,
        prompt: prompt === '' ? `${slot} 的素材` : prompt,
        run: input.run ?? false,
      }))
    }
    return tasks
  }

  /**
   * 推进队列里**排队中**的任务(串行,一个跑完再跑下一个)。
   * 返回跑过之后的任务视图。失败的任务留在 `failed`,不会被队列反复重跑
   * —— 重试是人的动作(`retryGenerationTask`),不是自动重试循环。
   */
  async runGenerationQueue(projectRef: string): Promise<GenerationTask[]> {
    const queued = (await this.generationTasks(projectRef)).filter((task) => task.state === 'queued')
    for (const task of queued) await this.runGenerationTask(projectRef, task.id)
    const after = await this.generationTasks(projectRef)
    return queued.map((task) => after.find((candidate) => candidate.id === task.id) ?? task)
  }

  /**
   * 重 roll 一个任务(人发起):保留历史,追加一次尝试。
   *
   * 允许在 `failed` 与 `awaiting-review` 上用(后者 = 看一眼不满意就重 roll)。
   * `prompt` 给了就**改词再出**(对话里"把小棠的怒颜重 roll 得更夸张"走的就是这条);
   * `size`/`referenceImages` 同理。被换掉的那一版记进历史(`replacedFingerprint`),
   * 所以"可对比"不是口头承诺。
   *
   * **拒收注记(T16)**:`note` 是"这一版为什么不行"的原话,它**只追加**进 `rejections`,
   * 并指向被拒的那一版(尝试号 + 指纹)。给了空注记 = 拒(`empty-note`):要么说清为什么,
   * 要么别记 —— 一条没有理由的"打回"对下一个看历史的人毫无价值。
   */
  async retryGenerationTask(
    projectRef: string,
    id: string,
    options: {
      run?: boolean
      prompt?: string
      size?: string
      quality?: string
      referenceImages?: Array<{ path: string; note?: string }>
      /** 拒收理由(人话;**不是**叙述内容,长度有上限)。 */
      note?: string
      /** 拒收注记是谁记的(工作台的人 or 替人转述的 agent)。 */
      via?: GenerationRejection['via']
    } = {},
  ): Promise<GenerationTask> {
    const reset = await this.#mutateTasks(projectRef, async (document, writers) => {
      const task = findTask(document, id)
      if (task === undefined) throw new GalfreeError('unknown-task', `没有这个图像任务:${id}`)
      if (options.prompt !== undefined && options.prompt.trim() === '') {
        throw new GalfreeError('empty-prompt', '重 roll 时给的提示词是空的:要么不给(沿用原词),要么给一句能用的')
      }
      const at = new Date().toISOString()
      const next: GenerationTask = {
        ...task,
        state: 'queued',
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.size === undefined ? {} : { size: options.size }),
        ...(options.quality === undefined ? {} : { quality: options.quality }),
        ...(options.referenceImages === undefined ? {} : { referenceImages: options.referenceImages }),
        updatedAt: at,
      }
      if (options.note !== undefined) {
        const note = options.note.trim()
        if (note === '') {
          throw new GalfreeError('empty-note', '拒收注记是空的:要么不给(没有理由就不记),要么给一句能用的')
        }
        if (note.length > MAX_REJECTION_NOTE_CHARS) {
          throw new GalfreeError('note-too-long', `拒收注记太长(${note.length} > ${MAX_REJECTION_NOTE_CHARS} 字):这里写制作理由,不写剧本`)
        }
        const rejected = task.attempts.at(-1)
        next.rejections = [...(task.rejections ?? []), {
          attempt: rejected?.n ?? 0,
          ...(rejected?.fingerprint === undefined ? {} : { fingerprint: rejected.fingerprint }),
          note,
          // 拒收注记**本质上是人的判断**;agent 只是转述,转述时必须显式标 `via:'agent'`。
          // 默认朝"人"这一侧:忘了标也不会把人的话记成机器的话。
          via: options.via ?? 'human',
          at,
        }]
      }
      delete next.lastError
      writers.push(next)
      return next
    })
    if (options.run === false) return reset
    return (await this.runGenerationTask(projectRef, id)) ?? reset
  }

  /**
   * 真跑一次任务:出网 → 解码 → **经写网关落盘** → 记账。
   *
   * 落盘是这一步的全部意义:产物进了项目目录、过网关(自动快照)、
   * 槽位的"已填"推导立刻变绿 —— 板不需要任何人上报。
   * 失败不产半成品,并把上游原话写进 `attempts`。
   */
  async runGenerationTask(projectRef: string, id: string): Promise<GenerationTask | null> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)

    // 1) 取任务(先读出来,拿到 model 才能选适配器)并置 running(状态机对外可见)。
    const started = new Date().toISOString()
    const task = await this.#mutateTasks(projectRef, (document, writers) => {
      const found = findTask(document, id)
      if (found === undefined) throw new GalfreeError('unknown-task', `没有这个图像任务:${id}`)
      const next: GenerationTask = { ...found, state: 'running', updatedAt: started }
      writers.push(next)
      return Promise.resolve(next)
    })
    const { channel, model } = this.#requireModel(task.model)

    const adapter = adapterFor(model.adapter)

    // 2) 出网。失败如实记账(上游原话进历史)。
    //    同步适配器一次就拿到字节;异步任务制只拿到 task id,要轮询到终态再取图。
    let bytes: Uint8Array
    try {
      // 参考图内联成 data URL(远端够不着项目内相对路径)。文件若在建任务之后被删了,
      // 这里**如实报错**而不是少发一张 —— "链看着生效了其实没有"正是要防的那种假象。
      const plan = adapter.buildRequest({
        channel,
        model,
        prompt: task.prompt,
        ...(task.size === undefined ? {} : { size: task.size }),
        ...(task.quality === undefined ? {} : { quality: task.quality }),
        referenceImages: await this.#inlineReferences(projectRef, task.referenceImages),
      })
      const http = this.#imagePorts!.http
      const response = await http.send(plan.request)
      const submission = adapter.onSubmit(response, model)
      if (submission.kind === 'bytes') {
        bytes = submission.bytes
      } else {
        bytes = await this.#awaitAsyncResult({ http, adapter, model, channel, taskId: submission.taskId })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await this.#mutateTasks(projectRef, (document, writers) => {
        const found = findTask(document, id)!
        const failed: GenerationTask = {
          ...found,
          state: 'failed',
          lastError: message,
          attempts: [...found.attempts, this.#attempt(found.attempts.length + 1, started, 'failed', { error: message })],
          updatedAt: new Date().toISOString(),
        }
        writers.push(failed)
        return Promise.resolve(failed)
      })
    }

    // 3) 产物经写网关落盘(自动快照)。CAS 用现读的版本戳:外部要是刚动过这张图,
    //    网关会如实报漂移,而不是把外部的改动盖掉。
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(task.outputPath)
    // 重 roll 要**保留上一产物为历史**(T15 AC):覆盖之前先把"正在被替换的那一张"
    // 的指纹记进本次尝试。文件本身照旧被覆盖 —— 但旧内容留在写批前的快照里,
    // 有了指纹就能精确对上"历史上哪一版是它"(git 快照 + snapshotHistory 可回看)。
    const replacedFingerprint = current.missing ? undefined : current.version
    const result = await gateway.writeBatch(
      [{ path: task.outputPath, content: bytes, expectVersion: current.version }],
      { origin: 'agent', reason: 'slot', slot: task.slot },
    )
    const written = result.versions[task.outputPath] ?? fingerprint(bytes)

    // 4) 记账:待复审(等人看)。
    return await this.#mutateTasks(projectRef, (document, writers) => {
      const found = findTask(document, id)!
      const done: GenerationTask = {
        ...found,
        state: 'awaiting-review',
        attempts: [...found.attempts, this.#attempt(found.attempts.length + 1, started, 'ok', {
          fingerprint: written,
          bytes: bytes.byteLength,
          ...(replacedFingerprint === undefined ? {} : { replacedFingerprint }),
        })],
        updatedAt: new Date().toISOString(),
      }
      delete done.lastError
      writers.push(done)
      return Promise.resolve(done)
    })
  }

  /**
   * 异步任务制:轮询到终态再取图。
   *
   * 三件事都**如实报**,不静默:
   *  - 上游明说失败 → 把 `fail_reason` 带回去;
   *  - 轮询到上限还没终态 → 说清"上游没在时限内给结果"(附最后一次状态);
   *  - 终态给了 URL → 再取一次二进制,取不到也算失败。
   */
  async #awaitAsyncResult(input: {
    http: ImageHttpClient
    adapter: ReturnType<typeof adapterFor>
    model: ReturnType<typeof imageModels>[number]
    channel: ImageChannelSettings
    taskId: string
  }): Promise<Uint8Array> {
    const { http, adapter, model, channel, taskId } = input
    if (adapter.pollOnce === undefined) {
      throw new Error(`适配器 ${adapter.id} 回了一个要轮询的任务,但它没有实现轮询(配置与协议不匹配)`)
    }
    const poll = adapter.pollConfig?.(model) ?? { intervalMs: 3000, maxAttempts: 60 }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (channel.apiKey !== undefined && channel.apiKey !== '') headers.authorization = `Bearer ${channel.apiKey}`

    let lastNote = '未知'
    for (let attempt = 0; attempt < poll.maxAttempts; attempt += 1) {
      const step = await adapter.pollOnce({ model, baseUrl: channel.baseUrl, taskId, http, headers })
      if (step.kind === 'failed') throw new Error(step.error)
      if (step.kind === 'done') {
        if (step.bytes !== undefined) return step.bytes
        if (step.url === undefined) throw new Error('上游说成功了但既没给字节也没给地址')
        // 结果图通常是公开 URL;带上密钥也无妨(取不到会被如实报)。
        const image = await downloadResultImage(http, step.url, {})
        if (image.format !== 'png') {
          // 约定路径是 .png;上游给别的格式时如实说明,但仍按原字节落盘(不转码,免得掉质量)。
          lastNote = `上游返回 ${image.format}(按 png 路径落盘)`
        }
        void lastNote
        return image.bytes
      }
      lastNote = step.note
      if (poll.intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, poll.intervalMs))
    }
    throw new Error(`上游没在时限内给结果(轮询 ${poll.maxAttempts} 次,最后一次状态:${lastNote})`)
  }

  /**
   * 把链上的参考图内联成 data URL。
   *
   * 为什么必须内联:链上的图是**项目内的文件**,远端网关拿一个 `game/images/x.png`
   * 什么也取不到;`image_url` 要的是可取的地址。账本里存的仍是路径(引用),
   * 图片内容**只在这一次出网里出现**,不落进 `.studio/`(铁律不变)。
   *
   * 建任务时已经筛过"文件在不在";这里若发现它在跑之前被删了,如实报错 ——
   * 少发一张参考图而不吭声,就是"链看起来生效了其实没有"。
   */
  async #inlineReferences(
    projectRef: string,
    references: Array<{ path: string; note?: string }>,
  ): Promise<Array<{ path: string; dataUrl?: string }>> {
    if (references.length === 0) return []
    const gateway = await this.#gatewayFor(projectRef)
    const inlined: Array<{ path: string; dataUrl?: string }> = []
    for (const reference of references) {
      const current = await gateway.readBytes(reference.path)
      if (current.bytes === null) {
        throw new Error(`参考图 ${reference.path} 不在磁盘上(建任务时还在):链断了,先把它出出来或从登记簿的参考链里去掉`)
      }
      inlined.push({ path: reference.path, dataUrl: dataUrlOf(current.bytes, reference.path) })
    }
    return inlined
  }

  #attempt(
    n: number,
    startedAt: string,
    outcome: GenerationAttempt['outcome'],
    extra: { error?: string; fingerprint?: string; bytes?: number; replacedFingerprint?: string },
  ): GenerationAttempt {
    return {
      n,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      ...(extra.fingerprint === undefined ? {} : { fingerprint: extra.fingerprint }),
      ...(extra.bytes === undefined ? {} : { bytes: extra.bytes }),
      ...(extra.replacedFingerprint === undefined ? {} : { replacedFingerprint: extra.replacedFingerprint }),
    }
  }

  /** 渠道与模型的两道门(没配 / 不在目录里都如实拒绝)。 */
  #requireModel(modelId: string): { channel: ImageChannelSettings; model: ReturnType<typeof imageModels>[number] } {
    const channel = this.#imagePorts?.channel() ?? null
    if (channel === null) {
      throw new GalfreeError('no-image-channel', '还没有配置图像渠道(设置 → 插件 → GALFree):先填端点、密钥与模型目录')
    }
    const model = channel.models.find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      throw new GalfreeError('unknown-image-model', `模型「${modelId}」不在这个渠道的模型目录里`, {
        known: imageModels(channel).map((candidate) => candidate.id),
      })
    }
    return { channel, model }
  }

  async #readTasks(projectRef: string): Promise<ReturnType<typeof parseTasksDocument>> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(IMAGE_TASKS_FILE)
    if (current.missing) return emptyTasksDocument()
    return parseTasksDocument(current.content)
  }

  /**
   * 读-改-写任务账本。`#taskQueue` 串起来保证并发调用不会互相覆盖
   * (网关只保证单次写批的原子性,跨批的"读→算→写"要自己串)。
   */
  async #mutateTasks<T>(
    projectRef: string,
    mutate: (document: ReturnType<typeof parseTasksDocument>, writers: GenerationTask[]) => Promise<T> | T,
  ): Promise<T> {
    // 先把队尾摘下来再挂自己:这样 mutate 内部若再调 `#mutateTasks`(例如"建完立刻跑")
    // 不会等自己 —— 嵌套调用排队等的是**前一个**调用,不是当前这个。
    const previous = this.#taskQueue
    let release!: () => void
    this.#taskQueue = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => {})
    try {
      const gateway = await this.#gatewayFor(projectRef)
      const current = await gateway.read(IMAGE_TASKS_FILE)
      const document = current.missing ? emptyTasksDocument() : parseTasksDocument(current.content)
      const writers: GenerationTask[] = []
      const result = await mutate(document, writers)
      if (writers.length > 0) {
        let next = document
        for (const task of writers) next = upsertTask(next, task)
        await gateway.writeBatch(
          [{ path: IMAGE_TASKS_FILE, content: tasksDocument(next), expectVersion: current.version }],
          { origin: 'agent', reason: 'queue' },
        )
      }
      return result
    } finally {
      release()
    }
  }

  #requireHuman(actor: { via: 'human' | 'agent' }): void {
    if (actor.via !== 'human') {
      throw new GalfreeError('stamp-forbidden', '审读戳只能由人盖(工作台真实动作),agent 无权设置')
    }
  }

  async #putStamp(projectRef: string, target: string, fingerprint: string): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read('.studio/stamps.json')
    const stamps = await this.stampRecords(projectRef)
    const next = withStamp(stamps, target, fingerprint)
    await gateway.writeBatch(
      [{ path: '.studio/stamps.json', content: stampsDocument(next), expectVersion: current.version }],
      { origin: 'workbench', reason: 'stamp' },
    )
  }

  /** 停掉全部监听(宿主 dispose 与测试收尾用)。 */
  async dispose(): Promise<void> {
    const gateways = await Promise.all([...this.#gateways.values()])
    for (const gateway of gateways) await gateway.dispose()
    this.#gateways.clear()
  }

  // ─── 内部 ────────────────────────────────────────────────────────────

  /** 建网关并挂快照钩子(ADR-0004 挂载点;git 未初始化时钩子跳过)。 */
  #newGateway(root: string): WriteGateway {
    const gateway = new WriteGateway(root)
    gateway.onBatchCommit(async ({ batchId, reason }) => {
      if (!existsSync(join(root, '.git'))) return // scaffold 批:稍后 #initGit 建初始快照
      await commitSnapshot(root, reason, batchId)
    })
    return gateway
  }

  /**
   * 按 id 或 name 解析项目并返回其网关(懒建)。
   * 竞态安全:在 `await` 之前**同步**写入 promise,两个并发调用拿到同一实例
   * (否则"每项目一队列"的串行保证与"唯一写通道"日志会被双网关穿透)。
   */
  async #gatewayFor(projectRef: string): Promise<WriteGateway> {
    const entry = await this.#resolve(projectRef)
    const existing = this.#gateways.get(entry.id)
    if (existing !== undefined) return existing
    // 同步占位:先建 promise 再 await 任何异步,消除 get→set 竞态窗口。
    const created = (async () => {
      await this.#assertPresent(entry)
      return this.#newGateway(entry.path)
    })()
    this.#gateways.set(entry.id, created)
    try {
      return await created
    } catch (error) {
      this.#gateways.delete(entry.id) // 建失败(如项目缺失):清占位,下次可重试。
      throw error
    }
  }

  async #resolve(projectRef: string): Promise<RegistryEntry> {
    const byId = await this.#registry.get(projectRef)
    if (byId !== undefined) return byId
    const all = await this.#registry.list()
    const matches = all.filter((entry) => entry.name === projectRef)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new GalfreeError('ambiguous-project', `项目名 ${projectRef} 有多个匹配,请用 id 引用`)
    throw new GalfreeError('unknown-project', `注册表中不存在项目 ${projectRef}`)
  }

  async #assertPresent(entry: RegistryEntry): Promise<void> {
    try {
      await access(join(entry.path, 'game'))
    } catch {
      throw new GalfreeError('project-missing', `项目目录已不存在:${entry.path}`)
    }
  }

  async #toInfo(id: string): Promise<ProjectInfo> {
    const entry = await this.#registry.get(id)
    if (entry === undefined) throw new GalfreeError('unknown-project', `注册表中不存在项目 ${id}`)
    let missing = false
    try {
      await access(join(entry.path, 'game'))
    } catch {
      missing = true
    }
    const activeId = await this.#registry.activeId()
    return { ...entry, root: entry.path, active: activeId === entry.id, missing }
  }

  /** 模板 git 化:init + 初始提交(作者 GALFree,ADR-0011)。 */
  /**
   * 从钉版 SDK 的 GUI 模板取界面文件(整份)。
   *
   * 取不到就**如实抛**:一个没有 `screens.rpy` 的项目是跑不起来的(关窗即崩),
   * 与其造一个"看着像项目、一玩就崩"的东西,不如当场说清缺什么、去哪儿补。
   */
  async #uiFilesFrom(sdkDir: string | undefined): Promise<{ files: Array<{ path: string; content: string }>; fontFiles: Array<{ path: string; content: Uint8Array }> }> {
    if (sdkDir === undefined || sdkDir === '') {
      throw new GalfreeError(
        'sdk-ui-missing',
        '新建项目需要钉版 SDK 的界面模板(screens.rpy / gui.rpy):没有它们,项目连关窗确认都会崩。请先完成 SDK 供给,或在设置里指定既有 SDK 路径。',
      )
    }
    const dir = join(sdkDir, 'gui', 'game')
    const files: Array<{ path: string; content: string }> = []
    for (const name of TEMPLATE_UI_FILES) {
      try {
        files.push({ path: `game/${name}`, content: await readFile(join(dir, name), 'utf8') })
      } catch (error) {
        throw new GalfreeError(
          'sdk-ui-missing',
          `SDK 的界面模板里缺 ${name}:${join(dir, name)} 读不到(${String(error)})。请检查 SDK 是否完整(设置 → GALFree → SDK 路径)。`,
        )
      }
    }
    // 中文字体:SDK 自带思源黑体,拷进项目(**相对路径才有效**;绝对路径会被静默回退)。
    // 拿不到不阻断建项目 —— 界面补丁会在注释里说明"中文会显示成方块",
    // 这比"因为少一个字体就不让人建项目"合理:项目本身是好的。
    const fontFiles: Array<{ path: string; content: Uint8Array }> = []
    try {
      fontFiles.push({
        path: `game/${TEMPLATE_CJK_FONT.target}`,
        content: await readFile(join(sdkDir, 'sdk-fonts', TEMPLATE_CJK_FONT.source)),
      })
    } catch { /* 见上:不阻断 */ }
    return { files, fontFiles }
  }

  async #initGit(root: string, name: string): Promise<void> {
    await runGit(root, ['init', '--initial-branch', 'main'])
    await runGit(root, ['add', '--all'])
    await runGit(root, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', `chore(galfree): scaffold template project "${name}"`])
  }
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  return new ProjectService(options)
}
