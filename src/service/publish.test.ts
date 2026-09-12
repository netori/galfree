/**
 * T18 seam tests — 本地发布 build_dists(#26)。
 *
 * 契约来源(T18 票面 AC):
 *  1. **全绿项目 → 接缝调用产出发行物,路径入状态**;
 *  2. **前置未满足 → 阻止并逐项列出缺项**(与推导板一致:lint 错 / 素材缺 / 音频悬空);
 *  3. **产物不在项目源树内、不进快照**;
 *  4. (慢带)产物主程序可启动 —— 那条在 `publish.slow.test.ts`。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态 + 推导对象。
 * 真 SDK 太贵也太慢:构建这一步是**注入端口**(快带假实现把假产物写进输出目录),
 * 生产的那个端口才去 spawn 钉版 SDK 的 launcher —— 与试玩的 `spawn` 端口同一个路数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import type { PublishPorts } from './publish.ts'

const exec = promisify(execFile)

/** 一场干净的戏(没有缺对白、没有悬空引用)。 */
const SCENE = [
  'label scene_one:',
  '    "（开场）"',
  '    return',
  '',
].join('\n')

describe('本地发布(T18)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let outDir: string
  let service: ProjectService
  let root: string
  /** 假构建:记录被调用的参数,把假产物写进目标目录。 */
  let calls: Array<{ launcher: string; launcherProject: string; projectRoot: string; destination: string; packages: string[] }>
  let exitCode: number

  const fakePublish = (): PublishPorts => ({
    resolveLauncher: async () => join(sdkDir, 'renpy.exe'),
    run: async (input) => {
      calls.push(input)
      if (exitCode !== 0) return { code: exitCode, log: 'Ren\'Py 构建失败:示例原因\n' }
      await mkdir(input.destination, { recursive: true })
      // 产物名照 Ren'Py 的口径(<directory_name>-<package>.zip),但内容是假的 ——
      // 这一层验的是"接缝把产物如实报出来",真构建在慢带。
      for (const pkg of input.packages) {
        await writeFile(join(input.destination, `galfree-pub-0.1.0-${pkg}.zip`), Buffer.from(`fake-${pkg}-zip-bytes`))
      }
      return { code: 0, log: `Built ${input.packages.join(', ')}\n` }
    },
  })

  /** 造项目 + 一场干净的戏(挂在 start 后面,保证可达)。 */
  const makeProject = async (name: string): Promise<void> => {
    await service.createProject({ projectsRoot, name, title: '发布' })
    root = (await service.getActiveProject())!.root
    await service.writeProjectFiles(name, [{ path: 'game/scenes/scene_one.rpy', content: SCENE, expectVersion: 'absent' }], { origin: 'agent', reason: 'scenario' })
    const snap = await service.readProjectFile(name, 'game/script.rpy')
    await service.writeProjectFiles(name, [{
      path: 'game/script.rpy',
      content: snap.content.replace(/^label start:\n/m, 'label start:\n    jump scene_one\n'),
      expectVersion: snap.version,
    }], { origin: 'agent', reason: 'scenario' })
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t18-data-')
    projectsRoot = await makeTempDir('galfree-t18-projects-')
    outDir = await makeTempDir('galfree-t18-out-')
    calls = []
    exitCode = 0
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      publish: { ports: fakePublish(), destination: () => join(outDir, 'dist') },
    })
    await makeProject('pub')
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ── AC2:前置未满足 → 阻止并逐项列出缺项(与推导板一致)────────────────

  it('AC2 全绿项目:就绪(没有阻塞项)', async () => {
    const readiness = await service.publishReadiness('pub')
    expect(readiness.ready).toBe(true)
    expect(readiness.blockers).toEqual([])
  })

  it('AC2 素材缺 → 阻止,缺项清单与**推导板**上的待填槽一致', async () => {
    // 剧本引用一个还没有图的槽 → 板上"待填"。
    const snap = await service.readProjectFile('pub', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('pub', [{
      path: 'game/scenes/scene_one.rpy',
      content: snap.content.replace('    return', '    scene bg rooftop\n    return'),
      expectVersion: snap.version,
    }], { origin: 'agent', reason: 'edit' })

    const progress = await service.progress('pub')
    const missing = progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot)
    expect(missing).toEqual(['bg rooftop'])

    const readiness = await service.publishReadiness('pub')
    expect(readiness.ready).toBe(false)
    const blocker = readiness.blockers.find((entry) => entry.code === 'missing-slots')!
    expect(blocker.count).toBe(1)
    expect(blocker.detail).toContain('bg rooftop')

    // 真的**阻止**了:构建端口一次都没被调用。
    const report = await service.publish('pub')
    expect(report.ok).toBe(false)
    expect(report.run).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('AC2 lint 未过 / 音频引用悬空 都算阻塞项(与板上同一份判断)', async () => {
    // 悬空跳转 = lint error(板上就是 lint 错)。
    const script = await service.readProjectFile('pub', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('pub', [{
      path: 'game/scenes/scene_one.rpy',
      content: script.content.replace('    return', '    jump nowhere\n    return'),
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'edit' })
    // 引用了不存在的音频 = missing-audio(error)。
    const afterJump = await service.readProjectFile('pub', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('pub', [{
      path: 'game/scenes/scene_one.rpy',
      content: afterJump.content.replace('    jump nowhere', '    play music "audio/none.ogg"\n    jump nowhere'),
      expectVersion: afterJump.version,
    }], { origin: 'agent', reason: 'edit' })

    const progress = await service.progress('pub')
    expect(progress.lint.ok).toBe(false)

    const readiness = await service.publishReadiness('pub')
    expect(readiness.ready).toBe(false)
    const codes = readiness.blockers.map((entry) => entry.code)
    expect(codes).toContain('lint-errors')
    expect(codes).toContain('missing-audio')
    // 阻塞项里的计数与板上一致(不是另算一遍)。
    expect(readiness.blockers.find((entry) => entry.code === 'lint-errors')!.count).toBe(progress.lint.errors)
    expect(readiness.blockers.find((entry) => entry.code === 'missing-audio')!.detail).toContain('audio/none.ogg')
  })

  it('项目没声明 build.name → 阻止(实测:会打出 `-pc/` 与 `.exe` 这种空名字的包)', async () => {
    // 模拟一个"老项目":options.rpy 里没有 build.name(模板现在会给新项目带上)。
    const current = await service.readProjectFile('pub', 'game/options.rpy')
    await service.writeProjectFiles('pub', [{
      path: 'game/options.rpy',
      content: current.content.replace(/^define build\.name = .*\n/m, ''),
      expectVersion: current.version,
    }], { origin: 'workbench', reason: 'edit' })

    const readiness = await service.publishReadiness('pub')
    expect(readiness.ready).toBe(false)
    const blocker = readiness.blockers.find((entry) => entry.code === 'build-identity-missing')!
    expect(blocker.label).toContain('build.name')
    expect(blocker.detail).toContain('define build.name')

    const report = await service.publish('pub')
    expect(report.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('界面图还没生成 → 阻止(实测:发行版里没有那个生成器,发出去界面全是缺图)', async () => {
    // 模板从 SDK 拷了 `gui/*.png` 的一部分,但真正的界面图(含 textbox.png)是
    // Ren'Py **首次运行时**生成进项目的 —— 判据就是那张哨兵。
    const sentinel = await service.readProjectFile('pub', 'game/gui/textbox.png')
    expect(sentinel.missing).toBe(false)
    await service.writeProjectFiles('pub', [{ path: 'game/gui/textbox.png', content: null, expectVersion: sentinel.version }], { origin: 'workbench', reason: 'edit' })

    const readiness = await service.publishReadiness('pub')
    const blocker = readiness.blockers.find((entry) => entry.code === 'gui-images-missing')!
    expect(blocker).toBeDefined()
    expect(blocker.label).toContain('试玩')

    const report = await service.publish('pub')
    expect(report.ok).toBe(false)
    expect(calls).toHaveLength(0)

    // 补回来(现实中就是"跑一次试玩")→ 就绪。
    await service.writeProjectFiles('pub', [{ path: 'game/gui/textbox.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), expectVersion: 'absent' }], { origin: 'workbench', reason: 'edit' })
    expect((await service.publishReadiness('pub')).ready).toBe(true)
  })

  // ── AC1:全绿项目 → 产出发行物,路径入状态 ─────────────────────────────

  it('AC1 就绪 → 构建 → 产物落输出目录,路径与状态进推导板', async () => {
    const report = await service.publish('pub', { packages: ['pc'] })
    expect(report.ok).toBe(true)
    expect(report.run).toBeDefined()

    // 构建端口收到的三件事:钉版启动器、launcher 项目、目标项目、输出目录、包名。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.launcher).toBe(join(sdkDir, 'renpy.exe'))
    expect(calls[0]!.launcherProject).toBe(join(sdkDir, 'launcher'))
    expect(calls[0]!.projectRoot).toBe(root)
    expect(calls[0]!.packages).toEqual(['pc'])

    // 产物**真的在磁盘上**,而且就在配置的输出目录里(不在项目源树内)。
    const run = report.run!
    expect(run.artifacts).toHaveLength(1)
    const artifact = run.artifacts[0]!
    expect(artifact.name).toBe('galfree-pub-0.1.0-pc.zip')
    expect(artifact.path.startsWith(outDir)).toBe(true)
    expect(artifact.path.startsWith(root)).toBe(false)
    expect(artifact.bytes).toBe(Buffer.from('fake-pc-zip-bytes').byteLength)
    expect((await readFile(artifact.path)).byteLength).toBe(artifact.bytes)

    // 状态上板:推导视图说得出"上一次发布是什么时候、产物在哪、还新不新"。
    const progress = await service.progress('pub')
    expect(progress.publish).not.toBeNull()
    expect(progress.publish!.ok).toBe(true)
    expect(progress.publish!.stale).toBe(false)
    expect(progress.publish!.artifacts.map((entry) => entry.name)).toEqual(['galfree-pub-0.1.0-pc.zip'])
    expect(progress.publish!.destination).toBe(join(outDir, 'dist'))
  })

  it('AC1 发布事实经网关落账本(可回读,只有路径与状态 —— 不是产物本身)', async () => {
    await service.publish('pub')
    const ledger = JSON.parse(await readFile(join(root, '.studio', 'publish.json'), 'utf8')) as {
      schemaVersion: number
      last: { ok: boolean; artifacts: Array<{ name: string; path: string }> }
      history: unknown[]
    }
    expect(ledger.schemaVersion).toBe(1)
    expect(ledger.last.ok).toBe(true)
    expect(ledger.last.artifacts[0]!.name).toBe('galfree-pub-0.1.0-pc.zip')
    expect((await service.writeLog('pub')).some((entry) => entry.path === '.studio/publish.json')).toBe(true)
  })

  // ── AC4:产物不在项目源树内、不进快照 ─────────────────────────────────

  it('AC4 产物在项目源树之外,项目 git 里一个字节都没多', async () => {
    await service.publish('pub')
    const status = await exec('git', ['status', '--porcelain'], { cwd: root })
    expect(status.stdout.trim()).toBe('')
    // 项目目录里没有任何 dists/ 之类的构建产物(源树干净)。
    const top = await readdir(root)
    expect(top.filter((name) => /dist|build/i.test(name) && name !== '.gitignore')).toEqual([])
    // 账本是**故意**进源树的(事实记录,与 playtest.json 同性质):它只存路径与状态,
    // 不是产物本身。别把"产物不进源树"读成"什么都不许写进项目"。
    expect((await service.writeLog('pub')).some((entry) => entry.path === '.studio/publish.json')).toBe(true)
  })

  it('AC4 输出目录在**另一个盘符**上也照样合法(跨盘符不是"在源树里")', async () => {
    // Windows 上 `path.relative('C:\\proj', 'D:\\out')` 返回的是绝对路径 ——
    // 只看"开不开头是 .."会把合法的跨盘输出目录误判成"在源树里"(审查抓到的真坑)。
    const drive = process.platform === 'win32' && /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : null
    const other = drive === null ? null : (drive.toLowerCase() === 'c:' ? 'D:' : 'C:')
    if (other === null) return // 非 Windows / 拿不到盘符:这条不适用(不假装测过)
    const report = await service.publish('pub', { outputDir: `${other}\\galfree-pub-cross-drive` })
    // 合法 = 不会被 destination-in-project 拦下(构建本身用假端口,照常跑通)。
    expect(report.blockers.map((entry) => entry.code)).not.toContain('destination-in-project')
    expect(report.ok).toBe(true)
  })

  it('AC4 输出目录想在项目源树里 → 如实拒绝(不许污染源树)', async () => {
    const report = await service.publish('pub', { outputDir: join(root, 'dists') })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((entry) => entry.code)).toContain('destination-in-project')
    expect(calls).toHaveLength(0)
  })

  // ── 失败与陈旧:如实呈现 ─────────────────────────────────────────────

  it('构建失败 → ok=false 且带上构建日志原话(不吞成"失败了")', async () => {
    exitCode = 1
    const report = await service.publish('pub')
    expect(report.ok).toBe(false)
    expect(report.run?.exitCode).toBe(1)
    expect(report.run?.logTail).toContain('构建失败')

    const progress = await service.progress('pub')
    expect(progress.publish!.ok).toBe(false)
    expect(progress.publish!.logTail).toContain('构建失败')
    expect(progress.publish!.artifacts).toEqual([])
  })

  it('发布之后剧本又改了 → 板上标注产物已陈旧(stale),不假装它还代表当前这一版', async () => {
    await service.publish('pub')
    expect((await service.progress('pub')).publish!.stale).toBe(false)

    const snap = await service.readProjectFile('pub', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('pub', [{
      path: 'game/scenes/scene_one.rpy',
      content: snap.content.replace('（开场）', '（改了一句）'),
      expectVersion: snap.version,
    }], { origin: 'workbench', reason: 'edit' })

    expect((await service.progress('pub')).publish!.stale).toBe(true)
  })

  it('没装配发布端口 → 如实报不可用(不是假装发布成功)', async () => {
    const bare = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    try {
      await bare.createProject({ projectsRoot, name: 'nopublish', title: '没端口' })
      const readiness = await bare.publishReadiness('nopublish')
      expect(readiness.blockers.map((entry) => entry.code)).toContain('publish-unavailable')
      const report = await bare.publish('nopublish')
      expect(report.ok).toBe(false)
    } finally {
      await bare.dispose()
    }
  })
})
