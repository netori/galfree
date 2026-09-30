/**
 * 舞台层(纯函数)—— 把「素材槽」翻译成 **Ren'Py 真认得的东西**。
 *
 * 这一层是 2026-09-30 实测出来的两个用户级 bug 的正面修法,先说清事实(别照直觉办):
 *
 * **事实一:Ren'Py 不会把 `game/images/bg-ferry.png` 认成图片名 `bg ferry`。**
 *  - `config.automatic_images` 在现代 SDK 里是 `None`(见 `renpy/common/00obsolete.rpy`)。
 *  - 8.5 新增的 `images/` 目录扫描(`renpy/common/00images.rpy` 的 `_scan_images_directory`)
 *    只按**文件名的字面**注册:`renpy.image("bg-ferry", fn)` ⇒ 名字是 `('bg-ferry',)`,
 *    不是 `('bg','ferry')`(`renpy/exports/displayexports.py:67` —— 字符串只按空白切)。
 *  - 而本插件的素材槽口径是 **tag + 属性**(`slot-naming.ts` 的 `slotName()`:
 *    `show bg ferry` / `show qiu_yan worried`)⇒ 差的那一步没人补。
 *
 * 后果是实测过的两件事(钉版 SDK 的 `lint` 与真引擎 traceback 都复现过):
 *  1. `scene bg ferry` → `'bg ferry' is not an image` ⇒ **整屏灰底占位 + 图片名**;
 *  2. `show qiu_yan worried` → 引擎先找 `qiu_yan worried`(没有),退到 `qiu_yan`(有),
 *     多出来的属性没处安放 ⇒ `Exception: Image 'qiu_yan' does not accept attributes 'worried'`
 *     —— **游戏当场崩在那一行**(用户报的"自动化创作完后打开报错")。
 *
 * 所以本模块的第一件事是:**为磁盘上真有的素材文件写显式 `image` 定义**。
 * 只为真有的文件写 —— 后者会让引擎在显示时去读一个不存在的路径(报错屏),
 * 比"灰底占位 + 板上写着缺素材"糟得多。
 *
 * **事实二:两个立绘同时在场 = 重叠。** 剧本里 `show a_tang` / `show lin_bo` 都没有
 * 位置子句,引擎就用默认位置 ⇒ 两张立绘叠在同一处(用户报的第二个 bug)。
 * 修法是**机械补 `at`**:按"这一刻台上有几个人"给每个 `show` 补一个站位变换。
 *
 * **事实三(反直觉,别照直觉写):`at a, b` 里 `a` 是内层、`b` 是外层。**
 * 引擎的实现是 `for i in at_list: img = i(child=img)`
 * (`renpy/exports/displayexports.py:494`)—— 列表里**越靠后越在外面**。
 * 于是"动作 + 站位"的组合要写成 `at <动作>, <站位>`(动作在内、站位在外),
 * 这样站位是相对**缩放之后**的结果定位的。写反了表现是"立绘跑到屏幕外/位置漂了"。
 *
 * 一条边界:**以 `gf_` 开头的站位名归插件管**(整备时按在场人数重排);要自己钉死位置,
 * 用引擎自带的 `left`/`center`/`right` 或自己的 transform —— 那些一律**不碰**。
 */

import type { ParsedScript, SceneNode, Statement } from './rpy/dialect.ts'
import { slotAssetPath } from './slot-naming.ts'
import { renderPaletteSection } from './text-color.ts'

/**
 * 生成物的路径。
 *
 * **这是 `gatewayPathOf` 的口径**(项目根为界,含 `game/`)—— 网关、写日志、快照都用它;
 * 而文件里的图片路径是**相对 `game/`** 的(引擎的 searchpath 只有 `game/`),两者别混。
 */
export const STAGE_FILE = 'game/zz_galfree_stage.rpy'

/** 立绘按「图高 = 屏幕高」归一;屏高/图高算不出来时的缺省(1024×1536 的立绘 + 720p)。 */
export const DEFAULT_SPRITE_ZOOM = 0.469

/**
 * 台上有 n 个立绘时,第 i 个(按**登场顺序**)站哪。
 *
 * 为什么是**表**而不是一条公式:站位同时决定"位"与"大小" —— 三个人以上必须一起缩,
 * 否则 3×480px 的立绘根本排不进 1280px 宽的屏幕。表是最容易看懂、也最容易手调的形状。
 * 名字里带人数(`gf_duo_left`),读剧本的人一眼知道"这是两人场里左边那个"。
 */
export const LAYOUTS: Record<number, readonly string[]> = {
  1: ['gf_solo'],
  2: ['gf_duo_left', 'gf_duo_right'],
  3: ['gf_trio_left', 'gf_trio_center', 'gf_trio_right'],
  4: ['gf_quad_far_left', 'gf_quad_left', 'gf_quad_right', 'gf_quad_far_right'],
  5: ['gf_quint_far_left', 'gf_quint_left', 'gf_quint_center', 'gf_quint_right', 'gf_quint_far_right'],
}

/** 表里出现过的**全部**站位名(判"这一行归不归插件管"用)。 */
export const PLACEMENT_NAMES: ReadonlySet<string> = new Set(Object.values(LAYOUTS).flat())

/** 每种人数对应的缩放系数(相对 `gf_sprite_zoom`)。 */
const LAYOUT_SCALES: Record<number, number> = { 1: 1, 2: 1, 3: 0.82, 4: 0.68, 5: 0.58 }

/** 场上的背景 tag(与 `slots.ts` 的舞台推导同口径:`scene` 把 `bg` 放进舞台状态)。 */
const BACKGROUND_TAG = 'bg'

/**
 * 一行 `show` 的 `at` 子句是否**归插件管**。
 *
 * 判据要窄:`at` 要么是空的,要么**只有一个**、且是表里的站位名。多一个别的东西
 * (人写的 `at left`、`at gf_breathe, gf_duo_left` 这种叠加)一律当成人的意图,不动。
 * 窄判据的代价是"人写好的位置不会被重排",收益是"插件永远不会踩掉人的手写"。
 */
function isManagedPlacement(statement: Extract<Statement, { kind: 'image' }>): boolean {
  if (statement.at.length === 0) return true
  return statement.at.length === 1 && PLACEMENT_NAMES.has(statement.at[0]!)
}

/** 一条待补的站位编辑(行号 1 基,与解析器/表单同口径)。 */
export interface PlacementEdit {
  /** `game/` 下的相对路径。 */
  file: string
  label: string
  line: number
  at: string[]
}

export interface StageReport {
  /** 立绘 `show` 里还没有站位子句的行数(整备前的现象)。 */
  unplaced: number
  /** 同一时刻两个立绘落在**同一个**站位上 —— 那就是"重叠"这件事本身。 */
  overlaps: Array<{ scene: string; file: string; line: number; names: string[] }>
  /** 台上超过 5 个立绘:表排不下,如实说(不假装排好了)。 */
  crowded: string[]
}

export function emptyStageReport(): StageReport {
  return { unplaced: 0, overlaps: [], crowded: [] }
}

/** 第 i 个出场(共 n 人)的站位名;n>5 时前 5 个照表、其余按序复用(会被 `crowded` 报出来)。 */
export function placementFor(index: number, count: number): string {
  const table = LAYOUTS[Math.min(count, 5)]!
  if (index < table.length) return table[index]!
  return table[index % table.length]!
}

/**
 * 粗档位:只用来回答"**人写的位置与插件排的位置会不会撞上**"。
 *
 * 为什么需要它:人可能写 `at right`(引擎自带),而插件排的是 `gf_duo_right` ——
 * 两个名字不同,同名比较抓不住,但它们**在屏幕上就是同一块地方**。
 * 只给几个**方位无歧义**的引擎内置位置做映射,猜不准的一律不映射(宁可漏报,不误报)。
 */
const COARSE: Record<string, 'L' | 'C' | 'R'> = {
  gf_far_left: 'L', gf_left: 'L', gf_duo_left: 'L', gf_trio_left: 'L', gf_quad_left: 'L',
  gf_quad_far_left: 'L', gf_quint_left: 'L', gf_quint_far_left: 'L',
  gf_solo: 'C', gf_trio_center: 'C', gf_quint_center: 'C',
  gf_duo_right: 'R', gf_trio_right: 'R', gf_quad_right: 'R', gf_quad_far_right: 'R',
  gf_quint_right: 'R', gf_quint_far_right: 'R',
  left: 'L', center: 'C', truecenter: 'C', right: 'R',
}

interface SceneWalk {
  edits: PlacementEdit[]
  overlaps: StageReport['overlaps']
  crowded: boolean
  unplaced: number
}

/**
 * 走一遍一场戏,算出每个立绘 `show` 该站的位。
 *
 * 规则(顺序即优先级):
 *  1. 人写了 `at`(且不是表里的站位名)→ **不动**,而且不参与自动布局的排名 ——
 *     插件只负责自己排的那些位("我排的我自己管,人写的我不猜")。
 *  2. tag 已经在台上(同一角色换表情)→ 沿用当前布局给它的位(否则换个表情人就跳一下)。
 *  3. 新上场的角色 → 按登场顺序排进"此刻**自动**人数"对应的布局。
 *
 * 重排是**故意的**,也是**可回写的**:一个人时居中,第二个人上来时先上那位挪到左边 ——
 * 所以编辑清单按**行号**记账,后面出现的角色会让前面那几行的目标位置跟着更新。
 * 因为它是可重算的纯函数,反复跑结果一致(幂等)。
 */
function walkScene(scene: SceneNode, file: string): SceneWalk {
  /**
   * 行号 → 这一行**最该用的**站位,以及它是在"几个人在场"时算出来的。
   *
   * 为什么要记"几个人在场"这一笔(实测踩到的):一个 `show` 行的 `at` 子句从这一行起
   * 一直管到那个 tag 再次 show 为止 —— 引擎不知道"第 12 行又来了一个人"。于是当那个 tag
   * 在场期间人数变过(先 1 人后 2 人、或者中途有人退场),我们**只能挑一个**写下去。
   * 挑的准则是:**按人最多的那一刻** —— 一个人站着偏左只是不好看,两个人叠在一起是 bug。
   */
  const best = new Map<number, { name: string; count: number; original: string[]; reappear: boolean }>()
  const overlaps: StageReport['overlaps'] = []
  let crowded = false

  /** 台上的立绘:tag → 当前 show 行的信息。Map 的插入序 = 登场顺序。 */
  const visible = new Map<string, { line: number; fixed: string[] | null; original: string[]; reappear: boolean }>()

  const recompute = (): void => {
    const members = [...visible.entries()].map(([tag, entry]) => ({ tag, ...entry }))
    const autos = members.filter((member) => member.fixed === null)
    if (members.length > 5) crowded = true
    // 位置最终值(供碰撞检测用):人写死的照抄,自动的按表算。
    const resolved: Array<{ tag: string; name: string; fixed: boolean }> = []
    autos.forEach((member, index) => {
      const name = placementFor(index, autos.length)
      resolved.push({ tag: member.tag, name, fixed: false })
      const current = best.get(member.line)
      // 只在"人更多"的那一刻改主意(同人数时保留先算出来的那一版 —— 结果与调用顺序无关)。
      if (current === undefined || autos.length > current.count) {
        best.set(member.line, { name, count: autos.length, original: member.original, reappear: member.reappear })
      }
    })
    for (const member of members) {
      if (member.fixed === null) continue
      resolved.push({ tag: member.tag, name: member.fixed.join(', '), fixed: true })
    }

    // 同名 = 一定叠在一起;人写死的**引擎方位**与自动位同档 = 很可能叠在一起。
    const byName = new Map<string, string[]>()
    for (const entry of resolved) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.tag])
    const hits = [...byName.entries()].filter(([, tags]) => tags.length > 1).map(([name, tags]) => ({ name, tags }))
    for (const fixedEntry of resolved.filter((entry) => entry.fixed && COARSE[entry.name] !== undefined)) {
      for (const autoEntry of resolved.filter((entry) => !entry.fixed)) {
        if (COARSE[autoEntry.name] !== COARSE[fixedEntry.name]) continue
        hits.push({ name: `${fixedEntry.name} ≈ ${autoEntry.name}`, tags: [fixedEntry.tag, autoEntry.tag] })
      }
    }
    for (const hit of hits) {
      const key = `${scene.label}|${[...hit.tags].sort().join()}`
      if (overlaps.some((entry) => `${entry.scene}|${entry.names.join()}` === key)) continue
      const first = members.find((member) => member.tag === hit.tags[0]!)
      if (first === undefined) continue
      overlaps.push({ scene: scene.label, file, line: first.line, names: [...hit.tags].sort() })
    }
  }

  for (const statement of scene.statements) {
    if (statement.kind !== 'image') continue
    if (statement.role === 'scene') {
      visible.clear()
    }
    if (statement.role === 'hide') {
      visible.delete(statement.tag)
      recompute()
      continue
    }
    // 背景不是立绘:不排位、也不参人数。
    if (statement.tag === BACKGROUND_TAG) continue

    const managed = isManagedPlacement(statement)
    const previous = visible.get(statement.tag)
    visible.set(statement.tag, {
      line: statement.line,
      fixed: managed ? (previous?.fixed ?? null) : [...statement.at],
      original: [...statement.at],
      // 这个 tag 已经在台上了 ⇒ 这一行是"换表情"而不是登场。
      reappear: previous !== undefined,
    })
    recompute()
  }

  const edits: PlacementEdit[] = []
  let unplaced = 0
  for (const [line, entry] of best) {
    // 已经写着同一个位的行不必重写(git diff 越安静越好)。
    if (entry.original.length === 1 && entry.original[0] === entry.name) continue
    /**
     * 「换表情」那一行:
     *  - 它**没写** `at` → 不动。引擎自己会保留那个 tag 当前的 transform,
     *    再补一个 `at` 只会白写一次、还可能把入场动画重放一遍;
     *  - 它**写着**一个插件管理的站位(上一轮整备补的)→ 照样更新,否则换表情时人会跳回旧位。
     */
    if (entry.reappear && entry.original.length === 0) continue
    if (entry.original.length === 0) unplaced += 1
    edits.push({ file, label: scene.label, line, at: [entry.name] })
  }
  return { edits: edits.sort((a, b) => a.line - b.line), overlaps, crowded, unplaced }
}

export interface StagePlan {
  edits: PlacementEdit[]
  report: StageReport
}

/**
 * 全项目扫描:每个生成目录里的场景要补哪些站位、哪里会重叠。
 *
 * **只对 `game/scenes/**` 出手**(生成目录)。`script.rpy` 是人的文件,生成器不越界 ——
 * 与"搬家"(`relocateScene`)同一条边界:人想让某一场被整备,先把那一段搬进生成目录。
 * 但**报告看全项目**:手写文件里有两个立绘叠着,板子也该说出来。
 */
export function planStage(parsed: Pick<ParsedScript, 'scenes'>): StagePlan {
  const edits: PlacementEdit[] = []
  const report = emptyStageReport()
  for (const scene of parsed.scenes) {
    if (scene.readOnly) continue
    const walk = walkScene(scene, scene.file)
    report.unplaced += walk.unplaced
    report.overlaps.push(...walk.overlaps)
    if (walk.crowded) report.crowded.push(scene.label)
    if (!scene.file.startsWith('scenes/')) continue
    edits.push(...walk.edits)
  }
  return { edits, report }
}

/** 子句关键字:`at` 之后、它们之前是站位内容。 */
const CLAUSE_KEYWORD = /\s(at|with|behind|zorder)(?=\s|$)/
/**
 * 行里已有的 `at …` 子句(**整个子句 + 里面的名字列表**)。
 *
 * 每个 token 前挂一个负向先行断言把 `with` / `behind` / `zorder` 排除掉 ——
 * 否则贪婪匹配会把 `with dissolve` 也当成变换名吞进去(那不是"补站位",那是删转场)。
 */
const AT_CLAUSE = /^\s+at((?:\s+(?!(?:with|behind|zorder)(?:\s|$))[A-Za-z0-9_,]+)*)/

/**
 * 把 `at <变换名>` 补进**一行原文**,其余部分逐字保留。
 *
 * 为什么不是"整行重新序列化":那一行可能有 `with dissolve` 这种子句
 * (`show qiu_yan worried with dissolve` 是生成侧真写过的形状),
 * 重新序列化会**悄悄吃掉它** —— 表现是"只是补了个站位,转场没了"。
 *
 * 已有的 `at` 子句**只换掉其中的站位名**(`gf_*` 表里的那些),
 * 人叠的动作(`at gf_solo, gf_breathe` 里的 `gf_breathe`)原样留着 ——
 * 只因为要换站位就把人的动作删掉,那是插件在踩人的手写。
 */
export function withPlacement(raw: string, transforms: string[]): string {
  const indent = /^[ \t]*/.exec(raw)?.[0] ?? ''
  const body = raw.slice(indent.length)
  const keyword = CLAUSE_KEYWORD.exec(body)
  if (keyword === null) {
    const clause = transforms.length === 0 ? '' : ` at ${transforms.join(', ')}`
    return `${indent}${body}${clause}`
  }
  const head = body.slice(0, keyword.index)
  const tail = body.slice(keyword.index)
  const existing = AT_CLAUSE.exec(tail)
  // 保留下来的那些名字(人在同一个 `at` 里叠的动作)要与新站位**合成同一个子句** ——
  // 写成两个 `at` 是坏语法(引擎读不懂,而且没人会想到去查这里)。
  const kept = existing === null
    ? []
    : (existing[1] ?? '').split(/[\s,]+/).filter((token) => token !== '' && !PLACEMENT_NAMES.has(token))
  const list = [...transforms, ...kept]
  const clause = list.length === 0 ? '' : ` at ${list.join(', ')}`
  // 没有 `at` 子句时,`tail` 整段(就是 `with …` 那些)原样留着。
  const rest = existing === null ? tail : tail.slice(existing[0].length)
  const after = rest.startsWith(' ') || rest === '' ? rest : ` ${rest}`
  return `${indent}${head}${clause}${after}`
}

/**
 * 一行原文 → **剔掉插件管理的站位子句**之后的形态(审读戳指纹用)。
 *
 * 为什么指纹要剔它:整备是**常规动作**(出完图点一下),而 `at gf_duo_left` 是它机械补上去的、
 * 不是人写的叙述 —— 算进指纹的后果是"点一次整备,所有审读戳作废"。这与 id 子句是同一条纪律
 * (`dialogue-id.ts` 的 `sceneTextForFingerprint` 把两者一起剔)。
 *
 * 剔的判据与"归不归插件管"**同一条**(只认表里的名字,且只有一个):
 * 人写的东西(`at left`、`at my_transform`、`at gf_solo, gf_breathe`)一个字都不动 ——
 * 那些整备本来也不改,于是指纹**稳定**:整备前后算出来一样,人改一次算出来不一样。
 */
export function stripManagedPlacement(line: string): string {
  const keyword = CLAUSE_KEYWORD.exec(line)
  if (keyword === null) return line
  const tail = line.slice(keyword.index)
  const existing = AT_CLAUSE.exec(tail)
  if (existing === null) return line
  const names = (existing[1] ?? '').split(/[\s,]+/).filter((token) => token !== '')
  if (names.length !== 1 || !PLACEMENT_NAMES.has(names[0]!)) return line
  const head = line.slice(0, keyword.index)
  const rest = tail.slice(existing[0].length)
  return rest.trim() === '' ? head : `${head}${rest}`
}

/** 把一批站位编辑落到**一个文件**的文本上(其余行逐字不动,与 `applySceneEdit` 同一态度)。 */export function applyPlacements(text: string, edits: readonly PlacementEdit[]): string {
  if (edits.length === 0) return text
  const lines = text.split('\n')
  for (const edit of edits) {
    const current = lines[edit.line - 1]
    if (current === undefined) continue
    lines[edit.line - 1] = withPlacement(current, edit.at)
  }
  return lines.join('\n')
}

export interface StageFileInput {
  /** 要写进定义的槽名(`tag 属性…`)。 */
  slots: readonly string[]
  /** 磁盘上真有的素材路径(项目根为界的 POSIX 路径,如 `game/images/bg-ferry.png`)。 */
  existing: ReadonlySet<string>
  /** 立绘图高(px);用来把 `gf_sprite_zoom` 定成"图高 = 屏幕高"。 */
  spriteHeight: number | null
  /** 项目虚拟分辨率高(缺省 720;从 `gui.rpy` 读到的真值更准)。 */
  screenHeight?: number
}

/** 槽名 → 图片定义;没有对应文件的槽**不写**(理由见文件头)。 */
export function imageDefinitions(input: Pick<StageFileInput, 'slots' | 'existing'>): Array<{ name: string; assetPath: string }> {
  const definitions: Array<{ name: string; assetPath: string }> = []
  const seen = new Set<string>()
  for (const raw of input.slots) {
    const name = raw.trim().replace(/\s+/g, ' ')
    if (name === '' || seen.has(name)) continue
    const assetPath = slotAssetPath(name)
    if (!input.existing.has(assetPath)) continue
    seen.add(name)
    definitions.push({ name, assetPath: assetPath.slice('game/'.length) })
  }
  return definitions
}

/** 缩放系数写到文件里的形态:四位小数去掉尾零(`0.469`、`0.3846`)。 */
function zoomText(value: number): string {
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 站位/动作变换的**全部文本** —— 一处定义,`renderStageFile` 与测试读同一份。
 *
 * 每条站位都带 `zoom`(缩放在站位里,不在外层):这样"三人在场一起缩小"这件事
 * 只由站位表决定,剧本里看不到魔法数字。
 */
export function transformVocabulary(zoom: number): string {
  const scaled = (factor: number): string => `gf_sprite_zoom * ${zoomText(factor)}`
  /** 一个站位:左/中/右锚点 + 该人数的缩放。 */
  const position = (name: string, xanchor: number, xpos: number, factor: number): string[] => [
    `transform ${name}:`,
    `    zoom ${scaled(factor)}`,
    `    xanchor ${xanchor}`,
    `    xpos ${xpos}`,
    // 底对齐:立绘的底边贴屏幕底 —— 半身立绘也因此永远不会被切掉头。
    '    yalign 1.0',
    '',
  ]
  return [
    '# ── 站位(整备会按在场人数自动写进剧本的 at 子句)──────────────────────',
    '# 一人在场:居中。两人:左 + 右。三人以上一起缩,保证排得进屏幕宽度。',
    ...position('gf_solo', 0.5, 0.5, 1),
    ...position('gf_duo_left', 0, 0.1, 1),
    ...position('gf_duo_right', 1, 0.9, 1),
    ...position('gf_trio_left', 0, 0.04, 0.82),
    ...position('gf_trio_center', 0.5, 0.5, 0.82),
    ...position('gf_trio_right', 1, 0.96, 0.82),
    ...position('gf_quad_far_left', 0, 0, 0.68),
    ...position('gf_quad_left', 0, 0.34, 0.68),
    ...position('gf_quad_right', 1, 0.66, 0.68),
    ...position('gf_quad_far_right', 1, 1, 0.68),
    ...position('gf_quint_far_left', 0, 0, 0.58),
    ...position('gf_quint_left', 0, 0.26, 0.58),
    ...position('gf_quint_center', 0.5, 0.5, 0.58),
    ...position('gf_quint_right', 1, 0.74, 0.58),
    ...position('gf_quint_far_right', 1, 1, 0.58),
    '# ── 演出动作(给剧本手写用;整备**不会**自动加)────────────────────────',
    '#',
    '# **组合顺序是反的,照这条抄**:Ren\'Py 的 `at a, b` 里 a 在内层、b 在外层',
    '# (`renpy/exports/displayexports.py:494`:`for i in at_list: img = i(child=img)`)。',
    '# 所以"动作 + 站位"要写成 `at <动作>, <站位>` —— 站位在外,才算在**缩放之后**定位。',
    '# 例:  show a_tang worried at gf_focus, gf_duo_left',
    '#       show san_shen at gf_breathe, gf_trio_right',
    '# 单独用也是安全的(都自带居中锚点),但记得 `gf_focus` 这类**不改站位**,',
    '# 一个人时配 `gf_solo`、两个人在场配 `gf_duo_left`/`gf_duo_right`。',
    '',
    '# 入场:从画外滑进来并淡入(站位已含在内,单独用)。首次登场比"啪一下出现"生动。',
    'transform gf_in_left:',
    `    zoom ${scaled(1)}`,
    '    xanchor 0.0',
    '    yalign 1.0',
    '    xpos -0.35',
    '    alpha 0.0',
    '    parallel:',
    '        easein 0.45 xpos 0.1',
    '    parallel:',
    '        linear 0.35 alpha 1.0',
    '',
    'transform gf_in_right:',
    `    zoom ${scaled(1)}`,
    '    xanchor 1.0',
    '    yalign 1.0',
    '    xpos 1.35',
    '    alpha 0.0',
    '    parallel:',
    '        easein 0.45 xpos 0.9',
    '    parallel:',
    '        linear 0.35 alpha 1.0',
    '',
    'transform gf_in_center:',
    `    zoom ${scaled(1.06)}`,
    '    xanchor 0.5',
    '    yalign 1.0',
    '    xpos 0.5',
    '    alpha 0.0',
    '    parallel:',
    `        easeout 0.5 zoom ${scaled(1)}`,
    '    parallel:',
    '        linear 0.35 alpha 1.0',
    '',
    '# 站定后的一次性小动作(都自带居中锚点;组合时写在**前面**)。',
    'transform gf_focus:',
    '    xanchor 0.5',
    '    xpos 0.5',
    '    yalign 1.0',
    `    easein 0.25 zoom ${scaled(1.16)}`,
    '',
    'transform gf_recede:',
    '    xanchor 0.5',
    '    xpos 0.5',
    '    yalign 1.0',
    `    easein 0.25 zoom ${scaled(0.86)} alpha 0.88`,
    '',
    '# 受惊/发抖:幅度小才像人,大了像鬼畜。',
    'transform gf_shake:',
    '    xanchor 0.5',
    '    xpos 0.5',
    '    yalign 1.0',
    '    block:',
    '        linear 0.03 xoffset 6',
    '        linear 0.03 xoffset -6',
    '        repeat 3',
    '    linear 0.06 xoffset 0',
    '',
    '# 台上的呼吸感:idle 时的极慢缩放循环(幅度 1.2%,大了会晕)。',
    'transform gf_breathe:',
    '    xanchor 0.5',
    '    xpos 0.5',
    '    yalign 1.0',
    '    block:',
    `        ease 1.6 zoom ${scaled(1.012)}`,
    `        ease 1.6 zoom ${scaled(1)}`,
    '        repeat',
    '',
    '# 特写:放大后**顶对齐**(立绘的头在画面顶端,底对齐会把头切掉)。',
    'transform gf_close:',
    `    zoom ${scaled(1.75)}`,
    '    xanchor 0.5',
    '    xpos 0.5',
    '    yanchor 0.0',
    '    ypos 0.0',
    '',
  ].join('\n')
}

/** 生成 `game/zz_galfree_stage.rpy` 的**全文**(可重算、幂等)。 */
export function renderStageFile(input: StageFileInput): string {
  const screenHeight = input.screenHeight ?? 720
  const zoom = input.spriteHeight === null || input.spriteHeight <= 0
    ? DEFAULT_SPRITE_ZOOM
    : Math.round((screenHeight / input.spriteHeight) * 1000) / 1000
  const definitions = imageDefinitions(input)
  const header = [
    '# ─────────────────────────────────────────────────────────────────────',
    '# GALFree 舞台层 —— **生成物**:下一次「整备舞台」会整份重写,别在这里手改。',
    '# 要改效果请改 src/service/stage.ts,或在剧本里用你自己的 transform。',
    '# ─────────────────────────────────────────────────────────────────────',
    '#',
    '# 它回答两件实测出来的事(没有它,游戏是坏的,不是"不好看"):',
    '#',
    '# 1) 素材图 → 图片名。现代 Ren\'Py 不再自动定义图片名:',
    "#    config.automatic_images 是 None(SDK 的 00obsolete.rpy);",
    '#    8.5 的 images/ 目录扫描只按**文件名字面**注册',
    '#    (game/images/bg-ferry.png 注册成 "bg-ferry",不是 "bg ferry")。',
    '#    而素材槽的口径是 tag + 属性(scene bg ferry / show qiu_yan worried)。',
    '#    缺这一步的实测症状:背景全变灰底占位;`show qiu_yan worried` 直接抛',
    '#    "Image \'qiu_yan\' does not accept attributes \'worried\'" 把游戏打崩。',
    '#    **只为磁盘上真有的图写定义** —— 还没出的槽不写(引擎会去读一个不存在的文件,',
    '#    那是报错屏,比"灰底占位 + 板上写着缺素材"糟)。',
    '#',
    '# 2) 立绘站位(gf_* 变换)。没有站位子句的两个立绘会落在同一个默认位置 ⇒ 重叠。',
    '#    「整备舞台」按"此刻台上有几个人"把站位机械地补进剧本的 `at` 子句。',
    '#    **以 gf_ 开头的站位名归插件管**(重排时会被改写);要钉死一个位置,',
    '#    用引擎自带的 left/center/right 或你自己的 transform —— 那些一律不碰。',
    '#',
    '# 3) 演出字色的调色板 + 描边(最后一节)。颜色**不是**自由取色的:四个槽、一个语义一档,',
    '#    分寸与理由见 src/service/text-color.ts 的文件头(那里写清了哪些是实测、哪些是判断)。',
    '#',
    `# 立绘缩放基准:本项目立绘图高 ${input.spriteHeight === null ? '(还没出过图,用缺省)' : `${input.spriteHeight}px`},`,
    `# 屏幕虚拟高 ${screenHeight}px ⇒ zoom = ${zoom}。换了出图尺寸,整备一次就会自动重算。`,
    '',
    `define gf_sprite_zoom = ${zoom}`,
    '',
  ].join('\n')

  const body = definitions.length === 0
    ? [
        '# ── 图片定义 ──────────────────────────────────────────────────────────',
        '# 磁盘上还没有任何被剧本引用到的素材图 —— 这里就是空的。',
        '# 出图之后整备一次,定义就会出现。',
        '',
      ].join('\n')
    : [
        '# ── 图片定义 ──────────────────────────────────────────────────────────',
        `# ${definitions.length} 张(槽被剧本引用 + 文件真在磁盘上)。`,
        ...definitions.map((definition) => `image ${definition.name} = "${definition.assetPath}"`),
        '',
      ].join('\n')

  return [header, body, transformVocabulary(zoom), renderPaletteSection()].join('\n')
}
