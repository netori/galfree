/**
 * 方言子集解析器(galfree-subset-1)—— 纯函数:输入 .rpy 文件集,输出
 * 分支骨架对象;同输入重算结果一致(可缓存、可全量重算,ADR-0009)。
 *
 * 策略:逐行、缩进敏感的行级解析。子集内语法照常产出;子集外语法 **如实记录
 * warning 并把所在场景标记只读**,其后仍可解析的行继续产出(降级不罢工)。
 */
import type { BranchEdge, BranchGraph, DialectProblem, MenuChoice, ParsedScript, SceneNode, Statement } from './dialect.ts'

export interface RpyFile {
  /** 文件名(不含目录)。 */
  name: string
  text: string
}

/** 已识别的顶层块起始词(label 之外)。 */
const TOPLEVEL_ACCEPT = /^(define|default|image)\s/
/** 明确不支持的子集外顶层语法。 */
const TOPLEVEL_UNSUPPORTED = /^(screen|transform|style|init|python|translate|testcase|flow|layermaster|dragzone|use)\b/

/** 场景内已接受语句的一行形态(不含 menu/if 等块)。 */
const JUMP_RE = /^jump\s+([A-Za-z0-9_]+)\s*$/
const CALL_RE = /^call\s+([A-Za-z0-9_]+)(?:\s+from\s+[A-Za-z0-9_]+)?\s*$/
const RETURN_RE = /^return(?:\s.*)?$/
const WITH_RE = /^with\s+([A-Za-z0-9_]+)\s*$/
const SHOW_BLOCK_RE = /^(show|scene|hide)\s+[A-Za-z0-9_]+[^:]*:\s*$/
const SHOW_RE = /^(show|scene|hide)\s+([A-Za-z0-9_]+)((?:\s+[A-Za-z0-9_]+)*)\s*$/
const PLAY_RE = /^play\s+(music|sound|voice)\s+"([^"]*)"\s*(loop)?\s*$/
const STOP_RE = /^stop\s+(music|sound|voice)\s*$/
const DIALOGUE_RE = /^(?:(?!\d)([A-Za-z_][A-Za-z0-9_]*)\s+)?"((?:[^"\\]|\\.)*)"(?:\s+with\s+([A-Za-z0-9_]+))?\s*$/
const CHAR_DEFINE_RE = /^define\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Character\(\s*"((?:[^"\\]|\\.)*)"/
const IMAGE_DEFINE_RE = /^image\s+([A-Za-z0-9_ ]+?)\s*=\s*.+$/

/** 场景内出现即触发只读降级的构造(有块结构的)。 */
const SCENE_UNSUPPORTED_BLOCK = /^(if|elif|else|while|for|python|block|pause\s+\{\{|vbar|bar|add|imagebutton|textbutton|input|viewport|use|showscreen|hide screen|window|centered|nvl|label)\b/
/** 行首单词白名单:场景内其余形态一律按可解析行处理。 */

/** 字符串字面量(简单形态):"…" 允许转义与成对引号以外的插值花括号。 */
function readStringLiteral(source: string, from: number): { value: string; end: number } | null {
  if (source[from] !== '"') return null
  let out = ''
  let i = from + 1
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === undefined) return null
      out += next === 'n' ? '\n' : next
      i += 2
      continue
    }
    if (ch === '"') {
      // Ren'Py 里 "" 不是转义而是两个字符串;方言子集不支持相邻字符串拼接。
      if (source[i + 1] === '"') return null
      return { value: out, end: i + 1 }
    }
    out += ch
    i += 1
  }
  return null
}

function indentOf(line: string): number {
  const m = /^( *)/.exec(line)
  return m === null ? 0 : m[1]!.length
}

function stripComment(line: string): string {
  let inString = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') inString = !inString
    else if (ch === '#' && !inString) return line.slice(0, i)
  }
  return line
}

interface RawLine {
  no: number
  indent: number
  body: string
}

function toRawLines(text: string): RawLine[] {
  const lines: RawLine[] = []
  text.split('\n').forEach((raw, index) => {
    const trimmed = stripComment(raw).replace(/\s+$/, '')
    if (trimmed.trim() === '') return
    lines.push({ no: index + 1, indent: indentOf(raw), body: trimmed.trim() })
  })
  return lines
}

/** 解析一组 .rpy 文件(顺序稳定:按文件名排序,保证纯函数可重入)。 */
export function parseRpy(files: RpyFile[]): ParsedScript {
  const scenes: SceneNode[] = []
  const edges: BranchEdge[] = []
  const problems: DialectProblem[] = []
  const characters: ParsedScript['characters'] = []
  const images: ParsedScript['images'] = []

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const lines = toRawLines(file.text)
    const rawLines = file.text.split('\n')
    const fileScenes: Array<{ scene: SceneNode; start: number }> = []
    let index = 0
    let current: SceneNode | null = null
    /** 舞台状态:tag → 图像引用名(showing 快照的输入;每个场景重置)。 */
    let stage = new Map<string, string>()

    const degrade = (problem: DialectProblem): void => {
      if (current !== null) {
        current.readOnly = true
        current.problems.push(problem)
      } else {
        problems.push(problem)
      }
    }

    /** 舞台状态更新:scene 清场换背景;show 挂/替换立绘;hide 摘除。 */
    const applyStage = (role: 'show' | 'scene' | 'hide', tag: string, attributes: string[]): void => {
      const name = [tag, ...attributes].join(' ')
      if (role === 'scene') { stage.clear(); stage.set('bg', name) }
      else if (role === 'show') stage.set(tag, name)
      else { stage.delete(tag); if (tag === 'bg') stage.delete('bg') }
    }

    /** 解析一段块体(indent 严格大于 minIndent 的行)。 */
    const parseBlock = (minIndent: number): Statement[] => {
      const statements: Statement[] = []
      while (index < lines.length && lines[index]!.indent > minIndent) {
        const line = lines[index]!
        const parsed = parseStatement(line, minIndent)
        if (parsed !== null) statements.push(parsed)
      }
      return statements
    }

    const parseStatement = (line: RawLine, parentIndent: number): Statement | null => {
      const body = line.body
      // 菜单块
      if (body === 'menu:') {
        index += 1
        return parseMenu(line, parentIndent)
      }
      // 明确不支持的块构造:吞掉整块(记录一次),继续后面的行。
      if (SCENE_UNSUPPORTED_BLOCK.test(body)) {
        const keyword = body.split(/[\s:]/)[0]!
        const code = /^(if|elif|else|while|for|block)$/.test(keyword) ? 'unsupported-control-flow'
          : keyword === 'python' ? 'unsupported-python'
          : 'unsupported-construct'
        degrade({
          severity: 'warning', file: file.name, line: line.no, code,
          message: `子集外构造被跳过:${keyword}…(本场景降级只读)`, snippet: body,
        })
        // 跳块:吃掉缩进比"块头行"更深的行,以及与之同级的 else/elif 头(及其块体)。
        const blockIndent = line.indent
        index += 1
        while (index < lines.length) {
          const next = lines[index]!
          if (next.indent > blockIndent) { index += 1; continue }
          if (next.indent === blockIndent && /^(else|elif)\b/.test(next.body)) { index += 1; continue }
          break
        }
        return null
      }
      let m: RegExpExecArray | null
      if ((m = RETURN_RE.exec(body)) !== null) { index += 1; return { kind: 'return', line: line.no } }
      if ((m = JUMP_RE.exec(body)) !== null) {
        index += 1
        return { kind: 'jump', target: m[1]!, line: line.no }
      }
      if ((m = CALL_RE.exec(body)) !== null) {
        index += 1
        return { kind: 'call', target: m[1]!, line: line.no }
      }
      if ((m = WITH_RE.exec(body)) !== null) {
        index += 1
        return { kind: 'with', transition: m[1]!, line: line.no }
      }
      const pauseMatch = /^pause(?:\s+(\d+(?:\.\d+)?))?\s*$/.exec(body)
      if (pauseMatch !== null) {
        index += 1
        return { kind: 'pause', seconds: pauseMatch[1] === undefined ? null : Number(pauseMatch[1]), line: line.no }
      }
      if (SHOW_BLOCK_RE.test(body)) {
        // show/scene + ATL 块:记 warning、跳过整块(标签仍进舞台状态)。
        const role = /^(show|scene|hide)/.exec(body)![1] as 'show' | 'scene' | 'hide'
        const tag = /^(?:show|scene|hide)\s+([A-Za-z0-9_]+)/.exec(body)?.[1] ?? '?'
        degrade({ severity: 'warning', file: file.name, line: line.no, code: 'unsupported-atl', message: `show ${tag} 带 ATL 块不在子集内(只读降级,块体跳过)`, snippet: body })
        index += 1
        while (index < lines.length && lines[index]!.indent > line.indent) index += 1
        applyStage(role, tag, [])
        return { kind: 'image', role, tag, attributes: [], line: line.no }
      }
      if ((m = SHOW_RE.exec(body)) !== null) {
        // show/scene/hide:tag + 属性;排除 `at`/`with` 修饰词。
        const role = m[1] as 'show' | 'scene' | 'hide'
        const tag = m[2]!
        const rest = (m[3] ?? '').split(/\s+/).filter((token) => token !== '')
        index += 1
        const attributes: string[] = []
        for (const token of rest) {
          if (token === 'at' || token === 'with' || token === 'behind' || token === 'zorder') break
          attributes.push(token)
        }
        applyStage(role, tag, attributes)
        return { kind: 'image', role, tag, attributes, line: line.no }
      }
      if ((m = PLAY_RE.exec(body)) !== null) {
        index += 1
        return { kind: 'audio', action: 'play', channel: m[1] as 'music' | 'sound' | 'voice', file: m[2] ?? null, loop: m[3] !== undefined, line: line.no }
      }
      if ((m = STOP_RE.exec(body)) !== null) {
        index += 1
        return { kind: 'audio', action: 'stop', channel: m[1] as 'music' | 'sound' | 'voice', file: null, loop: false, line: line.no }
      }
      // 对白:字符串(可带说话人变量)+ 当时画面的图像引用快照。
      const dialogue = parseDialogue(body, line.no, [...stage.values()])
      if (dialogue !== null) { index += 1; return dialogue }
      // 未知行:如实报告,不罢工。
      degrade({ severity: 'warning', file: file.name, line: line.no, code: 'unrecognized-line', message: `无法按方言子集解析(本场景降级只读)`, snippet: body })
      index += 1
      return null
    }

    const parseMenu = (menuLine: RawLine, parentIndent: number): Statement => {
      const choices: MenuChoice[] = []
      let menuProblem: DialectProblem | null = null
      while (index < lines.length && lines[index]!.indent > parentIndent) {
        const line = lines[index]!
        // 菜单提示语:纯字符串行(非 `…:`)。
        if (/^"(?:[^"\\]|\\.)*"$/.test(line.body)) { index += 1; continue }
        // 选项:`"…":` 形式。
        if (/^"(?:[^"\\]|\\.)*":\s*$/.test(line.body)) {
          const str = readStringLiteral(line.body, 0)
          if (str === null) {
            menuProblem = { severity: 'warning', file: file.name, line: line.no, code: 'unrecognized-line', message: '菜单选项字符串无法解析(本场景降级只读)', snippet: line.body }
            index += 1
            continue
          }
          index += 1
          const bodyStatements = parseBlock(line.indent)
          choices.push({ prompt: str.value, body: bodyStatements, line: line.no })
          continue
        }
        menuProblem = menuProblem ?? { severity: 'warning', file: file.name, line: line.no, code: 'unsupported-menu-line', message: '菜单中出现子集外行(本场景降级只读)', snippet: line.body }
        index += 1
      }
      if (menuProblem !== null) {
        if (current !== null) { current.readOnly = true; current.problems.push(menuProblem) }
      }
      return { kind: 'menu', choices, line: menuLine.no }
    }

    // 顶层扫描。
    while (index < lines.length) {
      const line = lines[index]!
      if (line.indent !== 0) {
        problems.push({ severity: 'warning', file: file.name, line: line.no, code: 'orphan-indent', message: '顶层之外出现缩进行(缺少 label?)', snippet: line.body })
        index += 1
        continue
      }
      const labelMatch = /^label\s+([A-Za-z0-9_]+):\s*$/.exec(line.body)
      if (labelMatch !== null) {
        const scene: SceneNode = { label: labelMatch[1]!, file: file.name, line: line.no, statements: [], text: '', readOnly: false, problems: [] }
        current = scene
        stage = new Map()
        index += 1
        scene.statements = parseBlock(0)
        fileScenes.push({ scene, start: line.no - 1 })
        scenes.push(scene)
        current = null
        continue
      }
      const charMatch = CHAR_DEFINE_RE.exec(line.body)
      if (charMatch !== null) {
        characters.push({ var: charMatch[1]!, displayName: charMatch[2]!, file: file.name, line: line.no })
        index += 1
        continue
      }
      const imageMatch = IMAGE_DEFINE_RE.exec(line.body)
      if (imageMatch !== null) {
        images.push({ name: imageMatch[1]!, file: file.name, line: line.no })
        index += 1
        continue
      }
      if (TOPLEVEL_ACCEPT.test(line.body)) {
        // define/default 非 Character/image:接受为不透明声明。
        index += 1
        continue
      }
      if (TOPLEVEL_UNSUPPORTED.test(line.body)) {
        problems.push({ severity: 'warning', file: file.name, line: line.no, code: 'unsupported-top-level', message: `子集外顶层构造:${line.body.split(/\s/)[0]}(跳过整块)`, snippet: line.body })
        index += 1
        while (index < lines.length && lines[index]!.indent > 0) index += 1
        continue
      }
      problems.push({ severity: 'warning', file: file.name, line: line.no, code: 'unrecognized-top-level', message: '无法按方言子集解析的顶层行(跳过)', snippet: line.body })
      index += 1
    }

    // 场景原始文本块:label 行起,到下一场景 label 前(EOF 截断)。
    const ordered = [...fileScenes].sort((a, b) => a.start - b.start)
    ordered.forEach((entry, position) => {
      const end = position + 1 < ordered.length ? ordered[position + 1]!.start : rawLines.length
      entry.scene.text = rawLines.slice(entry.start, end).join('\n')
    })
  }

  const labelSet = new Map<string, SceneNode>()
  for (const scene of scenes) {
    if (labelSet.has(scene.label)) {
      problems.push({ severity: 'error', file: scene.file, line: scene.line, code: 'duplicate-label', message: `label ${scene.label} 重复定义` })
    } else {
      labelSet.set(scene.label, scene)
    }
  }

  // 收集边并校验悬空目标。
  const addEdge = (from: string, to: string, via: BranchEdge['via'], file: string, line: number, prompt?: string): void => {
    edges.push({ from, to, via, prompt, file, line })
    if (!labelSet.has(to)) {
      problems.push({ severity: 'error', file, line, code: 'dangling-jump', message: `跳转目标 label ${to} 不存在(悬空引用)` })
    }
  }
  for (const scene of scenes) {
    collectEdges(scene.label, scene.statements, scene.file, addEdge)
  }

  if (scenes.length > 0 && !labelSet.has('start')) {
    problems.push({ severity: 'error', file: files[0]?.name ?? '', code: 'no-start-label', message: '缺少 label start:(主菜单入口)' })
  }

  return { scenes, edges, characters, images, problems }
}

function collectEdges(
  sceneLabel: string,
  statements: Statement[],
  file: string,
  addEdge: (from: string, to: string, via: BranchEdge['via'], file: string, line: number, prompt?: string) => void,
): void {
  for (const statement of statements) {
    if (statement.kind === 'jump') addEdge(sceneLabel, statement.target, 'jump', file, statement.line)
    else if (statement.kind === 'call') addEdge(sceneLabel, statement.target, 'call', file, statement.line)
    else if (statement.kind === 'menu') {
      for (const choice of statement.choices) {
        for (const inner of choice.body) {
          if (inner.kind === 'jump') addEdge(sceneLabel, inner.target, 'menu', file, inner.line, choice.prompt)
          else if (inner.kind === 'call') addEdge(sceneLabel, inner.target, 'call', file, inner.line, choice.prompt)
        }
        // 嵌套菜单也要走查。
        collectEdges(sceneLabel, choice.body.filter((s) => s.kind === 'menu'), file, addEdge)
      }
    }
  }
}

function parseDialogue(body: string, lineNo: number, showing: string[]): Statement | null {
  const match = DIALOGUE_RE.exec(body)
  if (match === null) return null
  const speaker = match[1] ?? null
  const text = match[2]!
  return { kind: 'dialogue', speaker, text, showing, line: lineNo }
}

/** 分支骨架派生(可缓存、全量重算)。 */
export function deriveGraph(parsed: ParsedScript): BranchGraph {
  const degraded = parsed.scenes.some((scene) => scene.readOnly) || parsed.problems.length > 0
  return { dialect: 'galfree-subset-1', scenes: parsed.scenes, edges: parsed.edges, problems: parsed.problems, degraded }
}
