/**
 * T31(#39)守卫 —— **界面换皮的参数那一半**(纯函数,不碰磁盘、不起引擎)。
 *
 * 为什么这一半值得单测:整个换皮的技术核心是"给 `gui7` 生成器一组参数",而
 * `launcher/game/gui7/parameters.py` 里那十来个颜色是**推导出来的**(tint / shade /
 * HSV 改写),不是随手挑的十六进制。推导错了的表现是"菜单能开、颜色不对",
 * 而真跑一次引擎要十几秒 —— 所以把那段数学搬成纯函数,用**真引擎跑出来的值**
 * 当期望(见本文件顶部那两组实测值),在这里钉住。
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_RESOLUTION,
  DEFAULT_THEME,
  derivePalette,
  GUI_IMAGE_DIR,
  hexcode,
  normalizeHexColor,
  parseColor,
  parseThemeRecord,
  parseThemeSpec,
  projectResolutionOf,
  shade,
  themeDefines,
  themeLabel,
  themeViewOf,
  tint,
  writeThemeDefines,
} from './theme.ts'

/**
 * 实测基准(2026-09-13,钉版 SDK)。
 *
 * 两条独立的真值来源,都不是本模块算出来的:
 *
 *  1. **`renpy.color.Color` 自己**(在 SDK 上跑 `PYTHONPATH=<sdk> python -c ...`)——
 *     `tint` / `shade` / HSV 改写是**引擎的**语义,这里抄的是它的输出;
 *  2. **像素**:把主题色写进 staging 副本的 `gui.rpy` → 跑 `renpy.exe <stage> quit`
 *     (项目里的 `guisupport.rpy` 会调 `gui7.generate_gui` + `_gui_images()`)→
 *     用 Pillow 读那几张纯色图的像素(菜单底、hover 按钮、滚动条滑块)。
 */
const ENGINE_COLORS = {
  /** 引擎给 `#00b8c3`(SDK 模板的默认主色)算出来的那一套 —— 与 SDK 的 gui.rpy 里写死的一致。 */
  teal: {
    tint60: '#66d4db',
    shade40: '#00494e',
    shade60: '#006e75',
    menu: '#2f3e3f',
    title: '#7ff7ff',
  },
  pink: { accent: '#c94f7c', tint60: '#de95b0', shade40: '#501f31', shade60: '#782f4a', menu: '#3f2f35', title: '#ff7fae' },
  green: { accent: '#2e7d5b', menu: '#2f3f38' },
} as const

/** 像素级实测(同一次探针;色值已换算成 hex)。 */
const ENGINE_PIXELS = {
  /** `#c94f7c` 那次的 `choice_hover_background.png`(不透明像素 (201,79,124))。 */
  pinkChoiceHover: '#c94f7c',
  /** 同一次的 `main_menu.png`(整张 (63,47,53))。 */
  pinkMenu: '#3f2f35',
  /** `#2e7d5b` 那次的 `scrollbar/horizontal_idle_thumb.png`((46,125,91))。 */
  greenScrollbarThumb: '#2e7d5b',
  /** 同一次的 `main_menu.png`((47,63,56))。 */
  greenMenu: '#2f3f38',
} as const

describe('界面换皮:参数与颜色推导(T31/#39)', () => {
  it('暗色主题:accent → 整套颜色与**引擎的** tint/shade/HSV 语义一致', () => {
    const palette = derivePalette({ accent: ENGINE_COLORS.pink.accent, light: false })
    // hover = accent.tint(.6);muted = accent.shade(.4);hover_muted = accent.shade(.6)。
    expect(palette.hover).toBe(ENGINE_COLORS.pink.tint60)
    expect(palette.muted).toBe(ENGINE_COLORS.pink.shade40)
    expect(palette.hoverMuted).toBe(ENGINE_COLORS.pink.shade60)
    // title / menu 走 HSV 改写(饱和度 .5/.25、明度 1.0/按主题取值)。
    expect(palette.title).toBe(ENGINE_COLORS.pink.title)
    expect(palette.menu).toBe(ENGINE_COLORS.pink.menu)
    // 固定值那一批(暗色):selected/idle/text/choice + 半透明的 insensitive。
    // insensitive 的 alpha 实测是 **7f**(127)不是 80 —— 引擎那边 `int(a * opacity)`
    // 在 `#888888` 上落到 127.49…,floor 给 127(这条差一个色阶,肉眼看不出来)。
    expect(palette).toMatchObject({
      selected: '#ffffff', idle: '#888888', idleSmall: '#aaaaaa',
      text: '#ffffff', choice: '#cccccc', insensitive: '#8888887f',
    })
    // accent 本身**原样传出**(拼错了 accent 却悄悄换个颜色最坑)。
    expect(palette.accent).toBe(ENGINE_COLORS.pink.accent)
    // 形状:不带 alpha 的明文色是 6 位,带 alpha 的只能是那把 8 位的(hexcode 的规矩)。
    for (const [name, value] of Object.entries(palette)) {
      expect(value, `${name} 不是 6/8 位小写 hex`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      if (name !== 'insensitive') expect(value, `${name} 不该带 alpha`).toHaveLength(7)
    }
  })

  it('SDK 模板那份默认主题也对得上:生成器写死的 muted/hover_muted 就是这两个值', () => {
    // SDK 的 `gui/game/gui.rpy` 里写死的 `gui.muted_color = "#00494e"` /
    // `gui.hover_muted_color = "#006e75"` —— 那是引擎拿默认主色 #00b8c3 算出来的,
    // 所以它是这条推导的**现成真值**(不用起引擎)。
    const palette = derivePalette({ accent: '#00b8c3', light: false })
    expect(palette.muted).toBe(ENGINE_COLORS.teal.shade40)
    expect(palette.hoverMuted).toBe(ENGINE_COLORS.teal.shade60)
    expect(palette.hover).toBe(ENGINE_COLORS.teal.tint60)
    expect(palette.menu).toBe(ENGINE_COLORS.teal.menu)
    expect(palette.title).toBe(ENGINE_COLORS.teal.title)
  })

  it('tint/shade 是**线性 RGB** 插值(不是 HLS):判据就是引擎那个红色', () => {
    // 这条防的是"照 docstring 想象"的错法:`renpy/color.py` 的 `_interpolate_tuple`
    // 看起来像 HLS 插值,而引擎实际跑的是线性 RGB —— `Color('#ff0000').tint(.5)`
    // 引擎给 `#ff7f7f`(= (255,127,127)),HLS 那条路会给 `#df9f9f`。
    expect(hexcode(tint(parseColor('#ff0000'), 0.5))).toBe('#ff7f7f')
    expect(hexcode(tint(parseColor('#ff0000'), 0.5))).not.toBe('#df9f9f')
    // 另一组锚点(与 SDK 模板写死的色值同源):
    const teal = parseColor('#00b8c3')
    expect(hexcode(tint(teal, 0.6))).toBe(ENGINE_COLORS.teal.tint60)
    expect(hexcode(shade(teal, 0.4))).toBe(ENGINE_COLORS.teal.shade40)
    expect(hexcode(shade(teal, 0.6))).toBe(ENGINE_COLORS.teal.shade60)
    // 两端是恒等式:全保留 = 原色;全给白/黑 = 白/黑。
    expect(hexcode(tint(teal, 1))).toBe('#00b8c3')
    expect(hexcode(shade(teal, 1))).toBe('#00b8c3')
    expect(hexcode(tint(teal, 0))).toBe('#ffffff')
    expect(hexcode(shade(teal, 0))).toBe('#000000')
  })

  it('换个 accent 不算"抄现成的":墨绿那组的菜单底色也对得上引擎实测像素', () => {
    const palette = derivePalette({ accent: ENGINE_COLORS.green.accent, light: false })
    expect(palette.accent).toBe(ENGINE_COLORS.green.accent)
    // 菜单底色:实测像素 (47,63,56) —— 它不是 accent 变暗那么简单,
    // 而是 HSV 里把饱和度压到 .25、明度按主题取值(暗 .25 / 亮 .75)。
    expect(palette.menu).toBe(ENGINE_COLORS.green.menu)
    expect(palette.menu).toBe(ENGINE_PIXELS.greenMenu)
    // 而那两张菜单图就是被它整张填满的(像素实测)。
    expect(derivePalette({ accent: ENGINE_COLORS.pink.accent, light: false }).menu).toBe(ENGINE_PIXELS.pinkMenu)
  })

  it('亮色主题:同一套公式走另一支(文本色反相、hover 不再 tint、menu 取值 .75)', () => {
    const dark = derivePalette({ accent: '#00b8c3', light: false })
    const light = derivePalette({ accent: '#00b8c3', light: true })
    expect(light).toMatchObject({
      selected: '#555555', idle: '#707070', idleSmall: '#606060',
      text: '#404040', choice: '#cccccc',
      // 亮色下 hover 就是 accent 本身(`hover_color = accent_color`,不 tint)。
      hover: '#00b8c3',
      // muted 一族在亮色下**往白里 tint**(暗色下是往黑里 shade),
      // 比例是 .6 / .4 那一对(与暗色那支对调)。
      muted: ENGINE_COLORS.teal.tint60,
      hoverMuted: '#99e2e7',
      insensitive: '#7070707f',
    })
    // 亮色那支的菜单底是**亮**的(value .75),暗色那支是暗的(value .25)——
    // 这正是"亮色主题"在整套界面图上的可见差别。
    expect(light.menu).toBe(ENGINE_COLORS.teal.menu.replace('2f3e3f', '8fbcbf'))
    expect(light.menu).not.toBe(dark.menu)
    expect(light.text).not.toBe(dark.text)
  })

  it('坏输入如实拒绝,不猜一个颜色(否则会写进项目界面文件)', () => {
    for (const bad of ['', 'c94f7c', '#c94f7', '#c94f7cff0', '#gggggg', 'rgb(1,2,3)', '#c94f7c ']) {
      expect(() => derivePalette({ accent: bad, light: false }), `应当拒绝 ${JSON.stringify(bad)}`)
        .toThrow(/颜色/)
    }
    // 合法形态照收,并**规范化成小写**(写进 .rpy 的大小写不该随人输入飘)。
    expect(normalizeHexColor('#C94F7C')).toBe('#c94f7c')
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc')
    expect(normalizeHexColor('#abcd')).toBe('#aabbccdd')
  })

  it('规格:基准分辨率与缩放公式来自 gui7 的 parameters.py(不是这里拍的)', () => {
    expect(BASE_RESOLUTION).toEqual({ width: 1280, height: 720 })
    // scale = min(w/1280, h/720) —— 所以 1920×1080 的缩放是 1.5,而 1280×1080 是 1.0。
    expect(themeLabel({ ...DEFAULT_THEME, width: 1920, height: 1080 })).toContain('1920×1080')
    expect(GUI_IMAGE_DIR).toBe('game/gui')
  })

  it('解析主题参数:缺省有据(accent/boring/分辨率),认不出的如实拒绝', () => {
    const spec = parseThemeSpec({ accent: '#C94F7C' })
    expect(spec).toMatchObject({ accent: '#c94f7c', light: false, width: 1280, height: 720 })
    // boring 是**文本框/底衬**那一族的颜色(gui7 的 second 参数),缺省是黑。
    expect(spec.boring).toBe('#000000')
    expect(parseThemeSpec({ boring: '#1B1B22' }).boring).toBe('#1b1b22')
    // 分辨率必须是正整数:0 / 负数 / 小数 / 缺失都是"认不出"。
    for (const bad of [0, -1280, 12.5, Number.NaN]) {
      expect(() => parseThemeSpec({ width: bad })).toThrow(/分辨率/)
    }
    expect(() => parseThemeSpec({ accent: 'red' })).toThrow(/颜色/)
  })

  it('项目分辨率:从 gui.init 那一行读(读不到 = 基准 1280×720,不猜)', () => {
    const fromRpy = '## 说明\ninit python:\n    gui.init(1920, 1080)\n'
    expect(projectResolutionOf(fromRpy)).toEqual({ width: 1920, height: 1080 })
    // 没有那一行:退回基准(新建项目就是它),不是 null —— 下游拿它算尺寸规格。
    expect(projectResolutionOf('define gui.accent_color = "#00b8c3"\n')).toEqual(BASE_RESOLUTION)
  })

  // ─── 写进 gui.rpy 的那些 define ──────────────────────────────────────

  it('换皮要写的颜色 define:与**引擎自己的输出**同一套值(实测对照)', () => {
    const defines = new Map(themeDefines({ ...DEFAULT_THEME, accent: '#c94f7c' }).map((d) => [d.name, d.value]))
    // 这一组是引擎 `generate_gui --update-code` 写进 gui.rpy 的原样(2026-09-13 实测,见探针):
    // 连**引号是单引号**都照抄 —— 两边写给同一份文件的行要逐字相同,否则"引擎重跑一次"
    // 就会把文件改成另一种写法(白留一条 diff)。
    expect(defines.get('gui.accent_color')).toBe("'#c94f7c'")
    expect(defines.get('gui.hover_color')).toBe("'#de95b0'")
    expect(defines.get('gui.muted_color')).toBe("'#501f31'")
    expect(defines.get('gui.hover_muted_color')).toBe("'#782f4a'")
    expect(defines.get('gui.insensitive_color')).toBe("'#8888887f'")
    expect(defines.get('gui.choice_button_text_idle_color')).toBe("'#888888'")
    expect(defines.get('gui.interface_text_color')).toBe("'#ffffff'")
    // 一份完整的清单:accent + hover 那两个 + 文本一族(少一条,面板预览就与渲染分叉)。
    expect([...defines.keys()]).toEqual([
      'gui.accent_color', 'gui.selected_color', 'gui.hover_color', 'gui.muted_color', 'gui.hover_muted_color',
      'gui.title_color', 'gui.idle_color', 'gui.idle_small_color', 'gui.insensitive_color', 'gui.text_color',
      'gui.interface_text_color', 'gui.choice_button_text_idle_color', 'gui.choice_button_text_insensitive_color',
    ])
  })

  it('写 define 只动那几行:别处的字节(含中文字体补丁那一段)原样保留', () => {
    const source = [
      '## 有没有 gui.title_color 这条 define 因模板而异',
      'init python:',
      '    gui.init(1280, 720)',
      '',
      'define gui.accent_color = "#00b8c3"',
      '# 注释里的 define gui.accent_color = "#000000" 不该被当成 define(带 # 前缀)',
      'define gui.hover_color = Color(gui.accent_color).tint(.6)',
      'define gui.muted_color = "#004e49"',
      'define gui.text_font = "fonts/SourceHanSansLite.ttf"',
      '',
      'init -100 python in gui:',
      '    def scale(n):',
      '        return int(n)',
      '',
    ].join('\n')
    const written = writeThemeDefines(source, { ...DEFAULT_THEME, accent: '#c94f7c' })

    // 改掉的:表达式与陈旧字面量都变成这一套的值。
    expect(written).toContain("define gui.accent_color = '#c94f7c'")
    expect(written).toContain("define gui.hover_color = '#de95b0'")
    expect(written).toContain("define gui.muted_color = '#501f31'")
    // 没被碰的:注释、init 块、中文字体那一行(逐字保留)。
    expect(written).toContain('# 注释里的 define gui.accent_color = "#000000" 不该被当成 define(带 # 前缀)')
    expect(written).toContain('    gui.init(1280, 720)')
    expect(written).toContain('define gui.text_font = "fonts/SourceHanSansLite.ttf"')
    expect(written).toContain('        return int(n)')
    // 模板里没有的(template 的 gui.rpy 没有 title_color / hover_muted_color 的 define)补在末尾。
    expect(written).toContain("define gui.title_color = '#ff7fae'")
    expect(written).toContain("define gui.hover_muted_color = '#782f4a'")
    // 幂等:同一份文本写两遍结果相同(换两次皮不会越写越长)。
    expect(writeThemeDefines(written, { ...DEFAULT_THEME, accent: '#c94f7c' })).toBe(written)
  })

  it('换行符按原样保留:CRLF 的 gui.rpy 不会被改成半 LF(SDK 在 Windows 上写的就是 CRLF)', () => {
    // 实测踩过:只按 \n 切再拼回去,会把被改的那几行变成 LF —— 一份文件里混两种换行。
    const source = [
      'define gui.accent_color = "#00b8c3"',
      'define gui.text_font = "fonts/SourceHanSansLite.ttf"',
      '',
    ].join('\r\n')
    const written = writeThemeDefines(source, { ...DEFAULT_THEME, accent: '#c94f7c' })
    expect(written).toContain("define gui.accent_color = '#c94f7c'\r\n")
    // 一个"裸 LF"(前面不是 \r 的 \n)都不该多出来。
    const bareLf = (written.match(/(?<!\r)\n/g) ?? []).length
    expect(bareLf, '新补的行也要用文件自己那种换行').toBe(0)
    // 反过来:LF 的文件不会被写成 CRLF。
    const lfSource = 'define gui.accent_color = "#00b8c3"\n'
    expect(writeThemeDefines(lfSource, { ...DEFAULT_THEME, accent: '#c94f7c' })).not.toContain('\r')
  })

  it('主题记录:坏 JSON / 缺字段 → 当成"没换过皮"(不猜一套主题出来)', () => {
    expect(parseThemeRecord(null)).toBeNull()
    expect(parseThemeRecord('')).toBeNull()
    expect(parseThemeRecord('{ 这不是 json')).toBeNull()
    expect(parseThemeRecord('{"schemaVersion":2,"appliedAt":"x"}')).toBeNull()
    expect(parseThemeRecord(JSON.stringify({ schemaVersion: 1, spec: { accent: 'red' }, appliedAt: 'x' }))).toBeNull()
    const good = parseThemeRecord(JSON.stringify({
      schemaVersion: 1, appliedAt: '2026-09-13T00:00:00.000Z', sdkVersion: '8.5.3', images: 52,
      spec: { accent: '#C94F7C', boring: '#1B1B22', light: false, width: 1920, height: 1080 },
    }))
    expect(good).toMatchObject({ images: 52, sdkVersion: '8.5.3', appliedAt: '2026-09-13T00:00:00.000Z' })
    // 记录里的主题色被规范化(写进 .rpy 的大小写不该随人输入飘)。
    expect(good!.spec).toMatchObject({ accent: '#c94f7c', boring: '#1b1b22', width: 1920, height: 1080 })
  })

  it('主题处境:记录的分辨率与项目现在的分辨率不一致 → 如实标"要重出"(不是静默沿用旧图)', () => {
    const applied = { ...DEFAULT_THEME, accent: '#c94f7c', width: 1280, height: 720 }
    const same = themeViewOf(applied, '2026-09-13T00:00:00.000Z', { width: 1280, height: 720 })
    expect(same.stale).toBe(false)
    expect(same.label).toContain('#c94f7c')
    expect(same.label).toContain('1280×720')
    expect(same.palette).toMatchObject({ accent: '#c94f7c' })

    const moved = themeViewOf(applied, '2026-09-13T00:00:00.000Z', { width: 1920, height: 1080 })
    expect(moved.stale).toBe(true)
    // 没换过皮时:如实说"还是默认那一套",而且 palette 是 null(不是编一套默认色出来)。
    const none = themeViewOf(null, null, { width: 1280, height: 720 })
    expect(none.stale).toBe(false)
    expect(none.palette).toBeNull()
    expect(none.label).toContain('还没换过皮')
  })
})
