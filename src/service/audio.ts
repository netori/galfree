/**
 * 音频文件池与引用处境(T17,纯函数 + 一次目录扫描)—— BGM/SE 接线的地基。
 *
 * 两条纪律:
 *  1. **池是派生的,没有手工登记**:`game/` 下凡是音频后缀的文件就是池成员 ——
 *     人把文件丢进去,编辑器立刻能选;文件删掉,池自己空掉。`.studio/` 里没有音频账本。
 *  2. **引用口径就是 Ren'Py 的口径**:`play music "audio/rain.ogg"` 里的字符串是
 *     **相对 `game/` 的路径**。这是从钉版 SDK 源码读出来的,不是猜的:
 *     `renpy.py:predefined_searchpath` 给的默认 searchpath 只有 `gamedir`,
 *     `config.search_prefixes` 默认是 `[""]`(见 `docs/contracts/stage-zero.md` 的 T17 节)。
 *     所以 `"rain.ogg"` 只在文件真的躺在 `game/rain.ogg` 时才算数,而不会被"顺手"在
 *     `game/audio/` 里找出来 —— 校验因此**不会误报**,也不会漏报。
 *
 * 引用缺失音频是**error**(ADR-0009 铁律:悬空引用=校验错误),并且定位到
 * "哪一场的哪一行";没人引用的池成员只是**信息**(`unused`),不进 lint 噪声。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DialectProblem, SceneNode, Statement } from './rpy/dialect.ts'

/** 认得的音频后缀(Ren'Py 支持的常见几档;判后缀,不解析内容)。 */
export const AUDIO_EXTENSIONS = ['ogg', 'oga', 'opus', 'mp3', 'wav', 'm4a', 'flac', 'aac'] as const

/**
 * 不扫的目录。
 *
 * `cache` / `saves`:Ren'Py 自己的运行目录,不会有素材。
 *
 * 注意 `voice/` **不在**这个名单里:语音文件仍然进池(见 `isVoicePath` ——
 * 它们只是不算"未使用")。"落盘 → 池里立刻有它"是 T29 的验收口径,别把它踢掉。
 */
const SKIP_DIRS = new Set(['cache', 'saves'])

export interface AudioFileEntry {
  /** **相对 `game/`** 的 POSIX 路径 —— 就是 `.rpy` 里该写的那一串。 */
  path: string
  /** 字节数(给面板显示;本票不做试听,所以不取内容指纹)。 */
  bytes: number
}

/** 剧本里的一条音频引用(带位置,面板与板都用它)。 */
export interface AudioReference {
  /** 写进 `.rpy` 的那一串原文(相对 game/)。 */
  ref: string
  action: 'play' | 'stop'
  channel: 'music' | 'sound' | 'voice'
  /** 引用它的场景 label。 */
  scene: string
  /** 场景文件(相对 game/ 的 POSIX 路径)。 */
  file: string
  line: number
  /** 触发这次引用的原始语句(定位用)。 */
  snippet: string
  /** 池里找得到吗(大小写不敏感:Windows 上 Ren'Py 找得到)。 */
  found: boolean
  /** 找到时对应的池内路径(可能与写的字符串只有大小写差异)。 */
  resolved?: string
}

export interface AudioDerivation {
  /** 池成员(`game/` 下的音频文件,排序稳定)。 */
  files: AudioFileEntry[]
  /** 剧本里全部的音频引用(按场景/行序)。 */
  references: AudioReference[]
  /** 引用了但池里没有的(与板上 problems 同源)。 */
  missing: AudioReference[]
  /** 池里有、剧本里没人引用的(信息,不是错误)。 */
  unused: string[]
  /** 悬空引用 → error(定位到场景与行)。 */
  problems: DialectProblem[]
}

export function isAudioPath(path: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext !== undefined && (AUDIO_EXTENSIONS as readonly string[]).includes(ext)
}

/** 音频文件池(派生的视图;面板的选单与板上的判断读同一份)。 */
export interface AudioPoolView {
  files: AudioFileEntry[]
  references: AudioReference[]
  missing: AudioReference[]
  unused: string[]
}

/**
 * 扫 `game/` 下全部的音频文件(递归;**唯一**一处落盘读取)。
 * 缺目录不算错(模板一定有,但项目可能被人清掉)—— 空池就是空池。
 *
 * 为什么不复用 `rpy/files.ts` 的遍历:那一个只认叙述 `.rpy`、**不跳任何目录**
 * (Ren'Py 会加载 `game/` 下任意深度的 `.rpy`,跳了就是漏);音频这边跳 `cache`/`saves`
 * (那是运行目录,里面就算有音频也不是项目内容),排序也用字节序而不是 locale 序
 * (池的顺序要在任何人的机器上一样)。两处的取舍都写在自己的文件里,不共用一套开关。
 */
export async function readAudioFiles(gameDir: string): Promise<AudioFileEntry[]> {
  const found: AudioFileEntry[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      if (!entry.isFile() || !isAudioPath(entry.name)) continue
      try {
        const info = await stat(join(dir, entry.name))
        found.push({ path: `${prefix}${entry.name}`, bytes: info.size })
      } catch { /* 读不到就跳过:池不该因为一个坏文件整体失败 */ }
    }
  }
  await walk(gameDir, '')
  // 排序用字节序而不是 locale 序:池的顺序在任何人机器上都一样。
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 引用字符串规范化:去空白、统一斜杠、去掉开头的 `./`。 */
export function normalizeAudioRef(ref: string): string {
  return ref.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 引用 → 池内文件。
 *
 * 精确匹配优先;找不到再按**大小写不敏感**匹配(Windows 的文件系统就是这样的,
 * 在这上面报"缺失"会是假阳性 —— 而假阳性比漏报更糟)。找不到就是找不到,不猜。
 */
export function resolveAudioRef(ref: string, files: AudioFileEntry[]): AudioFileEntry | undefined {
  const normalized = normalizeAudioRef(ref)
  const exact = files.find((file) => file.path === normalized)
  if (exact !== undefined) return exact
  const lower = normalized.toLowerCase()
  return files.find((file) => file.path.toLowerCase() === lower)
}

/** 场景语句里的音频引用(菜单选项体里也算 —— 那同样是会响的接线)。 */
function audioStatements(statements: Statement[]): Array<Extract<Statement, { kind: 'audio' }>> {
  const found: Array<Extract<Statement, { kind: 'audio' }>> = []
  for (const statement of statements) {
    if (statement.kind === 'audio') found.push(statement)
    else if (statement.kind === 'menu') for (const choice of statement.choices) found.push(...audioStatements(choice.body))
  }
  return found
}

/** 语句原文(定位用):从场景原始文本块里按行号取那一行。 */
function lineOf(scene: SceneNode, line: number): string {
  return scene.text.split('\n')[line - scene.line]?.trim() ?? ''
}

/**
 * 引用处境 + 悬空引用(纯函数)。
 * `files` 由调用方扫盘得到 —— 这个函数不碰磁盘,所以它与板上的其他推导同一条路数。
 */
export function deriveAudio(input: { scenes: SceneNode[]; files: AudioFileEntry[] }): AudioDerivation {  const references: AudioReference[] = []
  const problems: DialectProblem[] = []
  const used = new Set<string>()

  for (const scene of input.scenes) {
    for (const statement of audioStatements(scene.statements)) {
      // `stop <channel>` 不带文件 —— 它不是"对某个音频文件的引用",所以不进引用清单
      // (它当然也不需要存在性:停一个声道本来就不需要文件)。
      if (statement.file === null) continue
      const ref = statement.file
      const found = resolveAudioRef(ref, input.files)
      if (found !== undefined) used.add(found.path)
      const entry: AudioReference = {
        ref,
        action: statement.action,
        channel: statement.channel,
        scene: scene.label,
        file: scene.file,
        line: statement.line,
        snippet: lineOf(scene, statement.line),
        found: found !== undefined,
        ...(found === undefined ? {} : { resolved: found.path }),
      }
      references.push(entry)
      if (found !== undefined) continue
      problems.push({
        severity: 'error',
        file: scene.file,
        line: statement.line,
        code: 'missing-audio',
        message: `场景 ${scene.label} 要播「${ref}」,但 game/${normalizeAudioRef(ref)} 不存在(音频引用是悬空引用:先把这个文件丢进项目,或改成本地已有的那一个)`,
        snippet: entry.snippet,
      })
    }
  }

  const unused = input.files
    .filter((file) => !used.has(file.path) && !isVoicePath(file.path))
    .map((file) => file.path)
  return { files: input.files, references, missing: references.filter((reference) => !reference.found), unused, problems }
}

/**
 * 语音文件**不算"未使用"**(2026-09-19)。
 *
 * 为什么:`unused` 问的是"这份素材丢进项目了、却没有任何 `play` 引用它吗?" ——
 * 那是 BGM/SE 的问题。而语音**按设计就不写 `play` 语句**:ADR-0013 让引擎按**对话 id**
 * 去 `game/voice/<id>.ogg` 自动找(`config.auto_voice`)。所以拿 play 引用去衡量语音,
 * 得出的"未使用"是**假事实** —— 实测:这一部戏 655 条语音全被报成 unused。
 *
 * 语音文件**仍然留在 `files` 里**(不从这个池里踢出去):T29 的验收之一就是
 * "产物落进 `game/voice/` → **池里立刻有它**",那是"写真的落盘了"的观察口。
 */
function isVoicePath(path: string): boolean {
  return path.startsWith('voice/')
}

export function poolViewOf(derivation: AudioDerivation): AudioPoolView {
  const { files, references, missing, unused } = derivation
  return { files, references, missing, unused }
}
