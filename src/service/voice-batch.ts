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
 * 项目里那行"引擎按 id 找语音文件"的配置。**与模板写的那行逐字一致**
 * (`template.ts` 的 `game/options.rpy`)—— 对不上就等于没配。
 */
export const AUTO_VOICE_LINE = 'define config.auto_voice = "voice/{id}.ogg"'

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
  /** `config.auto_voice` 在不在(没有它引擎根本不找语音文件)。 */
  autoVoice: { present: boolean; file: string; line: string }
  scenes: VoiceWiringScene[]
  /** 本次真的动了哪些文件(`apply` 时才有)。 */
  changed: string[]
  /** 还有没有该补的(配置缺 / 有场景没盖全)。 */
  needsWiring: boolean
}
