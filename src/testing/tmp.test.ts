/**
 * 清理夹具的守卫(2026-09-13 · sdk.slow.test.ts 的 `EPERM: unlink renpy.exe` 那一条)。
 *
 * 背景:慢带里"从某场试玩"跑完后,清理夹具会去删临时目录,而 Windows 上刚被
 * `child.kill()` 的 Ren'Py 可能还活着几百毫秒 —— `rm` 于是抛 `EPERM: unlink`。
 * 那**不是**被测代码坏了(断言里那两条都过了,红的是 afterEach),
 * 所以修法不是放宽断言,而是让清理**等得起**、并且**把真删不掉的报出来**。
 *
 * 复现机制(实测,不是照文档想象):在这台机器上,一个**活着的进程**只要 cwd 在
 * 那个目录里,`rm` 就抛 `EPERM`;进程一退,同一个目录立刻删得掉。
 * 于是这一组用一个真子进程占住 cwd 来制造那个窗口 —— 这正是 Ren'Py 那条的形状。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempDirs, makeTempDir } from './tmp.ts'

/** 起一个子进程占住 `dir` 当 cwd,`holdMs` 之后自己退出。 */
function holdCwd(dir: string, holdMs: number): ChildProcess {
  return spawn(process.execPath, ['-e', `setTimeout(()=>{},${holdMs})`], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  })
}

/** 等到这个进程真的退出(不然测试自己就变成"抢跑"的那一方)。 */
function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once('exit', () => resolve())
  })
}

describe('cleanupTempDirs(夹具退避)', () => {
  /** 这一组自己起的进程,收尾时一律收干净(别把僵尸进程漏给后面的用例)。 */
  const spawned: ChildProcess[] = []

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited(child)
    }
    // 兜底:别把这一组自己造的目录漏给别的用例。
    const leftover = await cleanupTempDirs()
    for (const dir of leftover) rmSync(dir, { recursive: true, force: true })
  })

  it('正常路径:目录真被删掉,而且返回空数组', async () => {
    const dir = await makeTempDir('galfree-cleanup-ok-')
    await writeFile(join(dir, 'a.txt'), 'x', 'utf8')
    expect(existsSync(dir)).toBe(true)

    const failed = await cleanupTempDirs()

    expect(failed).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('嵌套子目录也一起删(真项目那种形状)', async () => {
    const dir = await makeTempDir('galfree-cleanup-nested-')
    await mkdir(join(dir, 'game', 'scenes'), { recursive: true })
    await writeFile(join(dir, 'game', 'scenes', 'scene_one.rpy'), 'label scene_one:\n    return\n', 'utf8')
    expect(await readFile(join(dir, 'game', 'scenes', 'scene_one.rpy'), 'utf8')).toContain('scene_one')

    const failed = await cleanupTempDirs()

    expect(failed).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('已经不存在 / 从没建过 → 不报错也不报失败(幂等)', async () => {
    // 连调两次:第二次没有待删的目录。
    await cleanupTempDirs()
    const failed = await cleanupTempDirs()
    expect(failed).toEqual([])
  })

  // 下面两条只能在 Windows 上构造:POSIX 不允许"活进程占着 cwd"阻止删除。
  // 用 `skipIf` 而不是提前 return —— 后者会把"什么都没跑"报成**通过**,那是假绿。
  const onWindows = process.platform === 'win32'

  it.skipIf(!onWindows)('进程占着目录一会儿 → 退避之后仍然删得掉(**不**误报失败)', async () => {
    // 这条盯的是 **Windows** 的形状:进程刚被杀、目录还占着,`rm` 先抛后成。
    const dir = await makeTempDir('galfree-cleanup-lock-')
    await writeFile(join(dir, 'renpy.exe'), 'fake', 'utf8')
    const child = holdCwd(dir, 250)
    spawned.push(child)
    // 等它真的把 cwd 占上(起进程不是瞬时的)。
    await new Promise((resolve) => setTimeout(resolve, 150))
    let blockedWhileHeld = false
    try { rmSync(dir, { recursive: true, force: true }) } catch { blockedWhileHeld = true }
    expect(blockedWhileHeld).toBe(true)

    // 进程会在这期间退出 → 退避重试应当把它删掉,而不是报失败。
    const failed = await cleanupTempDirs()
    await exited(child)

    expect(failed).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it.skipIf(!onWindows)('真删不掉 → **如实报路径**,不静默(临时目录在漏要看得见)', async () => {
    const dir = await makeTempDir('galfree-cleanup-stuck-')
    await writeFile(join(dir, 'renpy.exe'), 'fake', 'utf8')
    // 占住整个退避窗口都不放(5s 远大于约 1.9s 的总退避)。
    const child = holdCwd(dir, 5000)
    spawned.push(child)
    await new Promise((resolve) => setTimeout(resolve, 150))

    const failed = await cleanupTempDirs()

    // 关键:不许假装删干净了。
    expect(failed).toContain(dir)
    expect(existsSync(dir)).toBe(true)
    // 收尾交给 afterEach(它会先杀掉进程再删)。
  }, 30_000)

  it.skipIf(onWindows)('POSIX:进程占着 cwd **不**阻止删除(所以那套退避在那边是空转,不是必需)', async () => {
    // 把平台差异写成断言,而不是让它变成一个"在 CI 上莫名红"的坑。
    const dir = await makeTempDir('galfree-cleanup-posix-')
    await writeFile(join(dir, 'renpy.exe'), 'fake', 'utf8')
    const child = holdCwd(dir, 2000)
    spawned.push(child)
    await new Promise((resolve) => setTimeout(resolve, 150))

    let blocked = false
    try { rmSync(dir, { recursive: true, force: true }) } catch { blocked = true }
    expect(blocked).toBe(false)
    expect(existsSync(dir)).toBe(false)
  })
})
