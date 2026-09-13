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
import { join, dirname } from 'node:path'
import { GalfreeError } from './error.ts'
import { GATE } from './gates.ts'
import { runGit } from './git.ts'
import { ProjectRegistry, type RegistryEntry } from './registry.ts'
import { commitSnapshot, fileDiff, fileHistory, rollbackFile, type SnapshotEntry } from './snapshot.ts'
import { PROJECT_NAME_RE, TEMPLATE_CJK_FONT, TEMPLATE_UI_FILES, TEMPLATE_UI_IMAGE_DIR, TEMPLATE_WINDOW_ICON, renderTemplateFiles, renderUiPatch, templateKeepFiles } from './template.ts'
import { COVER_TARGETS, coverTargetOf, coverTargetIds } from './covers.ts'
import { dialogueIdFor } from './dialogue-id.ts'
import { isVoiceAudioFile, matchVoiceFiles, voiceTargetPath, type VoiceBatch, type VoiceBatchRow } from './voice-batch.ts'
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
  type CharacterRecord, type SlotRecord, type VoiceEmotion,
} from './characters.ts'
import { deriveSlots } from './slots.ts'
import { deriveAudio, poolViewOf, readAudioFiles, type AudioDerivation, type AudioPoolView } from './audio.ts'
import { resolveReferenceChain, sortSlotsByReference, type ReferenceChainView } from './reference-chain.ts'
import { buildVoiceAnchorBoard, resolveVoiceAnchor, type VoiceAnchorBoard, type VoiceAnchorView } from './voice-anchor.ts'
import { readVoiceLibrary, type VoiceLibraryReading } from './audio-discovery.ts'
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
import { abortError, contentFingerprint, launchPlaytest, playtestDocument, readPlaytest, PLAYTEST_FILE, type PlaytestPorts, type PlaytestRun } from './playtest.ts'
import {
  DEFAULT_PACKAGES, GUI_IMAGES_SENTINEL, PUBLISH_FILE, assertDestinationOutsideProject, buildIdentityBlockers,
  collectArtifacts, guiImagesBlockers, logTailOf,
  publishBlockers, publishDocument, publishView, readPublish, snapshotDir,
  type PublishArtifact, type PublishBlocker, type PublishDocument, type PublishPorts, type PublishReadiness,
  type PublishReport, type PublishRun, type PublishView,
} from './publish.ts'
import {
  IMAGE_TASKS_FILE, IMAGE_TASK_KIND_DESCRIPTOR, MAX_REJECTION_NOTE_CHARS, adapterFor, dataUrlOf, degradeInput, downloadResultImage,
  emptyTasksDocument, findTask, imageModels,
  parseTasksDocument, tasksDocument, upsertTask,
  type CreateGenerationTaskInput, type GenerationTask, type GenerationTaskDocument, type GenerationAttempt, type GenerationRejection,
  type ImageChannelSettings, type ImageHttpClient,
} from './images.ts'
// 任务账本的**通用层**(T27):图像与音频共用"读-改-写 + 串行"那一套纪律。
import { makeTaskLedger } from './tasks.ts'
import {
  adapterFor as audioAdapterFor,
  AUDIO_POLL_INTERVAL_MS, AUDIO_POLL_TIMEOUT_MS,
  AUDIO_TASK_KIND_DESCRIPTOR, AUDIO_TASKS_FILE, assertAudioOutputPath, audioModels, decodeBase64OrRaw, purposeOfPath,
  type AudioChannelSettings, type AudioModelDescriptor, type AudioPorts, type AudioPurpose, type AudioTask, type CreateAudioTaskInput,
} from './audio-generation.ts'
import type { GenerationDegradation } from './tasks.ts'
import { ABSENT, fileFingerprint, fingerprint, pathExists } from './hash.ts'
import {
  GUI_CODE_FILE, GUI_IMAGE_DIR, THEME_FILE, parseThemeRecord, parseThemeSpec, projectResolutionOf, themeLabel, themeViewOf,
  writeThemeDefines, type ThemeRecord, type ThemeSpec, type ThemeView,
} from './theme.ts'
import { generateThemedImages, type ThemePorts } from './theme-runner.ts'
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

/** 换皮参数的面(与 `ThemeSpec` 同形,只是都可省 —— 缺省有据)。 */
export type ThemeSpecInput = Partial<ThemeSpec>

/**
 * 分辨率那道门(预演与真换**同一道**)。
 *
 * 界面图整套按项目分辨率缩放;尺寸错的那一刻引擎**不报错**(它只是把图拉伸),
 * 画面就歪了 —— 所以这一条只能在入口拦,而且要在**预演**就拦:
 * 让人看到漂亮的数字、点下去才吃拒绝,等于把"能不能做"藏到最后一刻。
 */
function assertThemeResolution(spec: ThemeSpec, resolution: { width: number; height: number }): void {
  if (spec.width === resolution.width && spec.height === resolution.height) return
  throw new GalfreeError(
    'theme-resolution-mismatch',
    `主题给的是 ${spec.width}×${spec.height},而项目现在是 ${resolution.width}×${resolution.height}`
    + ' —— 界面图是按项目分辨率缩放出来的,尺寸对不上会整屏歪掉。'
    + `要么按 ${resolution.width}×${resolution.height} 重出一套;要么先改项目的分辨率(那是另一件事)。`,
  )
}

/** 换皮的预演(面板照它说清"要动什么")。 */
export interface ThemePreview {
  spec: ThemeSpec
  /** 项目当前分辨率(界面图就是按它缩放的)。 */
  resolution: { width: number; height: number }
  /** 现在是什么主题(人话)。 */
  from: string
  added: number
  replaced: number
  /** 会被删掉的旧文件(新的一套里没有的那些)。 */
  removed: string[]
  /** 这一次要写几个**图**文件(整套重出,不是增量)。 */
  images: number
  /** 除图之外还要写的两份:`game/gui.rpy` 与 `.studio/theme.json`(写批里总有它们)。 */
  extraWrites: number
}

/** 换皮的结果(如实报数:写了几张、几张是新的、删了什么、快照是哪一条)。 */
export interface ThemeApplyReport {
  spec: ThemeSpec
  appliedAt: string
  images: number
  added: number
  replaced: number
  removed: string[]
  batchId: number
  label: string
}

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
   * 音频生成端口(T27 / ADR-0012):音乐与语音共用的一条渠道。
   *
   * **缺省 = 没装配** → 音频生成如实报 `no-music-channel` / `no-voice-channel`(与图像同一种态度)。
   */
  audio?: AudioPorts
  /**
   * 界面模板来源(新建项目时从哪儿取 `screens.rpy` / `gui.rpy` 等)。
   *
   * 生产 = 钉版 SDK 的 `gui/game/`(随设置实时解析);快带 = 假 SDK 夹具。
   * 缺省实现按 `CreateProjectInput.sdkDir` 现取 —— 两个入口最终都落到
   * "读 SDK 的 GUI 模板",没有第二套界面来源。
   */
  uiTemplate?: (sdkDir: string | undefined) => Promise<{ files: Array<{ path: string; content: string }>; binaryFiles: Array<{ path: string; content: Uint8Array }> }>
  /**
   * 发布端口(T18):构建器 + 输出目录。
   *
   * **缺省 = 没装配** → 发布这条路如实报 `publish-unavailable`(与"没配渠道"同一种态度),
   * 不假装能出片。生产注入真 spawn 的钉版 SDK;快带注入假构建(把假产物写进输出目录)。
   */
  publish?: {
    ports: PublishPorts
    /** 这个项目的输出目录(绝对路径;生产 = 设置里的目录 / 数据目录下的默认位置)。 */
    destination: (project: ProjectInfo) => string
  }
  /**
   * 界面换皮端口(T31 / #39):跑一次钉版 SDK 的界面生成器(staging → 收整套界面图)。
   *
   * **缺省 = 没装配** → 换皮如实报 `theme-unavailable`(与"没配渠道"同一种态度)。
   * 生产注入真引擎(`realRenpyRun`);快带注入假生成器(往 staging 里写一批假 PNG)。
   */
  theme?: ThemePorts
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
  #audioPorts: AudioPorts | null = null
  /** 图像任务账本(与音频账本走**同一个**工厂,只是文件不同)。 */
  #imageLedger: ReturnType<typeof makeTaskLedger<GenerationTask>>
  /** 音频任务账本(T27)。 */
  #audioLedger: ReturnType<typeof makeTaskLedger<AudioTask>>
  /**
   * **最近一次读到的音色库**(T32):`GET /voices` 的文件名 + 目录。
   *
   * 为什么记在内存里而不是落盘:它是**那台服务此刻的处境**,不是项目的制作信息 ——
   * 写进 `.studio/` 就会变成"第二份真相",而服务端才是音色库的真相。
   * 用途只有一个:建语音任务时标一句"档案要的样本此刻不在库里"(`at` 让人知道它有多新)。
   */
  #voiceLibrary: { files: string[]; dir?: string; at: string } | null = null
  #publishPorts: NonNullable<ProjectServiceOptions['publish']> | null
  /** 界面换皮端口(T31);缺省 = 没装配 → 换皮如实拒绝。 */
  #themePorts: ThemePorts | null
  /** 换皮的串行:同一时刻只跑一次引擎(而且它要在 staging 上复制整份项目)。 */
  #themeQueue: Promise<unknown> = Promise.resolve()
  #uiTemplate: (sdkDir: string | undefined) => Promise<{ files: Array<{ path: string; content: string }>; binaryFiles: Array<{ path: string; content: Uint8Array }> }>
  #gateways = new Map<string, Promise<WriteGateway>>()
  /** 图像任务账本的写串行(与网关的串行合起来构成"读-改-写"原子性)。 */
  #taskQueue: Promise<unknown> = Promise.resolve()
  /** 发布的串行:构建很重,同时跑两个没有意义(而且会互相踩输出目录)。 */
  #publishQueue: Promise<unknown> = Promise.resolve()
  /** 试玩的串行:同时开两个游戏窗口没有意义(而且面板那颗"取消"要能指名道姓)。 */
  #playtestQueue: Promise<unknown> = Promise.resolve()
  /** 正在跑的那一次试玩的中止器;**null = 此刻没有在跑**。 */
  #playtestAbort: AbortController | null = null

  constructor(options: ProjectServiceOptions) {
    this.#registry = new ProjectRegistry(join(options.dataDir, 'registry.json'))
    this.#validator = options.validator ?? (async (project) => new FakeValidator().validate(join(project.root, 'game')))
    this.#playtestPorts = options.playtest ?? { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) }
    this.#imagePorts = options.images ?? null
    this.#audioPorts = options.audio ?? null
    this.#publishPorts = options.publish ?? null
    this.#themePorts = options.theme ?? null
    this.#uiTemplate = options.uiTemplate ?? ((sdkDir) => this.#uiFilesFrom(sdkDir))
    // 两份账本走**同一个**工厂(不同的只是文件与"形状对不对"那一条)。
    // 读-改-写经网关(ADR-0004)→ 自动进快照(ADR-0011)。
    const ledgerHost = {
      read: async (projectRef: string, path: string) => await this.#readLedgerFile(projectRef, path),
      write: async (projectRef: string, path: string, content: string, expectVersion: string) => {
        const gateway = await this.#gatewayFor(projectRef)
        await gateway.writeBatch([{ path, content, expectVersion }], { origin: 'agent', reason: 'queue' })
      },
    }
    this.#imageLedger = makeTaskLedger<GenerationTask>(IMAGE_TASK_KIND_DESCRIPTOR, ledgerHost)
    this.#audioLedger = makeTaskLedger<AudioTask>(AUDIO_TASK_KIND_DESCRIPTOR, ledgerHost)
  }

  /** 账本文件的原始读(网关口径:内容 + 版本戳 + 在不在)。 */
  async #readLedgerFile(projectRef: string, path: string): Promise<{ content: string; missing: boolean; version: string }> {
    const gateway = await this.#gatewayFor(projectRef)
    return await gateway.read(path)
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
      // 中文字体与界面图片:拷进项目(**相对路径才有效**;绝对路径会被静默回退)。
      ...ui.binaryFiles,
      // 中文字体/界面变量补丁(`hasFont` 由"到底拷到字体没有"决定);
      // 里面还带着"发行版排除 guisupport.rpy + 自带 gui.scale"那一段(T18 的实测修复)。
      renderUiPatch(ui.binaryFiles.some((file) => file.path.includes('SourceHanSans'))),
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
    // 界面主题(T31):记录 + 项目当前分辨率 → 推导"现在是什么主题 / 是不是要重出"。
    // 读不到界面代码时**不抛**:板子照出,主题那一格如实说"看不出分辨率"。
    const theme = await this.#themeView(projectRef)
    const derived = deriveSlots({ parsed, ledger, characters })
    // 项目级完整性(T13):孤立场景 / 结局不可达,外加把全局问题**定位到场景**。
    const completeness = deriveCompleteness(graph)
    // 音频引用(T17):池是派生的(扫 game/ 下的音频文件),悬空引用 = error 上板。
    const audio = await this.#deriveAudio(graph.scenes, entry.path)
    // 发布处境(T18):上次发布的产物在哪、还新不新(纯推导;没发布过 = null)。
    const publishLedger = await readPublish(entry.path)
    return computeProgress(entry.path, {
      scenes: graph.scenes,
      problems: [...graph.problems, ...completeness.problems, ...derived.problems, ...audio.problems],
      derivedSlots: derived.slots,
      characters,
      definedCharacters: parsed.characters,
      completeness: {
        entry: completeness.entry,
        orphans: completeness.orphans,
        endingReachable: completeness.endingReachable,
      },
      audio: poolViewOf(audio),
      publish: publishView(publishLedger, contentFingerprint(graph)),
      bible: {
        fingerprint: bibleFingerprint(bible),
        chapters: bible.chapters.length,
        characters: bible.characters.length,
        hasOutline: bible.outline !== null,
        outlineFingerprint: outlineText === null ? null : fingerprint(outlineText),
        outlineRef: bible.outline === null ? null : { fingerprint: bible.outline.fingerprint },
      },
      playtest: { last: playtest?.last ?? null, currentFingerprint: contentFingerprint(graph) },
      // 运行时事实(不是从磁盘推的):面板那颗"取消"按钮据此显示。
      playtestRunning: this.playtestRunning(),
      theme,
    })
  }

  /**
   * 主题处境的**推导形态**(给板子用):读不到 `gui.rpy` 时退成"看不出分辨率"(不抛)。
   *
   * 与 `theme()`(明确问"当前主题是什么")分开:那个是接口,缺文件要如实拒绝;
   * 这个是板子的一格,缺文件时整块板不该跟着塌。
   */
  async #themeView(projectRef: string): Promise<ThemeView> {
    const gateway = await this.#gatewayFor(projectRef)
    const [code, record] = await Promise.all([gateway.read(GUI_CODE_FILE), this.#readThemeRecord(projectRef)])
    if (!code.missing) {
      return themeViewOf(record?.spec ?? null, record?.appliedAt ?? null, projectResolutionOf(code.content))
    }
    const view = themeViewOf(record?.spec ?? null, record?.appliedAt ?? null, { width: 0, height: 0 })
    return { ...view, label: `看不出项目分辨率(${GUI_CODE_FILE} 不在)—— 界面换皮要先有这个文件` }
  }

  /** 解析项目的全部 `.rpy`(场景 + 顶层角色定义);`branchGraph` 与槽派生共用。 */
  async #parseScript(projectRef: string): Promise<ParsedScript> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    return parseRpy(await readRpyFiles(join(entry.path, 'game')))
  }

  /**
   * 音频文件池 + 引用处境(T17,纯推导 + 一次扫描)。
   *
   * 池成员 = `game/` 下的音频文件(递归),**没有任何手工登记**:人把文件丢进去,
   * 这里立刻有它;删掉就没了。引用缺失音频 = error,定位到哪一场的哪一行。
   */
  async audioPool(projectRef: string): Promise<AudioPoolView> {
    const graph = await this.branchGraph(projectRef)
    const entry = await this.#resolve(projectRef)
    return poolViewOf(await this.#deriveAudio(graph.scenes, entry.path))
  }

  async #deriveAudio(scenes: ReturnType<typeof parseRpy>['scenes'], root: string): Promise<AudioDerivation> {
    return deriveAudio({ scenes, files: await readAudioFiles(join(root, 'game')) })
  }

  /**
   * 一键试玩(T7/T13):钉版 SDK 启动当前项目、退出回传;运行事实经网关落 `.studio/playtest.json`
   * 并进快照。技术通过是推导(退出码/日志),不是人盖的戳。
   *
   * `fromLabel` 给了就**从这一场开始**(T13):在副本里覆写 start 跳过去 —— 用户项目一个
   * 字节都不动。目标场不存在会在启动时崩出 traceback,所以"落对了"这件事有可红的信号。
   *
   * **取消(T24 / #32)**:`options.signal` 是宿主那一轮的取消信号(协作式取消:谁等谁就得
   * 自己观察)。取消时子进程被中止,并如实抛 `aborted` —— 账本**不记**这一条(被取消的
   * 试玩不是一次试玩,记了板上就会多一条假事实)。面板那条路走 `cancelPlaytest()`,
   * 它中止的是**同一个**信号。
   *
   * `options.timeoutMs` 是这一次愿意等多久(有界;缺省 `PLAYTEST_TIMEOUT_MS`)。
   * 一次只跑一个:第二个调用排在后面(同时开两个游戏窗口没有意义)。
   */
  async playtestStart(
    projectRef: string,
    fromLabel: string | null = null,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<PlaytestRun> {
    // 排队期间也得能取消(T24):否则第二个调用方要等"前一个的最多 3 分钟 + 自己的 3 分钟",
    // 而取消它完全没反应 —— 那正是这张票要消灭的"等而不知道、停也停不掉"。
    // 做法就是**别硬等**:谁先落定(上一个人跑完 / 取消到了)谁说了算。
    if (options.signal?.aborted === true) throw abortError()
    const previous = this.#playtestQueue
    let release!: () => void
    this.#playtestQueue = new Promise<void>((resolve) => { release = resolve })
    const { signal } = options
    if (signal !== undefined) {
      const abortSignal = signal
      // 一个 `once` 监听器,finally 里摘掉(信号可能活一整轮会话,挂着不管就是一路漏)。
      const cancelled = new Promise<boolean>((resolve) => {
        const onAbort = (): void => resolve(true)
        abortSignal.addEventListener('abort', onAbort, { once: true })
        void previous.then(() => { abortSignal.removeEventListener('abort', onAbort) })
      })
      if (await Promise.race([previous.then(() => false), cancelled])) throw abortError()
    } else {
      await previous
    }
    // 占位**在排到队之后**才写:排队中的第二次调用不是"在跑",`cancelPlaytest()` 也不该
    // 对着它说"中止了正在跑的那一次"(那是假话 —— 契约明写没有在跑就返回 false)。
    const controller = new AbortController()
    this.#playtestAbort = controller
    const onCallerAbort = (): void => controller.abort()
    // 这里不用再查一次"已经取消过没有":上面那条 `cancelledWhileQueued` 已经覆盖了
    // (tsc 也知道 —— 它把 `signal.aborted` 窄化成了 `false`,再判一次会被它当死代码)。
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      const graph = await this.branchGraph(projectRef)
      const entry = await this.#resolve(projectRef)
      if (fromLabel !== null && !graph.scenes.some((scene) => scene.label === fromLabel)) {
        throw new GalfreeError('unknown-scene', `场景 ${fromLabel} 不存在,无法从它开始试玩`)
      }
      const gateway = await this.#gatewayFor(projectRef)
      const run = await launchPlaytest(this.#playtestPorts, entry.path, contentFingerprint(graph), fromLabel, {
        signal: controller.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      const ledger = (await readPlaytest(entry.path)) ?? { schemaVersion: 1 as const, last: null, history: [] }
      const next = { schemaVersion: 1 as const, last: run, history: [...ledger.history, run] }
      await this.#recordLedger(entry.id, PLAYTEST_FILE, playtestDocument(next), 'playtest')
      return run
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort)
      // 谁先来谁占位:只有**自己**还是那个在跑的,才清掉(否则会把后来者抹掉)。
      if (this.#playtestAbort === controller) this.#playtestAbort = null
      release()
    }
  }

  /** 此刻有没有一次试玩在跑(面板的"取消"按钮据此显示;不是推导,是运行时事实)。 */
  playtestRunning(): boolean {
    return this.#playtestAbort !== null
  }

  /**
   * 中止正在跑的那一次试玩(T24 / #32;面板那颗"取消"按钮的后端)。
   *
   * 走的是**同一个**中止信号(宿主取消与面板取消不是两条路):子进程被杀掉,
   * `playtestStart` 如实抛 `aborted`,账本不记。**没有在跑就返回 false** ——
   * 面板据此说"现在没有在跑的试玩",而不是假装杀掉了一个进程。
   */
  cancelPlaytest(): boolean {
    const controller = this.#playtestAbort
    if (controller === null) return false
    controller.abort()
    return true
  }

  /**
   * 项目级完整性(读,T13):入口 / 可达 / 孤立场景 / 结局可达 + 已定位到场景的问题。
   * 纯推导,可全量重算 —— 与板上的其他判断同源。
   */
  async completeness(projectRef: string): Promise<CompletenessReport> {
    const graph = await this.branchGraph(projectRef)
    return deriveCompleteness(graph)
  }

  // ─── 本地发布(T18)───────────────────────────────────────────────────

  /**
   * 发布前置检查(**读**):能不能发、缺什么、会用到哪个输出目录、上次发的是什么。
   *
   * 判断全部来自**同一份推导板**(`progress()`),不另算一套 lint/素材 ——
   * 否则板上说缺、发布说能出,两边迟早分叉。面板在点按钮之前就能显示这一份。
   */
  async publishReadiness(projectRef: string, options: { outputDir?: string; packages?: string[] } = {}): Promise<PublishReadiness> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const project = await this.#toInfo(entry.id)
    const progress = await this.progress(project.id)
    const publishPorts = this.#publishPorts
    const launcher = publishPorts === null ? null : await publishPorts.ports.resolveLauncher()
    const blockers = publishBlockers(progress, {
      sdkReady: launcher !== null,
      publishConfigured: publishPorts !== null,
    })
    const packages = options.packages ?? [...DEFAULT_PACKAGES]

    let destination: string | null = null
    if (publishPorts !== null) {
      destination = options.outputDir ?? publishPorts.destination(project)
      // 输出目录在源树里 = 会污染项目(AC4)→ 也是阻塞项,在**构建之前**说清楚。
      try {
        assertDestinationOutsideProject(destination, project.root)
      } catch (error) {
        blockers.push({ code: 'destination-in-project', label: error instanceof Error ? error.message : String(error) })
      }
      // 构建标识(实测:没有 build.name 会打出 `-pc/` 与 `.exe` 这种空名字的包)。
      const optionsRpy = await readFile(join(project.root, 'game', 'options.rpy'), 'utf8').catch(() => null)
      blockers.push(...buildIdentityBlockers(optionsRpy))
      // 界面图(Ren'Py 在**首次运行时**把它们生成进项目;发行版里没有那个生成器)。
      blockers.push(...guiImagesBlockers(await pathExists(join(project.root, 'game', 'gui', GUI_IMAGES_SENTINEL))))
    }
    return { ready: blockers.length === 0, blockers, destination, packages, last: progress.publish }
  }

  /**
   * **一键发布**(T18):钉版 SDK 的 `build_dists` 产出可发行物,落在**项目源树之外**。
   *
   * 两条硬规矩:
   *  - 前置没过就**不构建**(如实阻止并列缺项,不产半成品);
   *  - 产物只在输出目录里,项目里**一个字节都不多**(源树是唯一真相,不是构建垃圾场)。
   *
   * 事实记 `.studio/publish.json`(经网关 → 快照):板据此说"上次发布什么时候、产物在哪、
   * 还新不新"。平台上传与在线分发**不做**(spec Out of Scope)。
   */
  async publish(projectRef: string, options: { packages?: string[]; outputDir?: string } = {}): Promise<PublishReport> {
    const readiness = await this.publishReadiness(projectRef, {
      ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
      ...(options.packages === undefined ? {} : { packages: options.packages }),
    })
    const publishPorts = this.#publishPorts
    // 前置没过(含"这台宿主没装配")→ 不构建,把缺项原样交回。
    if (!readiness.ready || publishPorts === null || readiness.destination === null) {
      return { ...readiness, ok: false }
    }

    // 构建串行:两个构建同时写同一个输出目录只会互相踩。
    const previous = this.#publishQueue
    let release!: () => void
    this.#publishQueue = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => {})

    try {
      const entry = await this.#resolve(projectRef)
      const launcher = await publishPorts.ports.resolveLauncher()
      if (launcher === null) throw new GalfreeError(GATE.sdkNotReady, '钉版 SDK 尚未就绪,无法发布')
      const destination = readiness.destination
      const before = await snapshotDir(destination)
      const result = await publishPorts.ports.run({
        launcher,
        // distribute 命令由 **launcher 项目**注册(见 publish.ts 顶部):SDK 根目录下的 launcher/。
        launcherProject: join(dirname(launcher), 'launcher'),
        projectRoot: entry.path,
        destination,
        packages: readiness.packages,
      })
      const artifacts: PublishArtifact[] = result.code === 0 ? await collectArtifacts(destination, before) : []
      const graph = await this.branchGraph(entry.id)
      const run: PublishRun = {
        at: new Date().toISOString(),
        ok: result.code === 0,
        packages: readiness.packages,
        destination,
        artifacts,
        exitCode: result.code,
        logTail: logTailOf(result.log),
        fingerprint: contentFingerprint(graph),
      }
      await this.#recordLedger(entry.id, PUBLISH_FILE, publishDocument({
        schemaVersion: 1,
        last: run,
        history: [...((await readPublish(entry.path))?.history ?? []), run],
      }), 'publish')
      return { ...readiness, ok: run.ok, run }
    } finally {
      release()
    }
  }

  /**
   * 事实账本的"读-改-写"(试玩 / 发布共用):现读版本戳 → 经网关写 → 自动快照。
   * 与别的写一样只有这一条路 —— 账本也是项目文件。
   */
  async #recordLedger(projectRef: string, relPath: string, content: string, reason: string): Promise<void> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(relPath)
    await gateway.writeBatch([{ path: relPath, content, expectVersion: current.version }], { origin: 'workbench', reason })
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
    // 音频接线的闸门(T17/T20):**枚举与必填都在这里判** —— 写进 `.rpy` 的每一行都要是
    // 引擎认的语法,而工具面与面板路由都可能把自由 JSON 送进来(路由就是 `body as never`)。
    // 规则只住在某一个适配器里 = 另一条路能把坏行写进项目。
    if (input.edit.kind === 'setAudio') {
      if (!['music', 'sound', 'voice'].includes(input.edit.channel)) {
        throw new GalfreeError('invalid-audio', `声道只能是 music / sound / voice:${String(input.edit.channel)}`)
      }
      if (input.edit.action !== 'play' && input.edit.action !== 'stop') {
        throw new GalfreeError('invalid-audio', `音频动作只能是 play / stop:${String(input.edit.action)}`)
      }
      if (input.edit.action === 'play' && (input.edit.file ?? '').trim() === '') {
        throw new GalfreeError('invalid-audio', 'play 需要一个音频文件(相对 game/ 的路径,如 audio/rain.ogg);要停声道请用 stop')
      }
    }

    const path = gatewayPathOf(scene.file)
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(path)
    // 编辑指令本身不合法(行号越界 / 锚点找不到 / play 没给文件)= 请求方的错(400),
    // 不是服务端故障:纯函数抛的 Error 在这里翻译成带业务码的拒绝。
    let next: string
    try {
      next = applySceneEdit(current.content, input.edit)
    } catch (editError) {
      throw new GalfreeError('invalid-edit', editError instanceof Error ? editError.message : String(editError))
    }

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
      // 音频引用的问题也在这个文件的报告里(T17):写完当场就能看到"这一段要播的东西不在"。
      ...progress.problems.filter((problem) => problem.code === 'missing-audio'),
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
    if (record === undefined) throw new GalfreeError(GATE.bibleNotFinal, '设定集还没有盖"设定定稿"戳:下游生成只用定稿版')
    if (record.fingerprint !== bibleFingerprint(doc)) {
      throw new GalfreeError(GATE.bibleNotFinal, '设定集盖过定稿戳,但之后又改过(待复审):请人重新审读后再生成')
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
        // 产物类型(T27 起账本里显式写出来;老账本没有这一字段 → 读成 'image')。
        kind: 'image',
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
      throw new GalfreeError(GATE.noImageChannel, '还没有配置图像渠道(设置 → 插件 → GALFree):先填端点、密钥与模型目录')
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
   *
   * T27 起这是**薄包装**:真正的机制在 `makeTaskLedger` 里,音乐/语音那一侧
   * (`#audioLedger`)走**同一个**工厂 —— ADR-0012 要的是"复用",不是"再写一份像它的"。
   */
  async #mutateTasks<T>(
    projectRef: string,
    mutate: (document: GenerationTaskDocument, writers: GenerationTask[]) => Promise<T> | T,
  ): Promise<T> {
    return await this.#imageLedger.mutate(projectRef, mutate)
  }

  /**
   * 建一个**封面类**图像任务(T30 / #38):主菜单背景 / 游戏内菜单背景 / 窗口图标。
   *
   * 与素材槽那条**同一个任务模型、同一个队列、同一道门**(没配渠道 / 模型不在目录里都拒),
   * 只有一点不同:**目标路径来自规格表**(`COVER_TARGETS`),不由调用方随便给 ——
   * 这三张是生成器**不覆盖**的那三张,路径写错就等于白出一张图(引擎根本不读它)。
   *
   * 尺寸规格(项目分辨率 / 正方形)也来自那张表:菜单背景要项目分辨率的宽高比,
   * 图标要正方形 —— 出错了引擎不报错、只是画面歪,所以规格要在这里就说清楚。
   */
  async createCoverTask(
    projectRef: string,
    input: { target: string; model: string; prompt: string; size?: string; run?: boolean },
  ): Promise<GenerationTask> {
    const target = coverTargetOf(input.target)
    if (target === null) {
      throw new GalfreeError('unknown-cover-target', `认不出的封面目标:${input.target}(只有:${coverTargetIds().join(' / ')})`, {
        known: coverTargetIds(),
      })
    }
    const created = await this.#mutateTasks(projectRef, async (document, writers) => {
      const entry = await this.#resolve(projectRef)
      await this.#assertPresent(entry)
      const { channel, model } = this.#requireModel(input.model)
      const prompt = input.prompt.trim()
      if (prompt === '') throw new GalfreeError('empty-prompt', '提示词是空的:给一句能用的制作指令(风格/情绪/画面)')
      const degraded = degradeInput(model, {
        ...(input.size === undefined ? {} : { size: input.size }),
        referenceImages: [],
      })
      const at = new Date().toISOString()
      const task: GenerationTask = {
        schemaVersion: 1,
        kind: 'image',
        id: randomUUID(),
        // 封面没有"槽":目标是**规格表里那三张之一**,`target` 就是它的身份。
        slot: '',
        target: target.id,
        outputPath: target.path,
        state: 'queued',
        ...(channel.name === undefined ? {} : { channel: channel.name }),
        model: model.id,
        prompt,
        requiresCharacters: [],
        ...(degraded.effective.size === undefined ? {} : { size: degraded.effective.size }),
        referenceImages: [],
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
    return (await this.runGenerationTask(projectRef, created.id)) ?? created
  }

  /**
   * 音频渠道的**读法**(T27 / ADR-0012):音乐与语音**各读一条** —— 配没配、有哪些模型、
   * 每个模型声明了什么。
   *
   * 与 `imageChannel()` 同一个态度:**不含密钥** —— `apiKeyConfigured` 只说配没配,
   * 不回传密钥本身(ADR-0010/0012 的硬边界)。
   *
   * 为什么两条一起给:面板与 `/state` 都要同时显示"音乐配了没 / 语音配了没" ——
   * 分两次读只会让两边各自拼一次同样的形状。
   */
  async audioChannels(): Promise<Record<AudioPurpose, {
    configured: boolean
    name?: string
    baseUrl?: string
    apiKeyConfigured: boolean
    models: AudioModelDescriptor[]
  }>> {
    return {
      music: this.#audioChannelView('music'),
      voice: this.#audioChannelView('voice'),
    }
  }

  #audioChannelView(purpose: AudioPurpose): {
    configured: boolean
    name?: string
    baseUrl?: string
    apiKeyConfigured: boolean
    models: AudioModelDescriptor[]
  } {
    const channel = this.#audioPorts?.channel(purpose) ?? null
    if (channel === null) return { configured: false, apiKeyConfigured: false, models: [] }
    return {
      configured: true,
      ...(channel.name === undefined ? {} : { name: channel.name }),
      baseUrl: channel.baseUrl,
      apiKeyConfigured: channel.apiKey !== undefined && channel.apiKey !== '',
      models: audioModels(channel),
    }
  }

  // ─── 界面换皮(T31 / #39)─────────────────────────────────────────────

  /**
   * 主题处境(纯推导:记录 + 项目当前分辨率)。
   *
   * 读不到界面代码(`gui.rpy` 不在)时**不假装知道分辨率** —— 那说明这不是本产品的项目,
   * 如实报 `not-a-project`。
   */
  async theme(projectRef: string): Promise<ThemeView> {
    const { record, resolution } = await this.#readThemeInput(projectRef)
    return themeViewOf(record?.spec ?? null, record?.appliedAt ?? null, resolution)
  }

  /**
   * 换皮要读的那两样:**界面代码**(分辨率的真相 + 颜色 define 的宿主)与**主题记录**。
   *
   * 抽成一处是因为三个入口(`theme()` / `previewTheme()` / `applyTheme()`)读的是同一对东西
   * —— 各读一遍的话,"gui.rpy 不在怎么办"这条规则就会活成三份,迟早有一份漏掉。
   */
  async #readThemeInput(projectRef: string): Promise<{ code: FileSnapshot; record: ThemeRecord | null; resolution: { width: number; height: number } }> {
    const gateway = await this.#gatewayFor(projectRef)
    const [code, record] = await Promise.all([gateway.read(GUI_CODE_FILE), this.#readThemeRecord(projectRef)])
    if (code.missing) {
      throw new GalfreeError('not-a-project', `项目里没有 ${GUI_CODE_FILE}:界面换皮要它才谈得上"当前主题是什么"`)
    }
    return { code, record, resolution: projectResolutionOf(code.content) }
  }

  /** 读 `.studio/theme.json`(坏形状 = null,当成"没换过皮")。 */
  async #readThemeRecord(projectRef: string): Promise<ThemeRecord | null> {
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(THEME_FILE)
    return parseThemeRecord(current.missing ? null : current.content)
  }

  /**
   * 换皮的**预演**:要动哪些文件、哪些是新增、哪些会被删掉。
   *
   * 面板上那句"这会把 `game/gui/` 下的图整套替换"就是这个接口给的(AC 要求如实说清),
   * 而不是面板自己数一遍 —— 数法只有一份(与服务同一个)。
   *
   * **分辨率对不上在这里就拦**(和真换同一道门):预演不拦的话,人会看到一个漂亮的数字,
   * 点下去才吃一句拒绝 —— 那是把"能不能做"这件事藏到最后一刻。
   */
  async previewTheme(projectRef: string, input: { spec: ThemeSpecInput }): Promise<ThemePreview> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const { record, resolution } = await this.#readThemeInput(projectRef)
    const spec = parseThemeSpec(input.spec)
    assertThemeResolution(spec, resolution)
    const plan = await this.#planTheme(await this.#existingGuiFiles(entry), [])
    return {
      spec,
      resolution,
      from: themeViewOf(record?.spec ?? null, record?.appliedAt ?? null, resolution).label,
      ...plan,
    }
  }

  /**
   * 换皮(要写盘:整套界面图 + 颜色 define + 一条主题记录,同一个写批 + 一条快照)。
   *
   * 顺序是刻意的:**先在 staging 里把图出齐、点完数,再一次性写进项目**。
   * 引擎退出码 0 不等于图齐了(生成器内部的异常会被吞),残缺的一套写进去会让主菜单缺块。
   *
   * `actor` **必给**:这一条会改整个项目的界面资产,而写批的 `origin`(谁发起)进快照 commit
   * message 与写日志 —— 人在面板上点的那一下不该被记成 agent(审计链会失真)。口径与别的入口
   * 一致:`human` = 工作台那条路,`agent` = 工具那条路。
   */
  async applyTheme(
    projectRef: string,
    input: { spec: ThemeSpecInput },
    actor: { via: 'human' | 'agent' },
  ): Promise<ThemeApplyReport> {
    return await this.#serializeTheme(async () => {
      const entry = await this.#resolve(projectRef)
      await this.#assertPresent(entry)
      const ports = this.#themePorts
      if (ports === null) {
        throw new GalfreeError('theme-unavailable', '这台宿主没装配界面生成器端口:换皮跑不了(不假装换好了)')
      }
      const sdkDir = await ports.resolveSdkDir()
      const launcher = sdkDir === null || sdkDir === '' ? null : await ports.resolveLauncher()
      if (launcher === null) {
        throw new GalfreeError(GATE.sdkNotReady, '钉版 SDK 尚未就绪,无法换皮(先到工作台/设置完成 SDK 供给)')
      }
      const { code, resolution } = await this.#readThemeInput(projectRef)
      const spec = parseThemeSpec(input.spec)
      assertThemeResolution(spec, resolution)

      // 守卫已经保证 sdkDir 不是空的(`launcher` 只在 sdkDir 有值时才去取)。
      const generated = await generateThemedImages({ projectRoot: entry.path, sdkDir: sdkDir!, launcher, spec, ports })
      const current = await this.#existingGuiFiles(entry)
      const plan = await this.#planTheme(current, generated.images.map((image) => image.path))

      const appliedAt = new Date().toISOString()
      const record: ThemeRecord = {
        schemaVersion: 1,
        spec,
        appliedAt,
        sdkVersion: await ports.sdkVersion(),
        images: generated.images.length,
      }
      const gateway = await this.#gatewayFor(projectRef)
      const themeFile = await gateway.read(THEME_FILE)
      const outcome = await gateway.writeBatch([
        ...generated.images.map((image) => ({
          path: image.path,
          content: image.bytes,
          // 引擎产物:文件在不在由引擎说了算,所以 CAS 用"当前读到的版本"(缺 = absent)。
          expectVersion: current[image.path] ?? ABSENT,
        })),
        ...plan.removed.map((path) => ({ path, content: null, expectVersion: current[path] ?? ABSENT })),
        { path: GUI_CODE_FILE, content: writeThemeDefines(code.content, spec), expectVersion: code.version },
        { path: THEME_FILE, content: `${JSON.stringify(record, null, 2)}\n`, expectVersion: themeFile.version },
      ], {
        // 谁发起就记谁:人在面板上点的换皮被记成 agent,审计链就失真了。
        origin: actor.via === 'human' ? 'workbench' : 'agent',
        reason: `theme:${spec.accent}${spec.light ? ':light' : ''}`,
      })

      return {
        spec,
        appliedAt,
        images: generated.images.length,
        added: plan.added,
        replaced: plan.replaced,
        removed: plan.removed,
        batchId: outcome.batchId,
        label: themeLabel(spec),
      }
    })
  }

  /** 项目现在 `game/gui/` 下有哪些文件 → 各自当前的版本戳(换皮要按它做 CAS)。 */
  async #existingGuiFiles(entry: RegistryEntry): Promise<Record<string, string>> {
    const gateway = await this.#gatewayFor(entry.id)
    const current: Record<string, string> = {}
    for (const relative of await listFilesRecursive(join(entry.path, 'game', 'gui'))) {
      const path = `${GUI_IMAGE_DIR}/${relative}`
      current[path] = (await gateway.read(path)).version
    }
    return current
  }

  /**
   * 算这一次换皮要动哪些**图**文件(纯读)。
   *
   * 换皮是一整套重出,不是增量:`replaced + added = images`。
   *
   * **预演**(没有产出清单那种)与**真换**(拿到了引擎产物)的差别只在"数量哪来":
   *  - 预演:还不知道新一套有几张(那要跑完引擎),所以按"现在这些都要重写"说
   *    —— 那正是换皮这件事的规模,而且它**不假装知道会删掉什么**(`removed` 留空);
   *  - 真换:按引擎真产出的清单算,多出来的旧图就是 `removed`(它们会被删掉:
   *    留一张旧主题的图等于界面上留一块旧颜色)。
   *
   * 界面代码与主题记录那两份**另算**(`extraWrites`):它们不是图,混进这个数字
   * 会让"整套替换"那句话对不上账。
   */
  async #planTheme(
    current: Record<string, string>,
    produced: readonly string[],
  ): Promise<{ added: number; replaced: number; removed: string[]; images: number; extraWrites: number }> {
    const existing = new Set(Object.keys(current))
    const next = new Set(produced)
    // 换皮的写批里除图之外总有这两份:`game/gui.rpy` 与 `.studio/theme.json`。
    const extraWrites = 2
    if (produced.length === 0) {
      return { added: 0, replaced: existing.size, removed: [], images: existing.size, extraWrites }
    }
    const added = produced.filter((path) => !existing.has(path)).length
    return {
      added,
      replaced: produced.length - added,
      removed: [...existing].filter((path) => !next.has(path)).sort(),
      images: produced.length,
      extraWrites,
    }
  }

  /** 换皮的串行(引擎重、而且要在 staging 上复制整份项目:同时跑两次没有意义)。 */
  async #serializeTheme<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#themeQueue.then(work)
    this.#themeQueue = run.catch(() => {})
    return await run
  }

  /** 音频任务账本(读):全部任务,最新的在前。 */
  async audioTasks(projectRef: string): Promise<AudioTask[]> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const document = await this.#audioLedger.read(projectRef)
    return [...document.tasks].reverse()
  }

  /**
   * 建一个音频生成任务(T27)。
   *
   * **三道门如实拦**(与图像的 `createGenerationTask` 同一态度):
   *  1. **那条**渠道没配 → `no-music-channel` / `no-voice-channel`(绝不假装能生成;
   *     码按用途分,是因为"语音配好了、音乐没配"是常态,一个码说不清该去配哪一段);
   *  2. 模型不在**那条**渠道的目录里 → `unknown-audio-model`,并列出目录里有什么;
   *  3. 目标路径形状不对 → `invalid-audio-path`(引擎的 searchpath 只有 `game/`,
   *     而绝对路径会被**静默回退** —— 那是"看着生成了其实没人找得到")。
   */
  async createAudioTask(projectRef: string, input: CreateAudioTaskInput): Promise<AudioTask> {
    return await this.#audioLedger.mutate(projectRef, async (document, writers) => {
      const entry = await this.#resolve(projectRef)
      await this.#assertPresent(entry)
      const outputPath = input.outputPath.replace(/\\/g, '/')
      try {
        assertAudioOutputPath(outputPath)
      } catch (error) {
        throw new GalfreeError('invalid-audio-path', error instanceof Error ? error.message : String(error))
      }
      // 用途先定:它决定走哪条渠道、查哪份模型目录(`voice/` 下 = 语音,其余 = 音乐)。
      const purpose = input.purpose ?? purposeOfPath(outputPath)
      const { channel, model } = this.#requireAudioModel(input.model, purpose)
      const prompt = input.prompt.trim()
      if (prompt === '') throw new GalfreeError('empty-prompt', '提示词是空的:给一句能用的制作指令(风格/情绪/场景)')
      // **声音锚(T32)**:语音任务按 `dialogueId` 派生的说话人反查登记簿,自动带上音色档案。
      const voice = purpose === 'voice' ? await this.#resolveVoiceForTask(entry, projectRef, input) : null
      // `voiceId` 记的是**登记簿 id**:显式给的就是它,否则是这次解析出来的那个角色
      // (制作信息:这条是谁的嗓子;它**不进请求体** —— 服务端的 `speaker` 是另一件事)。
      const voiceCharacter = input.voiceId ?? voice?.character
      const at = new Date().toISOString()
      const task: AudioTask = {
        schemaVersion: 1,
        kind: purpose,
        id: randomUUID(),
        purpose,
        outputPath,
        state: 'queued',
        ...(channel.name === undefined ? {} : { channel: channel.name }),
        model: model.id,
        prompt,
        dialogueId: input.dialogueId ?? null,
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.sampleRate === undefined ? {} : { sampleRate: input.sampleRate }),
        ...(input.loop === undefined ? {} : { loop: input.loop }),
        ...(voiceCharacter === undefined ? {} : { voiceId: voiceCharacter }),
        ...(voice?.sample === undefined ? {} : { voiceSample: voice.sample }),
        ...(voice?.speaker === undefined ? {} : { voiceSpeaker: voice.speaker }),
        ...(voice?.lang === undefined ? {} : { voiceLang: voice.lang }),
        ...(voice?.emotion === undefined ? {} : { voiceEmotion: voice.emotion }),
        ...(voice?.degradation === undefined ? {} : { degradation: voice.degradation }),
        referenceAudio: input.referenceAudio ?? [],
        attempts: [],
        rejections: [],
        createdAt: at,
        updatedAt: at,
      }
      writers.push(task)
      return task
    })
  }

  /**
   * **这条语音用哪把嗓子**(T32)—— 声音锚的自动携链。
   *
   * 说话人的来源按优先级:
   *  1. 显式给了 `voiceId` → 当**登记簿 id** 用(不是服务端的 `speaker`!);
   *  2. 否则按 `dialogueId` 从 `.rpy` 派生的**说话人变量**反查登记簿的 `voice` 字段
   *     (与 `voiceBatch` 那条清单**同一套 id 口径**,不然"清单里的这句"与"任务里的这句"会对不上);
   *  3. 都没有 → 如实降级(说明写在任务上),而不是静默用服务端缺省。
   *
   * 返回的 `sample` 缺省时**不发**任何声音字段:`voiceId` 只进账本(制作信息),
   * 绝不进请求体(那正是 T32 修掉的那处错位)。
   */
  async #resolveVoiceForTask(
    entry: { path: string },
    projectRef: string,
    input: CreateAudioTaskInput,
  ): Promise<{ character?: string; sample?: string; speaker?: string; lang?: string; emotion?: VoiceEmotion; degradation?: GenerationDegradation }> {
    const characters = await readCharacters(entry.path)
    // 说话人变量只在**没显式给登记簿 id** 时才需要从剧本反查(反查要走一遍剧本)。
    const speakerVar = input.voiceId === undefined && input.dialogueId !== undefined
      ? await this.#speakerOfDialogue(projectRef, input.dialogueId)
      : undefined
    const anchor = resolveVoiceAnchor({
      ...(input.voiceId === undefined ? {} : { characterId: input.voiceId }),
      ...(speakerVar === undefined ? {} : { speakerVar }),
      characters,
      // 没读过音色库就是 `null`(**不谎报"库里没有"**,见 `voice-anchor.ts` 的说明)。
      library: this.#voiceLibrary?.files ?? null,
    })
    const explicitSample = input.voiceSample === undefined || input.voiceSample === '' ? undefined : input.voiceSample
    const sample = explicitSample ?? anchor.sample ?? undefined
    const speaker = input.voiceSpeaker ?? anchor.speaker
    const character = input.voiceId ?? anchor.character ?? undefined
    if (sample === undefined) {
      // **如实降级**(不是拒绝):任务照建,但把"这条拿不到谁的嗓子"写在它身上 ——
      // 面板与账本都能看见,而不是等人听出来"怎么每个人声音都一样"。
      return {
        ...(character === undefined ? {} : { character }),
        degradation: {
          code: 'voice-anchor-missing',
          message: `${anchor.message}。没配到的这条会用模型目录里写死的那把嗓子(如果有);要"每个角色一把嗓子",请到角色视图给它记一条音色档案`,
          droppedReferenceImages: [],
          notes: ['音色 = 参考样本(服务端音色库里的文件名);登记簿的音色档案就是这条锚'],
        },
      }
    }
    // 显式给的优先于档案里的(临时换一段参考而不动登记簿)。
    const lang = input.voiceLang ?? anchor.lang
    const emotion = input.voiceEmotion ?? anchor.emotion
    return {
      ...(character === undefined ? {} : { character }),
      sample,
      ...(speaker === undefined || speaker === '' ? {} : { speaker }),
      ...(lang === undefined ? {} : { lang }),
      ...(emotion === undefined ? {} : { emotion }),
    }
  }

  /**
   * 对话 id → 剧本里的**说话人变量**(没有就 undefined)。
   *
   * 口径与 `voiceBatch` **同一套**:优先 `.rpy` 里显式写的 `id`,没有则按
   * `dialogueIdFor(label, 序号)` 派生 —— 两处若各写一套,"清单里的第 3 句"与"账本里的第 3 句"
   * 就会指向不同的人(而那种错只在听的时候才发现)。
   */
  async #speakerOfDialogue(projectRef: string, dialogueId: string): Promise<string | undefined> {
    const graph = await this.branchGraph(projectRef)
    for (const scene of graph.scenes) {
      let seq = 0
      for (const statement of scene.statements) {
        if (statement.kind !== 'dialogue') continue
        const id = statement.id ?? dialogueIdFor(scene.label, seq)
        seq += 1
        if (id !== dialogueId) continue
        return statement.speaker ?? undefined
      }
    }
    return undefined
  }

  /**
   * **整部戏的嗓子清单**(T32,纯读):在册角色各一条音色档案 + 剧本里还没登记的说话人。
   *
   * 它回答的是"还差几个角色没有嗓子"(`withoutProfile`)与"这个角色用的是哪段参考"。
   * 音色库清单来自**最近一次**「读音色库」(`null` = 还没核对过,不谎报"库里没有")。
   */
  async voiceAnchors(projectRef: string): Promise<VoiceAnchorBoard> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const [characters, graph] = await Promise.all([readCharacters(entry.path), this.branchGraph(projectRef)])
    const speakers: string[] = []
    for (const scene of graph.scenes) {
      for (const statement of scene.statements) {
        if (statement.kind === 'dialogue' && statement.speaker !== null) speakers.push(statement.speaker)
      }
    }
    return buildVoiceAnchorBoard({
      characters,
      speakers,
      library: this.#voiceLibrary?.files ?? null,      ...(this.#voiceLibrary?.dir === undefined ? {} : { libraryDir: this.#voiceLibrary.dir }),
    })
  }

  /** 最近一次读到的音色库(`null` = 还没读过)与它读到的时刻。 */
  voiceLibrary(): { files: string[]; dir?: string; at: string } | null {
    return this.#voiceLibrary === null
      ? null
      : { files: [...this.#voiceLibrary.files], ...(this.#voiceLibrary.dir === undefined ? {} : { dir: this.#voiceLibrary.dir }), at: this.#voiceLibrary.at }
  }

  /**
   * **读音色库**(T32):问那台语音服务"你有哪些嗓子"(`GET /health` `/speakers` `/voices`)。
   *
   * 三件事在这里定死:
   *  - **走注入的出网端口**(生产 fetch / 快带假上游),协议形状不因测试而变;
   *  - **逐端点如实报**:本机 TTS 服务各不相同,`/speakers` 有的没有 —— 那是"这条路在这台
   *    服务上不存在",不是故障,所以没答上来的端点进 `problems`,不整体抛;
   *  - 读到的结果**记在内存里**(`#voiceLibrary`):建任务时用它标"库里没有那个样本",
   *    面板也用同一份 —— 但它是**某一刻的快照**,`at` 会一并回传给人看。
   */
  async readVoiceLibrary(projectRef: string): Promise<VoiceLibraryReading> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const ports = this.#audioPorts
    if (ports === null) {
      throw new GalfreeError('audio-unavailable', '这台宿主没有装配音频出网端口:读音色库发不出请求')
    }
    const channel = ports.channel('voice')
    if (channel === null) {
      throw new GalfreeError(GATE.noVoiceChannel, '还没有配置语音(TTS)渠道:读音色库要先有一个端点(设置 → 插件 → GALFree 的「语音生成渠道」那一段)')
    }
    const reading = await readVoiceLibrary(ports.http, { baseUrl: channel.baseUrl, ...(channel.apiKey === undefined ? {} : { apiKey: channel.apiKey }) })
    if (reading.voices !== undefined) {
      this.#voiceLibrary = {
        files: reading.voices,
        ...(reading.voiceDir === undefined ? {} : { dir: reading.voiceDir }),
        at: new Date().toISOString(),
      }
    }
    return reading
  }

  /**
   * 音频渠道与模型的两道门(**按用途**查:音乐查音乐那条、语音查语音那条)。
   *
   * 没配与"模型不在目录里"都如实拒绝,而且说清**是哪一条**渠道 —— 分类配置之后,
   * "哪一段没配"正是人要知道的那半句。
   */
  #requireAudioModel(modelId: string, purpose: AudioPurpose): { channel: AudioChannelSettings; model: AudioModelDescriptor } {
    const label = purpose === 'music' ? '音乐生成' : '语音(TTS)生成'
    const channel = this.#audioPorts?.channel(purpose) ?? null
    if (channel === null) {
      throw new GalfreeError(
        purpose === 'music' ? GATE.noMusicChannel : GATE.noVoiceChannel,
        `还没有配置${label}渠道(设置 → 插件 → GALFree):音乐与语音是**两条**渠道,先填${label}那一段的端点、密钥与模型目录`,
      )
    }
    const model = channel.models.find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      throw new GalfreeError('unknown-audio-model', `模型「${modelId}」不在${label}渠道的模型目录里(目录里有:${channel.models.map((candidate) => candidate.id).join(', ') || '(空)'})`, {
        known: channel.models.map((candidate) => candidate.id),
      })
    }
    return { channel, model }
  }

  /**
   * **本地 TTS 批量清单**(T29 / #37 的第一片,纯读):把每一句对白摊成
   * "场景 / 行号 / 说话人 / 台词 / **id** / 目标文件名"。
   *
   * 这条路**不花上游额度**:清单交给用户自己的本地 TTS 批量跑,再把音频按 id 放回来
   * (`importVoiceFiles`)。id 的口径与 ADR-0013 完全一致 —— **id 就是文件名**:
   * 已经写进 `.rpy` 的用那里的,还没写的按 `stampDialogueIds` 的**同一规则**派生。
   */
  async voiceBatch(projectRef: string): Promise<VoiceBatch> {
    const graph = await this.branchGraph(projectRef)
    const pool = await this.audioPool(projectRef)
    // 池里的路径是**相对 game/** 的(`audio/voice/x.ogg`),清单里是相对项目根的。
    const existing = new Set(pool.files.map((file) => file.path))
    const rows: VoiceBatchRow[] = []
    for (const scene of graph.scenes) {
      let seq = 0
      for (const statement of scene.statements) {
        if (statement.kind !== 'dialogue') continue
        const dialogueId = statement.id ?? dialogueIdFor(scene.label, seq)
        seq += 1
        const targetPath = voiceTargetPath(dialogueId)
        rows.push({
          scene: scene.label,
          line: statement.line,
          speaker: statement.speaker,
          text: statement.text,
          dialogueId,
          targetPath,
          missing: !existing.has(targetPath.replace(/^game\//, '')),
        })
      }
    }
    return { rows, missingVoiceFiles: rows.filter((row) => row.missing).length, extension: 'ogg' }
  }

  /**
   * **把本地 TTS 的产物收回来**(T29):按文件名认 id → 经写网关落进 `game/voice/`。
   *
   * 四类结果**逐条报**(收进来 / 缺 / 多余 / 对不上 id):静默跳过等于
   * "以为配齐了、玩的时候没声音" —— 与 T17 那条"悬空引用"要防的是同一种假象。
   */
  async importVoiceFiles(
    projectRef: string,
    input: { dropDir: string; rows?: VoiceBatchRow[] },
  ): Promise<{
    imported: Array<{ dialogueId: string; path: string; bytes: number }>
    duplicates: string[]
    unknownFiles: Array<{ name: string; path: string }>
    missing: VoiceBatchRow[]
  }> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const rows = input.rows ?? (await this.voiceBatch(projectRef)).rows
    const files = await this.#listVoiceCandidates(input.dropDir)
    const matched = matchVoiceFiles(rows, files)
    const gateway = await this.#gatewayFor(projectRef)
    const imported: Array<{ dialogueId: string; path: string; bytes: number }> = []
    for (const item of matched.imported) {
      const content = await readFile(item.sourcePath)
      const current = await gateway.read(item.targetPath)
      await gateway.writeBatch(
        [{ path: item.targetPath, content, expectVersion: current.version }],
        { origin: 'agent', reason: 'voice' },
      )
      imported.push({ dialogueId: item.dialogueId, path: item.targetPath, bytes: content.byteLength })
    }
    return {
      imported,
      duplicates: matched.duplicates.map((file) => file.name),
      unknownFiles: matched.unknown.map((file) => ({ name: file.name, path: file.path })),
      missing: matched.missing,
    }
  }

  /** 落盘目录里全部音频文件的候选清单(递归;`readme.txt` 这种不该被当语音)。 */
  async #listVoiceCandidates(dropDir: string): Promise<Array<{ name: string; path: string }>> {
    const out: Array<{ name: string; path: string }> = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const item of entries) {
        const full = join(dir, item.name)
        if (item.isDirectory()) { await walk(full); continue }
        if (isVoiceAudioFile(item.name)) out.push({ name: item.name, path: full })
      }
    }
    await walk(dropDir)
    return out
  }

  /**
   * 推进音频队列里**排队中**的任务(T27 的下一片:执行)。
   *
   * 与图像那条同一态度:串行、失败留在 `failed`(重试是人的动作,不是自动重试循环)。
   *
   * **`purpose` 给了就只跑那一类**(音乐与语音各一条渠道,面板也是两张卡):
   * 面板上"跑队列(N 条)"那个 N 必须是**这一下真会发出去的条数** ——
   * 只按用途数、却把两条都跑掉,对不上账,而且会替另一条渠道花钱
   * (TTS 按台词行计费,正是最贵的那条)。不给 = 全跑(CLI/工具那条路,语义与从前一致)。
   */
  async runAudioQueue(projectRef: string, options: { purpose?: AudioPurpose } = {}): Promise<AudioTask[]> {
    const queued = (await this.audioTasks(projectRef))
      .filter((task) => task.state === 'queued')
      .filter((task) => options.purpose === undefined || task.purpose === options.purpose)
    for (const task of queued) await this.runAudioTask(projectRef, task.id)
    const after = await this.audioTasks(projectRef)
    return queued.map((task) => after.find((candidate) => candidate.id === task.id) ?? task)
  }

  /**
   * 跑一个音频任务(T27 的执行那一片):适配器翻译 → 出网 → **经写网关落盘** → 记账。
   *
   * 与图像的 `runGenerationTask` 同一形状(同一套账本纪律):
   *  - 先置 `running`(状态机对外可见);失败如实记 `failed`(**上游原话**进历史,不吞);
   *  - 成功 → `awaiting-review`(等人听),并记下**被覆盖那一版**的指纹;
   *  - 适配器没实现就抛 → 记一条失败并指名道姓(不假装成功、也不静默不动)。
   */
  async runAudioTask(projectRef: string, id: string): Promise<AudioTask | null> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)

    const started = new Date().toISOString()
    const task = await this.#audioLedger.mutate(projectRef, (document, writers) => {
      const found = document.tasks.find((candidate) => candidate.id === id)
      if (found === undefined) throw new GalfreeError('unknown-task', `没有这个音频任务:${id}`)
      const next: AudioTask = { ...found, state: 'running', updatedAt: started }
      writers.push(next)
      return Promise.resolve(next)
    })
    // 跑任务时按**这条任务自己的用途**查渠道:音乐任务永远走音乐那条,语音永远走语音那条 ——
    // 哪怕两条渠道的模型 id 撞了名(它们本来就分属两份目录)。
    const { channel, model } = this.#requireAudioModel(task.model, task.purpose)

    let bytes: Uint8Array
    try {
      const adapter = audioAdapterFor(model.adapter)
      const plan = adapter.buildRequest({
        channel,
        model,
        task: {
          purpose: task.purpose,
          prompt: task.prompt,
          ...(task.format === undefined ? {} : { format: task.format }),
          ...(task.sampleRate === undefined ? {} : { sampleRate: task.sampleRate }),
          ...(task.loop === undefined ? {} : { loop: task.loop }),
          dialogueId: task.dialogueId,
          ...(task.voiceId === undefined ? {} : { voiceId: task.voiceId }),
          // 音色的那三样(T32):参考样本 / LoRA 名 / 语言,外加可选情感。
          ...(task.voiceSample === undefined ? {} : { voiceSample: task.voiceSample }),
          ...(task.voiceSpeaker === undefined ? {} : { voiceSpeaker: task.voiceSpeaker }),
          ...(task.voiceLang === undefined ? {} : { voiceLang: task.voiceLang }),
          ...(task.voiceEmotion === undefined ? {} : { voiceEmotion: task.voiceEmotion }),
          referenceAudio: task.referenceAudio,
        },
      })
      const response = await this.#audioPorts!.http.send(plan.request)
      const submission = await adapter.onSubmit(response, model)
      if (submission.kind === 'failed') throw new Error(submission.error)
      if (submission.kind === 'bytes') {
        bytes = submission.bytes
      } else {
        // 异步制:轮询到终态。**没实现 poll 的适配器如实拒绝**,不空转。
        if (adapter.poll === undefined || adapter.buildPollRequest === undefined) {
          throw new Error(`协议「${model.adapter}」返回了一个任务 id(${submission.taskId}),但这个适配器没有实现轮询 —— 拿不到产物`)
        }
        bytes = await this.#awaitAudioResult({ adapter, model, channel, task, taskId: submission.taskId })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await this.#audioLedger.mutate(projectRef, (document, writers) => {
        const found = document.tasks.find((candidate) => candidate.id === id)!
        const failed: AudioTask = {
          ...found,
          state: 'failed',
          lastError: message,
          attempts: [...found.attempts, this.#audioAttempt(found.attempts.length + 1, started, 'failed', { error: message })],
          updatedAt: new Date().toISOString(),
        }
        writers.push(failed)
        return Promise.resolve(failed)
      })
    }

    // 产物经写网关落盘(自动快照)。CAS 用现读的版本戳:外部刚动过就如实报漂移,不盖掉。
    const gateway = await this.#gatewayFor(projectRef)
    const current = await gateway.read(task.outputPath)
    const replacedFingerprint = current.missing ? undefined : current.version
    const result = await gateway.writeBatch(
      [{ path: task.outputPath, content: bytes, expectVersion: current.version }],
      { origin: 'agent', reason: 'queue' },
    )
    const written = result.versions[task.outputPath] ?? fingerprint(bytes)

    return await this.#audioLedger.mutate(projectRef, (document, writers) => {
      const found = document.tasks.find((candidate) => candidate.id === id)!
      const done: AudioTask = {
        ...found,
        state: 'awaiting-review',
        attempts: [...found.attempts, this.#audioAttempt(found.attempts.length + 1, started, 'ok', {
          fingerprint: written,
          bytes: bytes.byteLength,
          ...(replacedFingerprint === undefined ? {} : { replacedFingerprint }),
        })],
        updatedAt: new Date().toISOString(),
      }
      writers.push(done)
      return Promise.resolve(done)
    })
  }

  /** 异步制的轮询回路(与图像那条同形:有界、失败如实回传)。 */
  async #awaitAudioResult(input: {
    adapter: ReturnType<typeof audioAdapterFor>
    model: AudioModelDescriptor
    channel: AudioChannelSettings
    task: AudioTask
    taskId: string
  }): Promise<Uint8Array> {
    const http = this.#audioPorts!.http
    const poll = input.adapter.poll!
    const deadline = Date.now() + AUDIO_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, AUDIO_POLL_INTERVAL_MS))
      const request = input.adapter.buildPollRequest!(
        {
          channel: input.channel,
          model: input.model,
          task: {
            purpose: input.task.purpose,
            prompt: input.task.prompt,
            dialogueId: input.task.dialogueId,
            referenceAudio: input.task.referenceAudio,
          },
        },
        input.taskId,
      )
      const response = await http.send(request)
      const step = poll(response, input.taskId)
      if (step.kind === 'failed') throw new Error(step.error)
      if (step.kind === 'done') {
        if (step.bytes !== undefined) return step.bytes
        if (step.url === undefined) throw new Error('上游说完成了,但既没给字节也没给 URL')
        // 产物是一个**音频 URL**(Suno 类就是这样):下载口没装配就如实拒绝 ——
        // 不假装"任务成功但没有产物"(那是"以为配齐了、玩的时候没声音"的另一种形状)。
        const download = http.download
        if (download === undefined) {
          throw new Error('上游给的是一个音频 URL,而这台宿主没装配音频下载口 —— 拿不到产物(不假装成功)')
        }
        const fetched = await download(step.url)
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new Error(`下载音频失败(HTTP ${fetched.status}):${step.url}`)
        }
        if (fetched.bytes.byteLength === 0) throw new Error(`下载回来的音频是空文件:${step.url}`)
        return fetched.bytes
      }
    }
    throw new Error(`等了 ${Math.round(AUDIO_POLL_TIMEOUT_MS / 1000)} 秒还没等到音频(上游一直在跑)—— 这次不算成功`)
  }

  /**
   * 重 roll 一个音频任务(与图像那条同一语义):保留历史、追加一次尝试,可改词;
   * **拒收注记**只追加并指向被拒那一版(空注记/超长都拒)。
   */
  async retryAudioTask(
    projectRef: string,
    id: string,
    options: { run?: boolean; prompt?: string; note?: string; via?: 'human' | 'agent' },
  ): Promise<AudioTask | null> {
    const reset = await this.#audioLedger.mutate(projectRef, (document, writers) => {
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (task === undefined) throw new GalfreeError('unknown-task', `没有这个音频任务:${id}`)
      if (options.prompt !== undefined && options.prompt.trim() === '') {
        throw new GalfreeError('empty-prompt', '重 roll 时给的提示词是空的:要么不给(沿用原词),要么给一句能用的')
      }
      const at = new Date().toISOString()
      const next: AudioTask = {
        ...task,
        state: 'queued',
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
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
          // 人的判断是默认;agent 转述要**显式**标出来(与图像那条同一口径)。
          via: options.via ?? 'human',
          at,
        }]
      }
      writers.push(next)
      return Promise.resolve(next)
    })
    if (options.run !== true) return reset
    return await this.runAudioTask(projectRef, id)
  }

  #audioAttempt(
    n: number,
    startedAt: string,
    outcome: 'ok' | 'failed',
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

  #requireHuman(actor: { via: 'human' | 'agent' }): void {
    if (actor.via !== 'human') {
      throw new GalfreeError(GATE.stampForbidden, '审读戳只能由人盖(工作台真实动作),agent 无权设置')
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
  async #uiFilesFrom(sdkDir: string | undefined): Promise<{ files: Array<{ path: string; content: string }>; binaryFiles: Array<{ path: string; content: Uint8Array }> }> {
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
    // 中文字体与界面图片:都从 SDK 拷进项目(**相对路径才有效**;绝对路径会被静默回退)。
    // 字体拿不到**不阻断**建项目 —— 界面补丁会在注释里说明"中文会显示成方块",
    // 这比"因为少一个字体就不让人建项目"合理:项目本身是好的。
    const binaryFiles: Array<{ path: string; content: Uint8Array }> = []
    try {
      binaryFiles.push({
        path: `game/${TEMPLATE_CJK_FONT.target}`,
        content: await readFile(join(sdkDir, 'sdk-fonts', TEMPLATE_CJK_FONT.source)),
      })
    } catch { /* 见上:不阻断 */ }

    // SDK 界面模板里的图片资源(`gui/*.png`):**发行版里没有生成器**,所以能拷的就拷进去
    // (其余界面图由 SDK 在首次运行时生成 —— 那一步的兜底与检查见 template.ts 的 gui7 空壳)。
    try {
      for (const relative of await listFilesRecursive(join(dir, TEMPLATE_UI_IMAGE_DIR))) {
        binaryFiles.push({
          path: `game/${TEMPLATE_UI_IMAGE_DIR}/${relative}`,
          content: await readFile(join(dir, TEMPLATE_UI_IMAGE_DIR, ...relative.split('/'))),
        })
      }
    } catch { /* 图片缺失不阻断建项目:界面图本来就还有一条"首次运行时生成"的路 */ }

    // **窗口图标的默认值**(T30 / #38):模板的 `options.rpy` 设了 `config.window_icon`,
    // 而那个文件**必须已经存在** —— 缺了是**启动期崩**(`set_icon` 不兜底,见 covers.ts 的说明)。
    // 所以这一份不能"缺了就算了":缺了就得把 config 那行也去掉,否则项目建出来就是坏的。
    // 顺序上它排在界面图片之后:同名时以这份为准(生成器那套图标本来就是程序画的)。
    try {
      binaryFiles.push({
        path: `game/${TEMPLATE_WINDOW_ICON.target}`,
        content: await readFile(join(sdkDir, ...TEMPLATE_WINDOW_ICON.source.split('/'))),
      })
    } catch (error) {
      throw new GalfreeError(
        'sdk-ui-missing',
        `SDK 里缺默认窗口图标(${join(sdkDir, ...TEMPLATE_WINDOW_ICON.source.split('/'))} 读不到:${String(error)})。`
        + '模板的 options.rpy 设了 `config.window_icon`,而那个文件**不存在会让游戏启动即崩** —— '
        + '所以这里如实拒绝建项目(请检查 SDK 是否完整)。',
      )
    }

    return { files, binaryFiles }
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

/**
 * 递归列出一个目录下的文件(相对 POSIX 路径;缺目录 = 空)。
 *
 * **导出**是因为换皮那条路(`theme-runner.ts` 的端口)也要走同一份实现:
 * 两边各写一份,"缺目录算空"这条规则就会活两次,迟早分叉。
 */
export async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...await listFilesRecursive(join(dir, entry.name), rel))
      continue
    }
    if (entry.isFile()) found.push(rel)
  }
  return found
}
