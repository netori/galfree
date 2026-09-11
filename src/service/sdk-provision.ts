/**
 * 钉版 SDK 供给状态机(T5;ADR-0006)。
 *
 * 首次需要时:下载钉版 Ren'Py SDK zip → 校验和验证 → 解压到插件自有目录。
 * 进度可见、网络失败可重试、幂等(已就绪则不再下载)。下载与解压都是**端口**:
 * 快测注入假实现,真实现走 https + extract-zip。真 SDK lint 冒烟在慢集成带。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GalfreeError } from './error.ts'

/** 发版钉死的 SDK 版本(spec:改钉版走插件发版,非用户操作)。 */
export const PINNED_SDK = {
  version: '8.5.3',
  url: 'https://www.renpy.org/dl/8.5.3/renpy-8.5.3-sdk.zip',
  /** sha256(checksums.txt),下载后校验;留空 = 跳过校验(仅开发期)。 */
  sha256: '',
} as const

export interface Progress {
  phase: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'failed'
  /** 0..1(downloading 为字节比;其余阶段给里程碑)。 */
  fraction: number
  bytes?: number
  totalBytes?: number
  message?: string
}

export type Downloader = (url: string, onBytes: (received: number, total: number) => void, signal?: AbortSignal) => Promise<Uint8Array>
export type Extractor = (zipBytes: Uint8Array, destDir: string) => Promise<void>

export interface ProvisionerPorts {
  download: Downloader
  extract: Extractor
  /** SDK 解压后期望存在的启动器文件名(平台相关);探测用。 */
  launcherName: string
  /** 期望 sha256(缺省 = 钉版常量;测试可注入)。空串 = 跳过校验。 */
  sha256?: string
  /** 下载地址(缺省 = 钉版常量;测试可注入)。 */
  url?: string
}

export interface ProvisionStatus {
  /** 目标目录(插件自有)。 */
  sdkDir: string
  state: Progress['phase']
  progress: Progress
  /** 已就绪时的 SDK 版本(从目录探测)。 */
  detectedVersion?: string
  /** 与钉版差异(覆盖路径时也可能填)。 */
  versionMismatch?: { pinned: string; actual: string }
  error?: string
}

/** SDK 目录就绪判据:存在启动器文件。 */
export async function sdkIsReady(sdkDir: string, launcherName: string): Promise<boolean> {
  try {
    await access(join(sdkDir, launcherName))
    return true
  } catch {
    return false
  }
}

export class SdkProvisioner {
  #status: ProvisionStatus
  #inflight: Promise<void> | null = null
  #ports: ProvisionerPorts

  constructor(sdkDir: string, ports: ProvisionerPorts) {
    this.#ports = ports
    this.#status = { sdkDir, state: 'idle', progress: { phase: 'idle', fraction: 0 } }
  }

  get status(): ProvisionStatus {
    return structuredClone(this.#status)
  }

  #set(patch: Partial<Progress>, extra: Partial<ProvisionStatus> = {}): void {
    this.#status.progress = { ...this.#status.progress, ...patch }
    this.#status.state = this.#status.progress.phase
    Object.assign(this.#status, extra)
  }

  /** 确保 SDK 就绪(幂等)。已在下载则复用同一 promise(单飞)。 */
  async ensure(signal?: AbortSignal): Promise<ProvisionStatus> {
    if (await sdkIsReady(this.#status.sdkDir, this.#ports.launcherName)) {
      const version = await this.#detectVersion()
      this.#set({ phase: 'ready', fraction: 1 }, { detectedVersion: version, error: undefined })
      this.#applyMismatch(version)
      return this.status
    }
    if (this.#inflight !== null) {
      await this.#inflight
      return this.status
    }
    this.#inflight = this.#run(signal).finally(() => { this.#inflight = null })
    await this.#inflight
    return this.status
  }

  /** 手动重下(清掉半成品目录后重来)。 */
  async retry(signal?: AbortSignal): Promise<ProvisionStatus> {
    await rm(this.#status.sdkDir, { recursive: true, force: true })
    this.#set({ phase: 'idle', fraction: 0 }, { error: undefined })
    return this.ensure(signal)
  }

  async #run(signal?: AbortSignal): Promise<void> {
    try {
      this.#set({ phase: 'downloading', fraction: 0, message: "下载钉版 Ren'Py SDK…" })
      const bytes = await this.#ports.download(this.#ports.url ?? PINNED_SDK.url, (received, total) => {
        this.#set({ phase: 'downloading', fraction: total > 0 ? received / total : 0, bytes: received, totalBytes: total })
      }, signal)
      this.#set({ phase: 'verifying', fraction: 0.9 })
      const expectedSha = this.#ports.sha256 ?? PINNED_SDK.sha256
      if (expectedSha !== '') {
        const hash = createHash('sha256').update(bytes).digest('hex')
        if (hash !== expectedSha) throw new GalfreeError('checksum-mismatch', `校验和不匹配:期望 ${expectedSha},实际 ${hash}`)
      }
      this.#set({ phase: 'extracting', fraction: 0.95, message: '解压 SDK…' })
      await mkdir(dirname(this.#status.sdkDir), { recursive: true })
      await this.#ports.extract(bytes, this.#status.sdkDir)
      if (!(await sdkIsReady(this.#status.sdkDir, this.#ports.launcherName))) {
        throw new GalfreeError('bad-archive', `解压后未找到启动器 ${this.#ports.launcherName},产物不可用`)
      }
      const version = await this.#detectVersion()
      this.#set({ phase: 'ready', fraction: 1 }, { detectedVersion: version, error: undefined })
      this.#applyMismatch(version)
    } catch (error) {
      this.#set({ phase: 'failed', fraction: 0, message: '下载/解压失败,可重试' }, { error: String(error) })
      throw error
    }
  }

  async #detectVersion(): Promise<string | undefined> {
    // Ren'Py SDK 顶层目录形如 renpy-8.5.3-sdk/… 或含 version 文件;尽力探测。
    try {
      const entries = await readdir(this.#status.sdkDir)
      const hint = entries.find((name) => /renpy-\d+\.\d+\.\d+/.test(name))
      const fromDir = hint === undefined ? undefined : /\d+\.\d+\.\d+/.exec(hint)?.[0]
      if (fromDir !== undefined) return fromDir
      const vf = join(this.#status.sdkDir, 'renpy', 'test', 'stage', 'version')
      try { return (await readFile(vf, 'utf8')).trim() } catch { return undefined }
    } catch {
      return undefined
    }
  }

  #applyMismatch(version?: string): void {
    if (version !== undefined && version !== PINNED_SDK.version) {
      this.#status.versionMismatch = { pinned: PINNED_SDK.version, actual: version }
    } else {
      this.#status.versionMismatch = undefined
    }
  }
}

/** 从给定(可能是用户覆盖的)SDK 路径探测版本并给出差异警告(不阻塞)。 */
export async function probeOverrideSdk(sdkDir: string, launcherName: string): Promise<{ ready: boolean; version?: string; mismatch?: { pinned: string; actual: string } }> {
  const ready = await sdkIsReady(sdkDir, launcherName)
  if (!ready) return { ready: false }
  let version: string | undefined
  try {
    const entries = await readdir(sdkDir)
    const hint = entries.find((name) => /renpy-\d+\.\d+\.\d+/.test(name))
    version = hint === undefined ? undefined : /\d+\.\d+\.\d+/.exec(hint)?.[0]
  } catch { /* ignore */ }
  const mismatch = version !== undefined && version !== PINNED_SDK.version ? { pinned: PINNED_SDK.version, actual: version } : undefined
  return { ready: true, ...(version === undefined ? {} : { version }), ...(mismatch === undefined ? {} : { mismatch }) }
}
