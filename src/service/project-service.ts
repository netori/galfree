/**
 * 项目服务(Seam —— 唯一测试接缝,spec "Seam" 节)。
 *
 * Host 侧深接口:T1 起承载 注册表 + 模板新建;后续环节在**同一对象**上生长
 * (写网关、结构解析、推导进度、校验回路、图像队列、快照、试玩)。
 * agent 工具与工作台 Client 只是两个薄适配器,消费这里的状态,不另立真相源。
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { GalfreeError } from './error.ts'
import { runGit } from './git.ts'
import { ProjectRegistry } from './registry.ts'
import { PROJECT_NAME_RE, renderTemplateFiles, templateKeepFiles } from './template.ts'
import { TemplateValidator } from './validation/template-validator.ts'
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
  validator?: TemplateValidator
}

export class ProjectService {
  #registry: ProjectRegistry
  #validator: TemplateValidator

  constructor(options: ProjectServiceOptions) {
    this.#registry = new ProjectRegistry(join(options.dataDir, 'registry.json'))
    this.#validator = options.validator ?? new TemplateValidator()
  }

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
    const files = [
      ...renderTemplateFiles({ name: input.name, title, id }),
      ...templateKeepFiles(),
    ]
    const dirs = new Set<string>()
    for (const file of files) {
      dirs.add(join(root, file.path, '..'))
    }
    for (const dir of [...dirs].sort()) await mkdir(dir, { recursive: true })
    for (const file of files) await writeFile(join(root, file.path), file.content, 'utf8')

    try {
      await this.#initGit(root, input.name)
    } catch (error) {
      // 初始化失败不留半成品注册:目录已写但 git 失败 → 报 git-init-failed(目录不注册)。
      throw new GalfreeError('git-init-failed', `模板 git 初始化失败:${String(error)}`)
    }

    await this.#registry.add({ id, name: input.name, title, path: root, createdAt })
    return this.#toInfo(id)
  }

  /** 模板 git 化:init + 初始提交(作者 GALFree,ADR-0011)。 */
  async #initGit(root: string, name: string): Promise<void> {
    await runGit(root, ['init', '--initial-branch', 'main'])
    await runGit(root, ['add', '--all'])
    await runGit(root, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', `chore(galfree): scaffold template project "${name}"`])
  }

  async #commit(root: string, message: string): Promise<void> {
    await runGit(root, ['add', '--all'])
    // 无变化(未暂存内容)时跳过:commit 失败=模板瑕疵,直接冒泡。
    const staged = await runGit(root, ['diff', '--cached', '--name-only'])
    if (staged.length === 0) return
    await runGit(root, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', message])
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

  /** 校验回路:对当前激活项目跑验证器(T1 假验证器;T4 接方言解析契约)。 */
  async validateActiveProject(): Promise<ValidationReport> {
    const active = await this.getActiveProject()
    if (active === null) throw new GalfreeError('no-active-project', '没有激活项目可校验')
    if (active.missing) throw new GalfreeError('project-missing', `项目目录已不存在:${active.root}`)
    return this.#validator.validate(join(active.root, 'game'))
  }

  /** 供后续环节复用:把一次文件集变更并入新快照(T3 起走写网关的提交钩子)。 */
  async snapshotActive(message: string): Promise<void> {
    const active = await this.getActiveProject()
    if (active === null) throw new GalfreeError('no-active-project', '没有激活项目')
    if (active.missing) throw new GalfreeError('project-missing', `项目目录已不存在:${active.root}`)
    await this.#commit(active.root, message)
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
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  return new ProjectService(options)
}
