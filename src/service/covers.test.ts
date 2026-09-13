/**
 * T30(#38)守卫 —— 封面 / 主菜单背景 / 窗口图标。
 *
 * 这三张与**界面图**不是一回事,而且理由已在 SDK 源码里核实过
 * (`launcher/game/gui7/images.py:398,404,405` 的 `overwrite=False` + launcher 文案):
 * **生成器不覆盖它们** —— 它们是留给"人/工具"改的那三张。
 *
 * 两条最要紧的守卫:
 *  1. **规格**:主菜单/游戏菜单背景 = 项目分辨率(基准 1280×720);图标 = 正方形最佳。
 *     尺寸不对的图写进去,引擎不报错、但画面是歪的 —— 这类错只有真跑才看得见,
 *     所以要在**建任务那一刻**就拦住;
 *  2. **窗口图标那个坑**:`config.window_icon` 指向的文件不存在时引擎**不兜底**
 *     (`set_icon` 只 `except DownloadNeeded`;`renpy.loader.load` 抛 `FileNotFoundError`)
 *     → **启动期崩**。所以模板必须:① 先落一个默认图标;② 再设 config。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { COVER_TARGETS, coverTargetOf, expectedCoverSize } from './covers.ts'

const CHANNEL = {
  name: 'test-image',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'sk-image-secret',
  models: [{
    id: 'cover-model',
    adapter: 'openai-compatible' as const,
    capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
  }],
}

describe('封面 / 主菜单 / 窗口图标(T30)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t30-data-')
    projectsRoot = await makeTempDir('galfree-t30-projects-')
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: { http: { send: async () => ({ status: 200, text: '{}' }), download: async () => ({ status: 200, bytes: new Uint8Array(), contentType: '' }) }, channel: () => CHANNEL },
    })
    await service.createProject({ projectsRoot, name: 'cover', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ─── 规格(从钉版 SDK 读出来的那三条)──────────────────────────────

  it('三个目标各有固定路径与尺寸规格(就是生成器不覆盖的那三张)', () => {
    expect(COVER_TARGETS.map((target) => target.id).sort()).toEqual(['game_menu', 'main_menu', 'window_icon'])
    const mainMenu = coverTargetOf('main_menu')!
    expect(mainMenu.path).toBe('game/gui/main_menu.png')
    // 主菜单/游戏菜单背景 = 项目分辨率(基准 720p;1080p 项目就是 1920×1080)。
    expect(mainMenu.spec).toMatchObject({ aspect: 'screen', square: false })
    expect(expectedCoverSize(mainMenu)).toContain('1280×720')
    expect(expectedCoverSize(mainMenu, { width: 1920, height: 1080 })).toContain('1920×1080')
    // 图标:正方形最佳(引擎会补成正方形并缩到 ≤1024)。
    expect(coverTargetOf('window_icon')!.spec).toMatchObject({ square: true })
    expect(coverTargetOf('window_icon')!.path).toBe('game/gui/window_icon.png')
    // 认不出的 id 就是认不出(不猜一个目标)。
    expect(coverTargetOf('poster')).toBeNull()
  })

  // ─── 窗口图标那个坑:先落图,再设 config ──────────────────────────

  it('模板**先落一个默认图标**:`gui/window_icon.png` 建项目时就在(所以设 config 不会崩)', async () => {
    const root = (await service.listProjects()).find((project) => project.name === 'cover')!.root
    const icon = await readFile(join(root, 'game/gui/window_icon.png'))
    // 是个**真 PNG**:签名 + IHDR + IEND 三样都在(不是空文件、也不是占位文本)。
    // 为什么不查字节数:"大于 100 字节"这种断言换个夹具就假红,而"它是不是一张完整的 PNG"
    // 才是这条守卫真正在守的事(那个文件缺了/坏了 → 游戏启动即崩)。
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const text = icon.toString('latin1')
    expect(text).toContain('IHDR')
    expect(text).toContain('IEND')
  })

  it('模板里设了 `config.window_icon`(指向上一步那个文件)', async () => {
    const root = (await service.listProjects()).find((project) => project.name === 'cover')!.root
    const options = await readFile(join(root, 'game/options.rpy'), 'utf8')
    expect(options).toContain('config.window_icon')
    expect(options).toContain('gui/window_icon.png')
    // 设的那一行指的必须是**真存在的**那个文件(否则启动即崩)。
    const listed = /config\.window_icon\s*=\s*"([^"]+)"/.exec(options)
    expect(listed).not.toBeNull()
    await expect(readFile(join(root, 'game', listed![1]!))).resolves.toBeDefined()
  })

  // ─── 建任务:目标路径由规格定,不由调用方随便给 ──────────────────

  it('建封面任务:路径来自规格表,而且**模型与渠道照旧过门**', async () => {
    const task = await service.createCoverTask('cover', {
      target: 'main_menu', model: 'cover-model', prompt: '雨天的天台,主视觉',
    })
    expect(task).toMatchObject({
      kind: 'image',
      target: 'main_menu',
      outputPath: 'game/gui/main_menu.png',
      model: 'cover-model',
      state: 'queued',
    })
    // 没配渠道 / 模型不在目录里照样拒(与素材槽那条同一个门)。
    await expect(service.createCoverTask('cover', { target: 'main_menu', model: 'nope', prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown-image-model' })
  })

  it('认不出的目标 → 如实拒绝并列出有哪些(不猜一个路径往上写)', async () => {
    await expect(service.createCoverTask('cover', { target: 'poster' as never, model: 'cover-model', prompt: 'x' }))
      .rejects.toMatchObject({ code: 'unknown-cover-target' })
    await expect(service.createCoverTask('cover', { target: 'poster' as never, model: 'cover-model', prompt: 'x' }))
      .rejects.toThrow(/main_menu/)
  })
})
