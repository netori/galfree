/**
 * 「本地 TTS 批量清单」(T29 / #37 的第一片)—— **不花上游额度**的那条路。
 *
 * 发起人原话:"要么你给出需要生成语音的 excel 等本地 tts 可以识别的批量"。
 * 这条路把 TTS 从"必须先选一家 API"里解出来:
 *
 *   `voiceBatch()` 导出清单(谁、哪一句、**id**、目标文件名)
 *     → 用你自己的本地 TTS 批量跑(它只认"文本 + 输出文件名")
 *     → 按文件名放回来
 *     → `importVoiceFiles()` 经**写网关**收进 `game/voice/`,池立刻有它
 *
 * ## 三条口径(都有守卫)
 *
 * 1. **`id` 就是文件名**(ADR-0013):`game/voice/<id>.<ext>` —— 清单里不再编第二套命名。
 *    引擎那边由 `config.auto_voice = "voice/{id}.ogg"` 找它;
 * 2. **导回要逐条报**:收进来的 / 缺的 / 多余的 / 对不上 id 的,四类分开说
 *    (静默跳过等于"以为配齐了其实没有声音");
 * 3. CSV 该引的引、该翻倍的翻倍 —— 台词里带逗号/引号/换行是常态,
 *    一次没处理好,整份清单就是错行的(而错行会在成片里变成"这句配着上一句的音")。
 */

/** 引擎认的音频后缀(与 T17 的池同一份口径)。 */
export const VOICE_AUDIO_EXTENSIONS = ['ogg', 'oga', 'opus', 'mp3', 'wav', 'm4a', 'flac'] as const

/** 同一 id 有多个候选时的优先级:ogg 是 Ren'Py 最顺的,mp3 兼容最广。 */
const EXTENSION_PRIORITY: Record<string, number> = {
  ogg: 0, oga: 1, opus: 2, mp3: 3, m4a: 4, wav: 5, flac: 6,
}

export interface VoiceBatchRow {
  /** 场景 label。 */
  scene: string
  /** 文件内行号(定位用;重生成会变,所以**不是**身份)。 */
  line: number
  /** 说话人变量名(旁白 = null)。 */
  speaker: string | null
  /** 台词原文(一个字不改 —— 本地 TTS 要念的就是它)。 */
  text: string
  /**
   * 对话 id(ADR-0013 的那根锚)。**它就是文件名**:
   * 已经写进 `.rpy` 的用那里的;还没写的由 `stampDialogueIds` 的规则派生(同一个 label + 序号)。
   */
  dialogueId: string
  /** 语音产物该落在哪(`game/voice/<id>.<ext>`;后缀由本地工具决定,这里给默认 ogg)。 */
  targetPath: string
  /** 这条还没生成(磁盘上没有对应文件)。 */
  missing: boolean
  /**
   * 这一句在 `.rpy` 里**带显式 id** 吗?
   *
   * `false` = 我们按序号给它派生了 id(清单/账本照旧能用),但**引擎不认这个名字** ——
   * Ren'Py 会用内容哈希当标识符,`config.auto_voice` 于是找一个不存在的文件、
   * **静默无声**。所以"文件配齐了"不等于"能听见":这条为 false 时先跑
   * `galfree_voice_wiring` 盖章。
   */
  stamped: boolean
}

export interface VoiceBatch {
  rows: VoiceBatchRow[]
  /** 还没生成的条数(一眼看出"还欠多少条")。 */
  missingVoiceFiles: number
  /** 默认后缀(清单里给的那个)。 */
  extension: string
}

export const VOICE_BATCH_HEADER = ['scene', 'line', 'speaker', 'dialogue_id', 'target_path', 'text'] as const

/**
 * 行 → 语音产物路径(`game/voice/<id>.<ext>`)。
 *
 * 唯一口径:与模板里 `config.auto_voice = "voice/{id}.ogg"` 对齐 ——
 * 换后缀也行(引擎按实际文件找),但**目录与文件名必须是这个**。
 */
export function voiceTargetPath(dialogueId: string, extension = 'ogg'): string {
  return `game/voice/${dialogueId}.${extension}`
}

/** CSV 单元格:该引就引、引号翻倍(Excel 与所有本地工具都认这一套)。 */
function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function renderVoiceBatchCsv(batch: VoiceBatch): string {
  const lines = [VOICE_BATCH_HEADER.join(',')]
  for (const row of batch.rows) {
    lines.push([
      csvCell(row.scene),
      csvCell(String(row.line)),
      csvCell(row.speaker ?? ''),
      csvCell(row.dialogueId),
      csvCell(row.targetPath),
      csvCell(row.text),
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}

/** JSON 形态(本地工具链更爱吃的那个)。 */
export function renderVoiceBatchJson(batch: VoiceBatch): string {
  return `${JSON.stringify({ extension: batch.extension, missingVoiceFiles: batch.missingVoiceFiles, rows: batch.rows }, null, 2)}\n`
}

/** 落盘目录里挑出来的候选文件(只给"名字 + 绝对路径",不认识别的)。 */
export interface VoiceFileCandidate {
  name: string
  path: string
}

export interface MatchedVoiceFile {
  dialogueId: string
  targetPath: string
  sourcePath: string
}

export interface VoiceMatchResult {
  imported: MatchedVoiceFile[]
  /** 同一个 id 有多个候选时,被挑剩下的那些(报出来,免得人以为都收进去了)。 */
  duplicates: VoiceFileCandidate[]
  /** 后缀是音频、但**对不上任何 id** 的文件(id 打错?别的游戏的?)。 */
  unknown: VoiceFileCandidate[]
  /** 对不上任何文件的那些行(还欠的)。 */
  missing: VoiceBatchRow[]
}

/** 从文件名取"基名"(去目录、去后缀)。 */
function stemOf(name: string): string {
  const base = name.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

function extensionOf(name: string): string {
  const base = name.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isVoiceAudioFile(name: string): boolean {
  return (VOICE_AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name))
}

/**
 * 清单行 × 落盘文件 → 四类结果(**纯函数**,守卫直接喂数组验)。
 *
 * 匹配规则只有一条:**文件名(去后缀)等于 id**。不猜相似度 ——
 * 猜错的代价是"这句配着上一句的音",比缺一条严重得多。
 */
export function matchVoiceFiles(rows: Array<Pick<VoiceBatchRow, 'dialogueId' | 'targetPath'>>, files: VoiceFileCandidate[]): VoiceMatchResult {
  const byId = new Map<string, VoiceFileCandidate[]>()
  const unknown: VoiceFileCandidate[] = []
  const ids = new Set(rows.map((row) => row.dialogueId))
  for (const file of files) {
    if (!isVoiceAudioFile(file.name)) continue
    const stem = stemOf(file.name)
    if (!ids.has(stem)) { unknown.push(file); continue }
    const bucket = byId.get(stem) ?? []
    bucket.push(file)
    byId.set(stem, bucket)
  }
  const imported: MatchedVoiceFile[] = []
  const duplicates: VoiceFileCandidate[] = []
  const missing: VoiceBatchRow[] = []
  for (const row of rows) {
    const candidates = byId.get(row.dialogueId)
    if (candidates === undefined || candidates.length === 0) {
      missing.push(row as VoiceBatchRow)
      continue
    }
    const sorted = [...candidates].sort((a, b) => {
      const pa = EXTENSION_PRIORITY[extensionOf(a.name)] ?? 99
      const pb = EXTENSION_PRIORITY[extensionOf(b.name)] ?? 99
      return pa - pb || a.name.localeCompare(b.name)
    })
    const chosen = sorted[0]!
    duplicates.push(...sorted.slice(1))
    // **产物路径保持清单里的约定**(`game/voice/<id>.ogg`)—— 收进来的文件叫什么后缀,
    // 落盘就用什么后缀:`{id}.{ext}`。这样一个 id 有 mp3/wav 两版时也能都留着(人自己挑)。
    const extension = extensionOf(chosen.name)
    const targetPath = row.targetPath.replace(/\.[A-Za-z0-9]+$/, `.${extension}`)
    imported.push({ dialogueId: row.dialogueId, targetPath, sourcePath: chosen.path })
  }
  return { imported, duplicates, unknown, missing }
}

// ─── 语音接线落地(ADR-0013 的两条前提)────────────────────────────────

/**
 * 项目里那行"引擎按 id 找语音文件"的配置(**字符串形态**)。
 *
 * **与模板写的那行逐字一致**(`template.ts` 的 `game/options.rpy`)—— 对不上就等于没配。
 * 2026-09-30 起它只是**老项目/老模板**的形态:新模板写的是函数形态
 * (`AUTO_VOICE_FUNCTION_RPY`,见下),两种引擎都认。
 */
export const AUTO_VOICE_LINE = 'define config.auto_voice = "voice/{id}.ogg"'

/**
 * **函数形态**的 `config.auto_voice`(T39 追加)—— 新模板默认写这一份,
 * `voiceWiring` 升级老项目时也用同一份(两处各写一遍必然分叉)。
 *
 * 为什么必须能是函数(实测,不是口味问题):不同的 TTS 给**不同的容器** ——
 * 小米 MiMo 只给 `wav / mp3 / pcm / pcm16`(向上游要 ogg 会被回
 * `Unsupported audio format: ogg`),本地 IndexTTS 给 ogg。字符串形态只能钉**一个**后缀,
 * 钉错了的表现是最坏的那一种:**引擎不报错、试玩也照过、就是没声音**
 * (9/19 那次"655 个语音文件一个不差、一句都不响"是同一个形状)。
 *
 * 引擎那边认这一条:`renpy/common/00voice.rpy:364-367` —— 字符串就
 * `config.auto_voice.format(id=tlid)`,**否则当可调用对象调**(所以这里返回的是
 * **相对 `game/` 的路径**,与字符串形态同一个口径)。
 */
export const AUTO_VOICE_FUNCTION_RPY = [
  '# 语音(T26 / ADR-0013):按**对话 id** 找 `game/voice/<id>.<后缀>` —— 剧本里不写 voice 语句。',
  '#',
  '# 为什么是**函数**不是字符串:不同的 TTS 给不同的容器(小米 MiMo 只给 wav/mp3,',
  '# 本地 IndexTTS 给 ogg)。字符串只能钉一个后缀,钉错了就是**引擎不报错、试玩也照过、',
  '# 就是没声音**;函数按磁盘上真有的后缀找,两种可以混着用。',
  '# 引擎认这一条:renpy/common/00voice.rpy:364-367(非字符串就当可调用对象调)。',
  'init python:',
  '    def _galfree_voice(voice_id):',
  '        for _ext in ("ogg", "oga", "opus", "mp3", "wav", "m4a", "flac"):',
  '            _name = "voice/{}.{}".format(voice_id, _ext)',
  '            if renpy.loadable(_name):',
  '                return _name',
  '        return "voice/{}.ogg".format(voice_id)',
  '',
  '    config.auto_voice = _galfree_voice',
].join('\n')

/** `config.auto_voice` 的形态(**推导**,不是配置)。 */
export type AutoVoiceForm = 'absent' | 'string' | 'function'

/**
 * 从 `options.rpy` 的原文里读出 `config.auto_voice` 是**哪种形态**。
 *
 * 为什么要有它(而不是 `includes('config.auto_voice')` 一句话):两种形态的**后果不同** ——
 * 字符串形态钉死一个后缀,磁盘上是别的后缀时引擎够不着(静默无声);函数形态不会。
 * 报告要说得出区别,就必须先分得出形态。
 */
export function readAutoVoice(optionsRpy: string): { form: AutoVoiceForm; extension: string | null; line: string } {
  if (!/config\s*\.\s*auto_voice/.test(optionsRpy)) return { form: 'absent', extension: null, line: '' }
  const stringForm = /config\s*\.\s*auto_voice\s*=\s*"([^"]*)"/.exec(optionsRpy)
  if (stringForm === null) return { form: 'function', extension: null, line: 'config.auto_voice = <函数>' }
  // `voice/{id}.ogg` → 取最后一个后缀;取不到后缀就如实给 null(不猜一个)。
  const tail = stringForm[1]!.replace(/\{id\}/g, 'x')
  const extension = /\.([A-Za-z0-9]+)$/.exec(tail)?.[1]?.toLowerCase() ?? null
  return { form: 'string', extension, line: stringForm[0].trim() }
}

/**
 * 把字符串形态那一行**整行换成**函数形态(找不到那一行 = 原样返回,不硬来)。
 *
 * 只动那一行:`options.rpy` 是**人的文件**,多改一个字都是越界。
 */
export function upgradeAutoVoice(optionsRpy: string): { text: string; upgraded: boolean } {
  const lines = optionsRpy.split('\n')
  const index = lines.findIndex((line) => /^\s*define\s+config\s*\.\s*auto_voice\s*=\s*"/.test(line))
  if (index < 0) return { text: optionsRpy, upgraded: false }
  lines.splice(index, 1, ...AUTO_VOICE_FUNCTION_RPY.split('\n'))
  return { text: lines.join('\n'), upgraded: true }
}

/** 一个场景的接线处境。 */
export interface VoiceWiringScene {
  label: string
  /** 相对 `game/` 的路径(如 `scenes/start.rpy`)。 */
  file: string
  /** 这一场有几条对白。 */
  dialogueCount: number
  /** 其中几条在 `.rpy` 里**带了显式 id**。 */
  stampedCount: number
  /** 有对白、但没盖全 ⇒ 这些句子**引擎找不到语音**(静默无声)。 */
  needsStamp: boolean
  /**
   * 这一场住在**手写文件**里(不在 `game/scenes/`)—— 生成器不越界,
   * 所以只报不改。
   */
  handWritten: boolean
}

export interface VoiceWiringReport {
  /**
   * `config.auto_voice` 在不在、是哪种形态。
   *
   * `form: 'string'` 时 `extension` 就是它钉死的那个后缀 —— 磁盘上是别的后缀时,
   * 那些文件**引擎够不着**(见 `unreachable`)。
   */
  autoVoice: { present: boolean; file: string; line: string; form: AutoVoiceForm; extension: string | null }
  /** `game/voice/` 下真有哪些后缀、各几个(推导:扫磁盘,不靠登记)。 */
  voiceFiles: { count: number; extensions: Array<{ extension: string; count: number }> }
  /**
   * 引擎**够不着**的语音文件数 —— 只可能出现在字符串形态下,而且它**不报错**:
   * 引擎按 `voice/{id}.<钉死的后缀>` 找,磁盘上是别的后缀 ⇒ 那一句就是没声音。
   */
  unreachable: { count: number; extensions: string[]; hint: string }
  scenes: VoiceWiringScene[]
  /** 本次真的动了哪些文件(`apply` 时才有)。 */
  changed: string[]
  /** 还有没有该补的(配置缺 / 形态够不着文件 / 有场景没盖全)。 */
  needsWiring: boolean
}
