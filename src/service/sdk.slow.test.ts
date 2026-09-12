/**
 * 慢集成带(T5/T7):真钉版 Ren'Py SDK 的下载/解析/lint 冒烟。
 * 单一标记文件(*.slow.test.ts),默认由 vitest.config.ts 排除;
 * 显式 `npm run test:slow` 运行(需网络,发版前必跑)。
 *
 * 为免每次跑都拉 155MB,允许用 GALFREE_SDK_DIR 指向既有 SDK 跳过下载。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SdkProvisioner, sdkIsReady } from './sdk-provision.ts'
import { httpsDownloader, extractZip } from './sdk-real.ts'
import { platformLauncherName, findLauncher } from './hash.ts'
import { SdkValidator } from './validation/sdk-validator.ts'
import { createCompositeValidator } from './validation/composite-validator.ts'
import { createProjectService } from './project-service.ts'
import { realSpawn } from './playtest.ts'
import { runGit } from './git.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { renderTemplateFiles, templateKeepFiles } from './template.ts'

const overrideSdk = process.env.GALFREE_SDK_DIR

/** 解析出一个可用 SDK 目录(优先 GALFREE_SDK_DIR,否则真下载)。 */
async function ensureSdk(prefix: string): Promise<string> {
  let sdkDir = overrideSdk ?? ''
  if (sdkDir === '' || !(await findLauncher(sdkDir))) {
    const base = await makeTempDir(prefix)
    sdkDir = join(base, 'renpy-pinned')
    const provisioner = new SdkProvisioner(sdkDir, { download: httpsDownloader, extract: extractZip, launcherName: platformLauncherName() })
    const status = await provisioner.ensure()
    expect(status.state).toBe('ready')
  }
  expect(await findLauncher(sdkDir)).not.toBeNull()
  return sdkDir
}

describe('真钉版 SDK 慢带(T5)', () => {
  it('SDK 对模板 lint = clean,结果与假适配器结构同型', async () => {
    let sdkDir = overrideSdk ?? ''
    if (overrideSdk === undefined || !existsSync(join(overrideSdk, platformLauncherName()))) {
      const base = await makeTempDir('galfree-slow-sdk-')
      sdkDir = join(base, 'renpy-pinned')
      const provisioner = new SdkProvisioner(sdkDir, { download: httpsDownloader, extract: extractZip, launcherName: platformLauncherName() })
      const status = await provisioner.ensure()
      expect(status.state).toBe('ready')
    }
    expect(await sdkIsReady(sdkDir, platformLauncherName()) || (await findLauncher(sdkDir)) !== null).toBe(true)
    const launcher = await findLauncher(sdkDir)
    expect(launcher).not.toBeNull()

    // 造一个空模板项目。
    const projectRoot = await makeTempDir('galfree-slow-proj-')
    for (const file of [...renderTemplateFiles({ name: 'slowtest', title: 'slowtest', id: 'slowtest' }), ...templateKeepFiles()]) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    // Ren'Py lint 需要 options.rpy 里的 config;模板已含。
    const validator = new SdkValidator({ resolveLauncher: async () => launcher })
    const report = await validator.validate(projectRoot, { sdkDir, state: 'ready', progress: { phase: 'ready', fraction: 1 }, detectedVersion: '8.5.3' })
    expect(report.validator).toBe('sdk')
    expect(typeof report.ok).toBe('boolean')
    // 空模板真 SDK 判定干净(无 error)。
    const errors = report.problems.filter((problem) => problem.severity === 'error')
    expect(errors).toEqual([])

    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)

  it('引擎可加载项目(真 SDK compile 冒烟;GUI 启动由人经工作台点「启动试玩」)', async () => {
    // 需要一个可用 SDK:优先 GALFREE_SDK_DIR,否则先跑下载(慢)。
    let sdkDir = overrideSdk ?? ''
    if (sdkDir === '' || !(await findLauncher(sdkDir))) {
      const base = await makeTempDir('galfree-slow-sdk2-')
      sdkDir = join(base, 'renpy-pinned')
      const provisioner = new SdkProvisioner(sdkDir, { download: httpsDownloader, extract: extractZip, launcherName: platformLauncherName() })
      await provisioner.ensure()
    }
    const launcher = await findLauncher(sdkDir)
    expect(launcher).not.toBeNull()
    const projectRoot = await makeTempDir('galfree-slow-proj2-')
    for (const file of [...renderTemplateFiles({ name: 'smoke', title: 'smoke', id: 'smoke' }), ...templateKeepFiles()]) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = await promisify(execFile)(launcher!, [projectRoot, 'compile'], { maxBuffer: 16 * 1024 * 1024 }).catch((error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
    const code = typeof run === 'object' && 'code' in run && typeof run.code === 'number' ? run.code : 0
    // compile 成功 = 引擎能加载模板项目(试玩启动的前置事实)。
    expect(code).toBe(0)
    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)

  /**
   * 真启动回归:模板里写错一个变量名(config.title)、或把布尔写成小写 true,
   * `lint` 与 `compile` **都会返回退出码 0** —— 实测过。这类错误只有把游戏真跑起来
   * 才暴露(traceback.txt + 退出码)。
   *
   * 教训来源:环节零交付的模板就带着这两个错,用户新建的第一个项目一启动就崩,
   * 而慢带当时还没跑过一次。所以这条断言必须存在:它是"模板真能跑"的唯一证据。
   */
  it('模板真能启动(捕获 lint/compile 都漏掉的启动期错误)', async () => {
    let sdkDir = overrideSdk ?? ''
    if (sdkDir === '' || !(await findLauncher(sdkDir))) {
      const base = await makeTempDir('galfree-slow-sdk3-')
      sdkDir = join(base, 'renpy-pinned')
      const provisioner = new SdkProvisioner(sdkDir, { download: httpsDownloader, extract: extractZip, launcherName: platformLauncherName() })
      await provisioner.ensure()
    }
    const launcher = await findLauncher(sdkDir)
    expect(launcher).not.toBeNull()

    const projectRoot = await makeTempDir('galfree-slow-proj3-')
    // 特意用中文标题 + 长短 slug,顺带验证模板的转义与 save_directory 取值。
    const template = [
      ...renderTemplateFiles({ name: 'slow-boot', title: '慢带启动冒烟', id: 'slow-boot' }),
      ...templateKeepFiles(),
    ]
    for (const file of template) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }

    const { spawn } = await import('node:child_process')
    const child = spawn(launcher!, [projectRoot], {
      cwd: projectRoot,
      // 关掉音频/更新检查,尽量安静地起一个窗口。
      env: { ...process.env, RENPY_DISABLE_SOUND: '1', RENPY_LESS_UPDATES: '1' },
      stdio: 'ignore',
      windowsHide: false,
    })
    // 给它足够时间跑到"初始化完成并进入主菜单"——启动期异常会在这之前写 traceback.txt。
    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 25_000)
      child.once('exit', () => { clearTimeout(timer); resolve(false) })
    })
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const tracebackPath = join(projectRoot, 'traceback.txt')
    const crashed = existsSync(tracebackPath)
    const traceback = crashed ? await readFile(tracebackPath, 'utf8') : ''
    if (crashed) {
      // 把原因原样带到失败信息里,省得下次又要手动复现。
      expect.fail(`模板项目启动即崩:\n${traceback.split('\n').slice(0, 12).join('\n')}`)
    }
    // 启动期没退出 = 真的进了主菜单(不是"崩得很快")。
    expect(started).toBe(true)

    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)

  /**
   * T10 的闭环,用**真东西**验一遍:生成一场(经网关 + 写批 + 快照)→ 真 SDK 的 lint
   * 判定 → 项目真能启动。
   *
   * 为什么必须是这条:生成的剧本落在 `game/scenes/`(子目录),而"假验证器/分支图是否
   * 看得见子目录"和"真 Ren'Py 是否加载子目录"是**两件独立的事**。只有真 SDK 能同时回答
   * 这两个问题 —— 而生成器产出的项目必须真能跑起来,这是本项目的验收方式。
   */
  it('逐场生成闭环:生成 → 真 lint 通过 → 项目真能启动', async () => {
    const sdkDir = await ensureSdk('galfree-slow-sdk4-')
    const launcher = await findLauncher(sdkDir)
    const pinnedDir = join(sdkDir, '')

    const projectRoot = await makeTempDir('galfree-slow-generate-')
    for (const file of [...renderTemplateFiles({ name: 'gen', title: '生成闭环', id: 'gen' }), ...templateKeepFiles()]) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    await (await import('./git.ts')).runGit(projectRoot, ['init', '--initial-branch', 'main'])
    await (await import('./git.ts')).runGit(projectRoot, ['add', '--all'])
    await (await import('./git.ts')).runGit(projectRoot, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', 'scaffold'])

    // 用生产装配:合成验证器(假 lint 恒跑 + 真 SDK lint 就绪时叠加)。
    const dataDir = await makeTempDir('galfree-slow-generate-data-')
    const service = createProjectService({
      dataDir,
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
    })
    try {
      await service.createProject({ projectsRoot: projectRoot, name: 'genproj', title: '生成闭环' })

      const generated = await service.generateScene('genproj', {
        label: 'scene_one',
        source: [
          'label scene_one:',
          '    scene bg school',
          '    "第一场:生成出来的戏。"',
          '    return',
          '',
        ].join('\n'),
        outline: undefined,
      })

      // 落盘在生成目录,且这一个写批就产生了一个快照。
      expect(generated.path).toBe('game/scenes/scene_one.rpy')
      expect(await service.snapshotHistory('genproj', 'game/scenes/scene_one.rpy')).toHaveLength(1)

      // 真 SDK 的 lint:validator 应该是 sdk(合成端口在 SDK 就绪时升级),且判定干净。
      expect(generated.validation.validator).toBe('sdk')
      expect(generated.validation.problems.filter((problem) => problem.severity === 'error')).toEqual([])

      // 板也看得见子目录里的场景(假验证器/分支图与真 lint 同口径)。
      expect(generated.progress.scenes.map((scene) => scene.label)).toEqual(expect.arrayContaining(['scene_one']))
      expect(generated.progress.slots.map((slot) => slot.slot)).toContain('bg school')
    } finally {
      await service.dispose()
    }

    // 生成之后项目真能启动(引擎加载 game/scenes/ 下新写的文件)。
    const { spawn } = await import('node:child_process')
    const child = spawn(launcher!, [projectRoot], {
      cwd: projectRoot,
      env: { ...process.env, RENPY_DISABLE_SOUND: '1', RENPY_LESS_UPDATES: '1' },
      stdio: 'ignore',
      windowsHide: false,
    })
    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 25_000)
      child.once('exit', () => { clearTimeout(timer); resolve(false) })
    })
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const tracebackPath = join(projectRoot, 'traceback.txt')
    if (existsSync(tracebackPath)) {
      const traceback = await readFile(tracebackPath, 'utf8')
      expect.fail(`生成之后项目启动即崩:\n${traceback.split('\n').slice(0, 12).join('\n')}`)
    }
    expect(started).toBe(true)
    void pinnedDir

    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)

  /**
   * T13 的 AC:"从此场试玩"启动落在该场景。
   *
   * 做法:在**副本**里把 `start` 覆写为 `jump <目标场>`,再真启动。信号是可红的 ——
   * 目标场不存在时会在启动时崩出 traceback,所以"窗口活着"不是空断言,而是"那一场真的跑起来了"。
   * 用户项目一个字节都不动(副本用完即删)。
   */
  it('从某场试玩:真 SDK 下入口真的落在该场景,且用户项目不被污染', async () => {
    const sdkDir = await ensureSdk('galfree-slow-sdk5-')
    const launcher = await findLauncher(sdkDir)
    const projectRoot = await makeTempDir('galfree-slow-from-')
    for (const file of [...renderTemplateFiles({ name: 'flow', title: '整线', id: 'flow' }), ...templateKeepFiles()]) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    await runGit(projectRoot, ['init', '--initial-branch', 'main'])
    await runGit(projectRoot, ['add', '--all'])
    await runGit(projectRoot, ['commit', '--no-gpg-sign', '--author', 'GALFree <galfree@dsh.local>', '-m', 'scaffold'])

    const dataDir = await makeTempDir('galfree-slow-from-data-')
    const service = createProjectService({
      dataDir,
      playtest: { resolveLauncher: async () => launcher, spawn: realSpawn },
    })
    try {
      await service.createProject({ projectsRoot: projectRoot, name: 'fromscene', title: '整线' })
      const snap = await service.readProjectFile('fromscene', 'game/script.rpy')
      await service.writeProjectFiles('fromscene', [{
        path: 'game/script.rpy',
        content: [
          'label start:',
          '    "开场。"',
          '    jump scene_two',
          '',
          'label scene_two:',
          '    "第二场。"',
          '    return',
          '',
        ].join('\n'),
        expectVersion: snap.version,
      }], { origin: 'agent', reason: 'scenario' })

      // 真启动。人会一直玩下去,所以给 20 秒 watchdog;被 watchdog 杀掉 = 窗口活着(没在启动期崩)。
      const launched = service.playtestStart('fromscene', 'scene_two')
      const finished = await Promise.race([
        launched,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
      ])
      if (finished !== 'timeout') {
        // 它自己退出了:那就必须是干净的(目标场不存在会在这里留下 traceback)。
        expect(finished.traceback).toBeNull()
        expect(finished.from).toBe('scene_two')
      }
      // 无论哪种收尾:用户项目里不许出现试玩副本的入口文件,也不该有 traceback。
      expect(existsSync(join(projectRoot, 'game', 'zz_galfree_warp.rpy'))).toBe(false)
      expect(existsSync(join(projectRoot, 'traceback.txt'))).toBe(false)
    } finally {
      await service.dispose()
    }

    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)
})
