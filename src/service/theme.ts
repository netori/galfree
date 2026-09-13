/**
 * 游戏内界面换皮(T31 / #39)—— **参数那一半**(纯函数:不碰磁盘、不起引擎)。
 *
 * ## 为什么是"给生成器一组参数"而不是 AI 出图
 *
 * `game/gui/*.png` 那一整套(52 张)不是静态资源:它们是 Ren'Py **自己画**的 ——
 * `launcher/game/gui7/`(九宫格模板 + 参数)加引擎的 `_gui_images()`
 * (`renpy/common/00gui.rpy:469`)。拿 AI 出 100 张尺寸敏感的图(按钮九宫格边距、
 * 滚动条 12px)是把边距交给概率。所以这一票做的是**给参数**。
 *
 * ## 颜色那一套是怎么来的(三条都对着钉版 SDK 实测过,别照直觉改)
 *
 * 1. **`tint` / `shade` 是线性 RGB 插值**,不是 HLS:`Color('#ff0000').tint(.5)` = `#ff7f7f`;
 *    照 `renpy/color.py` 的 docstring 想象成 HLS 会得到 `#df9f9f`(实测判据)。
 * 2. **`replace_hsv_saturation` / `replace_value` 的中间值留在浮点里**:引擎的 `Color`
 *    对象自己缓存 hsv,`replace_value(replace_hsv_saturation(c, .25), .25)` 的第二步
 *    读到的饱和度是精确的 `.25`。若中途用「转成 RGB 字节再转回 HSV」代替,会得到
 *    `.2396` —— 颜色差一个色阶(`#2f3f3f` vs 引擎的 `#2f3e3f`)。
 * 3. 读 hsv 时分量**round 到 8 位小数**(实测:`#c94f7c` 的 title 色全精度算 `#ff7ead`,
 *    引擎给 `#ff7fae`)。
 *
 * 移植而不是"在引擎里跑一遍":面板要能**立刻**给人看"这套主题长什么样",
 * 而那不该为了看一眼颜色起一次引擎。准确性由慢带对着真引擎验(`theme.slow.test.ts`)。
 */
import { GalfreeError } from './error.ts'

/** 项目分辨率(界面图整套按它缩放)。 */
export interface Resolution {
  width: number
  height: number
}

/** gui7 的基准分辨率(`parameters.py` 的 WIDTH/HEIGHT)。 */
export const BASE_RESOLUTION = { width: 1280, height: 720 } as const

/** 界面图住在项目里的哪 —— 换皮替换的就是这一整个目录。 */
export const GUI_IMAGE_DIR = 'game/gui'

/** 界面代码文件(gui7 的 `generate_gui` 会改的就是它 —— 颜色 define 在里面)。 */
export const GUI_CODE_FILE = 'game/gui.rpy'

/** 主题记录(推导"当前主题是什么"的唯一事实源;与发布/试玩同一种账本态度)。 */
export const THEME_FILE = '.studio/theme.json'

/** gui7 生成器住在钉版 SDK 的哪儿 —— 换皮把它摆进 staging 副本(发行版里没有 SDK)。 */
export const GUI7_PACKAGE = {
  /** 相对 SDK 根。 */
  relative: 'launcher/game/gui7',
  /** 要摆进 staging 的 python 文件(`__init__.py` 里就是 `generate_gui`)。 */
  pythonFiles: ['__init__.py', 'code.py', 'images.py', 'parameters.py'],
  /** 图标(生成器拿它调主色当默认窗口图标)。 */
  iconFile: 'icon.png',
} as const

/**
 * staging 副本的机制名(带 `galfree_` 前缀,避开项目自己的模块名)。
 *
 * 放两份:① Python 包(发行版里没有 gui7,所以按 `guisupport.rpy` 的形状摆进项目);
 * ② 驱动脚本 —— 它 import 引擎自己的 ImageGenerator 与 `_gui_images()`,**不**改项目文件。
 */
export const THEME_STAGE = {
  /** staging 里那个包名(与 `game/<名>/` 对应)。 */
  packageName: 'galfree_gui7',
  /** 驱动脚本名。 */
  driverFile: 'game/zz_galfree_theme_stage.py',
} as const

// ───────────────────────────── 颜色(renpy/color.py 的移植)─────────────────────────────

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 颜色字面量的形状:`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`(前缀 `#` **必给**)。
 *
 * 引擎那边前缀确实可省(`renpy/color.py` 的两个正则都是 `#?`),但省了之后
 * `c94f7c` 与 `#c94f7c` 是同一个颜色的两种写法 —— 半个项目的颜色带 `#`、一半不带,
 * 是给下一个人添的活。所以这里**只收一种写法**,认不出的如实拒绝(不猜一个颜色)。
 */
const SHORT_HEX = /^#([0-9a-fA-F]{3,4})$/
const LONG_HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * 解析颜色字面量:`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`。
 * **不接受**颜色名与函数式写法 —— 认不出就抛(调用方如实拒绝),不猜一个颜色写进项目界面文件。
 */
export function parseColor(input: string): Rgba {
  // 前后空白**不静默吃掉**:`"#c94f7c "` 这种从别处粘贴来的值,在这里放过就会一路
  // 走到 `gui.rpy` 里。宁可当场说"认不出"。
  if (input.trim() !== input) {
    throw new GalfreeError('bad-color', `认不出的颜色「${input}」:前后有空白,去掉再给`)
  }
  const short = SHORT_HEX.exec(input)
  if (short !== null) {
    const d = short[1]!
    const [r, g, b] = [d[0]!, d[1]!, d[2]!]
    const a = d[3]
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
      a: a === undefined ? 255 : parseInt(a + a, 16),
    }
  }
  const long = LONG_HEX.exec(input)
  if (long !== null) {
    const d = long[1]!
    return {
      r: parseInt(d.slice(0, 2), 16),
      g: parseInt(d.slice(2, 4), 16),
      b: parseInt(d.slice(4, 6), 16),
      a: d.length === 8 ? parseInt(d.slice(6, 8), 16) : 255,
    }
  }
  throw new GalfreeError('bad-color', `认不出的颜色「${input}」:要 #rgb / #rrggbb / #rrggbbaa 这种写法`)
}

/**
 * 规范化成小写 hex(带 alpha 时 8 位)。
 * 与 `Color.hexcode` 同口径:**alpha == 255 时不给那两位**。
 */
export function normalizeHexColor(input: string): string {
  return hexcode(parseColor(input))
}

export function hexcode(color: Rgba): string {
  const two = (n: number): string => Math.trunc(n).toString(16).padStart(2, '0')
  const base = `#${two(color.r)}${two(color.g)}${two(color.b)}`
  return color.a === 255 ? base : `${base}${two(color.a)}`
}

/**
 * `tint(fraction)`:与白色按**线性 RGB** 插值,`fraction` 是**保留多少原色**
 * (1.0 = 不变,0.0 = 白)。alpha 不动,取整口径照引擎的 `int()` = **截断**。
 *
 * ⚠️ 别照 `renpy/color.py` 的 docstring 想象成 HLS 插值 —— 实测判据是
 * `Color('#ff0000').tint(.5)` = `#ff7f7f`(= (255,127,127)),HLS 那条路会给 `#df9f9f`。
 */
export function tint(color: Rgba, fraction: number): Rgba {
  return interpolateRgb(color, { r: 255, g: 255, b: 255, a: color.a }, 1 - fraction)
}

/** `shade(fraction)`:同 tint,但往黑里插(`fraction` 同样是**留下多少原色**)。 */
export function shade(color: Rgba, fraction: number): Rgba {
  return interpolateRgb(color, { r: 0, g: 0, b: 0, a: color.a }, 1 - fraction)
}

/**
 * `replace_opacity` / `opacity(n)`:改 alpha(`min(max(opacity,0),1)`,再乘 255)。
 *
 * 这里是 `floor` 而不是 `trunc`:引擎的实现在那边是 `int(a * opacity)`,而全精度浮点
 * 乘法常落到 `127.49999999999999` 这种值上 —— `trunc` 给 127、`floor` 也给 127,
 * 但 `0.5 * 255 = 127.5` 在真正该给 128 的地方两者就分道扬镳。实测口径是 **127**
 * (`#8888887f`),所以取 floor。
 */
export function replaceOpacity(color: Rgba, opacity: number): Rgba {
  const alpha = Math.min(Math.max(opacity, 0), 1)
  return { r: color.r, g: color.g, b: color.b, a: Math.floor(alpha * 255) }
}

/** 线性 RGB 逐通道插值(`from + (to - from) * fraction`,取整 = 截断)。 */
function interpolateRgb(from: Rgba, to: Rgba, fraction: number): Rgba {
  const channel = (a: number, b: number): number => Math.trunc(a + (b - a) * fraction)
  return { r: channel(from.r, to.r), g: channel(from.g, to.g), b: channel(from.b, to.b), a: channel(from.a, to.a) }
}

/** HSV 三元组(引擎 `Color.hsv` 的那三个分量)。 */
export type Hsv = readonly [number, number, number]

/** `Color.hsv` 的读法:分量 round 到 8 位小数(见文件头第 3 条)。 */
export function rgbToHsv(color: Rgba): Hsv {
  const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const v = max
  const s = max === 0 ? 0 : delta / max
  if (delta === 0) return [0, round8(s), round8(v)]
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h /= 6
  if (h < 0) h += 1
  return [round8(h), round8(s), round8(v)]
}

/** `Color(hsv=…)`:HSV → RGB(逐通道 `int(v * 255)` 截断)。 */
export function hsvToRgba(hsv: Hsv, alpha = 255): Rgba {
  const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2])
  return { r: Math.trunc(r * 255), g: Math.trunc(g * 255), b: Math.trunc(b * 255), a: alpha }
}

/** `replace_hsv_saturation`:换掉饱和度(色相与明度照旧)。 */
export function replaceHsvSaturation(hsv: Hsv, saturation: number): Hsv {
  return [hsv[0], saturation, hsv[2]]
}

/** `replace_value`:换掉明度(色相与饱和度照旧)。 */
export function replaceValue(hsv: Hsv, value: number): Hsv {
  return [hsv[0], hsv[1], value]
}

/**
 * 引擎读 `.hsv` / `.hls` 时把分量 round 到 8 位小数。
 *
 * 不照做的后果是**差一个色阶**(全精度下常数项落到 0.9999999…,而 round8 之后是 1.0)——
 * 肉眼看不出来,只有拿引擎的值对才发现。
 */
function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

/** Python `colorsys.hsv_to_rgb` 的逐行移植。 */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v, v, v]
  let i = Math.trunc(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  i %= 6
  if (i < 0) i += 6
  const table: Array<[number, number, number]> = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ]
  return table[i]!
}

// ───────────────────────────── 主题参数与调色板 ─────────────────────────────

/** 一组换皮参数(=`GuiParameters` 的四个入参)。 */
export interface ThemeSpec {
  /** 主色:按钮 hover、进度条、菜单线那一族。 */
  accent: string
  /** 辅色(文本框/底衬那一族;生成器里叫 boring)。 */
  boring: string
  /** 明/暗主题:决定文本色一族与 menu 的取值。 */
  light: boolean
  /** 项目分辨率(生成器按 `min(w/1280, h/720)` 缩放所有图)。 */
  width: number
  height: number
}

export const DEFAULT_THEME: ThemeSpec = {
  accent: '#00b8c3',
  boring: '#000000',
  light: false,
  width: BASE_RESOLUTION.width,
  height: BASE_RESOLUTION.height,
}

/**
 * 缺省化的主题参数(面板/agent 只给一部分时的口径)。
 *
 * 分辨率给了就必须**像个分辨率**:0/负数/小数/NaN 一律如实拒绝,而不是取整成某个值 ——
 * 分辨率的错法不报错、只是整屏界面歪掉(生成器按它缩放)。
 */
export function parseThemeSpec(input: {
  accent?: string
  boring?: string
  light?: boolean
  width?: number
  height?: number
}): ThemeSpec {
  const dimension = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value <= 0) {
      throw new GalfreeError('bad-resolution', `分辨率${name}要一个正整数,收到「${String(value)}」`)
    }
    return value
  }
  return {
    accent: normalizeHexColor(input.accent ?? DEFAULT_THEME.accent),
    boring: normalizeHexColor(input.boring ?? DEFAULT_THEME.boring),
    light: input.light ?? DEFAULT_THEME.light,
    width: dimension(input.width, DEFAULT_THEME.width, '宽'),
    height: dimension(input.height, DEFAULT_THEME.height, '高'),
  }
}

/**
 * accent + light → 一整套颜色(逐条照 `GuiParameters.__init__`)。
 *
 * 这些值**就是**生成器会写进 `gui.rpy` 的那些 define(面板按它预览、人按它判断好不好看)。
 */
export interface ThemePalette {
  accent: string
  selected: string
  hover: string
  muted: string
  hoverMuted: string
  title: string
  /** 菜单底色(生成器叫它 menu_color;`main_menu`/`game_menu` 两张图就是它整张填的)。 */
  menu: string
  idle: string
  idleSmall: string
  insensitive: string
  text: string
  choice: string
}

export function derivePalette(input: { accent: string; light: boolean }): ThemePalette {
  const accent = parseColor(input.accent)
  const light = input.light

  // hover / muted / hover_muted 走 tint / shade(线性 RGB 插值,fraction = 留下多少原色)。
  const hover = light ? accent : tint(accent, 0.6)
  const muted = light ? tint(accent, 0.6) : shade(accent, 0.4)
  const hoverMuted = light ? tint(accent, 0.4) : shade(accent, 0.6)

  // menu / title 走 HSV 改写 —— 中间值**留在同一个 hsv 三元组里**(见文件头第 2 条)。
  const baseHsv = rgbToHsv(accent)
  const menu = hsvToRgba(replaceValue(replaceHsvSaturation(baseHsv, 0.25), light ? 0.75 : 0.25))
  const title = hsvToRgba(replaceValue(replaceHsvSaturation(baseHsv, 0.5), 1.0))

  const fixed = light
    ? { selected: '#555555', idle: '#707070', idleSmall: '#606060', text: '#404040', choice: '#cccccc' }
    : { selected: '#ffffff', idle: '#888888', idleSmall: '#aaaaaa', text: '#ffffff', choice: '#cccccc' }

  return {
    accent: hexcode(accent),
    selected: fixed.selected,
    hover: hexcode(hover),
    muted: hexcode(muted),
    hoverMuted: hexcode(hoverMuted),
    title: hexcode(title),
    menu: hexcode(menu),
    idle: fixed.idle,
    idleSmall: fixed.idleSmall,
    // insensitive = idle 半透明(生成器:`idle_color.replace_opacity(.5)`)。
    insensitive: hexcode(replaceOpacity(parseColor(fixed.idle), 0.5)),
    text: fixed.text,
    choice: fixed.choice,
  }
}

/**
 * 面板/agent 读的那句人话("当前主题是什么"——AC 要求别让人猜)。
 *
 * 措辞里带上**分辨率**:换皮最容易踩的错就是"沿用 720p 的图"。
 */
export function themeLabel(spec: ThemeSpec): string {
  const mode = spec.light ? '亮色' : '暗色'
  return `${mode}主题 · 主色 ${spec.accent} · 辅色 ${spec.boring} · ${spec.width}×${spec.height}`
}

/**
 * 项目文件的**主题处境**(推导:记录 + 项目分辨率 → 还一致吗)。
 *
 * 与发布/试玩同一种态度:事实记在 `.studio/theme.json`,推导只回答
 * "它还是不是当前这一版项目的主题"。
 */
export interface ThemeView {
  /** 换过皮没有(没有记录 = 还是生成器默认那一套)。 */
  applied: ThemeSpec | null
  /** 换皮的时间(没换过 = null)。 */
  appliedAt: string | null
  /** 项目**当前**分辨率(gui.init 读出来的)。 */
  resolution: Resolution
  /** 那套主题长什么样(没换过 = null)。 */
  palette: ThemePalette | null
  /** 记录里的分辨率与项目当前分辨率不一致 → 整套图是按旧尺寸出的。 */
  stale: boolean
  /** 面向人的一句话(面板与 agent 读同一份)。 */
  label: string
}

/** 从 `gui.rpy` 的文本里读项目分辨率(`gui.init(w, h)` 那一行)。 */
export function projectResolutionOf(guiRpy: string): Resolution {
  const match = /gui\.init\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(guiRpy)
  if (match === null) return { ...BASE_RESOLUTION }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** 推导主题处境(纯函数:记录 + 项目分辨率 → 视图)。 */
export function themeViewOf(
  applied: ThemeSpec | null,
  appliedAt: string | null,
  resolution: Resolution,
): ThemeView {
  const stale = applied !== null && (applied.width !== resolution.width || applied.height !== resolution.height)
  return {
    applied,
    appliedAt,
    resolution,
    palette: applied === null ? null : derivePalette({ accent: applied.accent, light: applied.light }),
    stale,
    label: applied === null
      ? `还没换过皮 —— 界面是 Ren'Py 生成器默认那一套(${resolution.width}×${resolution.height})`
      : themeLabel(applied),
  }
}

/**
 * `.studio/theme.json` —— **换皮的事实**(不是"当前界面长什么样"的缓存)。
 *
 * 与发布/试玩同一种账本态度:这里只记"哪次换的、拿什么参数换的",
 * "那套参数与项目现在的分辨率还一致吗"由推导回答(`themeViewOf`)。
 */
export interface ThemeRecord {
  schemaVersion: 1
  spec: ThemeSpec
  appliedAt: string
  /** 换的时候用的 SDK(将来 SDK 升了,界面图该不该重出有个依据)。 */
  sdkVersion: string | null
  /** 搬进项目的界面图张数(如实记数,不假装"整套都换了")。 */
  images: number
}

/** 解析主题记录(坏 JSON / 形状不对 → null:当成"没换过皮",不猜)。 */
export function parseThemeRecord(text: string | null): ThemeRecord | null {
  if (text === null || text.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Partial<ThemeRecord>
  if (record.schemaVersion !== 1 || typeof record.appliedAt !== 'string') return null
  try {
    const spec = parseThemeSpec(record.spec ?? {})
    return {
      schemaVersion: 1,
      spec,
      appliedAt: record.appliedAt,
      sdkVersion: typeof record.sdkVersion === 'string' ? record.sdkVersion : null,
      images: typeof record.images === 'number' ? record.images : 0,
    }
  } catch {
    return null
  }
}

/**
 * 换皮要写进 `gui.rpy` 的那些 define。
 *
 * `gui.hover_color` 在内核模板里是**表达式**(`Color(gui.accent_color).tint(.6)`)——
 * 保持表达式、还是钉成字面量,都是一套自洽的值。这里钉成**字面量**:
 * 一是与引擎自己的 `generate_gui --update-code` 输出**逐字一致**(实测),
 * 二是防止模板里留下"别的 accent 算出来的"陈旧字面量(比如 `gui.muted_color` 就是字面量)。
 * 模板缺哪一条就**补在末尾**(不静默跳过),这样"面板预览的颜色"与"引擎渲染的颜色"永远同源。
 *
 * 值用**单引号**:引擎自己的 `update_defines` 就是 `repr(hexcode)`(单引号),这里逐字对齐 ——
 * 实测两边写给 `gui.rpy` 的那些行**完全相同**,于是"引擎重跑一次"也不会把文件变成另一种写法。
 */
export function themeDefines(spec: ThemeSpec): Array<{ name: string; value: string }> {
  const palette = derivePalette({ accent: spec.accent, light: spec.light })
  return [
    { name: 'gui.accent_color', value: palette.accent },
    { name: 'gui.selected_color', value: palette.selected },
    { name: 'gui.hover_color', value: palette.hover },
    { name: 'gui.muted_color', value: palette.muted },
    { name: 'gui.hover_muted_color', value: palette.hoverMuted },
    { name: 'gui.title_color', value: palette.title },
    { name: 'gui.idle_color', value: palette.idle },
    { name: 'gui.idle_small_color', value: palette.idleSmall },
    { name: 'gui.insensitive_color', value: palette.insensitive },
    { name: 'gui.text_color', value: palette.text },
    { name: 'gui.interface_text_color', value: palette.text },
    { name: 'gui.choice_button_text_idle_color', value: palette.idle },
    { name: 'gui.choice_button_text_insensitive_color', value: palette.insensitive },
  ].map((entry) => ({ name: entry.name, value: `'${entry.value}'` }))
}

/**
 * 把颜色 define 写进 `gui.rpy` 的文本(**纯函数**:进什么文本、出什么文本)。
 *
 * 它是"按行替换 + 缺则补"那个规则**唯一**的实现:引擎那边也是这个套路
 * (`gui7/code.py` 的 `update_defines`),两边写出来的行逐字一致(实测过),所以谁先谁后都不打架。
 * 只动 `define <名字> = …` 那一行,别的字节原样保留 —— `gui.rpy` 是**手写文件**,
 * 不是我们的生成物。
 *
 * **换行符按原样保留**:Windows 上 SDK 写出来的 `gui.rpy` 是 CRLF,只按 `\n` 切再拼回去
 * 会把被改的那几行变成 LF —— 一份文件里混两种换行(实测踩过:481 个 CRLF 变成 469 个)。
 * 所以这里按 `/\r?\n/` 切、把每行的换行符带着;新补的那几行用**文件自己的**那种。
 */
export function writeThemeDefines(source: string, spec: ThemeSpec): string {
  const wanted = new Map(themeDefines(spec).map((entry) => [entry.name, entry.value]))
  const seen = new Set<string>()
  const parts = source.split(/(\r?\n)/)
  // split 带捕获组:偶数下标是行、奇数下标是它后面那个换行符(最后一段可能没有换行)。
  const dominant = source.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i]!
    const eol = parts[i + 1] ?? ''
    // 行尾的回车**先摘掉**:`split(/(\r?\n)/)` 只在换行前切,末段(没有换行的那一行)会带着 `\r`。
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // 与引擎同一口径:不碰带缩进的 define(那些住在 `init python:` / `gui.variant(` 块里)。
    const match = /^define (.*?) =/.exec(line)
    const name = match === null ? null : match[1]!
    if (name === null || !wanted.has(name)) {
      out.push(raw + eol)
      continue
    }
    seen.add(name)
    out.push(`define ${name} = ${wanted.get(name)}` + (eol === '' ? dominant : eol))
  }
  for (const [name, value] of wanted) {
    if (seen.has(name)) continue
    out.push(`define ${name} = ${value}${dominant}`)
  }
  return out.join('')
}
