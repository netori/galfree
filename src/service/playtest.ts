/**
 * 试玩控制(T7;ADR-0001/0006):用钉版 SDK 启动当前项目、退出回传。
 * 技术通过 = 从运行日志机械推导(退出码 + 无 traceback),**不是人盖的戳**;
 * 主观"玩过了、行"走场景级审读戳。运行事实记 `.studio/playtest.json`
 * (经网关写 → 进快照),进度板推导其新鲜度(内容变了 → stale)。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  spawn: (launcher: string, projectRoot: string) => Promise<SpawnResult>
}

export interface PlaytestRun {
  at: string
  exitCode: number
  technicalPass: boolean
  /** traceback 摘要;干净为 null。 */
  traceback: string | null
  /** 运行时的内容指纹(推导新鲜度用)。 */
  fingerprint: string
}

export interface PlaytestDocument {
  schemaVersion: 1
  last: PlaytestRun | null
  history: PlaytestRun[]
}

export const PLAYTEST_FILE = '.studio/playtest.json'

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
 */
export async function launchPlaytest(ports: PlaytestPorts, projectRoot: string, fingerprint: string): Promise<PlaytestRun> {
  const launcher = await ports.resolveLauncher()
  if (launcher === null) throw new GalfreeError('sdk-not-ready', '钉版 SDK 尚未就绪,无法试玩(先到工作台/设置完成 SDK 供给)')
  const result = await ports.spawn(launcher, projectRoot)
  const traceback = extractTraceback(result.log)
  return {
    at: new Date().toISOString(),
    exitCode: result.code,
    technicalPass: result.code === 0 && traceback === null,
    traceback,
    fingerprint,
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
