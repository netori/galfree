/**
 * 场景表单模型(纯函数)—— T11 的核心。
 *
 * 编辑器要"逐行改",而 `.rpy` 里还有注释、空行这些**人不编辑但绝不能被吃掉**的东西。
 * 所以这里不做"解析 → 重新生成整个文件"那种事(那会把注释和格式全冲掉,也会让 diff
 * 变成全文件重写,直接违反 T11 的最小化 AC),而是:
 *
 *   原始文本 → 行(model)→ 编辑只动被指定的那一行 → 拼回去
 *
 * 行模型保留每一行的**原文**(`raw`)与**行号**(1 基,与解析器同口径),因此:
 *  - 未编辑的行按原文逐字回写(缩进、注释、空行、行尾都原样);
 *  - 编辑只替换目标行的文本,其余一行不动 → git diff 只有那一行。
 *
 * 行类型直接对应方言子集的语句形状(见 docs/contracts/dialect-subset.md),这样表单与
 * 解析器看到的是同一套词汇。
 */
import type { SceneNode, Statement } from './rpy/dialect.ts'
import { idClauseTextOf } from './dialogue-id.ts'

export type SceneRowKind =
  | 'dialogue' | 'image' | 'jump' | 'call' | 'return' | 'menu' | 'with' | 'pause' | 'audio'
  | 'comment' | 'blank' | 'unsupported'

export interface SceneRow {
  kind: SceneRowKind
  /** 行号(1 基,与解析器/戳账本同一口径)。 */
  line: number
  /** 该行原文(完整一行,含缩进)。人没改它时按原文逐字回写。 */
  raw: string
  /** 可编辑字段(按 kind 取用;不可编辑的行留空)。 */
  speaker?: string | null
  text?: string
  role?: 'show' | 'scene' | 'hide'
  tag?: string
  attributes?: string[]
  target?: string
  transition?: string
  seconds?: number | null
  channel?: 'music' | 'sound' | 'voice'
  /** 音频动作:`stop` 行没有文件,别在编辑时被悄悄改成 `play`(T17)。 */
  action?: 'play' | 'stop'
  file?: string | null
  loop?: boolean
  /** 选择项的选项文案(menu 行)。 */
  choices?: string[]
  /** 为什么这一行不可编辑(子集外/结构行)。 */
  note?: string
}

export interface SceneFormModel {
  label: string
  /** 场景覆盖的行区间(1 基,含起止)。 */
  startLine: number
  endLine: number
  rows: SceneRow[]
  readOnly: boolean
  readOnlyReason?: string
}

/** 缩进宽度(方言子集推荐 4,但只要求"更深";编辑时按原行缩进取齐)。 */
function indentOf(raw: string): string {
  const match = /^([ \t]*)/.exec(raw)
  return match === null ? '' : match[1]!
}

const DIALOGUE_RE = /^(?:(?!\d)([A-Za-z_][A-Za-z0-9_]*)\s+)?"((?:[^"\\]|\\.)*)"(?:\s+with\s+([A-Za-z0-9_]+))?\s*$/

/** 一行原文 → 行模型(判断部分复用方言子集的词法形状)。 */
function classify(raw: string, line: number, statement: Statement | undefined): SceneRow {
  const body = raw.trim()
  if (body === '') return { kind: 'blank', line, raw }
  if (body.startsWith('#')) return { kind: 'comment', line, raw }

  // 解析器认出过的语句优先(它与生成侧是同一套语法)。
  if (statement !== undefined) {
    switch (statement.kind) {
      case 'dialogue':
        return { kind: 'dialogue', line, raw, speaker: statement.speaker, text: statement.text }
      case 'image':
        return { kind: 'image', line, raw, role: statement.role, tag: statement.tag, attributes: [...statement.attributes] }
      case 'jump':
        return { kind: 'jump', line, raw, target: statement.target, note: '结构行:改跳转请用源文本模式' }
      case 'call':
        return { kind: 'call', line, raw, target: statement.target, note: '结构行:改调用请用源文本模式' }
      case 'return':
        return { kind: 'return', line, raw, note: '结构行:请用源文本模式' }
      case 'with':
        return { kind: 'with', line, raw, transition: statement.transition }
      case 'pause':
        return { kind: 'pause', line, raw, seconds: statement.seconds }
      case 'audio':
        return { kind: 'audio', line, raw, action: statement.action, channel: statement.channel, file: statement.file, loop: statement.loop }
      case 'menu':
        return { kind: 'menu', line, raw, choices: statement.choices.map((choice) => choice.prompt), note: '菜单块:改选项请用源文本模式' }
      default:
        return { kind: 'unsupported', line, raw, note: '这一行没有可编辑字段' }
    }
  }

  // 解析器没给语句:可能是 label 行、块体行、或子集外行 —— 一律如实标注,不假装可编辑。
  const match = DIALOGUE_RE.exec(body)
  if (match !== null) return { kind: 'dialogue', line, raw, speaker: match[1] ?? null, text: match[2]! }
  return {
    kind: body.startsWith('label ') ? 'unsupported' : 'unsupported',
    line,
    raw,
    note: body.startsWith('label ') ? 'label 声明行' : '子集外或无法识别的行',
  }
}

/**
 * 场景文本 → 表单模型。
 *
 * @param text 场景文件**整体**内容(不是片段):要能定位行号并原样回写。
 * @param scene 解析出的场景(给出 label、行区间与语句)。
 */
export function buildSceneForm(text: string, scene: Pick<SceneNode, 'label' | 'line' | 'readOnly' | 'problems' | 'statements'>): SceneFormModel {
  const lines = text.split('\n')
  const startLine = scene.line
  const endLine = endOfScene(lines, startLine)
  const byLine = new Map<number, Statement>()
  for (const statement of scene.statements) byLine.set(statement.line, statement)

  const rows: SceneRow[] = []
  for (let line = startLine; line <= endLine && line <= lines.length; line += 1) {
    rows.push(classify(lines[line - 1] ?? '', line, byLine.get(line)))
  }

  const reason = scene.problems.find((problem) => problem.severity === 'warning')?.message
  return {
    label: scene.label,
    startLine,
    endLine,
    rows,
    readOnly: scene.readOnly,
    ...(scene.readOnly ? { readOnlyReason: reason ?? '这一场用了方言子集外的语法:先改回子集内再编辑' } : {}),
  }
}

/** 场景结束行:下一个顶层 label 前(或文件末)。 */
function endOfScene(lines: string[], startLine: number): number {
  for (let line = startLine + 1; line <= lines.length; line += 1) {
    if (/^label\s+[A-Za-z0-9_]+:\s*$/.test(lines[line - 1] ?? '')) return line - 1
  }
  return lines.length
}

/** 序列化一行为原文(编辑后的行)。 */
export function serializeDialogue(indent: string, speaker: string | null, text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const name = speaker === null || speaker === '' ? '' : `${speaker} `
  return `${indent}${name}"${escaped}"`
}

export function serializeImage(indent: string, role: 'show' | 'scene' | 'hide', tag: string, attributes: string[]): string {
  const rest = attributes.filter((attribute) => attribute.trim() !== '')
  return `${indent}${role} ${tag}${rest.length === 0 ? '' : ` ${rest.join(' ')}`}`
}

/**
 * 音频接线(T17):`play music "audio/rain.ogg" loop` / `stop music`。
 *
 * 引号里的字符串是**相对 `game/` 的路径**(Ren'Py 的 searchpath 只有 `game/`,
 * 见 `audio.ts` 顶部的说明)—— 面板选的是池里的路径,这里原样写出去。
 * `play` 没有文件是坏语法:**写之前就拒绝**,别让半行坏语句落盘。
 */
export function serializeAudio(
  indent: string,
  action: 'play' | 'stop',
  channel: 'music' | 'sound' | 'voice',
  file: string | null,
  loop: boolean,
): string {
  if (action === 'stop') return `${indent}stop ${channel}`
  const name = (file ?? '').trim()
  if (name === '') throw new Error('play 需要一个音频文件(相对 game/ 的路径,如 audio/rain.ogg)')
  return `${indent}play ${channel} "${name.replace(/\\/g, '/').replace(/"/g, '\\"')}"${loop ? ' loop' : ''}`
}

/** 编辑指令:只动被指定的行(其余逐字保留)。 */
export type SceneEdit =
  | { kind: 'setDialogue'; line: number; speaker: string | null; text: string }
  | { kind: 'setImage'; line: number; role: 'show' | 'scene' | 'hide'; tag: string; attributes: string[] }
  /** 改一行的音频接线(T17);`play` 必须给文件,`stop` 不给。 */
  | { kind: 'setAudio'; line: number; action: 'play' | 'stop'; channel: 'music' | 'sound' | 'voice'; file: string | null; loop: boolean }
  /** 插在 `anchor` 文本那一行之后;`anchor` 省略时插在 `afterLine` 之后。 */
  | { kind: 'insertStatement'; afterLine?: number; anchor?: string; source: string }
  | { kind: 'deleteStatement'; line: number }
  | { kind: 'replaceSource'; source: string }

/**
 * 把编辑应用到场景文本上,返回**新的整体文本**。
 *
 * 关键性质:只有被指向的行会被替换/插入/删除,其它行按原文逐字回写。
 */
export function applySceneEdit(text: string, edit: SceneEdit): string {
  if (edit.kind === 'replaceSource') return edit.source.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const at = (line: number): string => lines[line - 1] ?? ''
  /**
   * 行号闸门:**正整数 + 在范围内**。
   *
   * 正面看是"越界要拒",背面才是要害:`NaN` 与小数会让 `line < 1` / `line > length`
   * 两个比较**全部为假**(NaN 与任何数比都是 false),于是守卫整个空过,
   * 接着 `lines[NaN - 1] = …` 会在数组上挂一个莫名其妙的属性 —— 写批算成功,文件没变,
   * 而调用方以为改好了。所以先判"是不是行号",再判"在不在范围内"。
   */
  const guard = (line: number): void => {
    if (!Number.isInteger(line) || line < 1) throw new Error(`行号必须是正整数:${String(line)}`)
    if (line > lines.length) throw new Error(`行号越界:${line}(文件共 ${lines.length} 行)`)
  }

  switch (edit.kind) {
    case 'setDialogue': {
      guard(edit.line)
      // **把这一行原有的 id 子句原样接回去**(T26 / ADR-0013)。
      // 这一行是**重建**出来的,而 id 是语音文件名的锚 —— 丢了它这一句就**永远没声音**
      // (引擎会拿内容哈希去找一个不存在的文件)。2026-09-19 实测踩到:
      // 作者试玩听不到语音,其中一个成因就是"改过台词的那几句 id 掉了"。
      const clause = idClauseTextOf(at(edit.line))
      lines[edit.line - 1] = `${serializeDialogue(indentOf(at(edit.line)), edit.speaker, edit.text)}${clause}`
      return lines.join('\n')
    }
    case 'setImage': {
      guard(edit.line)
      // role 是枚举:写进去的必须是引擎认的三种之一(自由 JSON 进来时静态类型挡不住)。
      if (edit.role !== 'show' && edit.role !== 'scene' && edit.role !== 'hide') {
        throw new Error(`图像动作只能是 show / scene / hide:${String(edit.role)}`)
      }
      lines[edit.line - 1] = serializeImage(indentOf(at(edit.line)), edit.role, edit.tag, edit.attributes)
      return lines.join('\n')
    }
    case 'setAudio': {
      guard(edit.line)
      lines[edit.line - 1] = serializeAudio(indentOf(at(edit.line)), edit.action, edit.channel, edit.file, edit.loop)
      return lines.join('\n')
    }
    case 'insertStatement': {
      // 优先按**语义锚点**(那一行的原文)定位:调用方从此不必知道文件头有几行 ——
      // 绝对行号在这类文件里太脆(生成器的头一变,行号就全错)。
      let at0: number
      if (edit.anchor !== undefined && edit.anchor !== '') {
        const index = lines.findIndex((line) => line === edit.anchor)
        if (index < 0) throw new Error(`找不到锚点行:${edit.anchor}`)
        at0 = index
      } else if (edit.afterLine !== undefined) {
        guard(edit.afterLine)
        at0 = edit.afterLine - 1
      } else {
        throw new Error('insertStatement 需要 anchor 或 afterLine')
      }
      // 新行缩进跟它上面那一行(编辑出来的行要和上下文对齐,而不是塞个固定宽度)。
      const indent = indentOf(lines[at0] ?? '')
      const body = edit.source.replace(/\r\n/g, '\n').replace(/\n+$/, '')
      const added = body.split('\n').map((line) => `${indent}${line.trim()}`)
      lines.splice(at0 + 1, 0, ...added)
      return lines.join('\n')
    }
    case 'deleteStatement': {
      guard(edit.line)
      lines.splice(edit.line - 1, 1)
      return lines.join('\n')
    }
    default:
      return text
  }
}
