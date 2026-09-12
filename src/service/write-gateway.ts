/**
 * 写网关(Host 单一写通道,ADR-0004)。
 *
 * - **串行**:一个项目一个 in-flight 队列,写批按提交顺序落盘。
 * - **版本戳**:文件内容哈希即版本(`fingerprint`,缺失哨兵 `ABSENT='absent'`)。
 *   每个写操作**必须**携带 `expectVersion`(CAS):对已存在文件不给出期望版本 →
 *   拒绝(`expect-required`);对新建文件传 `'absent'` 断言"我确认它不存在"。
 *   不存在"无条件覆盖"的旁路。
 * - **原子批**:批内先全部校验版本,再整体落盘;任一不符 → 抛错不落;落盘中途
 *   失败 → 逐文件回滚旧内容(尽力而为);回滚失败如实记入 `errors`。
 * - **外部修改 = 观察**:文件监听把网关外的改动广播出去(工作台刷新),网关自身
 *   写盘时抑制对应事件(不把自己的写当成外部改动)。
 * - 快照/审计钩子(`onBatchCommit`)失败**不静默**:记入 `errors` 供状态呈现
 *   (写批已落盘的事实不被否定,但"是否成功快照"是诚实可查的)。
 * - 网关是**唯一**插件内写通道:服务不直接 write 项目文件,一律经此。
 */
import { mkdir, readFile, rm, watch, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { GalfreeError } from './error.ts'
import { ABSENT, fingerprint } from './hash.ts'

export interface WriteOp {
  /** 相对项目根的 POSIX 路径。 */
  path: string
  /**
   * 目标内容;`null` = 删除该文件。
   *
   * 文本与**二进制**同一个口子:素材环节要落 PNG(T14),而"经网关写"是铁律
   * (ADR-0004),所以类型放开到 `Uint8Array` 而不是给图像开一条旁路。
   * 版本戳口径不变 —— 一律按**原始字节**取哈希(`fingerprint` 两个类型都吃)。
   */
  content: string | Uint8Array | null
  /** CAS 期望版本(读取时的 version;'absent' = 断言不存在)。必填,拒绝无条件覆盖。 */
  expectVersion: string
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
  /** 改动后的新版本;删除为 ABSENT('absent')。 */
  version: string
  /** 该事件来自网关自身写(internal)还是被观察到的外部写(external)。 */
  kind: 'internal' | 'external'
}

/** 写日志条目(接缝插桩:"网关是唯一写通道"的可断言记录)。 */
export interface WriteLogEntry {
  path: string
  batchId: number
  /** 落盘后的版本(ABSENT = 删除)。 */
  version: string
  reason: string
  origin: WriteBatchReason['origin']
  at: string
}

/** 非致命但必须如实呈现的故障(快照钩子失败、回滚失败)。 */
export interface GatewayError {
  batchId: number
  kind: 'snapshot-failed' | 'rollback-failed' | 'watch-failed'
  message: string
  at: string
}

export class WriteGateway {
  #queue: Promise<unknown> = Promise.resolve()
  #batch = 0
  /** 当前批正在落盘的路径(绝对):窗口内事件为写噪声(截断中间态),直接跳过。 */
  #inFlight = new Set<string>()
  /** 写完成→settle 复查之间的路径:事件延迟到 settle 时刻统一判定。 */
  #settling = new Map<string, { marker: string; timer: ReturnType<typeof setTimeout> }>()
  /** 每路径最近一次自身写的最终内容哈希:watcher 迟到地看到自己写的终态时据此抑制。 */
  #lastInternal = new Map<string, string>()
  #listeners = new Set<(change: ChangeEvent) => void>()
  #watcher: ReturnType<typeof watch> | undefined
  #watchStop: AbortController | undefined
  #writeLog: WriteLogEntry[] = []
  #errors: GatewayError[] = []
  #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** 读取文件 + 当前版本(内容哈希)。缺失文件 version = ABSENT。 */
  async read(relPath: string): Promise<FileSnapshot> {
    const abs = this.#abs(relPath)
    try {
      // 一律按**字节**读再解码:版本戳据此与二进制写口径一致(同内容同哈希)。
      const raw = await readFile(abs)
      return { content: raw.toString('utf8'), version: fingerprint(raw), missing: false }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') return { content: '', version: ABSENT, missing: true }
      throw new GalfreeError('read-failed', `读取失败 ${relPath}: ${String(error)}`)
    }
  }

  #abs(relPath: string): string {
    const abs = join(this.#root, ...relPath.split('/'))
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
    // 1) 校验阶段:全部读当前版本比对 CAS,任一漂移/缺期望版本 → 抛错,不落任何文件。
    for (const op of ops) {
      const now = await this.read(op.path)
      if (op.expectVersion === undefined || op.expectVersion === '') {
        throw new GalfreeError('expect-required', `写操作缺少 expectVersion(拒绝无条件覆盖):${op.path}`, { path: op.path })
      }
      if (now.version !== op.expectVersion) {
        throw new GalfreeError('version-drift', `版本漂移:${op.path} 期望 ${op.expectVersion},磁盘实际 ${now.version}`, {
          path: op.path, expected: op.expectVersion, actual: now.version, origin: reason.origin,
        })
      }
    }
    // 2) 准备:计算新版本。
    const batchId = ++this.#batch
    const versions: Record<string, string> = {}
    const prepared: Array<{ abs: string; op: WriteOp }> = []
    for (const op of ops) {
      const abs = this.#abs(op.path)
      versions[op.path] = op.content === null ? ABSENT : fingerprint(op.content)
      prepared.push({ abs, op })
    }
    // 3) 原子性:写窗口内(#inFlight)的路径事件按写噪声跳过;
    //    写前用刚读的旧内容做**权威 CAS 复校**,关闭校验→写入之间的 TOCTOU 缝隙。
    for (const item of prepared) this.#inFlight.add(item.abs)
    const written: Array<{ abs: string; prev: Uint8Array | null }> = []
    try {
      for (const item of prepared) {
        const prev = await this.#safeReadRaw(item.abs)
        const prevVersion = prev === null ? ABSENT : fingerprint(prev)
        if (prevVersion !== item.op.expectVersion) {
          throw new GalfreeError('version-drift', `落盘前版本漂移:${item.op.path} 期望 ${item.op.expectVersion},实际 ${prevVersion}`, {
            path: item.op.path, expected: item.op.expectVersion, actual: prevVersion, origin: reason.origin,
          })
        }
        if (item.op.content === null) {
          await rm(item.abs, { force: true })
        } else {
          await mkdir(dirname(item.abs), { recursive: true })
          // 文本按 utf8 落盘,二进制原样落盘 —— 两条路都经这里,没有旁路。
          await writeFile(item.abs, item.op.content)
        }
        written.push({ abs: item.abs, prev })
      }
    } catch (error) {
      for (const item of prepared) this.#inFlight.delete(item.abs)
      // 回滚(尽力而为);每步失败如实记录,不吞。
      for (const done of written.reverse()) {
        try {
          if (done.prev === null) await rm(done.abs, { force: true })
          else await writeFile(done.abs, done.prev)
        } catch (rollbackError) {
          this.#recordError(batchId, 'rollback-failed', `回滚 ${relative(this.#root, done.abs)} 失败:${String(rollbackError)}`)
        }
      }
      if (error instanceof GalfreeError && error.code === 'version-drift') throw error
      throw new GalfreeError('write-failed', `写批落盘失败,已尝试回滚:${String(error)}`)
    }
    // 4) 记写日志、广播 internal 事件、启动 settle 复查(判定写窗口内是否又混入外部改动)。
    const at = new Date().toISOString()
    for (const op of ops) {
      const version = versions[op.path] ?? ABSENT
      this.#writeLog.push({ path: op.path, batchId, version, reason: reason.reason, origin: reason.origin, at })
      this.#emit({ path: op.path, version, kind: 'internal' })
    }
    for (const item of prepared) {
      this.#inFlight.delete(item.abs)
      const marker = versions[item.op.path] ?? ABSENT
      this.#rememberInternal(item.abs, marker)
      const timer = setTimeout(() => {
        this.#settling.delete(item.abs)
        void (async () => {
          try {
            const now = await this.read(item.op.path)
            if (now.version !== marker) {
              // 写窗口内确有外部改动(或回滚发生):如实补一条 external。
              this.#emit({ path: item.op.path, version: now.version, kind: 'external' })
            }
          } catch { /* 读失败不打断;轮询兜底 */ }
        })()
      }, 350)
      timer.unref?.()
      this.#settling.set(item.abs, { marker, timer })
    }
    for (const hook of this.#batchHooks) {
      try {
        await hook({ batchId, reason, versions })
      } catch (hookError) {
        // 钩子失败不否定已落盘的写批(ADR-0004),但如实记录(ADR-0011 快照失败)。
        this.#recordError(batchId, 'snapshot-failed', String(hookError))
      }
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

  /** 非致命故障(快照/回滚/监听失败)——状态层必须能读到。 */
  get errors(): readonly GatewayError[] {
    return this.#errors
  }

  #recordError(batchId: number, kind: GatewayError['kind'], message: string): void {
    this.#errors.push({ batchId, kind, message, at: new Date().toISOString() })
    if (this.#errors.length > 100) this.#errors.shift()
  }

  /** 记住本路径最近一次自身写的终态(有界);watcher 迟到事件据此抑制。 */
  #rememberInternal(abs: string, marker: string): void {
    this.#lastInternal.set(abs, marker)
    if (this.#lastInternal.size > 500) {
      const oldest = this.#lastInternal.keys().next().value
      if (oldest !== undefined) this.#lastInternal.delete(oldest)
    }
  }

  /** 原样读回字节(TOCTOU 复校 + 回滚底本);不存在的路径返回 null。 */
  async #safeReadRaw(abs: string): Promise<Uint8Array | null> {
    try { return await readFile(abs) } catch { return null }
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
          if (rel.split('/')[0] === '.git') continue
          if (rel.endsWith('.rpyc') || rel.split('/').includes('cache') || rel.split('/').includes('saves')) continue
          const abs = join(this.#root, filename)
          let raw: Uint8Array | null
          try {
            // 按字节读:版本戳与写/读同一口径,二进制素材也能被正确比对(否则内部写噪声抑制失效)。
            raw = await readFile(abs)
          } catch {
            raw = null // 目录事件或已删除
          }
          const version = raw === null ? ABSENT : fingerprint(raw)
          // 写窗口(#inFlight)与 settle 复查(#settling)覆盖的路径:事件交给
          // settle 时刻统一判定;窗口外迟到的"自己写的终态"按 #lastInternal 抑制。
          if (this.#inFlight.has(abs) || this.#settling.has(abs)) continue
          if (this.#lastInternal.get(abs) === version) continue
          this.#emit({ path: rel, version, kind: 'external' })
        }
      } catch (error) {
        if ((error as { name?: string }).name !== 'AbortError') {
          this.#recordError(this.#batch, 'watch-failed', `外部监听降级:${String(error)}`)
        }
      }
    })()
  }

  async dispose(): Promise<void> {
    this.#watchStop?.abort()
    this.#watchStop = undefined
    this.#watcher = undefined
    for (const { timer } of this.#settling.values()) clearTimeout(timer)
    this.#settling.clear()
    this.#inFlight.clear()
    this.#listeners.clear()
  }
}
