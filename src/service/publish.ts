/**
 * 本地发布(T18;spec User Story 19)—— 用**钉版 SDK** 的 `build_dists` 产出可发行物。
 *
 * 三件事定死在这里:
 *
 *  1. **产物落在项目源树之外**(可配置输出目录)。发布不该往项目里塞 zip:
 *     源树是唯一真相、「改了什么」要看得清,构建产物在里面会让 diff 与快照一起变脏。
 *     目录配到了源树里 → 如实拒绝(`destination-in-project`)。
 *  2. **前置检查用板上的判断,不另算一套**:lint 错 / 素材缺 / 音频引用悬空 → 阻止并列缺项。
 *     板说"还没齐",发布就不该装作能出片。
 *  3. **事实进账本**:一次发布 = 一条 `.studio/publish.json` 记录(经网关 → 快照),
 *     板据此推导"上一次发布是什么时候、产物在哪、还新不新(stale)"。
 *
 * 平台上传与在线分发**不做**(spec Out of Scope);这里只把产物放到磁盘上并把路径说清楚。
 *
 * 命令形状来自钉版 SDK 源码(不是猜的):`distribute` 命令由 **launcher 项目**注册
 * (`launcher/game/distribute.rpy:1833`),参数 `--destination` / `--package <名>` 与一个
 * 位置参数 = 目标项目目录(`renpy.exe <launcher 目录> distribute --destination <输出>
 * --package pc <项目目录>`)。默认包名 `pc`(Windows + Linux,见 `renpy/common/00build.rpy`)。
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { GalfreeError } from './error.ts'
import { spawnWithLog } from './spawn-log.ts'
import type { ProgressSnapshot } from './progress.ts'

export const PUBLISH_FILE = '.studio/publish.json'
export const PUBLISH_SCHEMA = 1

/** 默认为 PC(Windows + Linux);Android 要另配 Android SDK,属于"可选"。 */
export const DEFAULT_PACKAGES = ['pc'] as const

export interface PublishArtifact {
  /** 文件名(给人看的;产物本身在输出目录里)。 */
  name: string
  /** **绝对路径**(在项目源树之外)。 */
  path: string
  bytes: number
}

/** 阻止发布的一项(与推导板同源,不是另算的一套)。 */
export interface PublishBlocker {
  code: 'lint-errors' | 'missing-slots' | 'missing-audio' | 'sdk-not-ready' | 'publish-unavailable' | 'destination-in-project' | 'build-identity-missing' | 'gui-images-missing'
  /** 面向人的一句话(面板与 agent 直接显示)。 */
  label: string
  count?: number
  /** 具体是哪些(槽名 / 音频引用 / 文件行),给人照着改。 */
  detail?: string
}

export interface PublishRun {
  at: string
  ok: boolean
  packages: string[]
  /** 输出目录(**绝对路径**,在项目源树之外)。 */
  destination: string
  artifacts: PublishArtifact[]
  exitCode: number
  /** 构建日志尾部(失败时给人看上游原话)。 */
  logTail: string
  /** 构建时的内容指纹(推导新鲜度用;与试玩同一口径)。 */
  fingerprint: string
}

export interface PublishDocument {
  schemaVersion: 1
  last: PublishRun | null
  history: PublishRun[]
}

/** 板上"发布"这一格的推导视图。 */
export interface PublishView {
  at: string
  ok: boolean
  destination: string
  packages: string[]
  artifacts: PublishArtifact[]
  logTail: string
  /** 产物之后内容又变了 → 它代表的不再是当前这一版。 */
  stale: boolean
}

export interface PublishReadiness {
  ready: boolean
  blockers: PublishBlocker[]
  /** 这一次会用到的输出目录(绝对路径;面板直接显示它)。 */
  destination: string | null
  packages: string[]
  /** 上一次发布的推导视图(没发布过 = null)—— 与 `progress.publish` 同一份。 */
  last: PublishView | null
}

export interface PublishReport extends PublishReadiness {
  /** 这一次真的产出可发行物了吗(被阻止或构建失败都是 false)。 */
  ok: boolean
  /** 真跑过才有(被阻止时缺省)。 */
  run?: PublishRun
}

/** 构建端口:生产 spawn 钉版 SDK;快带用假实现(协议形状不因测试而变)。 */
export interface PublishPorts {
  /** 解析 SDK 启动器;null = 未就绪(如实失败,不假装能构建)。 */
  resolveLauncher: () => Promise<string | null>
  /** 跑一次 `distribute`(注入端口)。 */
  run: (input: {
    launcher: string
    /** launcher **项目**目录(SDK 里注册 distribute 命令的那个项目)。 */
    launcherProject: string
    projectRoot: string
    destination: string
    packages: string[]
  }) => Promise<{ code: number; log: string }>
}

/**
 * **前置检查**:把板上的判断翻译成"能不能发布"。
 * 这里刻意**只读** `ProgressSnapshot`(同一个推导),不自己再算一遍 lint/素材 ——
 * 否则板上说缺、发布说能出,两边迟早分叉。
 */
export function publishBlockers(progress: ProgressSnapshot, options: { sdkReady: boolean; publishConfigured: boolean }): PublishBlocker[] {
  const blockers: PublishBlocker[] = []
  if (!options.publishConfigured) {
    blockers.push({ code: 'publish-unavailable', label: '这台宿主没有装配发布端口:装不上就老实说,不假装能出片' })
  }
  if (!options.sdkReady) {
    blockers.push({ code: 'sdk-not-ready', label: '钉版 SDK 尚未就绪(先完成 SDK 供给),没有它就没有构建器' })
  }
  if (!progress.lint.ok) {
    blockers.push({
      code: 'lint-errors',
      label: `lint 未过(${progress.lint.errors} 个 error):先修完板上的结构问题再发`,
      count: progress.lint.errors,
      detail: progress.problems.filter((problem) => problem.severity === 'error').slice(0, 10).map((problem) => `${problem.file}${problem.line === undefined ? '' : `:${problem.line}`} ${problem.message}`).join('\n'),
    })
  }
  const missingSlots = progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot)
  if (missingSlots.length > 0) {
    blockers.push({
      code: 'missing-slots',
      label: `素材缺(${missingSlots.length} 个槽还没有图):空槽发出去就是灰底`,
      count: missingSlots.length,
      detail: missingSlots.join('、'),
    })
  }
  const missingAudio = progress.audio.missing.map((reference) => `${reference.ref}(${reference.scene}:${reference.line})`)
  if (missingAudio.length > 0) {
    blockers.push({
      code: 'missing-audio',
      label: `音频引用悬空(${missingAudio.length} 处):那一段会静默没声音`,
      count: missingAudio.length,
      detail: missingAudio.join('、'),
    })
  }
  return blockers
}

/**
 * **构建标识检查**:`options.rpy` 里有没有 `build.name`。
 *
 * 这条是被真构建教出来的:Ren'Py 的 `build.name` 缺省是 `None`,于是
 * `directory_name` / `executable_name` 全空 —— 慢带里打出来的包真的叫 `-pc/`、主程序真的叫 `.exe`。
 * 那样的"发行物"发出去就是笑话,所以**当阻塞项拦下来**,并给出一行就能补上的写法。
 * (新项目由模板带上这一行;老项目要自己补,或者照着提示补。)
 */
export function buildIdentityBlockers(optionsRpy: string | null): PublishBlocker[] {
  // 先去掉注释再匹配:`# define build.name = …` 这种被注释掉的行不算"声明过"
  // (否则人以为填了,实际没生效,打出来的还是空名字的包)。
  const source = optionsRpy === null ? null : optionsRpy.replace(/(^|\s)#.*$/gm, '')
  if (source !== null && /^\s*(define\s+)?build\.name\s*=/m.test(source)) return []
  return [{
    code: 'build-identity-missing',
    label: '项目没有声明 build.name:Ren\'Py 会把包名与主程序名打成**空的**',
    detail: optionsRpy === null
      ? '缺 game/options.rpy;至少要有 `define build.name = "<项目名>"`(ASCII 名)'
      : '在 game/options.rpy 里加一行:`define build.name = "<项目名>"`(ASCII 名)—— 目录名会自动是 `<名字>-<版本>`,主程序是 `<名字>`',
  }]
}

/**
 * **界面图检查**(T18 慢带实测):`game/gui/` 里的界面图是 Ren'Py **首次运行时**生成进项目的
 * (SDK 的 `guisupport.rpy` → `gui7.generate_gui`),而**发行版里没有那个生成器**。
 *
 * 所以一个"从没跑过"的项目打出来的包,界面全是缺图占位。与其发出去才发现,不如在发布前
 * 如实拦下并告诉人怎么办:**先跑一次试玩**(那一刻界面图会落进项目,和别的素材一样进快照)。
 */
export const GUI_IMAGES_SENTINEL = 'textbox.png'

export function guiImagesBlockers(sentinelExists: boolean): PublishBlocker[] {
  if (sentinelExists) return []
  return [{
    code: 'gui-images-missing',
    label: '界面图还没生成(先在 SDK 里跑一次「试玩」):Ren\'Py 的界面图是首次运行时生成进项目的,发行版里没有那个生成器',
    detail: `判据是 game/gui/${GUI_IMAGES_SENTINEL} 不存在。跑一次试玩,界面图会落进项目(和别的素材一样进快照),再发布就是完整的`,
  }]
}

/**
 * 输出目录的**唯一**守卫:构建产物必须在项目源树之外。
 * 配到了源树里(等于把 dists 塞进项目)就如实拒绝 —— 源树是唯一真相,不是构建垃圾场。
 *
 * **跨盘符是个真陷阱**(Windows):`path.relative('C:\\proj', 'D:\\out')` 返回的是
 * **绝对路径** `D:\out`(不是 `..\…`)。只看"开不开头是 `..`"会把 C: 项目 + D: 输出目录
 * 误判成"在源树里" → 把合法配置拦死。所以先判 `isAbsolute`。
 */
export function assertDestinationOutsideProject(destination: string, projectRoot: string): void {
  const rel = relative(projectRoot, destination)
  const inside = rel === '' || (!isAbsolute(rel) && !rel.startsWith('..') && !rel.startsWith(`${sep}`))
  if (inside) {
    throw new GalfreeError(
      'destination-in-project',
      `发布输出目录不能放在项目源树里(${destination}):产物会混进 git 快照,源树就不再是干净的真相了。换一个项目外的目录`,
    )
  }
}

export async function readPublish(root: string): Promise<PublishDocument | null> {
  try {
    const doc = JSON.parse(await readFile(join(root, PUBLISH_FILE), 'utf8')) as PublishDocument
    if (doc.schemaVersion !== PUBLISH_SCHEMA) return null
    return doc
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GalfreeError('publish-ledger-corrupt', `发布账本无法解析:${String(error)}`)
  }
}

export function publishDocument(doc: PublishDocument): string {
  return `${JSON.stringify({ schemaVersion: PUBLISH_SCHEMA, last: doc.last, history: doc.history.slice(-20) }, null, 2)}\n`
}

/** 账本 + 当前内容指纹 → 板上的发布视图(纯推导)。 */
export function publishView(ledger: PublishDocument | null, currentFingerprint: string): PublishView | null {
  const last = ledger?.last ?? null
  if (last === null) return null
  return {
    at: last.at,
    ok: last.ok,
    destination: last.destination,
    packages: last.packages,
    artifacts: last.artifacts,
    logTail: last.logTail,
    stale: last.fingerprint !== currentFingerprint,
  }
}

/** 日志尾巴(失败时给人看上游原话;太长就只留末尾)。 */
export function logTailOf(log: string, limit = 4000): string {
  const trimmed = log.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

/**
 * 输出目录的递归遍历(**唯一**一处):`visit(相对名, 绝对路径, 字节数)`。
 * 构建前后各扫一遍(前 = 快照,后 = 清单),两边共用这一份 —— 目录规则只有一套。
 */
async function walkOutput(dir: string, visit: (name: string, abs: string, bytes: number) => void, prefix = ''): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await walkOutput(abs, visit, name)
      continue
    }
    if (!entry.isFile()) continue
    visit(name, abs, (await stat(abs)).size)
  }
}

/** 构建前的目录快照(名字 → 字节数)。 */
export async function snapshotDir(destination: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  await walkOutput(destination, (name, _abs, bytes) => map.set(name, bytes))
  return map
}

/**
 * **产物清单:构建**前后**比对目录**,而不是猜文件名。
 *
 * 猜名字(比如假定 `<name>-pc.zip`)在换包名/换版本号时会静默漏报;比对目录则是
 * "这一次构建**真的**多出了什么"——上游改了命名口径也不会让我们报错东西。
 */
export async function collectArtifacts(destination: string, before: Map<string, number>): Promise<PublishArtifact[]> {
  const found: PublishArtifact[] = []
  await walkOutput(destination, (name, abs, bytes) => {
    const previous = before.get(name)
    if (previous !== undefined && previous === bytes) return
    found.push({ name, path: abs, bytes })
  })
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 一次构建的最长等待:打包几百 MB 很慢,但也不能无限期挂着。 */
export const PUBLISH_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 真构建(Host 装配用):`renpy.exe <launcher 项目> distribute --destination … --package … <项目>`。
 *
 * `windowsHide: true` 是对的(这是**命令行构建**,不该弹窗);与试玩那条相反 ——
 * 试玩必须让游戏窗口出现在人眼前(那一课写在 `spawn-log.ts` 的注释里)。
 */
export async function realDistribute(input: {
  launcher: string
  launcherProject: string
  projectRoot: string
  destination: string
  packages: string[]
  timeoutMs?: number
}): Promise<{ code: number; log: string }> {
  const timeoutMs = input.timeoutMs ?? PUBLISH_TIMEOUT_MS
  await mkdir(input.destination, { recursive: true })
  return await spawnWithLog(input.launcher, [
    input.launcherProject,
    'distribute',
    '--destination', input.destination,
    ...input.packages.flatMap((pkg) => ['--package', pkg]),
    input.projectRoot,
  ], {
    timeoutMs,
    windowsHide: true,
    timeoutNote: `[GALFREE] 构建等待超时(${Math.round(timeoutMs / 1000)} 秒),已中止构建进程。`,
  })
}
