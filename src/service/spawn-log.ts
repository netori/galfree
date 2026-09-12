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
 */
import { spawn } from 'node:child_process'

export interface SpawnLogResult {
  code: number
  /** 合并 stdout + stderr 的运行日志。 */
  log: string
}

export async function spawnWithLog(
  command: string,
  args: string[],
  options: { timeoutMs: number; windowsHide: boolean; timeoutNote: string },
): Promise<SpawnLogResult> {
  return await new Promise<SpawnLogResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: options.windowsHide })
    let log = ''
    let settled = false
    const finish = (result: SpawnLogResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      // 到点杀掉:留下僵进程比"少跑一次"糟得多。
      try { child.kill() } catch { /* 已经没了 */ }
      finish({ code: -1, log: `${log}\n${options.timeoutNote}\n` })
    }, options.timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => finish({ code: code ?? 1, log }))
  })
}
