/**
 * T2 seam tests — 写网关(Host 单一写通道,ADR-0004)。
 * 断言外部可观察行为:磁盘终态、版本漂移失败、原子性、外部修改被观察。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from '../service/project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

describe('写网关(T2)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let root: string

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-data-')
    projectsRoot = await makeTempDir('galfree-projects-')
    service = createProjectService({ dataDir })
    const project = await service.createProject({ projectsRoot, name: 'gw', title: undefined })
    root = project.root
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('写批 = 原子文件集 + 版本戳:成功写入读回一致,版本戳前移', async () => {
    const rel = 'game/script.rpy'
    const before = await service.readProjectFile('gw', rel)
    const result = await service.writeProjectFiles('gw', [
      { path: rel, content: 'label start:\n    "改过的一句"\n    return\n', expectVersion: before.version },
    ], { reason: 'edit', origin: 'workbench' })
    expect(result.versions[rel]).not.toBe(before.version)
    expect(await readFile(join(root, 'game', 'script.rpy'), 'utf8')).toContain('改过的一句')
    const after = await service.readProjectFile('gw', rel)
    expect(after.version).toBe(result.versions[rel])
  })

  it('同文件两个并发写批:第二个依版本戳失败并报告版本漂移,互不覆盖', async () => {
    const rel = 'game/script.rpy'
    const v0 = (await service.readProjectFile('gw', rel)).version
    const [first, second] = await Promise.allSettled([
      // 两个写批都声称基于 v0(模拟 agent 与人同时看到旧版本)。
      service.writeProjectFiles('gw', [{ path: rel, content: 'A\n', expectVersion: v0 }], { reason: 'edit', origin: 'agent' }),
      service.writeProjectFiles('gw', [{ path: rel, content: 'B\n', expectVersion: v0 }], { reason: 'edit', origin: 'workbench' }),
    ])
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled')
    const rejected = [first, second].filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'version-drift' })
    // 磁盘只剩一个写批的结果,不是混合体。
    const disk = await readFile(join(root, 'game', 'script.rpy'), 'utf8')
    expect(disk === 'A\n' || disk === 'B\n').toBe(true)
  })

  it('陈旧版本戳:即便无并发,基于过期版本的写批失败并报 drift', async () => {
    const rel = 'game/script.rpy'
    const stale = (await service.readProjectFile('gw', rel)).version
    await service.writeProjectFiles('gw', [{ path: rel, content: 'fresh\n', expectVersion: stale }], { reason: 'edit', origin: 'agent' })
    await expect(
      service.writeProjectFiles('gw', [{ path: rel, content: 'stale-write\n', expectVersion: stale }], { reason: 'edit', origin: 'agent' }),
    ).rejects.toMatchObject({ code: 'version-drift' })
    expect(await readFile(join(root, 'game', 'script.rpy'), 'utf8')).toBe('fresh\n')
  })

  it('写批失败不留半成品(全有或全无):批内某文件漂移则整批不落盘', async () => {
    const relA = 'game/script.rpy'
    const relB = 'game/options.rpy'
    const vb = (await service.readProjectFile('gw', relB)).version
    // 先单独改掉 A,使批内对 A 的 expectVersion 过期。
    await service.writeProjectFiles('gw', [{ path: relA, content: 'A-new\n', expectVersion: (await service.readProjectFile('gw', relA)).version }], { reason: 'edit', origin: 'agent' })
    const beforeB = await readFile(join(root, 'game', 'options.rpy'), 'utf8')

    await expect(service.writeProjectFiles('gw', [
      { path: relA, content: 'should-not-land\n', expectVersion: 'bogus-stale' },
      { path: relB, content: 'B-should-not-land\n', expectVersion: vb },
    ], { reason: 'edit', origin: 'agent' })).rejects.toMatchObject({ code: 'version-drift' })

    // B 未受影响,证明批内 A 的失败回滚/未提交保护了 B。
    expect(await readFile(join(root, 'game', 'options.rpy'), 'utf8')).toBe(beforeB)
    expect(await readFile(join(root, 'game', 'script.rpy'), 'utf8')).toBe('A-new\n')
  })

  it('网关是唯一插件内写通道:直接外部写不更新网关版本戳 → 网关下次写按外部版本重取', async () => {
    const rel = 'game/script.rpy'
    // 模拟 VSCode 直接改文件(绕过网关)。
    await writeFile(join(root, 'game', 'script.rpy'), 'external-edit\n', 'utf8')
    const observed = await service.readProjectFile('gw', rel)
    expect(observed.content).toBe('external-edit\n')
    // 用外部改动后的新版本戳写,应成功(网关以磁盘为真,不缓存旧内容)。
    await expect(service.writeProjectFiles('gw', [{ path: rel, content: 'after-external\n', expectVersion: observed.version }], { reason: 'edit', origin: 'agent' })).resolves.toBeTruthy()
  })

  it('外部修改被观察并推送事件(工作台无刷新即更新的底层)', async () => {
    const rel = 'game/script.rpy'
    const events: Array<{ path: string; kind: string }> = []
    const stop = service.observeChanges('gw', (change) => {
      events.push({ path: change.path, kind: change.kind })
    })
    // 等 watcher 就绪
    await new Promise((r) => setTimeout(r, 250))
    await writeFile(join(root, 'game', 'script.rpy'), 'external-change\n', 'utf8')
    // 轮询等待事件(避免固定 sleep 竞态)
    await expect.poll(() => events.some((e) => e.path === rel && e.kind === 'external'), { timeout: 4000, interval: 100 }).toBe(true)
    stop()
  })

  it('网关自写不伪装成外部修改:网关写批只产生 internal 事件', async () => {
    const rel = 'game/script.rpy'
    const events: Array<{ path: string; kind: string }> = []
    const stop = service.observeChanges('gw', (change) => events.push({ path: change.path, kind: change.kind }))
    await new Promise((r) => setTimeout(r, 250))
    const v = (await service.readProjectFile('gw', rel)).version
    await service.writeProjectFiles('gw', [{ path: rel, content: 'gateway-write\n', expectVersion: v }], { reason: 'edit', origin: 'agent' })
    await new Promise((r) => setTimeout(r, 400))
    const forRel = events.filter((e) => e.path === rel)
    expect(forRel.length).toBeGreaterThan(0)
    expect(forRel.every((e) => e.kind === 'internal')).toBe(true)
    stop()
  })

  it('无旁路写(插桩断言):模板新建与网关写批之外,项目内不存在被服务改动过的文件', async () => {
    // 新建时记录网关写日志:每个 git 跟踪的文件都必须是网关写的。
    const written = new Set((await service.writeLog('gw')).map((entry) => entry.path))
    const tracked = (await import('node:child_process')).execSync(`git -C "${root}" ls-files`, { encoding: 'utf8' })
      .split('\n').filter((line) => line !== '')
    for (const file of tracked) {
      expect(written.has(file), `旁路写:${file} 未经过网关`).toBe(true)
    }
    // 再来一次网关写,日志同步增长。
    const v = (await service.readProjectFile('gw', 'game/script.rpy')).version
    await service.writeProjectFiles('gw', [{ path: 'game/script.rpy', content: 'logged\n', expectVersion: v }], { reason: 'edit', origin: 'agent' })
    expect((await service.writeLog('gw')).filter((entry) => entry.path === 'game/script.rpy').length).toBeGreaterThanOrEqual(2)
  })
})
