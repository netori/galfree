/**
 * 演出字色(纯函数)—— 让"用不同颜色的文字增加趣味性"这件事**有度可依**。
 *
 * ## 先说这个模块**没有**做的事
 *
 * 发起人的原话是"可以用不同颜色的文字增加趣味性,但要适度……素晴日是我认为使用的比较好的"。
 * 我们真去查了素晴日(2026-09-30,`.scratch/research-text-color.md`)——**没能证实**任何
 * 具体的字色用法:官方商店页能看清文本框的两张截图里是**白字 + 深色描边**、两个不同说话人
 * **没有配色差异**;而"某章某句是什么颜色"这类说法**一条一手来源都找不到**
 * (まとめ wiki 对本机 IP 返回 403)。
 *
 * 所以这里的规则**不建立在传闻上**。能立住的是那条**机制**解释(标注为推断):
 * 素晴日的界面把"字色的期望值"压到了零 —— 单色基线 + 稀有偏离 ⇒ 任何一次变色都自带重音。
 * 复刻它要复刻的就是这一条:**先有单调的基线,再有极少数的偏离**;不是去凑某个颜色表。
 *
 * ## 立得住的硬事实(全部实测/源码,出处见调研文档)
 *
 *  - **描边不能逐段加**:官方文档写明 outlines 只对**整个 Text displayable** 生效、
 *    对 text tag 无效 ⇒ 想给彩色跨段加安全网,描边必须**整行统一存在**。
 *    这正是本模块的对比度闸门成立的前提:字号色与**描边色**比对比度,与背景无关。
 *  - WCAG 2.2 SC 1.4.3 的 Note 5:字母的**边框可以计入**对比度 ⇒ 4.5:1 是那条线。
 *  - 未知文本标签**不静默**:引擎运行时直接抛(报错屏);但项目可以自定义标签
 *    (`config.custom_text_tags`),所以这里只报 warning,不当结构错。
 *  - **没有显式 `id` 时,插入一个 `{color=}` 会改对话标识符**(md5 含台词原文),
 *    于是 `config.auto_voice` 去找的文件名跟着变 ⇒ **演出行也必须盖 id**。
 *    本项目生成侧一律盖 id(`dialogue-id.ts`),所以这条在正路是安全的 ——
 *    但手写文件里加颜色仍要记得这件事。
 *  - 默认界面会在**历史记录**里把颜色剥掉(`gui.history_allow_tags` 不含 color),
 *    所以舞台层顺手补上那一项(见 `stage.ts`)。
 *
 * ## 度(全部是**判断值**,不是实证;够用就好的那种)
 *
 *  | 规则 | 阈值 | 严重度 |
 *  |---|---|---|
 *  | 着色密度 | 每 20 行对白最多 1 处着色 | warning |
 *  | 每场色数 | 最多 2 种 | warning |
 *  | 整行着色 | 每场最多 1 行,且只允许"装置色"(强信号必须 1:1 对一个语义) | warning |
 *  | 用在哪 | 只在标了 `# galfree:perf` 的**演出场**里用 | warning |
 *  | 对比度 | 与描边色 ≥ 4.5:1 | warning |
 *
 * 一律 warning、不设 error:这是**分寸建议**,不是结构缺陷 —— 板子该说出来,但不该把
 * 一部已经做完的戏变成"发布被拦下"。人不同意某一条,改这里就行(改之前先读上面那段事实)。
 */
import type { DialectProblem, SceneNode, Statement } from './rpy/dialect.ts'

/**
 * 调色板 —— 四个槽,每个槽**一个语义**,不是四种好看的颜色。
 *
 * 颜色都对着描边色 `#101014` 算过对比度(括号里是真算出来的值),全部 ≥ 4.5:1。
 * 为什么不给自由取色:自由取色的后果是"每场戏都在挑颜色",而那正好把
 * "稀有偏离"变成"到处是颜色"—— 也就是过度。
 */
export const TEXT_PALETTE = [
  { name: 'gf_c_device', hex: '#e0c060', label: '装置色(非人的声音 / 神来之物 / 记录装置)', contrast: 10.74 },
  { name: 'gf_c_warn', hex: '#e8564f', label: '不安色(警告 / 逼近的坏事 / 生理性的不适)', contrast: 5.31 },
  { name: 'gf_c_cold', hex: '#7fd4ff', label: '疏离色(冷 / 远 / 旁观者 / 记忆)', contrast: 11.54 },
  { name: 'gf_c_accent', hex: '#00b8c3', label: '主题色(关键词 / 与界面主色呼应的一处重音)', contrast: 7.81 },
] as const

/** 描边色:整行统一加描边之后,彩色字的对比度**与背景无关**。 */
export const TEXT_OUTLINE_COLOR = '#101014'

/** 演出场的标记:场景文件里的一行注释(`# galfree:perf`)。注释不是叙述内容,`.rpy` 仍是唯一真相。 */
export const PERF_MARKER = 'galfree:perf'

/** 每 20 行对白最多 1 处着色。 */
const SPANS_PER_LINES = 20
/** 每场最多几个不同颜色。 */
const MAX_DISTINCT_COLORS = 2
/** 每场最多几处整行着色。 */
const MAX_WHOLE_LINE = 1

/**
 * 引擎/本项目认的文本标签(白名单)。
 *
 * `vert`/`horiz` 必须在白名单里 —— 实测:Ren'Py 8.5.3 的 lint 会把它们**误报**成未知标签
 * (`renpy/text/extras.py` 的 `text_tags` 少了两项),我们照它办就会冤枉纵排文本。
 */
const KNOWN_TAGS = new Set([
  'color', 'c', 'b', 'i', 'u', 's', 'plain', 'font', 'size', 'outlinecolor', 'alpha', 'k',
  'cps', 'w', 'nw', 'p', 'fast', 'clear', 'space', 'vspace', 'image', 'rt', 'rb', 'art',
  'alt', 'noalt', 'shader', 'vert', 'horiz', 'a', 'noalt',
])

/** 相对亮度(WCAG 2.x)。 */
function luminance(hex: string): number | null {
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

/** 两色的对比度(1..21);任一个不是 6 位 hex 就返回 null(不猜)。 */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** 调色板名 → hex(`gf_c_warn` 或 `#rrggbb` 都收)。 */
export function paletteHex(token: string): string | null {
  const named = TEXT_PALETTE.find((entry) => entry.name === token.trim())
  if (named !== undefined) return named.hex
  return /^#[0-9a-fA-F]{6}$/.test(token.trim()) ? token.trim() : null
}

/** 一处着色跨段。 */
interface ColorSpan {
  /** `{color=…}` 里的原样取值(可能是调色板名,也可能是 hex)。 */
  token: string
  line: number
  /** 该行是否**整行**被着色(着色从行首开始且到行尾结束)。 */
  wholeLine: boolean
}

export interface SceneColorCensus {
  scene: string
  file: string
  line: number
  /** 标了 `# galfree:perf` 没有。 */
  perf: boolean
  dialogueLines: number
  coloredSpans: number
  distinctColors: string[]
  wholeLineColored: number
}

export interface TextColorDerivation {
  census: SceneColorCensus[]
  problems: DialectProblem[]
  /** 用了字色的场景数 / 总场景数(板上那一格"演出场次占比"的输入)。 */
  coloredScenes: number
}

/** 场景正文里有没有演出场标记(注释形态,`.rpy` 仍是唯一真相)。 */
export function isPerformanceScene(scene: Pick<SceneNode, 'text'>): boolean {
  return new RegExp(`#\\s*${PERF_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(scene.text)
}

/** 从一行对白文本里扫出着色跨段(只认 `{color=…}`;`{c=…}` 是它的简写)。 */
function spansOf(text: string, line: number): Array<ColorSpan> {
  const spans: ColorSpan[] = []
  const pattern = /\{\s*(?:color|c)\s*=\s*([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const opened = match.index
    const closing = /\{\s*\/\s*(?:color|c)\s*\}/.exec(text.slice(opened + match[0].length))
    const end = closing === null ? text.length : opened + match[0].length + closing.index + closing[0].length
    spans.push({
      token: (match[1] ?? '').trim(),
      line,
      // 整行着色:着色从这一行的第一个字符开始,且一直罩到行尾(不管有没有闭合标签)。
      wholeLine: opened === 0 && end >= text.length,
    })
  }
  return spans
}

/** 一行对白里出现的**所有**文本标签(用来查未知标签与裸 `[`)。 */
function tagsOf(text: string): string[] {
  const tags: string[] = []
  const pattern = /\{\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) tags.push(`${match[1] ?? ''}${match[2]!}`)
  return tags
}

/**
 * 一场戏的字色体检(**纯推导**):数一数用了多少、用了什么色,并给出该说的话。
 *
 * 它不判断"这句该不该上色" —— 那是作者的判断。它只回答**能机械回答的**那几件:
 * 颜色在不在调色板里、够不够清楚、密度是不是过了界、用没用在该用的时候。
 */
export function censusSceneTextColor(scene: SceneNode): { census: SceneColorCensus; problems: DialectProblem[] } {
  const problems: DialectProblem[] = []
  const perf = isPerformanceScene(scene)
  let dialogueLines = 0
  let coloredSpans = 0
  let wholeLineColored = 0
  const colors = new Set<string>()
  const locate = (line: number, code: string, severity: 'warning' | 'error', message: string, snippet?: string): void => {
    problems.push({ severity, file: scene.file, line, code, message, ...(snippet === undefined ? {} : { snippet }) })
  }

  for (const statement of scene.statements) {
    const dialogue = statement as Extract<Statement, { kind: 'dialogue' }>
    if (dialogue.kind !== 'dialogue') continue
    dialogueLines += 1
    const text = dialogue.text

    for (const tag of tagsOf(text)) {
      const bare = tag.replace(/^\//, '')
      if (KNOWN_TAGS.has(bare)) continue
      // 自定义标签是合法 Ren'Py(`config.custom_text_tags`),所以只提示、不当结构错。
      locate(dialogue.line, 'text-tag-unknown', 'warning',
        `这行用了不认识的文本标签 {${tag}} —— 引擎会**在运行时抛异常**(报错屏),除非项目用 config.custom_text_tags 定义过它`,
        text)
    }
    // `[` 是 Ren'Py 的插值符:正文里要显示方括号必须写 `[[`(插入 `{color=[gf_c_x]}` 之后
    // 这一条更容易踩到 —— 我们自己的调色板引用就长这样)。
    if (/(^|[^\[])\[(?!\[)/.test(text)) {
      locate(dialogue.line, 'text-bare-bracket', 'warning',
        '正文里有单个 `[`:Ren\'Py 会把它当插值起点。要显示方括号请写 `[[`',
        text)
    }

    for (const span of spansOf(text, dialogue.line)) {
      coloredSpans += 1
      if (span.wholeLine) wholeLineColored += 1
      const hex = paletteHex(span.token)
      colors.add(span.token)
      if (hex === null) {
        locate(dialogue.line, 'text-color-unknown', 'warning',
          `字色 ${span.token === '' ? '(空)' : span.token} 既不是调色板名也不是 #rrggbb —— 引擎会当场抛异常`,
          text)
        continue
      }
      const ratio = contrastRatio(hex, TEXT_OUTLINE_COLOR)
      if (ratio !== null && ratio < 4.5) {
        locate(dialogue.line, 'text-color-low-contrast', 'warning',
          `字色 ${span.token} 与描边色对比度只有 ${ratio.toFixed(2)}:1(低于 4.5:1)—— 在浅背景或投影仪上会糊掉;换调色板里的一档`,
          text)
      }
      if (span.wholeLine && span.token !== 'gf_c_device') {
        locate(dialogue.line, 'text-color-whole-line', 'warning',
          `整行着色只给"装置色"(\`gf_c_device\`):整行染色是很强的信号,用多了就不强了`,
          text)
      }
    }
  }

  const census: SceneColorCensus = {
    scene: scene.label,
    file: scene.file,
    line: scene.line,
    perf,
    dialogueLines,
    coloredSpans,
    distinctColors: [...colors],
    wholeLineColored,
  }

  if (coloredSpans > 0 && !perf) {
    locate(scene.line, 'text-color-off-scene', 'warning',
      `这一场用了 ${coloredSpans} 处字色,但没有标演出场 —— 字色是一种**演出**手段,`
      + `请在场景文件里加一行注释 \`# ${PERF_MARKER}\`(或把颜色撤掉)。`
      + '单色基线越干净,变色越有分量。')
  }
  const budget = Math.max(1, Math.floor(dialogueLines / SPANS_PER_LINES))
  if (coloredSpans > budget) {
    locate(scene.line, 'text-color-budget', 'warning',
      `这一场 ${dialogueLines} 行对白里有 ${coloredSpans} 处着色(建议不超过 ${budget} 处,约每 ${SPANS_PER_LINES} 行 1 处)`
      + ' —— 密度一高,读者就把颜色当排版而不是当重音了。')
  }
  if (colors.size > MAX_DISTINCT_COLORS) {
    locate(scene.line, 'text-color-palette-budget', 'warning',
      `这一场用了 ${colors.size} 种字色(建议不超过 ${MAX_DISTINCT_COLORS} 种):每一种颜色都该对应一个说得出的语义,`
      + '对不上就别用。')
  }
  if (wholeLineColored > MAX_WHOLE_LINE) {
    locate(scene.line, 'text-color-whole-line-budget', 'warning',
      `这一场有 ${wholeLineColored} 行整行着色(建议不超过 ${MAX_WHOLE_LINE} 行)。`)
  }

  return { census, problems }
}

/** 全剧本的字色推导(板上那一格 + 问题的唯一出处)。 */
export function deriveTextColor(parsed: { scenes: readonly SceneNode[] }): TextColorDerivation {
  const census: SceneColorCensus[] = []
  const problems: DialectProblem[] = []
  for (const scene of parsed.scenes) {
    if (scene.readOnly) continue
    const result = censusSceneTextColor(scene)
    census.push(result.census)
    problems.push(...result.problems)
  }
  return { census, problems, coloredScenes: census.filter((entry) => entry.coloredSpans > 0).length }
}

/**
 * 舞台上那一节"字色调色板"的文本(生成物的一部分)。
 *
 * 三个 `define`(`gf_c_*`)+ 一段写给作者看的**分寸**(不是写给机器的规则 ——
 * 机器那一半在 `deriveTextColor` 里)。
 */
export function renderPaletteSection(): string {
  return [
    '# ── 演出字色(只用这四个槽;用 name 引用,别在剧本里写 hex)────────────────',
    '#',
    "# 剧本里这么写:  \"他抬起头。{color=gf_c_warn}雨停了。{/color}\"",
    '# 每个槽**一个语义**,不是一个好看的颜色:',
    ...TEXT_PALETTE.map((entry) => `#   ${entry.name.padEnd(13)} ${entry.hex}  ${entry.label}(对比度 ${entry.contrast}:1)`),
    '#',
    '# 分寸(为什么是这几条,见 src/service/text-color.ts 的文件头):',
    '#   · 基线必须单调 —— 颜色只留给**少数**地方,它才有重音;',
    '#   · 只在标了 `# galfree:perf` 的演出场里用(那是"这一幕是表演"的声明);',
    '#   · 每 20 行对白最多 1 处;每场最多 2 种色;整行着色每场最多 1 行且只能用装置色;',
    '#   · 对比度按 WCAG SC 1.4.3 的 4.5:1 卡(以**描边色**为底 —— 所以下面的描边是必需的,不是装饰)。',
    '#',
    '# 一条容易踩的坑:`[` 是 Ren\'Py 的插值符,正文里要显示方括号必须写 `[[`。',
    '',
    ...TEXT_PALETTE.map((entry) => `define ${entry.name} = "${entry.hex}"`),
    '',
    '# 整行统一的深色描边 —— 它是彩色字的**安全网**:',
    "# 官方文档写明 outlines 只对**整个** Text displayable 生效、对 text tag 无效,",
    '# 所以描边不可能只加在彩色那一段上。整行都描 ⇒ 彩色字的对比度**与背景无关**。',
    '# (SDK 的 gui 模板默认**没有**描边,这一条是本插件加的;不想要就把下面两段删掉,',
    '#  但那样低对比度的彩色字就可能糊在浅色背景里。)',
    'style say_dialogue:',
    `    outlines [ (3, "${TEXT_OUTLINE_COLOR}", 0, 0) ]`,
    '',
    'style say_label:',
    `    outlines [ (3, "${TEXT_OUTLINE_COLOR}", 0, 0) ]`,
    '',
    "# 历史记录屏默认会把 {color} 过滤掉(`gui.history_allow_tags` 里没有 color,",
    '# 见 SDK 的 screens.rpy),于是"读过的记录里颜色没了"。补上它。',
    '# 用 init 100 而不是 define:这个变量由 screens.rpy 在 init 0 定义,',
    '# 谁先谁后不该靠文件名赌。',
    'init 100 python:',
    '    try:',
    '        gui.history_allow_tags.add("color")',
    '        gui.history_allow_tags.add("c")',
    '    except Exception:',
    '        pass',
    '',
  ].join('\n')
}
