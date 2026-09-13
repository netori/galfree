/**
 * 快带的**假 SDK 目录**:只放"新建项目时要从 SDK 拷的那几个界面文件"。
 *
 * 为什么需要它:建项目时必须拿到 SDK 的 GUI 模板(`screens.rpy` 等),否则项目连
 * 关窗确认都跑不了(实测崩在 `layout.yesno_prompt`)。快带不该依赖真 SDK(155MB),
 * 所以这里造一份**形状对、内容极简**的替身 —— 断言的是"拷过去了、路径对",
 * 而不是"SDK 的文件内容是什么"(那是慢带与真 SDK 的事)。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TEMPLATE_CJK_FONT, TEMPLATE_UI_FILES, TEMPLATE_WINDOW_ICON } from '../service/template.ts'
import { GalfreeError } from '../service/error.ts'
import { makeTempDir } from './tmp.ts'

/** 造一个假 SDK(界面文件 + 中文字体),返回它的根目录。 */
export async function makeFakeSdk(overrides: Record<string, string> = {}): Promise<string> {
  const dir = await makeTempDir('galfree-fake-sdk-')
  const target = join(dir, 'gui', 'game')
  await mkdir(target, { recursive: true })
  for (const name of TEMPLATE_UI_FILES) {
    // 假 SDK 的界面文件只放**方言子集内的最小构造**:快带断言的是"拷过去了、路径对";
    // 真 SDK 的 screens.rpy 长什么样(几百个 style/init)是慢带与真 SDK 的事。
    const content = overrides[name] ?? [
      `# 假 SDK 的 ${name}(快带夹具;内容极简,只为验"拷过去了")`,
      'label _galfree_fake_ui_start:',
      '    return',
      '',
    ].join('\n')
    await writeFile(join(target, name), content, 'utf8')
  }
  // 缺失场景要用:让调用方点名少拷哪个。
  for (const [name, content] of Object.entries(overrides)) {
    if (content === '') await writeFile(join(target, name), '', 'utf8')
  }
  // 中文字体(SDK 的 sdk-fonts/ 下):假一份极小内容,只为验"拷进项目了"。
  await mkdir(join(dir, 'sdk-fonts'), { recursive: true })
  await writeFile(join(dir, 'sdk-fonts', 'SourceHanSansLite.ttf'), Buffer.from([0x00, 0x01, 0x00, 0x00]))
  // 界面图(SDK 的 gui/game/gui/ 下):生产模板会把这些拷进项目(T18),
  // 其中 textbox.png 还是发布前置检查的哨兵 —— 假 SDK 少了它,快带建出来的项目
  // 就会永远被"界面图还没生成"拦着,测的就不是产品行为了。
  await mkdir(join(dir, 'gui', 'game', 'gui'), { recursive: true })
  for (const name of ['textbox.png', 'main_menu.png', 'bubble.png']) {
    await writeFile(join(dir, 'gui', 'game', 'gui', name), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }
  // 窗口图标的**默认来源**(T30 / #38):真 SDK 在 `launcher/game/gui7/icon.png`。
  // 夹具给一张**真的最小 PNG** —— 那个文件缺了会让游戏**启动即崩**,
  // 所以假 SDK 得像真 SDK 一样"有它",否则这条路在快带里测的就不是产品行为。
  await mkdir(join(dir, 'launcher', 'game', 'gui7'), { recursive: true })
  await writeFile(join(dir, 'launcher', 'game', 'gui7', 'icon.png'), MINIMAL_PNG)
  return dir
}

/**
 * 一张**真的最小 PNG**(1×1 透明)。
 *
 * 为什么不是随便几个字节:这个文件要过"是不是 PNG"这关,而且真实路径上它会被引擎读,
 * 夹具里留着假字节就会掩盖"拷过去的根本不是图"这种错。
 */
export const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * 快带用的**界面文件来源**(接缝的 `uiTemplate` 端口)。
 *
 * 用法:`createProjectService({ dataDir, uiTemplate: fakeUiTemplate(await makeFakeSdk()) })`
 * —— 于是"建项目必须带上 SDK 界面文件"这条铁律在快带里也成立(而不是被测试绕过)。
 *
 * 失败行为与生产实现**一致**:缺文件时报同一个业务码 `sdk-ui-missing` ——
 * 夹具若只抛 ENOENT,测出来的就不是产品行为(上一版正是这么错的)。
 */
export function fakeUiTemplate(sdkDir: string): (requested: string | undefined) => Promise<{ files: Array<{ path: string; content: string }>; binaryFiles: Array<{ path: string; content: Uint8Array }> }> {
  return async (requested) => {
    const dir = requested !== undefined && requested !== '' ? requested : sdkDir
    const files: Array<{ path: string; content: string }> = []
    for (const name of TEMPLATE_UI_FILES) {
      try {
        files.push({ path: `game/${name}`, content: await readFile(join(dir, 'gui', 'game', name), 'utf8') })
      } catch (error) {
        throw new GalfreeError(
          'sdk-ui-missing',
          `SDK 的界面模板里缺 ${name}:读不到(${String(error)})。请检查 SDK 是否完整。`,
        )
      }
    }
    const binaryFiles: Array<{ path: string; content: Uint8Array }> = []
    binaryFiles.push({
      path: `game/${TEMPLATE_CJK_FONT.target}`,
      content: await readFile(join(dir, 'sdk-fonts', TEMPLATE_CJK_FONT.source)),
    })
    // 界面图:生产模板也拷它们(缺了不阻断,但快带要能测到"拷过去了")。
    for (const name of ['textbox.png', 'main_menu.png', 'bubble.png']) {
      binaryFiles.push({
        path: `game/gui/${name}`,
        content: await readFile(join(dir, 'gui', 'game', 'gui', name)),
      })
    }
    // 窗口图标的默认值(T30 / #38):生产实现**缺它就不让建项目**(因为 config 已经指向它,
    // 缺了是启动期崩)—— 夹具照做,否则快带里的项目"能建起来"是假的。
    binaryFiles.push({
      path: `game/${TEMPLATE_WINDOW_ICON.target}`,
      content: await readFile(join(dir, ...TEMPLATE_WINDOW_ICON.source.split('/'))),
    })
    return { files, binaryFiles }
  }
}
