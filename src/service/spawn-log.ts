/**
 * "跑一个子进程、把它的输出收回来、到点杀掉" —— 试玩与发布共用的一份实现。
 *
 * 为什么单列成模块:这两处本来各写了一份**逐行同构**的 promise 管道(散在
 * `playtest.ts` 与 `publish.ts` 里),只有 `windowsHide` 与超时话术不同。共用之后
 * "到点必须杀掉"这条纪律只在一处,不会一处修好一处忘掉。
 *
 * 唯一的参数差异(`windowsHide`)是有理由的,写在这里免得下一个人踩:
 *  - **试玩必须 `false`**:Windows 上 GUI 程序与控制台共享这个标志,传 true 等于把
 *    游戏窗口藏起来 —— 用户点"试玩"看起来毫无反应(实测过);
 *  - **构建用 `true`**:那是命令行打包,不该弹窗。
 *
 * **取消也是在这里兑现的(T24 / #32)**:等一个"要人去点关闭"的 GUI 窗口,是整条
 * 流水线上最容易把人绊住的等待。过去这个管道只认"进程自己退出"与"到点杀掉"两条出路,
 * 于是取消一轮对话**不会**让它停 —— 试玩看着就是卡死。
 *
 * 现在它观察调用方给的 `signal`,并且**把"为什么停"当成一等结果回报**:
 * `timedOut`(等满上限)/ `aborted`(被取消)/ `killed`(进程真停了没有)/ `elapsedMs`(等了多久)。
 * 都可断言 —— 一句"超时了"没法核,一个布尔加一个毫秒数可以。
 * 中止时**返回结果而不是抛异常**:调用方才知道"这是取消、不是我这条路径坏了"。
 *
 * `killed` 是**确认**过的那一半:`child.kill()` 之后我们再等一小会儿看它到底退没退
 * (`KILL_GRACE_MS`)。没等到就如实说 `killed: false` —— "我发了信号但它没停"与
 * "它已经不在了"是两句不同的话,不该用同一句糊过去(承诺"进程已杀掉"而窗口还开着,
 * 正是这张票要消灭的那类假事实)。
 */
import { spawn } from 'node:child_process'

export interface SpawnLogResult {
  code: number
  /** 合并 stdout + stderr 的运行日志。 */
  log: string
  /** 等到上限被中止(不是异常,是"该停了")。 */
  timedOut: boolean
  /** 被调用方取消(协作式取消:谁等谁就得自己观察信号)。 */
  aborted: boolean
  /**
   * 进程**确认**退出了(`false` = 发了中止信号但它没在宽限期内退出 —— 可能还开着)。
   * 正常退出那条路上恒为 `true`。
   */
  killed: boolean
  /** 从起到停真实过了多少毫秒 —— 面板与账本据此说得出"跑了多久"。 */
  elapsedMs: number
}

/**
 * 发了中止信号之后,再等多久确认进程真的退了。
 *
 * 为什么要有它:Windows 上 SIGTERM 对 GUI 子树是"尽力而为",游戏窗口有可能还开着。
 * 所以我们不**猜**,而是等一个有界的确认窗口:等到了就说"进程已停",没等到就如实说
 * "信号发了但它没停,窗口可能还开着"。
 */
export const KILL_GRACE_MS = 3_000

/**
 * "它到底停了没有" —— 一个有界的等待。
 *
 * 单列出来是因为**这条逻辑没法在真进程上量**:在 Windows 上 `child.kill()` 一定能让替身进程
 * 退掉(实测,连忽略信号的写法都留不住它),所以"发了信号但它没停"这条真实存在的路
 * (对 GUI 子树,终止是尽力而为)在快带里只能拿**假的判据**验。拆成纯函数之后,
 * 宽限期的两个出口都能直接验:等到了 → true;等不到 → false(T24 的守卫在用)。
 */
export function waitForExit(input: {
  /** 已经退了吗(调用时会再看一次)。 */
  hasExited: () => boolean
  /** 等它退:退的那一 tick 调 `onClosed`。 */
  onClosed: (callback: () => void) => void
  graceMs: number
}): Promise<boolean> {
  if (input.hasExited()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(false)
    }, input.graceMs)
    timer.unref?.()
    input.onClosed(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function spawnWithLog(
  command: string,
  args: string[],
  options: { timeoutMs: number; windowsHide: boolean; timeoutNote: string; signal?: AbortSignal },
): Promise<SpawnLogResult> {
  return await new Promise<SpawnLogResult>((resolvePromise, rejectPromise) => {
    const startedAt = Date.now()
    let log = ''
    let settled = false
    let closed = false
    let closedCode: number | null = null
    // 已经取消过就**一个进程都不起**:起了再杀会留一次闪烁的窗口,而且那一步本身就是浪费。
    if (options.signal?.aborted === true) {
      resolvePromise({ code: -1, log, timedOut: false, aborted: true, killed: false, elapsedMs: 0 })
      return
    }
    const child = spawn(command, args, { windowsHide: options.windowsHide })
    /**
     * 我们**主动**叫停的原因(超时 / 取消);`undefined` = 进程是自己退的。
     *
     * 为什么要单独记:在 Windows 上 `kill()` 是**同步**的 —— `close` 会在同一个宏任务里
     * 紧接着来(实测),于是"谁先落定谁说了算"会把 `timedOut`/`aborted` 覆盖成"正常退出"。
     * 原因由发起方记着,而"退没退"由 `close` 回答 —— 两者分开,才不会互相抹掉。
     */
    let stopReason: { code: number; timedOut: boolean; aborted: boolean } | null = null
    /** 落定一次(幂等);`mustClose` = 别急,先看进程到底退没退。 */
    const settle = (outcome: { code: number; timedOut: boolean; aborted: boolean }, mustClose = false): void => {
      if (settled) return
      if (mustClose && !closed) {
        // 还没退:等一个有界的确认窗口(`waitForExit`)。
        // **注意**:不能拿 `child.exitCode` 当"退没退"的判据 —— Windows 上 `kill()` 会同步把
        // `exitCode` 设上(实测:设成 0),拿它判会直接把超时/取消这两个原因丢掉。
        // 所以这里的判据是 `closed`(close 事件),而"我们主动叫停过"记在 `stopReason` 里,
        // 让 close 那条路带着**这个原因**落定。
        stopReason = outcome
        void waitForExit({
          hasExited: () => closed,
          onClosed: (callback) => { child.once('close', callback) },
          graceMs: KILL_GRACE_MS,
        }).then((stopped) => {
          if (stopped) closedCode = child.exitCode
          settle(outcome)
        })
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        code: outcome.code,
        log,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        killed: closedCode !== null || child.signalCode !== null,
        elapsedMs: Date.now() - startedAt,
      })
    }
    const onAbort = (): void => {
      // 取消也要杀掉:窗口没关掉就是僵进程,比"少跑一次"糟得多。
      try { child.kill() } catch { /* 已经没了 */ }
      settle({ code: -1, timedOut: false, aborted: true }, true)
    }
    const timer = setTimeout(() => {
      // 超时那句话留在日志里:调用方/人看日志时能看出"为什么只有这半截输出"。
      log += `\n${options.timeoutNote}\n`
      try { child.kill() } catch { /* 已经没了 */ }
      settle({ code: -1, timedOut: true, aborted: false }, true)
    }, options.timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      closed = true
      closedCode = code
      if (settled) return
      // 我们主动叫停过 → 那个原因说了算(见 `stopReason`);否则才是"它自己退的"。
      settle(stopReason ?? { code: code ?? 1, timedOut: false, aborted: false })
    })
  })
}
