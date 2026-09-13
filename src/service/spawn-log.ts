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
 * `timedOut`(等满上限)/ `aborted`(被取消)/ `elapsedMs`(到底等了多久)。
 * 三者都可断言 —— 一句"超时了"没法核,一个布尔加一个毫秒数可以。
 * 中止时**返回结果而不是抛异常**:调用方才知道"这是取消、不是我这条路径坏了"。
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
  /** 从起到停真实过了多少毫秒 —— 面板与账本据此说得出"跑了多久"。 */
  elapsedMs: number
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
    // 已经取消过就**一个进程都不起**:起了再杀会留一次闪烁的窗口,而且那一步本身就是浪费。
    if (options.signal?.aborted === true) {
      resolvePromise({ code: -1, log, timedOut: false, aborted: true, elapsedMs: 0 })
      return
    }
    const child = spawn(command, args, { windowsHide: options.windowsHide })
    const finish = (outcome: { code: number; timedOut: boolean; aborted: boolean }, stop: { kill: boolean } = { kill: false }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // 到点杀掉:留下僵进程比"少跑一次"糟得多(取消同理:窗口没关掉就是僵进程)。
      if (stop.kill) {
        try { child.kill() } catch { /* 已经没了 */ }
      }
      resolvePromise({ code: outcome.code, log, timedOut: outcome.timedOut, aborted: outcome.aborted, elapsedMs: Date.now() - startedAt })
    }
    const onAbort = (): void => finish({ code: -1, timedOut: false, aborted: true }, { kill: true })
    const timer = setTimeout(() => {
      // 超时那句话留在日志里:调用方/人看日志时能看出"为什么只有这半截输出"。
      log += `\n${options.timeoutNote}\n`
      finish({ code: -1, timedOut: true, aborted: false }, { kill: true })
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
      // 取消/超时可能先到(`finish` 已经把结果发出去了),那就以先到的那个为准 ——
      // 但日志照旧留在这一份结果里(杀进程前打的那几行往往就是病因)。
      if (settled) return
      finish({ code: code ?? 1, timedOut: false, aborted: false })
    })
  })
}
