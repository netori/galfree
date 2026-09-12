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
import { PROJECT_NAME_RE, renderTemplateFiles, templateKeepFiles } from './template.ts'
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
import {
  BIBLE_FILE, OUTLINE_FILE, applyBiblePatch, bibleDocument, bibleFingerprint, buildGenerationContext,
  outlineRef, readBible, readOutline,
  type BibleDocument, type BiblePatch, type GenerationContext,
} from './bible.ts'
import { BIBLE_STAMP_TARGET } from './stamps.ts'
import { composeSceneFile, extractSceneBlock, gatewayPathOf, scenesPathOf } from './scene-file.ts'
import { applySceneEdit, buildSceneForm, type SceneEdit, type SceneFormModel } from './scene-form.ts'
import { contentFingerprint, launchPlaytest, playtestDocument, readPlaytest, PLAYTEST_FILE, type PlaytestPorts, type PlaytestRun } from './playtest.ts'
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
}

export class ProjectService {
  #registry: ProjectRegistry
  #validator: ValidatorPort
  #playtestPorts: PlaytestPorts
  #gateways = new Map<string, Promise<WriteGateway>>()

  constructor(options: ProjectServiceOptions) {
    this.#registry = new ProjectRegistry(join(options.dataDir, 'registry.json'))
    this.#validator = options.validator ?? (async (project) => new FakeValidator().validate(join(project.root, 'game')))
    this.#playtestPorts = options.playtest ?? { resolveLauncher: async () => null, spawn: async () => ({ code: 0, log: '' }) }
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
    await mkdir(root, { recursive: true })

    // 模板内容一律经网关落盘(网关是唯一写通道)。
    const files = [...renderTemplateFiles({ name: input.name, title, id }), ...templateKeepFiles()]
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
    return computeProgress(entry.path, {
      scenes: graph.scenes,
      problems: [...graph.problems, ...derived.problems],
      derivedSlots: derived.slots,
      characters,
      definedCharacters: parsed.characters,
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
   * 一键试玩:钉版 SDK 启动当前项目、退出回传;运行事实经网关落 `.studio/playtest.json`
   * 并进快照。技术通过是推导(退出码/日志),不是人盖的戳。
   */
  async playtestStart(projectRef: string): Promise<PlaytestRun> {
    const graph = await this.branchGraph(projectRef)
    const entry = await this.#resolve(projectRef)
    const gateway = await this.#gatewayFor(projectRef)
    const run = await launchPlaytest(this.#playtestPorts, entry.path, contentFingerprint(graph))
    const ledger = (await readPlaytest(entry.path)) ?? { schemaVersion: 1 as const, last: null, history: [] }
    const next = { schemaVersion: 1 as const, last: run, history: [...ledger.history, run] }
    const current = await gateway.read(PLAYTEST_FILE)
    await gateway.writeBatch(
      [{ path: PLAYTEST_FILE, content: playtestDocument(next), expectVersion: current.version }],
      { origin: 'workbench', reason: 'playtest' },
    )
    return run
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
  async #initGit(root: string, name: string): Promise<void> {
    await runGit(root, ['init', '--initial-branch', 'main'])
    await runGit(root, ['add', '--all'])
    await runGit(root, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', `chore(galfree): scaffold template project "${name}"`])
  }
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  return new ProjectService(options)
}
