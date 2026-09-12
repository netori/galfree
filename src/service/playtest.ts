/**
 * 试玩控制(T7/T13;ADR-0001/0006):用钉版 SDK 启动当前项目、退出回传。
 * 技术通过 = 从运行日志机械推导(退出码 + 无 traceback),**不是人盖的戳**;
 * 主观"玩过了、行"走场景级审读戳。运行事实记 `.studio/playtest.json`
 * (经网关写 → 进快照),进度板推导其新鲜度(内容变了 → stale)。
 *
 * **从某场试玩**(T13):启动落在指定场景,而不是从头开始。做法是**在副本里**覆写
 * `start` 跳向目标场 —— 不在用户项目里塞文件(`.rpy` 是唯一真相,试玩副本不是真相源)。
 * 目标场不存在就会在启动时崩出 traceback,所以"落对了"这件事有可红的信号。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GalfreeError } from './error.ts'
import { fingerprint } from './hash.ts'
import type { BranchGraph } from './rpy/dialect.ts'

export interface SpawnResult {
  code: number
  /** 合并 stdout+stderr 的运行日志。 */
  log: string
}

export interface PlaytestPorts {
  /** 解析启动器绝对路径;null = SDK 未就绪(如实失败)。 */
  resolveLauncher: () => Promise<string | null>
  /** 启动游戏到退出(注入端口:快测假,真实现 spawn 子进程)。 */
  spawn: (launcher: string, projectRoot: string, options?: { fromLabel?: string | null }) => Promise<SpawnResult>
}

export interface PlaytestRun {
  at: string
  exitCode: number
  technicalPass: boolean
  /** traceback 摘要;干净为 null。 */
  traceback: string | null
  /** 运行时的内容指纹(推导新鲜度用)。 */
  fingerprint: string
  /** 从哪一场开始试的(null = 从头)。 */
  from: string | null
}

export interface PlaytestDocument {
  schemaVersion: 1
  last: PlaytestRun | null
  history: PlaytestRun[]
}

export const PLAYTEST_FILE = '.studio/playtest.json'

/** 试玩副本里覆写 start 的文件名(排序靠后,确保它的 start 生效)。 */
export const WARP_FILE = 'zz_galfree_warp.rpy'

/**
 * 为"从某场试玩"准备一个副本:整个项目拷过去,再写一个覆写 `start` 的入口文件。
 *
 * 忠实性:唯一被改的是 `start` 这个入口 label(它本来就是"从哪开始"的开关),
 * 其余文件逐字拷贝 —— 所以跑的是真项目的内容。
 */
export async function prepareWarpCopy(projectRoot: string, fromLabel: string, copyRoot?: string): Promise<string> {
  const target = copyRoot ?? join(tmpdir(), `galfree-warp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(projectRoot, target, { recursive: true, force: true })
  // 副本里不需要历史与缓存,少拷点噪声(失败不影响正确性)。
  await rm(join(target, '.git'), { recursive: true, force: true }).catch(() => {})
  await rm(join(target, 'game', 'cache'), { recursive: true, force: true }).catch(() => {})
  await rm(join(target, 'traceback.txt'), { force: true }).catch(() => {})
  await rm(join(target, 'log.txt'), { force: true }).catch(() => {})
  await writeFile(
    join(target, 'game', WARP_FILE),
    [
      `# GALFree 试玩副本:把入口指向 ${fromLabel}(只在副本里存在,不进用户项目)。`,
      '# 目标 label 不存在时,启动即崩 → 试玩如实报错(可红的信号)。',
      'label start:',
      `    jump ${fromLabel}`,
      '',
    ].join('\n'),
    'utf8',
  )
  return target
}

export async function readPlaytest(root: string): Promise<PlaytestDocument | null> {
  try {
    const doc = JSON.parse(await readFile(join(root, PLAYTEST_FILE), 'utf8')) as PlaytestDocument
    if (doc.schemaVersion !== 1) return null
    return doc
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GalfreeError('playtest-ledger-corrupt', `试玩账本无法解析:${String(error)}`)
  }
}

export function playtestDocument(doc: PlaytestDocument): string {
  return JSON.stringify({ ...doc, history: doc.history.slice(-20) }, null, 2) + '\n'
}

/**
 * 运行内容指纹:全部场景原始文本块 + 边结构。与场景戳同一口径(原始文本哈希),
 * 试玩后又改任何内容(哪怕子集外)都会推导为 stale。
 */
export function contentFingerprint(graph: BranchGraph): string {
  return fingerprint(graph.scenes.map((scene) => `${scene.file}\u0000${scene.text}`).join('\u0001'))
}

/** traceback 提取:优先 "Full traceback:" 段;退化到含 Exception/Error 的行块。 */
export function extractTraceback(log: string): string | null {
  const lines = log.split('\n')
  const start = lines.findIndex((line) => /full traceback/i.test(line))
  if (start >= 0) {
    return lines.slice(start, start + 30).join('\n').slice(0, 4000)
  }
  const hits = lines.filter((line) => /(^|\s)\w*(Exception|Error)\b/.test(line) && !/0 errors/i.test(line))
  return hits.length === 0 ? null : hits.join('\n').slice(0, 4000)
}

/**
 * 启动试玩并回传运行事实。SDK 未就绪 → sdk-not-ready(不静默、不伪装通过)。
 * 调用方(服务层)负责把事实经网关落盘 —— 记录也是项目文件。
 *
 * `fromLabel` 给了就"从这一场开始":在**副本**里覆写 start 跳过去,跑完即清理,
 * 用户项目一个字节都不动。
 */
export async function launchPlaytest(
  ports: PlaytestPorts,
  projectRoot: string,
  fingerprintValue: string,
  fromLabel: string | null = null,
): Promise<PlaytestRun> {
  const launcher = await ports.resolveLauncher()
  if (launcher === null) throw new GalfreeError('sdk-not-ready', '钉版 SDK 尚未就绪,无法试玩(先到工作台/设置完成 SDK 供给)')

  let runRoot = projectRoot
  let temporary: string | null = null
  if (fromLabel !== null) {
    temporary = await prepareWarpCopy(projectRoot, fromLabel)
    runRoot = temporary
  }
  try {
    const result = await ports.spawn(launcher, runRoot, { fromLabel })
    let traceback = extractTraceback(result.log)
    // 副本里跑时,traceback 也可能落在副本自己的文件里(日志不总是抓到)。
    if (temporary !== null && traceback === null) {
      traceback = await readFile(join(temporary, 'traceback.txt'), 'utf8').catch(() => null)
    }
    return {
      at: new Date().toISOString(),
      exitCode: result.code,
      technicalPass: result.code === 0 && traceback === null,
      traceback: traceback === null ? null : traceback.slice(0, 4000),
      fingerprint: fingerprintValue,
      from: fromLabel,
    }
  } finally {
    if (temporary !== null) await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}

/** 真 spawn 实现(Host 装配用):启动游戏进程,退出后回传合并日志。 */
export async function realSpawn(launcher: string, projectRoot: string): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(launcher, [projectRoot], { windowsHide: true })
    let log = ''
    child.stdout.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code: code ?? 1, log }))
  })
}
