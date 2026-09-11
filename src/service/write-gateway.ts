/**
 * 写网关(Host 单一写通道,ADR-0004)。
 *
 * - **串行**:一个项目一个 in-flight 队列,写批按提交顺序落盘。
 * - **版本戳**:以文件内容哈希为版本(token),CAS 式拒绝过期写;漂移如实报告。
 * - **原子批**:批内先全部校验版本,再整体落盘;任一不符 → 整批不落(全有或全无)。
 * - **外部修改 = 观察**:文件监听把网关外的改动广播出去(工作台刷新),网关自身
 *   写盘时抑制对应事件(不把自己的写当成外部改动)。
 * - 网关是**唯一**插件内写通道:服务不直接 write 项目文件,一律经此。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, watch, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { GalfreeError } from './error.ts'

export interface WriteOp {
  /** 相对项目根的 POSIX 路径。 */
  path: string
  /** 目标内容;null = 删除该文件。 */
  content: string | null
  /** CAS 期望版本(读取时的 version);缺省 = 无条件覆盖(仅限新建)。 */
  expectVersion?: string
}

export interface WriteBatchReason {
  /** 发起侧:工作台 / agent / 外部(观察回填)。 */
  origin: 'workbench' | 'agent' | 'external'
  /** 环节/动作上下文(进快照 commit message,T3)。 */
  reason: string
  scene?: string
  slot?: string
}

export interface WriteResult {
  /** 每条受影响路径落盘后的新版本。 */
  versions: Record<string, string>
  /** 本次批次提交号(自增),供快照/审计关联。 */
  batchId: number
}

export interface FileSnapshot {
  content: string
  version: string
  missing: boolean
}

export interface ChangeEvent {
  path: string
  /** 外部改动后的新版本;删除为 'deleted'。 */
  version: string
  /** 该事件来自网关自身写(internal)还是被观察到的外部写(external)。 */
  kind: 'internal' | 'external'
}

/** 写日志条目(接缝插桩:"网关是唯一写通道"的可断言记录)。 */
export interface WriteLogEntry {
  path: string
  batchId: number
  /** 落盘后的版本('absent' = 删除)。 */
  version: string
  reason: string
  origin: WriteBatchReason['origin']
  at: string
}

function versionOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

export class WriteGateway {
  #queue: Promise<unknown> = Promise.resolve()
  #batch = 0
  /** 网关自身写盘时登记的期望哈希,watch 见到即判为 internal(抑制"外部"事件)。 */
  #internalWrites = new Map<string, string>()
  #listeners = new Set<(change: ChangeEvent) => void>()
  #watcher: ReturnType<typeof watch> | undefined
  #watchStop: AbortController | undefined
  #writeLog: WriteLogEntry[] = []
  #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** 读取文件 + 当前版本(内容哈希)。缺失文件 version = 'absent'。 */
  async read(relPath: string): Promise<FileSnapshot> {
    const abs = this.#abs(relPath)
    try {
      const content = await readFile(abs, 'utf8')
      return { content, version: versionOf(content), missing: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', version: 'absent', missing: true }
      throw new GalfreeError('read-failed', `读取失败 ${relPath}: ${String(error)}`)
    }
  }

  #abs(relPath: string): string {
    const abs = join(this.#root, ...relPath.split('/'))
    // 防路径逃逸:解析后必须仍在项目根内。
    const rel = relative(this.#root, abs)
    if (rel.startsWith('..') || rel.startsWith(sep)) throw new GalfreeError('path-escape', `路径越出项目根:${relPath}`)
    return abs
  }

  /** 串行提交一个写批(全有或全无)。 */
  writeBatch(ops: WriteOp[], reason: WriteBatchReason): Promise<WriteResult> {
    const run = this.#queue.then(() => this.#doBatch(ops, reason))
    // 队列只保串行;错误不外溢成 unhandled(调用方拿到 rejected)。
    this.#queue = run.catch(() => {})
    return run
  }

  async #doBatch(ops: WriteOp[], reason: WriteBatchReason): Promise<WriteResult> {
    // 1) 校验阶段:全部读当前版本比对 CAS,任一漂移 → 抛错,不落任何文件。
    for (const op of ops) {
      if (op.expectVersion === undefined) continue
      const now = await this.read(op.path)
      if (now.version !== op.expectVersion) {
        throw new GalfreeError('version-drift', `版本漂移:${op.path} 期望 ${op.expectVersion},磁盘实际 ${now.version}`, {
          path: op.path, expected: op.expectVersion, actual: now.version, origin: reason.origin,
        })
      }
    }
    // 2) 落盘阶段:逐文件写入,登记 internal 版本供 watcher 抑制。
    const batchId = ++this.#batch
    const versions: Record<string, string> = {}
    const pending: Array<{ abs: string; rel: string; content: string | null }> = []
    for (const op of ops) {
      const abs = this.#abs(op.path)
      pending.push({ abs, rel: op.path, content: op.content })
      versions[op.path] = op.content === null ? 'absent' : versionOf(op.content)
      this.#internalWrites.set(abs, op.content === null ? 'deleted' : versionOf(op.content))
    }
    // 3) 原子性:先确保目录,再写;失败回滚已写内容到旧值。
    const rollback: Array<() => Promise<void>> = []
    try {
      for (const item of pending) {
        const snapshot = await this.#safeReadRaw(item.abs)
        rollback.push(() => (snapshot === null ? rm(item.abs, { force: true }) : writeFile(item.abs, snapshot, 'utf8')))
        if (item.content === null) {
          await rm(item.abs, { force: true })
        } else {
          await mkdir(dirname(item.abs), { recursive: true })
          await writeFile(item.abs, item.content, 'utf8')
        }
      }
    } catch (error) {
      for (const undo of rollback.reverse()) {
        try { await undo() } catch { /* 回滚尽力而为 */ }
      }
      throw new GalfreeError('write-failed', `写批落盘失败,已回滚:${String(error)}`)
    }
    // 4) 记写日志、广播 internal 事件、触发批提交钩子(快照 T3 挂这里)。
    const at = new Date().toISOString()
    for (const op of ops) {
      const version = versions[op.path] ?? 'absent'
      this.#writeLog.push({ path: op.path, batchId, version, reason: reason.reason, origin: reason.origin, at })
      this.#emit({ path: op.path, version, kind: 'internal' })
    }
    // 让 watcher 有机会消费 internal 标记后再清理(短暂窗口后按文件粒度比对)。
    const timer = setTimeout(() => { for (const op of ops) this.#internalWrites.delete(this.#abs(op.path)) }, 1500)
    timer.unref?.()
    for (const hook of this.#batchHooks) {
      try { await hook({ batchId, reason, versions }) } catch { /* 钩子失败不否定已落盘的写批;由调用方状态如实呈现 */ }
    }
    return { versions, batchId }
  }

  #batchHooks: Array<(info: { batchId: number; reason: WriteBatchReason; versions: Record<string, string> }) => Promise<void> | void> = []

  /** 批提交后钩子(快照/审计的挂载点,ADR-0004/0011)。 */
  onBatchCommit(hook: (info: { batchId: number; reason: WriteBatchReason; versions: Record<string, string> }) => Promise<void> | void): () => void {
    this.#batchHooks.push(hook)
    return () => {
      const index = this.#batchHooks.indexOf(hook)
      if (index >= 0) this.#batchHooks.splice(index, 1)
    }
  }

  /** 写日志(插桩:断言所有写都经过网关)。 */
  get log(): readonly WriteLogEntry[] {
    return this.#writeLog
  }

  async #safeReadRaw(abs: string): Promise<string | null> {
    try { return await readFile(abs, 'utf8') } catch { return null }
  }

  /** 订阅变更事件(网关内部写 kind=internal;观察到的外部写 kind=external)。 */
  observe(listener: (change: ChangeEvent) => void): () => void {
    this.#listeners.add(listener)
    this.#ensureWatch()
    return () => {
      this.#listeners.delete(listener)
      // 无人订阅就释放监听器(Windows 下避免目录占用)。
      if (this.#listeners.size === 0) void this.dispose()
    }
  }

  #emit(change: ChangeEvent): void {
    for (const listener of this.#listeners) listener(change)
  }

  /** 惰性启动文件监听;每个改动比对 internal 登记表决定 internal/external。 */
  #ensureWatch(): void {
    if (this.#watcher !== undefined) return
    const controller = new AbortController()
    this.#watchStop = controller
    void (async () => {
      try {
        const watcher = await watch(this.#root, { recursive: true, signal: controller.signal })
        this.#watcher = watcher
        for await (const event of watcher) {
          const filename = typeof event.filename === 'string' ? event.filename : null
          if (filename === null) continue
          const rel = filename.split(sep).join('/')
          // 跳过 git 内部与运行噪声(不广播它们,避免抖动)。
          if (rel.split('/')[0] === '.git') continue
          if (rel.endsWith('.rpyc') || rel.split('/').includes('cache') || rel.split('/').includes('saves')) continue
          const abs = join(this.#root, filename)
          let raw: string | null
          try {
            raw = await readFile(abs, 'utf8')
          } catch {
            raw = null // 目录事件或已删除
          }
          const version = raw === null ? 'deleted' : versionOf(raw)
          const expectedInternal = this.#internalWrites.get(abs)
          if (expectedInternal !== undefined && version === expectedInternal) {
            // 这是网关自己的写:已在 writeBatch 广播过,抑制"外部"事件。
            // 标记由批后的 TTL 清理(一次写可能触发多个 watch 事件,不能在此消费)。
            continue
          }
          this.#emit({ path: rel, version, kind: 'external' })
        }
      } catch (error) {
        if ((error as { name?: string }).name !== 'AbortError') {
          // 监听失败不致命:外部观察降级,写通道仍可用(状态如实呈现靠 read 现取)。
        }
      }
    })()
  }

  async dispose(): Promise<void> {
    this.#watchStop?.abort()
    this.#watchStop = undefined
    this.#watcher = undefined
    this.#listeners.clear()
  }
}
