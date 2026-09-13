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
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GalfreeError } from './error.ts'
import { GATE } from './gates.ts'
import { fingerprint } from './hash.ts'
import { spawnWithLog } from './spawn-log.ts'
import type { BranchGraph } from './rpy/dialect.ts'

export interface SpawnResult {
  code: number
  /** 合并 stdout+stderr 的运行日志。 */
  log: string
  /** 等到上限被中止(默认等待见 `PLAYTEST_TIMEOUT_MS`)。 */
  timedOut?: boolean
  /** 被取消(协作式取消:调用方中止了 `signal`)。 */
  aborted?: boolean
  /** 需要中止时,进程**确认**停了没有(正常退出恒为 true)。 */
  killed?: boolean
  /** 从起到停真实过了多少毫秒(面板与账本据此说得出"跑了多久")。 */
  elapsedMs?: number
}

export interface PlaytestPorts {
  /** 解析启动器绝对路径;null = SDK 未就绪(如实失败)。 */
  resolveLauncher: () => Promise<string | null>
  /**
   * 启动游戏到退出(注入端口:快测假,真实现 spawn 子进程)。
   *
   * `signal` 是**协作式取消**那条路(`#32`):真实现必须在它中止时杀掉子进程并
   * 回传 `aborted` —— 否则取消一轮对话不会让试玩停下,看着就是卡死。
   */
  spawn: (
    launcher: string,
    projectRoot: string,
    options?: { fromLabel?: string | null; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<SpawnResult>
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
  /** 这一次是**等满上限**被中止的(不是游戏自己退出的)。 */
  timedOut: boolean
  /** 等了多久才停(毫秒)——“为什么停”的第二半。 */
  elapsedMs: number
  /**
   * 需要中止时,进程**确认**停了没有(正常退出恒为 true)。
   * `false` = 发了中止信号但它没在宽限期内退出 —— 窗口可能还开着,得照实说。
   */
  killed: boolean
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
 *
 * `options.signal` 是宿主的**协作式取消**契约(T24 / #32):取消/中断这一轮时
 * 中止子进程,**并如实抛 `aborted`** —— 被取消的试玩不是一次试玩,所以它**不记账本**
 * (记进去的话,板上会多出一条"技术通过/失败"的假事实)。宿主之外没人能取消它:
 * 面板那条路经 `cancelPlaytest` 走同一个信号。
 *
 * `options.timeoutMs` 是这一次愿意等多久(有界;缺省见 `PLAYTEST_TIMEOUT_MS`)。
 */
export async function launchPlaytest(
  ports: PlaytestPorts,
  projectRoot: string,
  fingerprintValue: string,
  fromLabel: string | null = null,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PlaytestRun> {
  const { signal } = options
  // 取消已经发生:**起步前就停** —— 不去起进程、也不去拷试玩副本。
  if (signal?.aborted === true) throw abortError()
  const launcher = await ports.resolveLauncher()
  if (launcher === null) throw new GalfreeError(GATE.sdkNotReady, '钉版 SDK 尚未就绪,无法试玩(先到工作台/设置完成 SDK 供给)')

  let runRoot = projectRoot
  let temporary: string | null = null
  if (fromLabel !== null) {
    temporary = await prepareWarpCopy(projectRoot, fromLabel)
    runRoot = temporary
  }
  try {
    const result = await ports.spawn(launcher, runRoot, {
      fromLabel,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    })
    // 取消可能发生在**跑的过程中**:这一步不当成一次试玩(理由同上)。
    // 两半都要看:`aborted` 是端口如实回报的那一半;`signal.aborted` 是"树倒猢狲散"那一半
    // —— 端口就算没认真观察信号,我们也不能把一次被取消的运行记成结果。
    if ((signal?.aborted ?? false) || result.aborted === true) throw abortError()
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
      timedOut: result.timedOut === true,
      elapsedMs: result.elapsedMs ?? 0,
      // 缺省 true(正常退出那条路):只有端口**明确**说"没杀掉"时才是 false。
      killed: result.killed !== false,
    }
  } finally {
    if (temporary !== null) await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 一次试玩的**默认**等待上限。到点如实中止并报错,不无限期挂着。
 *
 * 这是个**产品决定**(票面明说要先想清楚):人**总是**要亲手去关那个游戏窗口,
 * 所以"等多久算久"取决于人要多快知道 agent 没在傻等。Ren'Py 起窗口只要几秒到几十秒,
 * 3 分钟足够人看见窗口、玩两句、关掉;再长就是对着一张挡住别的窗口的游戏窗口干等 ——
 * 而取消(宿主的中断 / 面板那颗按钮)在任何时刻都能立刻停下它。
 *
 * 15 分钟那一版实测下来就是用户报的"卡住"。工具面能按次给更短的 `timeout_seconds`。
 */
export const PLAYTEST_TIMEOUT_MS = 3 * 60 * 1000

/** 界面上那句人话里的分钟数 —— 与上面那个毫秒值**同源**(免得两处各说一个数)。 */
export const PLAYTEST_DEFAULT_WAIT_MINUTES = Math.round(PLAYTEST_TIMEOUT_MS / 60_000)

/** 工具面按次能给的上限:再长就回到"卡住"那一版了(缺省仍按上面那个)。 */
export const PLAYTEST_MAX_WAIT_MS = 15 * 60 * 1000

/**
 * 发了中止信号之后,再等多久确认进程真的退了(实现在 `spawn-log.ts` 里,试玩与发布共用)。
 * 在这里再导出一次:试玩的守卫要拿它当"宽限期"的时间基准,不该去 import 那个实现模块。
 *
 * `waitForExit` 同理 —— 它是那条判据本身,守卫直接在它两个出口上验(真进程量不出来)。
 */
export { KILL_GRACE_MS, waitForExit } from './spawn-log.ts'

/**
 * 真 spawn 实现(Host 装配用):启动游戏进程,退出后回传合并日志。
 *
 * 三条实测教训(都在这行代码上踩过):
 *  1. **绝不能带 `windowsHide: true`** —— 那会把游戏窗口藏起来,用户点"试玩"看起来
 *     毫无反应(其实进程已经起来了)。Windows 上 GUI 程序与控制台共享这个标志,
 *     传 true 等于"把游戏窗口也藏了"。
 *  2. **必须有超时**:游戏窗口要是跑到后台/别的显示器,或用户忘了关,试玩请求会一直
 *     等它退出 —— 面板卡在"试玩中",还会留下僵进程。到点杀掉并如实报"等超时"。
 *  3. **必须观察取消信号**(T24 / #32):同上,但触发者是"取消这一轮对话/点面板的取消"
 *     —— 那时要**立刻**杀掉进程并回传 `aborted`,不能等超时上限(用户报的"卡住"就是这个)。
 */
export async function realSpawn(
  launcher: string,
  projectRoot: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    /** 仅测试用:不把项目路径当参数传(拿非 renpy 程序当替身时用)。 */
    omitProjectArg?: boolean
  } = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? PLAYTEST_TIMEOUT_MS
  const args = options.omitProjectArg === true
    ? (process.env.GALFREE_TEST_SRC === undefined ? [] : ['-e', process.env.GALFREE_TEST_SRC])
    : [projectRoot]
  return await spawnWithLog(launcher, args, {
    timeoutMs,
    // windowsHide 必须 false:游戏窗口要出现在用户屏幕上(见 spawn-log.ts 的说明)。
    windowsHide: false,
    timeoutNote: `[GALFree] 试玩等待超时(${Math.round(timeoutMs / 1000)} 秒),已中止游戏进程。`,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/**
 * "被取消"不是失败,是**没发生**:它有自己的错误码,于是工具面/面板/账本三处都能
 * 按码判别,而不是去猜一句文案。抛出它的地方一律**不记账本**。
 *
 * 措辞**不承诺"进程已停"**:这个错误在"还没起进程""跑在中途""进程没响应信号"三种处境下
 * 都会抛,那一刻我们并不知道它停没停(确认过的那一半是 `PlaytestRun.killed`)。
 * 说不知道的事,就是这张票要消灭的那类假事实。
 */
export function abortError(): GalfreeError {
  return new GalfreeError('aborted', '这次试玩被取消了(调用方中止了 CancellationToken):这次运行不再往下走,账本也不记它 —— 被取消不是一个结果。')
}
