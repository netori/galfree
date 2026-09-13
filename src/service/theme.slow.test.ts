/**
 * 慢带:**换皮在真引擎上真跑一遍**(钉版 SDK)。
 *
 * 这一条盯的是三件"快带证不了"的事:
 *
 *  1. **staging 那条路真能出图**:照 `guisupport.rpy` 的形状把 `gui7` 摆进副本、
 *     起一次引擎 —— 几十张界面图真的落进 staging(实测几秒);写完图的那份**改过的**
 *     `gui.rpy` **没被搬进项目**(staging 里引擎顺手写的 `.bak` 也不在项目里);
 *  2. **颜色推导与引擎逐值一致**:`theme.ts` 是 `parameters.py` + `renpy/color.py` 的移植,
 *     而移植错一口的表现是"颜色偏一点点" —— 所以这里拿**真引擎**算一遍同一组参数,
 *     逐条比 `gui.rpy` 里的 define(那是引擎自己的输出,不是我们算的);
 *  3. **换完起得来**:lint 干净 + 真启动无 traceback(换皮改的是整套界面资产,
 *     出错是"主菜单就崩"那一级)。
 *
 * 分辨率那半另有一条:**1080p 项目真的按缩放公式重出**(不是沿用 720p 的图)——
 * 尺寸错了引擎不报错、只是画面歪,所以只能量像素。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectService } from './project-service.ts'
import { createCompositeValidator } from './validation/composite-validator.ts'
import { findLauncher } from './hash.ts'
import { defaultThemePorts, realThemeRun } from './theme-runner.ts'
import { derivePalette, GUI_CODE_FILE, themeDefines } from './theme.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const run = promisify(execFile)

/** 拿钉版 SDK 目录(与别的慢带用例同一口径)。 */
async function sdkDirFor(): Promise<string> {
  const fromEnv = process.env.GALFREE_SDK_DIR
  const dir = fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-galfree', 'sdk')
  if ((await findLauncher(dir)) === null) {
    throw new Error(`慢带需要真 SDK,但在 ${dir} 找不到启动器(设 GALFREE_SDK_DIR 或先完成 SDK 供给)`)
  }
  return dir
}

/**
 * 真引擎算同一组参数的颜色:`PYTHONPATH=<sdk> python -c …`。
 *
 * 只问 `GuiParameters` **会写进 `gui.rpy`** 的那几条 —— `menu_color`(菜单底色)
 * 与 `boring_color` 只活在生成器里(它们决定的是那几张图的像素,不是 define),
 * 拿它们来比会得出一个假红。
 */
async function enginePalette(sdkDir: string, accent: string, light: boolean): Promise<Record<string, string>> {
  const script = [
    'import json',
    'from renpy.color import Color',
    `a = Color(${JSON.stringify(accent)})`,
    `light = ${light ? 'True' : 'False'}`,
    'hover = a if light else a.tint(.6)',
    'muted = a.tint(.6) if light else a.shade(.4)',
    'hover_muted = a.tint(.4) if light else a.shade(.6)',
    'title = a.replace_hsv_saturation(.5).replace_value(1.0)',
    'idle = Color("#707070") if light else Color("#888888")',
    'print(json.dumps({',
    '  "accent": a.hexcode, "hover": hover.hexcode, "muted": muted.hexcode,',
    '  "hoverMuted": hover_muted.hexcode, "title": title.hexcode,',
    '  "insensitive": idle.replace_opacity(.5).hexcode,',
    '}))',
  ].join('\n')
  const { stdout } = await run('python', ['-c', script], {
    env: { ...process.env, PYTHONPATH: sdkDir },
    maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(stdout.trim()) as Record<string, string>
}

describe('界面换皮(慢带,真 SDK)', () => {
  afterEach(async () => { await cleanupTempDirs() })

  it('换皮的整套图对得上引擎:颜色逐值一致 + 项目里只多出该多出的东西', async () => {
    const sdkDir = await sdkDirFor()
    const launcher = (await findLauncher(sdkDir))!
    const base = await makeTempDir('galfree-slow-theme-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const accent = '#c94f7c'
    const themePorts = defaultThemePorts({
      run: realThemeRun,
      resolveSdkDir: async () => sdkDir,
      resolveLauncher: async () => launcher,
      sdkVersion: async () => 'pinned',
    })
    const service = createProjectService({
      dataDir: join(base, 'data'),
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
      theme: themePorts,
    })
    try {
      const project = await service.createProject({ projectsRoot, name: 'themeslow', title: '换皮链路', sdkDir })
      const before = await readFile(join(project.root, GUI_CODE_FILE), 'utf8')

      const report = await service.applyTheme('themeslow', { spec: { accent, boring: '#1b1b22' } }, { via: 'agent' })
      expect(report.images).toBeGreaterThan(40)
      expect(report.label).toContain(accent)

      // ① **颜色逐值一致**:引擎自己算一遍同一组参数,与写进 gui.rpy 的那些 define 比。
      const fromEngine = await enginePalette(sdkDir, accent, false)
      const written = await readFile(join(project.root, GUI_CODE_FILE), 'utf8')
      for (const [name, value] of Object.entries(fromEngine)) {
        expect(written, `${name} 与引擎不一致(引擎给 ${value})`).toContain(`'${value}'`)
      }
      // 而我们的纯函数与引擎也一致(移植错一口的守卫)。
      const mine = derivePalette({ accent, light: false })
      expect(mine).toMatchObject(fromEngine)
      expect(themeDefines({ accent, boring: '#000000', light: false, width: 1280, height: 720 }))
        .toContainEqual({ name: 'gui.hover_color', value: `'${fromEngine.hover}'` })

      // ② staging 里那些**引擎噪声**没进项目:`.bak` 一个都没有,而且项目里的 gui.rpy
      //    只被我们改了那几行(不是引擎重排过的那一份)。
      const entries = await readdir(join(project.root, 'game'))
      expect(entries.filter((name) => name.includes('.bak'))).toEqual([])
      // 行数 = 原样 + 我们补的那几条「模板里没有的 define」(其余字节逐字保留)。
      const appended = themeDefines({ accent, boring: '#000000', light: false, width: 1280, height: 720 })
        .filter((entry) => !before.includes(`define ${entry.name} =`)).length
      expect(written.split('\n').length).toBe(before.split('\n').length + appended)

      // ③ 界面图真的换了一套:每张都是**完整 PNG**(签名 + IHDR + IEND)。
      const textbox = await readFile(join(project.root, 'game', 'gui', 'textbox.png'))
      expect([...textbox.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(textbox.toString('latin1')).toContain('IHDR')
      expect(textbox.toString('latin1')).toContain('IEND')

      // ④ 换完之后:lint 干净 + **真启动**无 traceback(整套界面资产换了,这一步最容易崩)。
      const validation = await service.validateActiveProject()
      expect(validation.validator).toBe('sdk')
      expect(validation.problems.filter((problem) => problem.severity === 'error')).toEqual([])

      const { spawn } = await import('node:child_process')
      const child = spawn(launcher, [project.root], {
        cwd: project.root,
        env: { ...process.env, RENPY_DISABLE_SOUND: '1', RENPY_LESS_UPDATES: '1' },
        stdio: 'ignore',
      })
      const alive = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 25_000)
        child.once('exit', () => { clearTimeout(timer); resolve(false) })
      })
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const traceback = join(project.root, 'traceback.txt')
      if (existsSync(traceback)) {
        expect.fail(`换皮之后真启动崩了:\n${(await readFile(traceback, 'utf8')).split('\n').slice(0, 14).join('\n')}`)
      }
      expect(alive, '引擎没能把换过皮的项目启动起来').toBe(true)

      // ⑤ 板子看得见"当前主题是什么"(AC:别让人猜)。
      const view = await service.theme('themeslow')
      expect(view.applied).toMatchObject({ accent, width: 1280, height: 720 })
      expect(view.stale).toBe(false)
      expect((await service.progress('themeslow')).theme.label).toBe(view.label)
    } finally {
      await service.dispose()
    }
  }, 600_000)

  it('分辨率 ≠ 720p:按缩放公式重出(不是沿用基准图)', async () => {
    const sdkDir = await sdkDirFor()
    const launcher = (await findLauncher(sdkDir))!
    const base = await makeTempDir('galfree-slow-theme-hd-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const service = createProjectService({
      dataDir: join(base, 'data'),
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
      theme: defaultThemePorts({
        run: realThemeRun,
        resolveSdkDir: async () => sdkDir,
        resolveLauncher: async () => launcher,
        sdkVersion: async () => 'pinned',
      }),
    })
    try {
      const project = await service.createProject({ projectsRoot, name: 'themeshd', title: '高清换皮', sdkDir })
      // 把项目改成 1080p(分辨率是 `gui.rpy` 里那一行说了算)。
      const code = await readFile(join(project.root, GUI_CODE_FILE), 'utf8')
      await service.writeProjectFiles('themeshd', [{
        path: GUI_CODE_FILE,
        content: code.replace('gui.init(1280, 720)', 'gui.init(1920, 1080)'),
        expectVersion: (await service.readProjectFile('themeshd', GUI_CODE_FILE)).version,
      }], { origin: 'agent', reason: 'resolution' })

      // 给 720p 会被如实拒绝(不出一套歪的图)。
      await expect(service.applyTheme('themeshd', { spec: { accent: '#2e7d5b', width: 1280, height: 720 } }, { via: 'human' }))
        .rejects.toMatchObject({ code: 'theme-resolution-mismatch' })

      const report = await service.applyTheme('themeshd', { spec: { accent: '#2e7d5b', width: 1920, height: 1080 } }, { via: 'human' })
      expect(report.images).toBeGreaterThan(40)

      // 尺寸真的按 `scale = min(w/1280, h/720) = 1.5` 重出了 —— 量像素(错尺寸引擎不报错:
      // 它只是把图拉伸,画面就歪了;所以这条只能量)。
      // 文本框:模板是 185 高 → 1.5 倍 = 277.5,引擎的 `int()` **截断**成 277(不是四舍五入)。
      const size = await pngSize(join(project.root, 'game', 'gui', 'textbox.png'))
      expect(size).toEqual({ width: 1920, height: 277 })
      // 菜单底:整张铺满项目分辨率(1080p 的项目就该是 1920×1080,不是沿用 720p 的图)。
      const menu = await pngSize(join(project.root, 'game', 'gui', 'main_menu.png'))
      expect(menu).toEqual({ width: 1920, height: 1080 })

      expect((await service.theme('themeshd')).resolution).toEqual({ width: 1920, height: 1080 })
    } finally {
      await service.dispose()
    }
  }, 600_000)
})

/** 读 PNG 的宽高(只看 IHDR 那 8 个字节;不引图像库)。 */
async function pngSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const bytes = await readFile(path)
    if (bytes.length < 24) return null
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } catch {
    return null
  }
}
