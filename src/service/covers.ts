/**
 * 封面 / 主菜单背景 / 窗口图标(T30 / #38)—— 那三张**生成器不覆盖**的界面图。
 *
 * ## 为什么就这三张(已从钉版 SDK 源码核实,别重查)
 *
 * `game/gui/` 那一整套界面图是 Ren'Py **首次运行时程序生成**的(`launcher/game/gui7/`,
 * 九宫格模板 + 参数)。但其中三张是例外:`images.py:398,404,405` 用的是
 * `save(..., overwrite=False)`,launcher 的文案也明说"**不会**覆盖 main_menu.png /
 * game_menu.png / window_icon.png" —— 也就是**留给人的那三张**。
 *
 * ## 为什么不在这一票里换掉整套界面图
 *
 * 拿 AI 出 100 张尺寸敏感的图(按钮九宫格、文本框边距)是把边距交给概率;
 * 游戏内主题应当**给 gui7 生成器一组参数**(那是 #39)。
 *
 * ## 一条会**启动即崩**的坑(实现这一票之前必须知道)
 *
 * `config.window_icon` 指向的文件**不存在**时,引擎不兜底:
 * `set_icon()` 只 `except renpy.webloader.DownloadNeeded`(`renpy/display/core.py:1044-1071`),
 * 而 `renpy.loader.load` 找不到文件会抛 `FileNotFoundError`(`renpy/loader.py`)→ **启动期崩**。
 *
 * 所以顺序**不能反**:模板先落一个默认图标(`gui/window_icon.png`),**再**设 config。
 * 人/AI 出的新图标只是把那个文件换掉 —— 这一步永远不会"先设 config 后落图"。
 */

/** 封面类的三个目标(生成器不覆盖的那三张)。 */
export type CoverTargetId = 'main_menu' | 'game_menu' | 'window_icon'

export interface CoverTargetSpec {
  /** 与项目分辨率同宽高比(引擎按项目分辨率渲染菜单背景)。 */
  aspect: 'screen' | '1:1'
  /** 要不要正方形(图标:引擎会补成正方形并缩到 ≤1024)。 */
  square: boolean
  /** 一句话说清"要什么样的图"(面板与 agent 都读它)。 */
  note: string
}

export interface CoverTarget {
  id: CoverTargetId
  /** 项目内相对路径(引擎的 searchpath 只有 `game/`)。 */
  path: string
  /** 谁在读它(出处行号见文件头注释)。 */
  readBy: string
  spec: CoverTargetSpec
}

/**
 * 规格表(唯一出处)。
 *
 * 基准分辨率 1280×720 与缩放公式 `scale = min(w/1280, h/720)` 都来自 gui7 的
 * `parameters.py`(WIDTH/HEIGHT/scale)—— 所以 1080p 项目的菜单背景就该是 1920×1080,
 * 而不是沿用 720p 的图。
 */
export const COVER_TARGETS: readonly CoverTarget[] = [
  {
    id: 'main_menu',
    path: 'game/gui/main_menu.png',
    readBy: '模板 gui.rpy 的 gui.main_menu_background',
    spec: { aspect: 'screen', square: false, note: '主菜单背景(游戏的第一眼);用项目分辨率的宽高比' },
  },
  {
    id: 'game_menu',
    path: 'game/gui/game_menu.png',
    readBy: '游戏内菜单背景',
    spec: { aspect: 'screen', square: false, note: '游戏内菜单(存读档/设置)的背景' },
  },
  {
    id: 'window_icon',
    path: 'game/gui/window_icon.png',
    readBy: 'options.rpy 的 config.window_icon',
    spec: { aspect: '1:1', square: true, note: '窗口/任务栏图标;正方形最佳(引擎会补成正方形并缩到 ≤1024)' },
  },
] as const

/** 按 id 取目标;认不出的返回 null(调用方据此**如实拒绝**,不猜一个路径)。 */
export function coverTargetOf(id: string): CoverTarget | null {
  return COVER_TARGETS.find((target) => target.id === id) ?? null
}

/** 目标 id 的清单(错误信息里用:"只有这些")。 */
export function coverTargetIds(): string[] {
  return COVER_TARGETS.map((target) => target.id)
}

/**
 * 项目分辨率 → 该出多大的菜单背景(**规格的一致口径**)。
 *
 * 默认 1280×720(Ren'Py 新建项目的基准);项目在 `options.rpy` 里改了分辨率就按它算。
 * 图标不按这个:它要正方形。
 */
export const BASE_RESOLUTION = { width: 1280, height: 720 } as const

export function expectedCoverSize(target: CoverTarget, project?: { width: number; height: number }): string {
  if (target.spec.square) return '正方形(引擎会补成正方形,再缩到 ≤1024)'
  const size = project ?? BASE_RESOLUTION
  return `${size.width}×${size.height}(与项目分辨率同宽高比)`
}

/**
 * 窗口图标的**默认来源**(从钉版 SDK 拷)。
 *
 * 为什么不把 PNG 放进仓库:图标是个二进制,而钉版 SDK 里就有一张现成的
 * (`launcher/game/gui7/icon.png`,Ren'Py 自己用它当默认图标)—— 与中文字体那条
 * "从 SDK 拷"是同一条路(少一个随包二进制,少一处会过期的东西)。
 */
export const TEMPLATE_WINDOW_ICON = {
  source: 'launcher/game/gui7/icon.png',
  target: 'gui/window_icon.png',
} as const
