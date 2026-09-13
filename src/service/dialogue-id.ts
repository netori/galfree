/**
 * 对话 id(T26 / ADR-0013)—— 语音文件名的那根锚。
 *
 * **为什么必须显式给**:不给 id 时 Ren'Py 的对话标识符是**内容哈希**
 * (`renpy/translation/__init__.py:337-357` 的 `md5(say 的代码)[:8]`)——
 * 改一个字,那一句的语音文件就找不到了(实测记录见 ADR-0013)。而本产品逐场重生成是常规动作。
 *
 * **取名规则照抄引擎**:`renpy/parser.py:1491` 是 `identifier = l.require(l.name)`,
 * 而 `name` 的首字符必须是字母/下划线,其余是字母数字下划线。我们只产出这个形态,
 * 别人的手写文件里出现别的形态就如实报 error(引擎也不会认)。
 *
 * 三条纪律(都有守卫:`dialogue-id.test.ts`):
 *  1. **id 是制作信息,不是叙述内容**(ADR-0003/0009)—— 指纹要把它剔掉,
 *     否则每生成一次语音,人都得把整场重盖一遍;
 *  2. 剔除只发生在**行尾的 id 子句**上:`e "这句话里有 id 这个词。"` 不许被误剔;
 *  3. 名字不合规则 / 同一场里重名 = **error**(重名会让两句抢同一个语音文件)。
 */

/** 引擎 `l.name` 的形态。 */
export const DIALOGUE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 对白行的**实体**部分:说话人(可省)+ 文本 + 可选的 `with <trans>`(行尾)。
 *
 * 唯一出处在**这里**,不是解析器里 —— 因为"什么算一条对白"有两个用户:
 * 解析(`rpy/parse.ts`)与**盖章**(`stampDialogueIds`)。两处各写一遍迟早分叉,
 * 而分叉的后果是"解析器认的句子盖不上章"(语音就那么漏了)。
 * 行尾的 `id` 子句**不在这里**,由 `dialogueIdClauseOf` 单独处理。
 */
export const DIALOGUE_STATEMENT_RE = /^(?:(?!\d)([A-Za-z_][A-Za-z0-9_]*)\s+)?"((?:[^"\\]|\\.)*)"(?:\s+with\s+([A-Za-z0-9_]+))?\s*$/

/**
 * 行尾的 `id` 子句(不管名字合不合规则、甚至有没有名字)。
 *
 * 三种尾部形态都要认(引擎 `finish_say` 的循环允许子句任意顺序,`parser.py:1479-1493`):
 * `… id NAME` / `… id NAME with TRANS` / `… with TRANS id NAME`。
 * 第三种的关键是**允许值后面还跟着 `with <词>`** —— 否则 `… id ch1 "…" with dissolve`
 * 会把 `ch1 with dissolve` 当成名字,然后整行解析不出来(实测踩过)。
 *
 * 与 `DIALOGUE_ID_RE`(**取名规则**,照抄引擎的 `l.require(l.name)`)是两件事:
 * 这个只负责"行尾有没有 id 子句、它的值是什么"。分开之后 `e "坏了。" id 1abc` 与
 * `e "坏了。" id` 都能被发现并如实报错,而不是掉进"这行不认识"的 warning 里。
 */
const TRAILING_ID_CLAUSE_RE = /\s+id(?:\s+(.+?))?(?:\s+with\s+[A-Za-z0-9_]+)?\s*$/

export interface DialogueIdClause {
  /** 行尾有没有 `id` 子句。 */
  present: boolean
  /** 子句里的名字;**没有名字**(或后面跟的不是名字)时为 null。 */
  name: string | null
}

/** 取行尾 id 子句;没有就 `{present:false, name:null}`。 */
export function dialogueIdClauseOf(body: string): DialogueIdClause {
  const match = TRAILING_ID_CLAUSE_RE.exec(body)
  if (match === null) return { present: false, name: null }
  const raw = match[1] ?? null
  return { present: true, name: raw !== null && DIALOGUE_ID_RE.test(raw) ? raw : null }
}

/** 取出行尾 id 的名字(合规则的才有);没有/不合规则返回 null。 */
export function dialogueIdOf(body: string): string | null {
  const clause = dialogueIdClauseOf(body)
  return clause.present && clause.name !== null ? clause.name : null
}

/** 行尾有 `id` 子句,但**名字缺失或不合规则**(引擎会报错的地方)。 */
export function hasMalformedIdClause(body: string): boolean {
  const clause = dialogueIdClauseOf(body)
  return clause.present && clause.name === null
}

/** 去掉行尾 id 子句(给指纹用);没有就原样返回。 */
export function stripDialogueId(body: string): string {
  return body.replace(TRAILING_ID_CLAUSE_RE, '').replace(/\s+$/, '')
}

/**
 * 场景文本 → **指纹口径的文本**:逐行剔掉行尾 id 子句。
 *
 * 单独成函数是因为它必须与解析器用**同一条**规则:两处各写一遍,迟早一处改了另一处没改
 * (指纹是审读戳的输入,分叉的后果是"改了台词戳不动"或"没改台词戳乱动")。
 */
export function sceneTextForFingerprint(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const stripped = stripDialogueId(line)
      return stripped === line ? line : stripped
    })
    .join('\n')
}

/**
 * 给一条对白生成**稳定 id**:同一个 `label` + 同一句**序号**(从 0 起)永远是同一个。
 *
 * 为什么用序号而不是内容哈希:与"为什么不用引擎那套"同一个理由 ——
 * 改一个字不该换文件名。代价是**插入/删除一行会让其后所有 id 平移**;
 * 这是知情选择(ADR-0013 的 Consequences 里写了),换来的是"改台词不掉语音"。
 */
export function dialogueIdFor(label: string, index: number): string {
  const safeLabel = label.replace(/[^A-Za-z0-9_]/g, '_')
  return `${safeLabel}_${String(index).padStart(4, '0')}`
}

/**
 * 给一场戏的**对白**逐条盖上 id(T26:生成侧的那一半)。
 *
 * 为什么必须在**生成**这一侧做:引擎按 id 找语音文件,而"没有 id 就用内容哈希"
 * ——所以生成器不盖 id,整套语音计划就是空的(文件生出来了也没人找得到)。
 *
 * 三条纪律:
 *  1. **只盖对白**(`speaker "text"` / `"text"`),别的行一行不碰;
 *  2. **只盖场景体那一层**:块构造(`if` / `menu` …)里的行**不碰** —— 那些行本来就
 *     子集外、整场只读,盖了也是白盖,还会把"看不懂的东西"伪装成处理过;
 *  3. **幂等**:已经有 id 的按序号**重写**(同一个 label + 同序号 = 同一个 id),
 *     所以反复调用结果一致,改台词也不掉 id。
 */
export function stampDialogueIds(source: string, label: string): string {
  const indentOf = (line: string): number | null => {
    const group = /^( *)\S/.exec(line)?.[1]
    return group === undefined ? null : group.length
  }
  const lines = source.split('\n')
  // 场景体缩进 = 第一条有缩进的行的缩进(没有缩进行 = 空场景,原样返回)。
  let bodyIndent: number | null = null
  for (const line of lines) {
    const indent = indentOf(line)
    if (indent !== null && indent > 0) { bodyIndent = indent; break }
  }
  if (bodyIndent === null) return source
  const indentLevel = bodyIndent
  let seq = 0
  return lines
    .map((line) => {
      // 只碰场景体那一层:更深的行属于块构造,更浅的是 label / 顶层。
      if (indentOf(line) !== indentLevel) return line
      const body = line.trim()
      const stripped = stripDialogueId(body)
      if (!DIALOGUE_STATEMENT_RE.test(stripped)) return line
      const id = dialogueIdFor(label, seq)
      seq += 1
      return `${' '.repeat(indentLevel)}${stripped} id ${id}`
    })
    .join('\n')
}
