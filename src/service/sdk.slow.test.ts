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
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { renderTemplateFiles, templateKeepFiles } from './template.ts'

const overrideSdk = process.env.GALFREE_SDK_DIR

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
})
