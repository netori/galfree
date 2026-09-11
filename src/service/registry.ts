/**
 * 项目注册表(数据模型 v1:项目列表 + 单激活标志;切换 UI 后补,ADR/spec R7)。
 *
 * 磁盘上的项目目录是项目内容的唯一真相;注册表**只存指针**(路径与激活位),
 * 内容状态一律不落这里(无第二处项目状态)。missing 标志在读取时对磁盘
 * 现算,不是持久字段。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GalfreeError } from './error.ts'

export interface RegistryEntry {
  id: string
  name: string
  title: string
  path: string
  createdAt: string
}

interface RegistryDocument {
  schemaVersion: 1
  projects: RegistryEntry[]
  activeId: string | null
}

export class ProjectRegistry {
  #doc: RegistryDocument = { schemaVersion: 1, projects: [], activeId: null }
  #loaded = false

  constructor(private readonly filePath: string) {}

  async #load(): Promise<void> {
    if (this.#loaded) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as RegistryDocument
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
        throw new GalfreeError('registry-corrupt', `注册表文件格式不可识别:${this.filePath}`)
      }
      this.#doc = parsed
    } catch (error) {
      if (error instanceof GalfreeError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw new GalfreeError('registry-corrupt', `注册表读取失败:${this.filePath}`, { cause: String(error) })
      this.#doc = { schemaVersion: 1, projects: [], activeId: null }
    }
    this.#loaded = true
  }

  /** 原子落盘(写临时文件再 rename)。 */
  async #save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.#doc, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  async add(entry: RegistryEntry): Promise<void> {
    await this.#load()
    if (this.#doc.projects.some((project) => project.id === entry.id)) return
    this.#doc.projects.push(entry)
    this.#doc.activeId ??= entry.id
    await this.#save()
  }

  async list(): Promise<RegistryEntry[]> {
    await this.#load()
    return this.#doc.projects.map((entry) => ({ ...entry }))
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    await this.#load()
    const entry = this.#doc.projects.find((project) => project.id === id)
    return entry === undefined ? undefined : { ...entry }
  }

  async activeId(): Promise<string | null> {
    await this.#load()
    return this.#doc.activeId
  }

  async setActive(id: string): Promise<void> {
    await this.#load()
    if (!this.#doc.projects.some((project) => project.id === id)) {
      throw new GalfreeError('unknown-project', `注册表中不存在项目 ${id}`)
    }
    this.#doc.activeId = id
    await this.#save()
  }
}
