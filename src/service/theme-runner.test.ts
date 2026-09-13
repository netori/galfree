/**
 * T31(#39)守卫 —— **staging 那一半**(假端口:不起真引擎、不碰真项目)。
 *
 * 这一层要守住的两件事,都是"错了会静默坏掉"的那种:
 *
 *  1. **真项目一个字节都不动**:引擎在 staging 里会写 `.bak`、会重排 `gui.rpy` ——
 *     那些文件绝不能被搬进项目(落盘只走写网关);
 *  2. **产物不全要如实报错**:引擎退出码 0 **不等于**图都出来了(生成器内部的异常
 *     会被 init 阶段吞掉)。少一张就报错,不假装成功 —— 残缺的界面图会让主菜单缺块。
 *
 * 真引擎那半在 `theme.slow.test.ts`(它会把整套图真跑一遍)。
 */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeTempDir } from '../testing/tmp.ts'
import { generateThemedImages, renderStageDriver, REQUIRED_THEME_IMAGES, defaultThemePorts, type ThemePorts } from './theme-runner.ts'
import { DEFAULT_THEME, GUI7_PACKAGE, THEME_STAGE } from './theme.ts'

/**
 * staging 是**一整份项目副本**,所以引擎写的路径与项目根相对路径**同形**
 * (`<stage>/game/gui/textbox.png`)—— 假引擎照这个形状写,才谈得上"替身做的是产品那件事"。
 */
const STAGE_SENTINELS = [...REQUIRED_THEME_IMAGES]

/** 假 SDK:只放 gui7 那四个 .py 与图标(真内容由慢带验)。 */
async function fakeSdk(): Promise<string> {
  const dir = await makeTempDir('galfree-theme-sdk-')
  const gui7 = join(dir, ...GUI7_PACKAGE.relative.split('/'))
  await mkdir(gui7, { recursive: true })
  for (const name of GUI7_PACKAGE.pythonFiles) await writeFile(join(gui7, name), `# fake ${name}\n`, 'utf8')
  await writeFile(join(gui7, GUI7_PACKAGE.iconFile), 'PNG', 'utf8')
  return dir
}

/** 假项目:有 game/ 与一个界面代码文件。 */
async function fakeProject(): Promise<string> {
  const root = await makeTempDir('galfree-theme-proj-')
  await mkdir(join(root, 'game'), { recursive: true })
  await writeFile(join(root, 'game', 'gui.rpy'), 'define gui.accent_color = "#00b8c3"\n', 'utf8')
  return root
}

/** 假引擎:它**模拟生成器会做的事**(写 52 张图里的那几张哨兵 + 一个 `.bak` 噪声文件),
 * 并且把"被调用时 staging 里长什么样"记下来 —— 断言就靠那份记录。
 *
 * `write` 是**相对 staging 根**的路径(引擎就是往 staging 的项目里写)——
 * 差别在这里踩过一次:写成相对项目根,就会在 staging 里凭空多一层 `game/`。
 */
function fakePorts(options: { write?: string[]; exitCode?: number; log?: string } = {}) {
  const written = options.write ?? [...STAGE_SENTINELS]
  const seen: { roots: string[]; drivers: string[]; staged: string[] } = { roots: [], drivers: [], staged: [] }
  const copies: string[] = []
  const base = defaultThemePorts({
    run: async () => ({ code: 0, log: '' }),
    resolveSdkDir: async () => null,
    resolveLauncher: async () => null,
    sdkVersion: async () => null,
  })
  const ports: ThemePorts = {
    ...base,
    copyTree: async (from, to) => {
      copies.push(from)
      await base.copyTree(from, to)
    },
    runEngine: async (_launcher, root) => {
      seen.roots.push(root)
      // 驱动脚本得先摆进去(否则这条断言就永远绿)。
      seen.drivers.push(await readFile(join(root, ...THEME_STAGE.driverFile.split('/')), 'utf8'))
      seen.staged.push(...await base.listFiles(join(root, 'game')))
      if ((options.exitCode ?? 0) !== 0) return { code: options.exitCode!, log: options.log ?? '' }
      for (const path of written) {
        const abs = join(root, ...path.split('/'))
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      }
      // 引擎会留下的噪声:一个 .bak(它绝不该被搬进项目)。
      await writeFile(join(root, 'game', 'gui.rpy.bak'), 'noise', 'utf8')
      return { code: 0, log: 'Ren\'Py 8.x\n' }
    },
  }
  return { ports, seen, copies }
}

const spec = { ...DEFAULT_THEME, accent: '#c94f7c', boring: '#1b1b22', width: 1920, height: 1080 }

describe('换皮:staging 那一半(T31/#39)', () => {
  it('摆好 gui7 + 驱动脚本 → 收 `game/gui/**` 的 PN G,且**不把 .bak / 驱动脚本当产物**', async () => {
    const sdk = await fakeSdk()
    const project = await fakeProject()
    const { ports, seen, copies } = fakePorts()

    const result = await generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports })

    // 产物只认 `game/gui/` 下的 PNG:引擎在 staging 里写的 `.bak` 与别的文件都不在内。
    // 比较用**排序后**的清单:目录枚举顺序是文件系统的事(拿它当断言会变成假红)。
    expect(result.images.map((image) => image.path).sort()).toEqual([...REQUIRED_THEME_IMAGES].sort())
    for (const image of result.images) {
      expect([...image.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
    // 复制的是**真项目**;引擎跑的是 staging(两个不同的目录)。
    expect(copies).toEqual([project])
    expect(seen.roots).toHaveLength(1)
    expect(seen.roots[0]).not.toBe(project)
    // gui7 真被摆进了 staging 的 game/ 下(发行版里没有它,必须自己带)。
    expect(seen.staged).toContain(`${THEME_STAGE.packageName}/parameters.py`)
    expect(seen.staged).toContain(`${THEME_STAGE.packageName}/__init__.py`)
    // 驱动脚本也在(引擎跑的是 staging 里那一份,不是项目里那一份)。
    expect(seen.staged).toContain(THEME_STAGE.driverFile.replace(/^game\//, ''))
    // 产物是**从 staging 收的**:`.bak` 那种引擎噪声没被当成界面图。
    expect(result.images.every((image) => image.path.endsWith('.png'))).toBe(true)
  })

  it('驱动脚本:照主题参数写生成器调用(accent/boring/light 都从参数来,不是写死)', () => {
    const driver = renderStageDriver(spec)
    // 主色走 `gui.accent_color`(staging 的 gui.rpy 里那一版),辅色与明暗是字面量。
    expect(driver).toContain('gui.accent_color')
    expect(driver).toContain(JSON.stringify(spec.boring))
    expect(driver).toContain('False, None,')
    expect(driver).toContain('ImageGenerator(_galfree_theme).generate_all()')
    // 引擎那一半(按钮底/条/滑块)也要跑 —— 它读的是渲染真正用的 gui 变量。
    expect(driver).toContain('_gui_images()')
    // 换 light 时驱动脚本真的会不同(不然"亮色主题"就是个假开关)。
    expect(renderStageDriver({ ...spec, light: true })).not.toBe(driver)
    expect(renderStageDriver({ ...spec, light: true })).toContain('True, None,')
    // 驱动脚本**不碰项目的界面代码**:不调 generate_gui(那会重排 gui.rpy)。
    expect(driver).not.toContain('generate_gui(')
  })

  it('引擎退出码非 0 → 如实报错并贴上日志尾巴(不吞成"成功了")', async () => {
    const sdk = await fakeSdk()
    const project = await fakeProject()
    const { ports } = fakePorts({ exitCode: 1, log: 'Traceback\n  File "x.py", line 1\nRuntimeError: 生成器炸了\n' })

    await expect(generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports }))
      .rejects.toMatchObject({ code: 'theme-generate-failed' })
    await expect(generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports }))
      .rejects.toThrow(/生成器炸了/)
  })

  it('引擎说成功但图不全 → 报 `theme-images-missing` 并点名缺哪张(不把残缺的一套写进项目)', async () => {
    const sdk = await fakeSdk()
    const project = await fakeProject()
    // 少产出 textbox.png(发布前置检查盯的就是它)。
    const { ports } = fakePorts({ write: STAGE_SENTINELS.filter((path) => path !== 'game/gui/textbox.png') })
    await expect(generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports }))
      .rejects.toMatchObject({ code: 'theme-images-missing' })
    await expect(generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports }))
      .rejects.toThrow(/gui\/textbox\.png/)
  })

  it('SDK 里没有生成器 → 如实拒绝(不说"换好了")', async () => {
    const sdk = await makeTempDir('galfree-theme-nosdk-')
    const project = await fakeProject()
    const { ports } = fakePorts()

    await expect(generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports }))
      .rejects.toMatchObject({ code: 'sdk-incomplete' })
  })

  it('staging 用完就清掉(别在临时目录里攒 52 张图)', async () => {
    const sdk = await fakeSdk()
    const project = await fakeProject()
    const { ports, seen } = fakePorts()

    await generateThemedImages({ projectRoot: project, sdkDir: sdk, launcher: '/sdk/renpy.exe', spec, ports })
    expect(existsSync(seen.roots[0]!)).toBe(false)
  })
})
