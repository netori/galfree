/**
 * T3 seam tests — 快照:写网关每批提交后自动 git commit(ADR-0011)。
 * 真 git + 临时仓库;断言外部可观察的历史/diff/回滚行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectService, type ProjectService } from '../service/project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

const exec = promisify(execFile)
async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args])
  return stdout
}

describe('快照(T3)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let root: string

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-data-')
    projectsRoot = await makeTempDir('galfree-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    const project = await service.createProject({ projectsRoot, name: 'snap', title: undefined })
    root = project.root
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('每次写批后 HEAD 前进,commit message 含原因上下文(发起侧/环节/场景)', async () => {
    const before = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const v = (await service.readProjectFile('snap', 'game/script.rpy')).version
    await service.writeProjectFiles('snap', [{ path: 'game/script.rpy', content: 'x\n', expectVersion: v }], {
      reason: 'scene-script', origin: 'agent', scene: 'ch01',
    })
    const after = (await git(root, ['rev-parse', 'HEAD'])).trim()
    expect(after).not.toBe(before)
    const subject = (await git(root, ['log', '-1', '--format=%s'])).trim()
    expect(subject).toContain('agent')
    expect(subject).toContain('scene-script')
    expect(subject).toContain('ch01')
    // 作者标识 GALFree(ADR-0011 划界:不冒充用户)。
    expect((await git(root, ['log', '-1', '--format=%an <%ae>'])).trim()).toBe('GALFree <galfree@dsh.local>')
    // 工作区干净:快照覆盖批内容。
    expect((await git(root, ['status', '--porcelain'])).trim()).toBe('')
  })

  it('一次写批 = 一个 commit:批内多文件合并进同一个快照', async () => {
    const headBefore = (await git(root, ['rev-list', '--count', 'HEAD'])).trim()
    const vs = (await service.readProjectFile('snap', 'game/script.rpy')).version
    const vo = (await service.readProjectFile('snap', 'game/options.rpy')).version
    await service.writeProjectFiles('snap', [
      { path: 'game/script.rpy', content: 'multi-1\n', expectVersion: vs },
      { path: 'game/options.rpy', content: 'multi-2\n', expectVersion: vo },
    ], { reason: 'edit', origin: 'workbench' })
    const headAfter = (await git(root, ['rev-list', '--count', 'HEAD'])).trim()
    expect(Number(headAfter) - Number(headBefore)).toBe(1)
  })

  it('历史查询与单文件 diff:接缝返回可读历史,含该文件的改动', async () => {
    const rel = 'game/script.rpy'
    const v = (await service.readProjectFile('snap', rel)).version
    await service.writeProjectFiles('snap', [{ path: rel, content: 'first-write\n', expectVersion: v }], { reason: 'edit', origin: 'workbench' })
    const v2 = (await service.readProjectFile('snap', rel)).version
    await service.writeProjectFiles('snap', [{ path: rel, content: 'second-write\n', expectVersion: v2 }], { reason: 'edit', origin: 'agent' })

    const history = await service.snapshotHistory('snap', rel)
    expect(history.length).toBeGreaterThanOrEqual(2)
    // 最新条目对应当前磁盘内容。
    const first = history[0]!
    expect(first).toMatchObject({ path: rel })
    expect(first.subject.length).toBeGreaterThan(0)
    expect((await git(root, ['rev-parse', 'HEAD'])).trim().startsWith(first.commit)).toBe(true)

    const diff = await service.snapshotDiff('snap', rel, history[1]!.commit, first.commit)
    expect(diff).toContain('second-write')
  })

  it('回滚把目标文件恢复到历史版本,且回滚本身产生新快照(不改写历史)', async () => {
    const rel = 'game/script.rpy'
    const v0 = (await service.readProjectFile('snap', rel)).version
    const original = (await service.readProjectFile('snap', rel)).content
    await service.writeProjectFiles('snap', [{ path: rel, content: 'bad-llm-write\n', expectVersion: v0 }], { reason: 'scene-script', origin: 'agent' })
    const badVersion = (await service.readProjectFile('snap', rel)).version
    const countBefore = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim())

    await service.snapshotRollback('snap', rel, badVersion === v0 ? '' : (await git(root, ['rev-parse', 'HEAD~1'])).trim())

    // 磁盘恢复原内容。
    expect(await readFile(join(root, rel), 'utf8')).toBe(original)
    // 历史没有缩短:多了一个回滚快照。
    const countAfter = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim())
    expect(countAfter).toBe(countBefore + 1)
    // 回滚提交也是 GALFree 作者,message 标明回滚。
    const subject = (await git(root, ['log', '-1', '--format=%s'])).trim()
    expect(subject.toLowerCase()).toContain('rollback')
  })

  it('用户手动 commit 不被改写/删除;插件永不 push(负例:无 remote、手动提交仍在)', async () => {
    // 模拟人手动提交一个新文件。
    await writeFile(join(root, 'notes.txt'), 'human note\n', 'utf8')
    await git(root, ['add', 'notes.txt'])
    await git(root, ['-c', 'user.name=Human', '-c', 'user.email=h@x', 'commit', '-m', 'human commit'])
    const humanHead = (await git(root, ['rev-parse', 'HEAD'])).trim()

    // 网关写批 → 追加快照,不动用户提交。
    const v = (await service.readProjectFile('snap', 'game/script.rpy')).version
    await service.writeProjectFiles('snap', [{ path: 'game/script.rpy', content: 'after human\n', expectVersion: v }], { reason: 'edit', origin: 'agent' })

    const log = await git(root, ['log', '--format=%H %an'])
    expect(log).toContain(`${humanHead} Human`)
    // 无 remote:物理上不可能 push。
    expect((await git(root, ['remote'])).trim()).toBe('')
  })

  it('外部编辑器的改动被观察 → 下一次网关写批的快照一并纳入(观察→落账不丢失)', async () => {
    await writeFile(join(root, 'game', 'script.rpy'), 'external-direct\n', 'utf8')
    const observed = await service.readProjectFile('snap', 'game/script.rpy')
    expect(observed.content).toBe('external-direct\n')
    // 经网关再写另一个文件 → 快照提交整批磁盘状态(含外部改动)。
    const vo = (await service.readProjectFile('snap', 'game/options.rpy')).version
    await service.writeProjectFiles('snap', [{ path: 'game/options.rpy', content: 'touched\n', expectVersion: vo }], { reason: 'edit', origin: 'workbench' })
    const committed = (await git(root, ['show', 'HEAD:game/script.rpy'])).trim()
    expect(committed).toBe('external-direct')
  })
})
