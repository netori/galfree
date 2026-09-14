/** Shared helpers for seam tests (temp dirs; real fs, real git). */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a temp working directory tracked for cleanup. */
export async function makeTempDir(prefix = 'galfree-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const tempDirs: string[] = []

/**
 * Remove every temp dir created by makeTempDir in this process.
 *
 * Windows 上"刚被杀掉的进程还占着目录"是常态而不是异常:游戏窗口的 `child.kill()`
 * 只杀父进程,真的占着 `renpy.exe` 的子进程可能再活几百毫秒 —— 于是紧跟着的
 * `rm` 撞上 `EPERM: unlink`。这不是被测代码坏了,是**清理夹具跑得比操作系统快**。
 *
 * 实测机制(这台机器上):一个**活着的进程**只要 cwd 落在那个目录里,`rm` 就抛
 * `EPERM`/`EBUSY`;进程一退,同一个目录立刻删得掉。所以这里自己退避重试
 * (Node `rm` 的 `maxRetries` 默认退避太短,对这个场景不够),
 * 并且**记下真删不掉的**:静默吞掉等于把"临时目录在漏"变成看不见的事。
 * 返回删不掉的那些路径(正常情况是空数组),调用方想断言就能断言。
 */
export async function cleanupTempDirs(): Promise<string[]> {
  const dirs = tempDirs.splice(0, tempDirs.length)
  const failures = await Promise.all(dirs.map(async (dir) => {
    // 三档退避:总共约 1.9s,够一个刚被杀的 Ren'Py 放开目录。
    for (const delayMs of [200, 600, 1200]) {
      try {
        await rm(dir, { recursive: true, force: true })
        return null
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    // 最后一次:不再兜底,让调用方看见它是哪一个。
    try {
      await rm(dir, { recursive: true, force: true })
      return null
    } catch {
      return dir
    }
  }))
  return failures.filter((dir): dir is string => dir !== null)
}
