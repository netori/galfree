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
import { deriveGraph, parseRpy, type RpyFile } from './rpy/parse.ts'
import type { BranchGraph } from './rpy/dialect.ts'
import { computeProgress, sceneFingerprint, slotAssetPath, type ProgressSnapshot } from './progress.ts'
import { readStamps, sceneTarget, slotTarget, stampsDocument, withStamp, type StampRecord } from './stamps.ts'
import { contentFingerprint, launchPlaytest, playtestDocument, readPlaytest, PLAYTEST_FILE, type PlaytestPorts, type PlaytestRun } from './playtest.ts'
import { createHash } from 'node:crypto'
import { readFile as readFileNode } from 'node:fs/promises'
import { WriteGateway, type ChangeEvent, type FileSnapshot, type WriteLogEntry, type WriteOp, type WriteResult } from './write-gateway.ts'
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

export interface ProjectServiceOptions {
  /** 插件数据目录(注册表等宿主侧状态落这里)。 */
  dataDir: string
  /** 注入验证器(T1 假验证器;T5 真 SDK 适配器实现同一契约)。 */
  validator?: FakeValidator
  /** 试玩端口(T7;缺省 = SDK 未就绪的诚实失败)。 */
  playtest?: PlaytestPorts
}

export class ProjectService {
  #registry: ProjectRegistry
  #validator: FakeValidator
  #playtestPorts: PlaytestPorts
  #gateways = new Map<string, WriteGateway>()

  constructor(options: ProjectServiceOptions) {
    this.#registry = new ProjectRegistry(join(options.dataDir, 'registry.json'))
    this.#validator = options.validator ?? new FakeValidator()
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
      files.map((file): WriteOp => ({ path: file.path, content: file.content, expectVersion: 'absent' })),
      { origin: 'workbench', reason: 'scaffold' },
    )
    this.#gateways.set(id, gateway)

    try {
      await this.#initGit(root, input.name)
    } catch (error) {
      throw new GalfreeError('git-init-failed', `模板 git 初始化失败:${String(error)}`)
    }

    await this.#registry.add({ id, name: input.name, title, path: root, createdAt })
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

  /** 注册表里按 id 取元数据(id/名称/路径)。 */
  async getRegistryEntry(id: string): Promise<{ id: string; name: string; title: string; path: string } | null> {
    return (await this.#registry.get(id)) ?? null
  }

  async getActiveProject(): Promise<ProjectInfo | null> {
    const id = await this.#registry.activeId()
    return id === null ? null : this.#toInfo(id)
  }

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

  /** 校验回路:对当前激活项目跑验证器(T1 假验证器;T4 接方言解析契约)。 */
  async validateActiveProject(): Promise<ValidationReport> {
    const active = await this.getActiveProject()
    if (active === null) throw new GalfreeError('no-active-project', '没有激活项目可校验')
    if (active.missing) throw new GalfreeError('project-missing', `项目目录已不存在:${active.root}`)
    return this.#validator.validate(join(active.root, 'game'))
  }

  /** 分支骨架(派生视图:可缓存、全量重算;ADR-0009 `.rpy` 为尊)。 */
  async branchGraph(projectRef: string): Promise<BranchGraph> {
    const entry = await this.#resolve(projectRef)
    await this.#assertPresent(entry)
    const files: RpyFile[] = []
    for (const item of await readdir(join(entry.path, 'game'), { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith('.rpy')) {
        files.push({ name: item.name, text: await readFile(join(entry.path, 'game', item.name), 'utf8') })
      }
    }
    return deriveGraph(parseRpy(files))
  }

  // ─── 推导进度 + 审读戳(T6)───────────────────────────────────────────

  /** 阶段板:纯推导(文件 + 解析 + 校验 + 戳 + 试玩事实),可全量重算、幂等、无手写通道。 */
  async progress(projectRef: string): Promise<ProgressSnapshot> {
    const graph = await this.branchGraph(projectRef)
    const entry = await this.#resolve(projectRef)
    const ledger = await readPlaytest(entry.path)
    return computeProgress(entry.path, {
      scenes: graph.scenes,
      problems: graph.problems,
      playtest: { last: ledger?.last ?? null, currentFingerprint: contentFingerprint(graph) },
    })
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
  async stampSlot(projectRef: string, slot: string, actor: { via: 'human' | 'agent' }): Promise<void> {
    this.#requireHuman(actor)
    const entry = await this.#resolve(projectRef)
    const fingerprint = await this.#assetFingerprint(entry.path, slotAssetPath(slot))
    if (fingerprint === 'absent') throw new GalfreeError('slot-not-filled', `素材槽未填,不能盖审读戳:${slot}`)
    await this.#putStamp(projectRef, slotTarget(slot), fingerprint)
  }

  #requireHuman(actor: { via: 'human' | 'agent' }): void {
    if (actor.via !== 'human') {
      throw new GalfreeError('stamp-forbidden', '审读戳只能由人盖(工作台真实动作),agent 无权设置')
    }
  }

  async #assetFingerprint(root: string, assetPath: string): Promise<string> {
    try {
      const bytes = await readFileNode(join(root, ...assetPath.split('/')))
      return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    } catch {
      return 'absent'
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
    for (const gateway of this.#gateways.values()) await gateway.dispose()
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

  /** 按 id 或 name 解析项目,返回其网关(懒建)。 */
  async #gatewayFor(projectRef: string): Promise<WriteGateway> {
    const entry = await this.#resolve(projectRef)
    let gateway = this.#gateways.get(entry.id)
    if (gateway === undefined) {
      await this.#assertPresent(entry)
      gateway = this.#newGateway(entry.path)
      this.#gateways.set(entry.id, gateway)
    }
    return gateway
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
