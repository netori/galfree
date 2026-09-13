/**
 * 方言子集解析器(galfree-subset-1)—— 纯函数:输入 .rpy 文件集,输出
 * 分支骨架对象;同输入重算结果一致(可缓存、可全量重算,ADR-0009)。
 *
 * 策略:逐行、缩进敏感的行级解析。子集内语法照常产出;子集外语法 **如实记录
 * warning 并把所在场景标记只读**,其后仍可解析的行继续产出(降级不罢工)。
 */
import type { BranchEdge, BranchGraph, DialectProblem, MenuChoice, ParsedScript, SceneNode, Statement } from './dialect.ts'
import { dialogueIdClauseOf, DIALOGUE_STATEMENT_RE, stripDialogueId } from '../dialogue-id.ts'

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
/**
 * 对白行的**实体**部分。唯一出处在 `dialogue-id.ts` 的 `DIALOGUE_STATEMENT_RE`
 * —— "什么算一条对白"有两个用户(解析与盖章),两处各写一遍迟早让"解析器认的句子盖不上章"。
 * 行尾的 `id` 子句由 `dialogueIdClauseOf` 单独取(T26),因为子句可以在 `with` 前后
 * (引擎 `finish_say` 是个循环,`parser.py:1479-1493`)。
 */
const DIALOGUE_RE = DIALOGUE_STATEMENT_RE
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
      // 对白:字符串(可带说话人变量)+ 可选的行尾 `id` 子句 + 当时画面的图像引用快照。
      const dialogue = parseDialogue(body, line.no, [...stage.values()])
      if (dialogue !== null) {
        index += 1
        // id 子句坏掉的两种形态(缺名字 / 名字不合规则)是**结构错**,不是"这行不认识":
        // 引擎那边会直接报错,我们不能把它降级成一句 warning 就放过去。
        if (dialogue.problem !== null) {
          degrade({ ...dialogue.problem, file: file.name })
        }
        return dialogue.statement
      }
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
    // 对话 id 的跨语句检查要等**整场语句收齐**之后才能做(重名是场内的属性,T26)。
    checkDialogueIds(scene)
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

/**
 * 行内字符串的转义 → **引擎看到的那串文本**。
 *
 * 为什么必须解(`parseDialogue` 的 regex 捕获的是**原始**字符):
 * 引擎把 `\"` 解成一个真引号(实测:`renpy.exe <项目> dialogue None` 导出的 Dialogue 列
 * 里就是一个 `"`,没有反斜杠)。我们留着反斜杠的后果很实在 ——
 * **送给本地 TTS 的文本会多出反斜杠**(念出来或直接失败),而这正是 T29 要用的那条路。
 *
 * 规则极简(只认引擎这三样):`\"` → `"`、`\\` → `\`、`\n` → 换行;其余 `\x` 原样留着
 * (引擎对没定义的转义就是这个态度 —— 不吞、不猜)。
 */
export function unescapeRpyString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch !== '\\') { out += ch; continue }
    const next = raw[i + 1]
    if (next === undefined) { out += ch; continue }
    if (next === 'n') { out += '\n'; i += 1; continue }
    if (next === '"' || next === '\\') { out += next; i += 1; continue }
    out += ch
  }
  return out
}

/**
 * 一行对白 → 语句。行尾的 `id` 子句先摘掉再匹配实体部分,id 单独取(T26)。
 *
 * `problem` 回传的两种是**结构错**(引擎也不认),由调用方记成 error:
 * 行尾 `id` 后面缺名字、或名字不合 `l.name` 的规则。
 */
function parseDialogue(
  body: string,
  lineNo: number,
  showing: string[],
): { statement: Statement; problem: DialectProblem | null } | null {
  const clause = dialogueIdClauseOf(body)
  // 子句在 `with` 之前也要能认:摘掉之后再匹配实体部分。
  const core = clause.present ? stripDialogueId(body) : body
  const match = DIALOGUE_RE.exec(core)
  if (match === null) return null
  const speaker = match[1] ?? null
  // 文本解转义 —— 存的是**引擎看到的那串**(见 `unescapeRpyString` 的说明)。
  const text = unescapeRpyString(match[2]!)
  const problem: DialectProblem | null = clause.present && clause.name === null
    ? {
        severity: 'error', line: lineNo, code: 'invalid-dialogue-id', file: '',
        message: '对话 id 不合引擎的取名规则(要字母/下划线开头,其余是字母数字下划线)',
        snippet: body,
      }
    : null
  return {
    statement: { kind: 'dialogue', speaker, text, id: clause.name, showing, line: lineNo },
    problem,
  }
}

/**
 * 对白 id 子句的**跨语句检查**(T26 / ADR-0013):同一场里重名。
 *
 * 为什么是 error 而不是 warning:重名会让**两句抢同一个语音文件**(引擎按 id 找文件)
 * —— 这不是"风格问题",是"这个 id 用不了"。与 `duplicate-label` / `dangling-jump` 同级
 * (结构缺陷,进板、挡发布)。名字不合规则那条在 `parseDialogue` 里当场就报了。
 */
function checkDialogueIds(scene: SceneNode): void {
  const seen = new Map<string, number>()
  const visit = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'menu') { visit(statement.choices.flatMap((choice) => choice.body)); continue }
      if (statement.kind !== 'dialogue' || statement.id === null) continue
      const first = seen.get(statement.id)
      if (first === undefined) { seen.set(statement.id, statement.line); continue }
      scene.problems.push({
        severity: 'error', file: scene.file, line: statement.line, code: 'duplicate-dialogue-id',
        message: `对话 id 重复:${statement.id}(第 ${first} 行已经用过)—— 重名会让这两句抢同一个语音文件`,
      })
    }
  }
  visit(scene.statements)
}

/** 分支骨架派生(可缓存、全量重算)。 */
export function deriveGraph(parsed: ParsedScript): BranchGraph {
  const degraded = parsed.scenes.some((scene) => scene.readOnly) || parsed.problems.length > 0
  return { dialect: 'galfree-subset-1', scenes: parsed.scenes, edges: parsed.edges, problems: parsed.problems, degraded }
}
