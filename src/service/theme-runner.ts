/**
 * 换皮的**手那一半**:在 staging 副本里跑一次钉版 SDK 的生成器,把整套界面图拿回来。
 *
 * ## 为什么是"跑一次引擎"而不是纯 TypeScript 画图
 *
 * 那 52 张图里有一半是**引擎自己**画的(`renpy/common/00gui.rpy:469` 的 `_gui_images()`:
 * 按钮底、条、滑块、滚动条、存档格),它读的是**渲染真正用的** `gui.*` 变量
 * (含 `config.thumbnail_width` 这种要跑起来才有的值)。重写一遍等于把引擎的实现抄一份、
 * 然后跟着 SDK 升级慢慢歪掉。所以这里的做法是:**照 `guisupport.rpy` 的形状**把
 * `gui7` 摆进项目、起一次引擎、把产物读回来 —— 然后经写网关落进真项目。
 *
 * ## 两条保证(测试盯着它们)
 *
 *  1. **只在 staging 里跑**:`stageProject` 进出都是临时目录,真项目一个字节都不动
 *     (落盘只走写网关,ADR-0004)。所以引擎在 staging 里写 `.bak`、写 `gui.rpy`
 *     都无所谓 —— 那些文件不会被搬进项目。
 *  2. **产物不全就如实报错**:引擎退出码 0 不等于图都出来了(生成器某一步抛异常会被吞)。
 *     所以跑完按一张**哨兵清单**点数:少一张就报 `theme-images-missing`,不假装成功。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GalfreeError } from './error.ts'
import { spawnWithLog } from './spawn-log.ts'
// 目录走查**只有一份**(在 project-service 里):两边各写一遍,"缺目录算空"就会活两次。
import { listFilesRecursive } from './project-service.ts'
import { GUI7_PACKAGE, THEME_STAGE, type ThemeSpec } from './theme.ts'

/**
 * 生成器**一定要产出**的那几张(引擎那边少一张,界面就有一块是空的)。
 *
 * 路径口径是**项目根相对**(`game/gui/…`,与写网关、面板全项目一致)。
 *
 * 不是"整套 50 来张都要点名"—— 手机版(`phone/`)那些只在小屏变体下生成,
 * 点名一整套会在 SDK 改动时变成假红。这一份盯的是**主路径上会被引用到的**:
 * 文本框(发布前置 `gui-images-missing` 查的就是它)、两张菜单底、窗口图标、主按钮。
 */
export const REQUIRED_THEME_IMAGES = [
  'game/gui/textbox.png',
  'game/gui/main_menu.png',
  'game/gui/game_menu.png',
  'game/gui/window_icon.png',
  'game/gui/namebox.png',
  'game/gui/overlay/main_menu.png',
  'game/gui/button/choice_idle_background.png',
  'game/gui/button/choice_hover_background.png',
] as const

/** 生成器一次跑下来的结果(staging 里的产物,还没进项目)。 */
export interface ThemeStageResult {
  /** `game/gui/` 下所有产物(项目根相对路径 → 字节)。 */
  images: Array<{ path: string; bytes: Uint8Array }>
  /** 引擎自己的日志(失败时要能贴出来,别吞)。 */
  log: string
}

/** 端口:纯函数测不了"起引擎",所以那一段在接缝上(staging 目录给测试注入)。 */
export interface ThemePorts {
  /** 钉版 SDK 目录(没就绪 = null;查询时现读设置)。 */
  resolveSdkDir: () => Promise<string | null>
  /** 启动器绝对路径(没就绪 = null)。 */
  resolveLauncher: () => Promise<string | null>
  /** SDK 版本(记进主题账本;探测不到 = null,不编一个)。 */
  sdkVersion: () => Promise<string | null>
  /** 造一个临时 staging 目录(调用方负责用 `remove` 清掉)。 */
  makeStageDir: () => Promise<string>
  /** 递归复制(项目 → staging)。 */
  copyTree: (from: string, to: string) => Promise<void>
  /** 递归列文件(POSIX 相对路径)。 */
  listFiles: (dir: string) => Promise<string[]>
  /** 读文件字节。 */
  readBytes: (path: string) => Promise<Uint8Array>
  /** 起引擎(launcher, [项目, 'quit'])并等它跑完。 */
  runEngine: (launcher: string, root: string) => Promise<{ code: number; log: string }>
  /** 清掉 staging。 */
  remove: (path: string) => Promise<void>
}

/**
 * 生产端口(真文件系统 + 真子进程)。
 *
 * `resolveSdkDir` / `resolveLauncher` / `sdkVersion` 三个是**能力式**的:宿主没就绪时
 * 如实返回 null(调用方据此报 `sdk-not-ready`),不在这里假装有 SDK。
 */
export function defaultThemePorts(input: {
  run: ThemePorts['runEngine']
  resolveSdkDir: ThemePorts['resolveSdkDir']
  resolveLauncher: ThemePorts['resolveLauncher']
  sdkVersion: ThemePorts['sdkVersion']
}): ThemePorts {
  return {
    resolveSdkDir: input.resolveSdkDir,
    resolveLauncher: input.resolveLauncher,
    sdkVersion: input.sdkVersion,
    makeStageDir: async () => await mkdtemp(join(tmpdir(), 'galfree-theme-')),
    copyTree: async (from, to) => { await cp(from, to, { recursive: true }) },
    listFiles: async (dir) => await listFilesRecursive(dir),
    readBytes: async (path) => await readFile(path),
    runEngine: input.run,
    remove: async (path) => { await rm(path, { recursive: true, force: true }) },
  }
}

/**
 * staging 里那份驱动脚本。
 *
 * 它**只做两件事**:① 按主题参数生成界面图(`gui7.ImageGenerator`,与
 * `guisupport.rpy` 的调用形状逐字对齐);② 调引擎的 `_gui_images()` 补上引擎那一半图。
 * **不改项目文件**:`generate_gui(...)` 那一步被刻意跳过(`update_code=False`),
 * 颜色 define 由我们自己写(`theme.ts` 的 `writeThemeDefines`)—— 否则生成器会顺手
 * 重排 `gui.rpy`(还可能重写我们的中文字体补丁,那个坑在 UI 字体那一票里踩过)。
 */
export function renderStageDriver(spec: ThemeSpec): string {
  const boring = spec.boring
  const light = spec.light ? 'True' : 'False'
  return [
    '# GALFree T31(#39):换皮的 staging 驱动(临时文件,写完就删;不进项目、不进快照)。',
    'init 100 python:',
    '    from store import config',
    '    import os, sys',
    '',
    '    # 发行版里没有 gui7,所以照 guisupport.rpy 的形状把包摆进项目再 import。',
    '    sys.path.insert(0, config.gamedir)',
    '    sys.path.insert(0, os.path.join(config.renpy_base, "launcher", "game"))',
    '',
    '    from galfree_gui7.parameters import GuiParameters',
    '    from galfree_gui7.images import ImageGenerator',
    '',
    '    _galfree_theme = GuiParameters(',
    '        config.gamedir, config.gamedir,',
    '        config.screen_width, config.screen_height,',
    `        gui.accent_color, ${JSON.stringify(boring)}, ${light}, None,`,
    '        True, False, False, "galfree",',
    '    )',
    '    _galfree_theme.skip_backup = True',
    '    ImageGenerator(_galfree_theme).generate_all()',
    '',
    '    # 引擎那一半(按钮底/条/滑块/滚动条/存档格):读的是渲染真正用的 gui 变量。',
    '    import store.gui as _galfree_gui',
    '    _galfree_gui._skip_backup = True',
    '    _galfree_gui._gui_images()',
    '',
  ].join('\n')
}

/**
 * 在 staging 副本里跑一次生成器,把 `game/gui/**` 读回来。**真项目一个字节都不动。**
 */
export async function generateThemedImages(input: {
  projectRoot: string
  sdkDir: string
  launcher: string
  spec: ThemeSpec
  ports: ThemePorts
}): Promise<ThemeStageResult> {
  const { projectRoot, sdkDir, launcher, spec, ports } = input
  const gui7Dir = join(sdkDir, ...GUI7_PACKAGE.relative.split('/'))
  if (!existsSync(join(gui7Dir, '__init__.py'))) {
    throw new GalfreeError(
      'sdk-incomplete',
      `钉版 SDK 里没有界面生成器(${GUI7_PACKAGE.relative}):换皮要它才画得出界面图。请检查 SDK 是否完整。`,
    )
  }

  const stage = await ports.makeStageDir()
  try {
    await ports.copyTree(projectRoot, stage)
    if (!existsSync(join(stage, 'game'))) {
      throw new GalfreeError('not-a-project', `staging 副本里没有 game/ 目录:${projectRoot} 看起来不是 Ren'Py 项目`)
    }

    // ① 把 gui7 摆进 staging 的项目里(发行版里没有它)。
    const packageDir = join(stage, 'game', THEME_STAGE.packageName)
    await mkdir(packageDir, { recursive: true })
    for (const name of GUI7_PACKAGE.pythonFiles) {
      await writeFile(join(packageDir, name), await readFile(join(gui7Dir, name)))
    }
    await writeFile(join(packageDir, GUI7_PACKAGE.iconFile), await readFile(join(gui7Dir, GUI7_PACKAGE.iconFile)))

    // ② 先把 staging 里**上一套界面图**清掉,再让生成器画新的。
    //
    // 为什么必须清:staging 是整份项目副本,里面本来就有旧的一套图;生成器只会**覆盖**
    // 它画的那几十张,不会删掉旧的一套里多出来的(`phone/` 那种只在小屏变体下生成的图)。
    // 不清的话,收产物时会把**旧主题的图**当成"这次生成的产物"一起写回项目 —— 那正是
    // "界面上留一块旧颜色"的来源,而且它是静默的。
    await rm(join(stage, 'game', 'gui'), { recursive: true, force: true })

    // ③ 驱动脚本。名字带 zz_ 前缀,排在项目自己的界面文件之后(读到的 gui.* 是我们这一版)。
    await writeFile(join(stage, ...THEME_STAGE.driverFile.split('/')), renderStageDriver(spec), 'utf8')

    // ④ 起一次引擎(它会跑 init → 生成图 → quit)。日志照收,失败时贴出来。
    const run = await ports.runEngine(launcher, stage)
    if (run.code !== 0) {
      throw new GalfreeError('theme-generate-failed', `界面生成器没能跑完(退出码 ${run.code}):\n${tail(run.log)}`)
    }

    // ⑤ 收产物:staging 的 `game/gui/**`(路径换成项目根相对)。
    const guiDir = join(stage, 'game', 'gui')
    const found = existsSync(guiDir) ? await ports.listFiles(guiDir) : []
    const images = await Promise.all(found
      .filter((name) => name.endsWith('.png'))
      .map(async (name) => ({ path: `game/gui/${name}`, bytes: await ports.readBytes(join(guiDir, ...name.split('/'))) })))

    // ⑥ 哨兵点数:引擎退出码 0 **不等于**图都出来了(生成器内部的异常会被吞)。
    const have = new Set(images.map((image) => image.path))
    const missing = REQUIRED_THEME_IMAGES.filter((path) => !have.has(path))
    if (missing.length > 0) {
      throw new GalfreeError(
        'theme-images-missing',
        `生成器跑完了,但缺 ${missing.length} 张该有的界面图:${missing.join('、')} —— 不把这一套写进项目(残缺的界面图会让主菜单缺块)`,
      )
    }
    if (images.length === 0) {
      throw new GalfreeError('theme-images-missing', `生成器一张图都没产出 —— 不假装成功`)
    }

    return { images, log: run.log }
  } finally {
    await ports.remove(stage)
  }
}

function tail(text: string, lines = 20): string {
  const split = text.trimEnd().split('\n')
  return split.slice(-lines).join('\n')
}

/** 一次换皮的生成器最长等待:它要起一次引擎、画几十张图(实测几秒),给足但**有界**。 */
export const THEME_GENERATE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 真跑一次生成器(Host 装配用):`renpy.exe <staging 项目> quit`。
 *
 * 为什么用 `quit` 而不是 `lint`:那套界面图是在 **init 阶段** 画的(项目的
 * `guisupport.rpy` 那一族 + 我们的驱动脚本),跑完 init 就够;`lint` 会多跑一遍全项目
 * 解析与统计,白白慢一截。退出码 0 = init 跑通了(生成器内部的异常**会被吞**,
 * 所以"图全不全"由 `generateThemedImages` 的数数那一步兜底)。
 *
 * `windowsHide: true` 是对的:这是**命令行生成**,不该在人眼前闪一个窗口 ——
 * 与试玩那条相反(试玩必须让窗口出现在人眼前,那一课写在 `spawn-log.ts` 里)。
 */
export async function realThemeRun(launcher: string, root: string): Promise<{ code: number; log: string }> {
  const result = await spawnWithLog(launcher, [root, 'quit'], {
    timeoutMs: THEME_GENERATE_TIMEOUT_MS,
    windowsHide: true,
    timeoutNote: `[GALFREE] 界面生成等待超时(${Math.round(THEME_GENERATE_TIMEOUT_MS / 1000)} 秒),已中止生成进程。`,
  })
  return { code: result.code, log: result.log }
}
