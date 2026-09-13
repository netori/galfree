/**
 * T31(#39)守卫 —— **换皮这条写路**(假生成器:不起真引擎,但写盘、快照、账本全是真的)。
 *
 * 三条最要紧的:
 *
 *  1. **整套替换是"经写网关的一个写批"**(ADR-0004):一次几十张 + 颜色 define + 一条主题
 *     记录,同一个批、同一条快照 —— 半套写进去的界面是最坏的结果(主菜单缺块);
 *  2. **老项目那件事要如实说清**:换皮会把 `game/gui/` 整套替换(AC 要求),
 *     面板读的是 `previewTheme` 的数(不是它自己数);
 *  3. **分辨率对不上就拒绝**:界面图是按项目分辨率缩放的,那一步"不报错、只是整屏歪"。
 *
 * 真引擎那半在 `theme.slow.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { generateThemedImages, REQUIRED_THEME_IMAGES, type ThemePorts } from './theme-runner.ts'
import { GUI_CODE_FILE, THEME_FILE, writeThemeDefines } from './theme.ts'

/** gui7 生成器会画的那 24 张(路径是项目根相对)。 */
const GUI7_IMAGES = [
  'game/gui/bubble.png', 'game/gui/game_menu.png', 'game/gui/main_menu.png',
  'game/gui/namebox.png', 'game/gui/notify.png', 'game/gui/nvl.png', 'game/gui/skip.png',
  'game/gui/textbox.png', 'game/gui/thoughtbubble.png', 'game/gui/window_icon.png',
  'game/gui/frame.png',
  'game/gui/button/choice_hover_background.png', 'game/gui/button/choice_idle_background.png',
  'game/gui/button/quick_hover_background.png', 'game/gui/button/quick_idle_background.png',
  'game/gui/overlay/confirm.png', 'game/gui/overlay/game_menu.png', 'game/gui/overlay/main_menu.png',
  'game/gui/phone/textbox.png', 'game/gui/phone/nvl.png',
  'game/gui/phone/overlay/game_menu.png', 'game/gui/phone/overlay/main_menu.png',
  'game/gui/phone/button/choice_hover_background.png', 'game/gui/phone/button/choice_idle_background.png',
]

/** 引擎那边 `_gui_images()` 补的那一批(条、滑块、滚动条、存档格)。 */
const ENGINE_IMAGES = [
  'game/gui/bar/left.png', 'game/gui/bar/right.png', 'game/gui/bar/top.png', 'game/gui/bar/bottom.png',
  'game/gui/button/idle_background.png', 'game/gui/button/hover_background.png',
  'game/gui/button/check_foreground.png', 'game/gui/button/check_selected_foreground.png',
  'game/gui/button/radio_foreground.png', 'game/gui/button/radio_selected_foreground.png',
  'game/gui/button/slot_idle_background.png', 'game/gui/button/slot_hover_background.png',
  'game/gui/slider/horizontal_idle_bar.png', 'game/gui/slider/horizontal_idle_thumb.png',
  'game/gui/slider/horizontal_hover_bar.png', 'game/gui/slider/horizontal_hover_thumb.png',
  'game/gui/slider/vertical_idle_bar.png', 'game/gui/slider/vertical_idle_thumb.png',
  'game/gui/slider/vertical_hover_bar.png', 'game/gui/scrollbar/horizontal_idle_bar.png',
  'game/gui/scrollbar/horizontal_idle_thumb.png', 'game/gui/scrollbar/vertical_idle_bar.png',
  'game/gui/scrollbar/vertical_idle_thumb.png',
]

const PRODUCED = [...GUI7_IMAGES, ...ENGINE_IMAGES]

/**
 * 假生成器:它**照着真生成器的形状**往 staging 里写图(同一个 `game/gui/` 布局),
 * 但内容是可辨认的"这次主题的产物" —— 于是"新的一套真的覆盖了旧的一套"可断言。
 *
 * `sdkDir` 传真夹具目录:生产路径要真的去 SDK 里找 `launcher/game/gui7`
 * (那条"SDK 完整不完整"的检查不该被夹具绕过去)。
 */
function fakeThemePorts(
  options: { sdkDir?: string | null; produced?: string[]; launcher?: string | null; exitCode?: number } = {},
): ThemePorts & { engineRuns: number } {
  const produced = options.produced ?? PRODUCED
  const ports = {
    engineRuns: 0,
    resolveSdkDir: async () => (options.sdkDir === undefined ? null : options.sdkDir),
    resolveLauncher: async () => (options.launcher === undefined ? '/fake/sdk/renpy.exe' : options.launcher),
    sdkVersion: async () => '8.5.3',
    makeStageDir: async () => await makeTempDir('galfree-theme-stage-'),
    copyTree: async (from: string, to: string) => { await cp(from, to, { recursive: true }) },
    listFiles: async (dir: string): Promise<string[]> => {
      const found: string[] = []
      const walk = async (current: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) await walk(join(current, entry.name), rel)
          else found.push(rel)
        }
      }
      try { await walk(dir, '') } catch { return [] }
      return found
    },
    readBytes: async (path: string) => await readFile(path),
    runEngine: async (_launcher: string, root: string) => {
      ports.engineRuns += 1
      if (options.exitCode !== undefined && options.exitCode !== 0) return { code: options.exitCode, log: 'boom\n' }
      for (const path of produced) {
        const abs = join(root, ...path.split('/'))
        await mkdir(join(abs, '..'), { recursive: true })
        // 产物打上"这次主题"的记号:断言"覆盖"就靠它。
        await writeFile(abs, `png:${path}`)
      }
      return { code: 0, log: "Ren'Py 8.5.3\n" }
    },
    remove: async (path: string) => { await rm(path, { recursive: true, force: true }) },
  }
  return ports as unknown as ThemePorts & { engineRuns: number }
}

describe('界面换皮:写路(T31/#39)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t31-data-')
    projectsRoot = await makeTempDir('galfree-t31-projects-')
  })

  afterEach(async () => {
    await service?.dispose()
    await cleanupTempDirs()
  })

  async function createProject(themePorts?: ThemePorts, name = 'theme'): Promise<string> {
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      ...(themePorts === undefined ? {} : { theme: themePorts }),
    })
    await service.createProject({ projectsRoot, name, title: '换皮' })
    return join(projectsRoot, name)
  }

  it('还没换过皮:板上如实说"还是默认那一套",而且**不编一套默认色**出来', async () => {
    await createProject(fakeThemePorts({ sdkDir }))
    const view = await service.theme('theme')
    expect(view.applied).toBeNull()
    expect(view.palette).toBeNull()
    expect(view.resolution).toEqual({ width: 1280, height: 720 })
    expect(view.stale).toBe(false)
    expect(view.label).toContain('还没换过皮')
    // 板上那一格与 theme() 是同一份(不是两处各算一遍)。
    const board = await service.progress('theme')
    expect(board.theme).toEqual(view)
    // 界面代码是模板那份:**没有**我们写过的主题色(否则说明上面读的是幻觉)。
    const code = await readFile(join(projectsRoot, 'theme', GUI_CODE_FILE), 'utf8')
    expect(code).not.toContain("define gui.accent_color = '#c94f7c'")
  })

  it('换皮:整套图 + 颜色 define + 主题记录**同一个写批**(一条快照),老文件被如实删掉', async () => {
    const ports = fakeThemePorts({ sdkDir })
    const root = await createProject(ports)
    // 造一张"新的一套里没有"的旧图(真项目上就是 `phone/` 那种只在小屏变体下生成的图)。
    await service.writeProjectFiles('theme', [
      { path: 'game/gui/phone/legacy.png', content: Buffer.from('old'), expectVersion: 'absent' },
    ], { origin: 'agent', reason: 'seed' })

    const report = await service.applyTheme('theme', { spec: { accent: '#c94f7c', boring: '#1b1b22' } }, { via: 'human' })
    expect(ports.engineRuns).toBe(1)
    expect(report).toMatchObject({ images: PRODUCED.length, removed: ['game/gui/phone/legacy.png'] })
    // 模板本来就带了 textbox/main_menu 那几张 → 它们是"覆盖",不是"新增"。
    expect(report.replaced).toBeGreaterThan(0)
    expect(report.replaced + report.added).toBe(PRODUCED.length)
    expect(report.label).toContain('#c94f7c')
    expect(report.label).toContain('1280×720')

    // ① 图真的换了(内容是新一套的记号)。
    expect((await readFile(join(root, 'game/gui/textbox.png'))).toString()).toBe('png:game/gui/textbox.png')
    // ② 新的一套里的图都在。
    for (const path of REQUIRED_THEME_IMAGES) {
      expect((await readFile(join(root, ...path.split('/')))).byteLength).toBeGreaterThan(0)
    }
    // ③ 旧的那张不在新一套里 → 删掉了(留一张旧主题的图 = 界面上留一块旧颜色)。
    await expect(readFile(join(root, 'game/gui/phone/legacy.png'))).rejects.toThrow()
    // ④ 颜色 define 写进界面代码:值就是引擎那一套。
    const code = await readFile(join(root, GUI_CODE_FILE), 'utf8')
    expect(code).toContain("define gui.accent_color = '#c94f7c'")
    expect(code).toContain("define gui.hover_color = '#de95b0'")
    expect(code).toContain("define gui.muted_color = '#501f31'")
    // ⑤ 主题记录落盘,而且板子立刻看得见"现在是什么主题"。
    const record = JSON.parse(await readFile(join(root, THEME_FILE), 'utf8'))
    expect(record).toMatchObject({ schemaVersion: 1, images: PRODUCED.length, sdkVersion: '8.5.3' })
    const view = await service.theme('theme')
    expect(view.applied).toMatchObject({ accent: '#c94f7c', boring: '#1b1b22', width: 1280, height: 720 })
    expect(view.palette).toMatchObject({ accent: '#c94f7c', hover: '#de95b0' })
    expect(view.stale).toBe(false)
    expect(view.label).toContain('#c94f7c')
  })

  it('换皮是**一个写批**:那一批里能同时看到图、define、主题记录(半套写进去是最坏的结果)', async () => {
    await createProject(fakeThemePorts({ sdkDir }))
    const report = await service.applyTheme('theme', { spec: { accent: '#2e7d5b' } }, { via: 'human' })
    const log = await service.writeLog('theme')
    const batch = log.filter((entry) => entry.batchId === report.batchId)
    expect(batch.some((entry) => entry.path === 'game/gui/textbox.png')).toBe(true)
    expect(batch.some((entry) => entry.path === GUI_CODE_FILE)).toBe(true)
    expect(batch.some((entry) => entry.path === THEME_FILE)).toBe(true)
    // 整个批就是"这一套图 + 界面代码 + 主题记录"。
    expect(batch).toHaveLength(PRODUCED.length + 2)
    // 而且**没有第二个批**(一次换皮 = 一条快照,回滚是一步的事)。
    expect(log.filter((entry) => entry.reason.startsWith('theme:'))).toHaveLength(PRODUCED.length + 2)
  })

  it('预演:要动多少 —— 面板读这份说清"整套替换"(不自己数),而且**预演不写盘不起引擎**', async () => {
    await createProject(fakeThemePorts({ sdkDir }))
    await service.writeProjectFiles('theme', [
      { path: 'game/gui/phone/legacy.png', content: Buffer.from('old'), expectVersion: 'absent' },
    ], { origin: 'agent', reason: 'seed' })
    // 模板自带的界面图(textbox/main_menu/bubble)也在 `game/gui/` 下 —— 预演要把它算进去。
    const seeded = (await readdir(join(projectsRoot, 'theme/game/gui'))).length

    const preview = await service.previewTheme('theme', { spec: { accent: '#c94f7c' } })
    expect(preview.resolution).toEqual({ width: 1280, height: 720 })
    expect(preview.spec).toMatchObject({ accent: '#c94f7c', light: false, width: 1280, height: 720 })
    expect(preview.from).toContain('还没换过皮')
    // 预演时还不知道新一套有几张(那要跑完引擎),所以按"现在这些都要重写"说 —— 那正是规模。
    expect(preview.images).toBe(seeded)
    expect(preview.replaced).toBe(seeded)
    // 除图之外还有两份要写:`game/gui.rpy` 与 `.studio/theme.json`。
    // 数字分开报,是为了让"整套替换"那句话对得上账(真换那一批 = images + extraWrites)。
    expect(preview.extraWrites).toBe(2)
    // 预演**不写盘、不起引擎、也不假装知道会删掉什么**(removed 留空)。
    expect(preview.removed).toEqual([])
    expect((await readFile(join(projectsRoot, 'theme/game/gui/phone/legacy.png'))).toString()).toBe('old')
  })

  it('预演与真换**同一道分辨率门**:对不上的值在预演就拒(不让人点下去才吃拒绝)', async () => {
    const ports = fakeThemePorts({ sdkDir })
    const root = await createProject(ports)
    const code = await readFile(join(root, GUI_CODE_FILE), 'utf8')
    await service.writeProjectFiles('theme', [{
      path: GUI_CODE_FILE,
      content: code.replace('gui.init(1280, 720)', 'gui.init(1920, 1080)'),
      expectVersion: (await service.readProjectFile('theme', GUI_CODE_FILE)).version,
    }], { origin: 'agent', reason: 'resolution' })

    await expect(service.previewTheme('theme', { spec: { accent: '#c94f7c' } }))
      .rejects.toMatchObject({ code: 'theme-resolution-mismatch' })
    // 而按项目分辨率给就过得去(预演是通道,不是墙)。
    const preview = await service.previewTheme('theme', { spec: { accent: '#c94f7c', width: 1920, height: 1080 } })
    expect(preview.resolution).toEqual({ width: 1920, height: 1080 })
    expect(ports.engineRuns).toBe(0)
  })

  it('写批的 origin 记**谁发起的**:人在面板点的那条路不能被记成 agent(审计链)', async () => {
    await createProject(fakeThemePorts({ sdkDir }))
    const fromPanel = await service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' })
    const fromAgent = await service.applyTheme('theme', { spec: { accent: '#2e7d5b' } }, { via: 'agent' })
    const log = await service.writeLog('theme')
    const originOf = (batchId: number): string | undefined => log.find((entry) => entry.batchId === batchId)?.origin
    expect(originOf(fromPanel.batchId)).toBe('workbench')
    expect(originOf(fromAgent.batchId)).toBe('agent')
  })

  it('分辨率对不上 → 如实拒绝并说清后果(不出一套歪的图)', async () => {
    const ports = fakeThemePorts({ sdkDir })
    const root = await createProject(ports)
    // 把项目改成 1080p(改的是界面代码里那一行,那才是分辨率的真相)。
    const code = await readFile(join(root, GUI_CODE_FILE), 'utf8')
    await service.writeProjectFiles('theme', [{
      path: GUI_CODE_FILE,
      content: code.replace('gui.init(1280, 720)', 'gui.init(1920, 1080)'),
      expectVersion: (await service.readProjectFile('theme', GUI_CODE_FILE)).version,
    }], { origin: 'agent', reason: 'seed' })

    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c', width: 1280, height: 720 } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'theme-resolution-mismatch' })
    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c', width: 1280, height: 720 } }, { via: 'human' }))
      .rejects.toThrow(/1920×1080/)
    // 没跑引擎(拒绝了就别白跑一趟)。
    expect(ports.engineRuns).toBe(0)

    // 按项目分辨率给 → 过。板子也会显示 1080p。
    const report = await service.applyTheme('theme', { spec: { accent: '#c94f7c', width: 1920, height: 1080 } }, { via: 'human' })
    expect(report.label).toContain('1920×1080')
    expect((await service.theme('theme')).resolution).toEqual({ width: 1920, height: 1080 })
  })

  it('项目分辨率之后又被改了 → 板上标 stale(整套图是按旧尺寸出的)', async () => {
    const root = await createProject(fakeThemePorts({ sdkDir }))
    await service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' })
    expect((await service.theme('theme')).stale).toBe(false)

    const code = await readFile(join(root, GUI_CODE_FILE), 'utf8')
    await service.writeProjectFiles('theme', [{
      path: GUI_CODE_FILE,
      content: code.replace('gui.init(1280, 720)', 'gui.init(1920, 1080)'),
      expectVersion: (await service.readProjectFile('theme', GUI_CODE_FILE)).version,
    }], { origin: 'agent', reason: 'resolution' })

    const view = await service.theme('theme')
    expect(view.stale).toBe(true)
    expect(view.resolution).toEqual({ width: 1920, height: 1080 })
    // 记录还是 720p 那一套(事实没被改写)。
    expect(view.applied).toMatchObject({ width: 1280, height: 720 })
  })

  it('生成器炸了 / 图不全 → 如实报错,**项目一个字节都不动**(不写半套)', async () => {
    const root = await createProject(fakeThemePorts({ sdkDir, exitCode: 1 }))
    const before = await readFile(join(root, GUI_CODE_FILE), 'utf8')

    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'theme-generate-failed' })
    expect(await readFile(join(root, GUI_CODE_FILE), 'utf8')).toBe(before)
    await expect(readFile(join(root, THEME_FILE))).rejects.toThrow()
    expect(await service.theme('theme')).toMatchObject({ applied: null })

    // 图不全(引擎说成功,但少了 textbox.png)—— 换一个项目名,别踩上一个项目的目录。
    await createProject(fakeThemePorts({ sdkDir, produced: PRODUCED.filter((path) => path !== 'game/gui/textbox.png') }), 'partial')
    await expect(service.applyTheme('partial', { spec: { accent: '#c94f7c' } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'theme-images-missing' })
    expect(await service.theme('partial')).toMatchObject({ applied: null })
  })

  it('SDK 没就绪 / 没装配端口 → 如实拒绝(不假装换好了)', async () => {
    await createProject(fakeThemePorts({ sdkDir: null }))
    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'sdk-not-ready' })

    // 没装配端口(生产上"这台宿主没这条能力")。
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'theme-unavailable' })
  })

  it('SDK 里没有生成器 → 如实拒绝(而不是静默出一套空图)', async () => {
    const bare = await makeTempDir('galfree-t31-bare-sdk-')
    await createProject(fakeThemePorts({ sdkDir: bare }))
    await expect(service.applyTheme('theme', { spec: { accent: '#c94f7c' } }, { via: 'human' }))
      .rejects.toMatchObject({ code: 'sdk-incomplete' })
    // 而且这次失败之后项目照旧可用。
    expect((await service.theme('theme')).applied).toBeNull()
  })

  it('颜色 define 那条规则只有一份实现:服务写的与 theme.ts 的纯函数逐字相同', async () => {
    const root = await createProject(fakeThemePorts({ sdkDir }))
    await service.applyTheme('theme', { spec: { accent: '#c94f7c', light: true } }, { via: 'human' })
    const written = await readFile(join(root, GUI_CODE_FILE), 'utf8')
    // 服务的产物 = 纯函数作用于**模板文本**(同一套值、同一套换行)。
    const template = await readFile(join(sdkDir, 'gui', 'game', 'gui.rpy'), 'utf8')
    expect(written).toBe(writeThemeDefines(template, { accent: '#c94f7c', boring: '#000000', light: true, width: 1280, height: 720 }))
    expect(written).toContain("define gui.accent_color = '#c94f7c'")
    // 亮色主题那一支:文本色反相(与 accent 无关的那批固定值)。
    expect(written).toContain("define gui.selected_color = '#555555'")
    expect(written).toContain("define gui.text_color = '#404040'")
  })

  it('服务用的是 runner 那一份实现(不是自己又写了一遍收图逻辑)', async () => {
    const root = await createProject(fakeThemePorts({ sdkDir }))
    const generated = await generateThemedImages({
      projectRoot: root,
      sdkDir,
      launcher: '/x',
      spec: { accent: '#c94f7c', boring: '#000000', light: false, width: 1280, height: 720 },
      ports: fakeThemePorts({ sdkDir, exitCode: 1 }),
    }).catch((error: { code?: string }) => error)
    expect(generated).toMatchObject({ code: 'theme-generate-failed' })
  })
})

