/**
 * T30(#38)慢带守卫 —— 窗口图标那条"**启动即崩**"的路,只有真引擎能验。
 *
 * 为什么必须有这一条:`config.window_icon` 指向的文件不存在时,引擎**不兜底**
 * (`set_icon` 只 `except renpy.webloader.DownloadNeeded`;`renpy.loader.load` 抛
 * `FileNotFoundError`,`renpy/display/core.py:1044-1071`)→ 启动期直接崩。
 * 快带能验"模板里的文件在、config 指向它",但**验不了"引擎真的能带着它起来"**。
 *
 * 这条跑的是一份**按模板建出来的真项目**:lint 干净 → 真启动一次(假显示驱动 + 一进
 * 主菜单就退出)→ 退出码 0 且没有 traceback。图标缺了/坏了,这条会红在"启动"上。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findLauncher, platformLauncherName } from './hash.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { renderTemplateFiles, templateKeepFiles, TEMPLATE_WINDOW_ICON } from './template.ts'

const overrideSdk = process.env.GALFREE_SDK_DIR

describe('窗口图标与真引擎(T30,慢带)', () => {
  it('按模板建的项目(含默认图标)过真 lint,而且**真起得来**(不崩在 set_icon 上)', async () => {
    const sdkDir = overrideSdk ?? ''
    const launcher = sdkDir === '' ? null : await findLauncher(sdkDir)
    if (launcher === null) {
      console.warn(`⚠ 跳过:没找到钉版 SDK(GALFREE_SDK_DIR=${sdkDir || '(未设)'},启动器 ${platformLauncherName()})`)
      return
    }

    const project = await makeTempDir('galfree-t30-slow-')
    for (const file of [...renderTemplateFiles({ name: 'coverprobe', title: '封面探针', id: 'coverprobe' }), ...templateKeepFiles()]) {
      const abs = join(project, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    // 照生产实现:界面文件、中文字体、**默认窗口图标**都从 SDK 拷进项目。
    for (const name of ['screens.rpy', 'gui.rpy', 'guisupport.rpy']) {
      await cp(join(sdkDir, 'gui', 'game', name), join(project, 'game', name))
    }
    await mkdir(join(project, 'game', 'fonts'), { recursive: true })
    await cp(join(sdkDir, 'sdk-fonts', 'SourceHanSansLite.ttf'), join(project, 'game', 'fonts', 'SourceHanSansLite.ttf')).catch(() => {})
    await mkdir(join(project, 'game', 'gui'), { recursive: true })
    await cp(join(sdkDir, ...TEMPLATE_WINDOW_ICON.source.split('/')), join(project, 'game', TEMPLATE_WINDOW_ICON.target))
    // 断言一下前提:模板的 options.rpy 真的指向那个文件(否则这条测的就不是那条路)。
    expect(await readFile(join(project, 'game', 'options.rpy'), 'utf8')).toContain('config.window_icon = "gui/window_icon.png"')

    const run = promisify(execFile)
    const lint: { code?: number; stdout?: string; stderr?: string } = await run(launcher, [project, 'lint'], { maxBuffer: 16 * 1024 * 1024 })
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => error)
    expect(lint.code ?? 0).toBe(0)

    // **真起一次**:一进主菜单就退出(假显示驱动;内容为空,不依赖任何素材)。
    process.env.SDL_VIDEODRIVER = 'dummy'
    process.env.SDL_AUDIODRIVER = 'dummy'
    await writeFile(join(project, 'game', 'zz_probe.rpy'), [
      'init python:',
      '    config.developer = False',
      '    def _probe_quit():',
      '        renpy.quit()',
      '    config.start_callbacks.append(_probe_quit)',
      '',
    ].join('\n'), 'utf8')
    const started: { code?: number; stdout?: string; stderr?: string } = await run(launcher, [project], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => error)
    // 退出码 0 = 引擎带着图标起来了并正常退出;**非 0 或 traceback = 这条红**。
    expect(started.code ?? 0).toBe(0)
    const traceback = await readFile(join(project, 'traceback.txt'), 'utf8').catch(() => null)
    expect(traceback).toBeNull()

    await rm(project, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 300_000)
})
