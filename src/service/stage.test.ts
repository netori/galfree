/**
 * 舞台层的守卫(纯函数测试)。
 *
 * 这些用例对着**两个实测过的真 bug**写:
 *  1. `show qiu_yan worried` 在真引擎上抛 `Image 'qiu_yan' does not accept attributes`
 *     —— 根因是素材图的显式定义从来没被写出来(`config.automatic_images` 是 None,
 *     8.5 的目录扫描只按文件名字面注册);
 *  2. 两个立绘同时在场**重叠** —— 根因是剧本里没有 `at` 子句,引擎把它们放在同一处。
 *
 * 所以下面盯的不是"函数返回什么",而是"生成出来的东西能不能让那两个现象不再发生":
 * 定义逐条对得上、站位按在场人数给、`with` 子句不被吃掉、反复整备结果一致(幂等)。
 */
import { describe, expect, it } from 'vitest'
import { parseRpy } from './rpy/parse.ts'
 import { sceneTextForFingerprint } from './dialogue-id.ts'
import {
  applyPlacements, imageDefinitions, placementFor, planStage, PLACEMENT_NAMES, stripManagedPlacement,
  renderStageFile, withPlacement,
} from './stage.ts'

function parse(text: string) {
  return parseRpy([{ name: 'scenes/s1.rpy', text }])
}

const TWO_SPRITES = [
  'label s1:',
  '    scene bg ferry',
  '    show a_tang',
  '    "一个人。"',
  '    show lin_bo',
  '    "两个人。"',
  '    show a_tang serious',
  '    "换表情不该换位置。"',
  '',
].join('\n')

describe('立绘站位(用户报的"两个立绘重叠")', () => {
  it('一个人时居中;第二个人上来时两人分左右(先上那位会挪位)', () => {
    const { edits } = planStage(parse(TWO_SPRITES))
    const at = (line: number) => edits.find((edit) => edit.line === line)?.at
    expect(placementFor(0, 1)).toBe('gf_solo')
    expect(at(3)).toEqual(['gf_duo_left'])
    expect(at(5)).toEqual(['gf_duo_right'])
    // 第 7 行是"换表情"—— 同一 tag 重新 show,位置沿用,不该跳。
    expect(at(7)).toBeUndefined()
  })

  it('表里的每个名字都在"归插件管"的集合里(重排判据与表不会分叉)', () => {
    for (const count of [1, 2, 3, 4, 5]) {
      for (let index = 0; index < count; index += 1) {
        expect(PLACEMENT_NAMES.has(placementFor(index, count))).toBe(true)
      }
    }
  })

  it('人写死的 at 一律不碰,插件只排自己那些位', () => {
    const { edits } = planStage(parse([
      'label s1:',
      '    scene bg hall',
      '    show a_tang at right',
      '    show lin_bo',
      '',
    ].join('\n')))
    // 第 4 行(lin_bo)按表补位 —— 它是**唯一**一个由插件排的立绘 ⇒ 居中。
    // (自动布局不把"人写死的位"算进人数:插件不猜 `at right` 到底占了哪一格。)
    expect(edits.map((edit) => edit.line)).toEqual([4])
    expect(edits[0]!.at).toEqual(['gf_solo'])
  })

  it('人写的位置与自动位撞上时也要报出来(`at right` 与三人场的右位)', () => {
    const { report } = planStage(parse([
      'label s1:',
      '    scene bg hall',
      '    show lin_bo at right',
      '    show a_tang',
      '    show san_shen',
      '',
    ].join('\n')))
    // 自动那两个排成 左/右;人写在 `right` 的那位与自动的**右位**同档 ⇒ 会撞。
    expect(report.overlaps).toHaveLength(1)
    expect(report.overlaps[0]!.names).toEqual(['lin_bo', 'san_shen'])
  })

  it('同站位会被报成重叠(那是"叠在一起"这件事本身)', () => {
    const { report } = planStage(parse([
      'label s1:',
      '    scene bg hall',
      '    show a_tang at right',
      '    show lin_bo at right',
      '',
    ].join('\n')))
    expect(report.overlaps).toHaveLength(1)
    expect(report.overlaps[0]!.names).toEqual(['a_tang', 'lin_bo'])
  })

  it('背景不是立绘:不排位、不参人数', () => {
    const { edits } = planStage(parse([
      'label s1:',
      '    scene bg hall',
      '    show a_tang',
      '    scene bg room',
      '    show lin_bo',
      '',
    ].join('\n')))
    // 每段各只有一个人 ⇒ 都是 solo。
    expect(edits.map((edit) => edit.at[0])).toEqual(['gf_solo', 'gf_solo'])
  })

  it('反复整备结果一致(幂等):补完站位的剧本再排一次,没有任何编辑)', () => {
    const first = planStage(parse(TWO_SPRITES)).edits
    const text = applyPlacements(TWO_SPRITES, first)
    const second = planStage(parse(text)).edits
    expect(second).toEqual([])
    expect(applyPlacements(text, second)).toBe(text)
  })

  it('退场不会把先前那一行"改回去":一个 show 行的 at 管到下一次 show 为止', () => {
    // 实测踩到的形状(迎神的 s04):`show a_tang` → 两句之后 `show lin_bo` → 50 行后 `hide lin_bo`。
    // 退场那一刻台上又只剩一个人 —— 如果照"此刻几个人"回写,第 3 行会被改成居中,
    // 而居中与 lin_bo 的右位**会叠在一起**。所以一行 `at` 取的是"人最多的那一刻"。
    const { edits } = planStage(parse([
      'label s1:',
      '    scene bg hall',
      '    show a_tang',
      '    "只有她。"',
      '    show lin_bo',
      '    "两个人。"',
      '    hide lin_bo',
      '    "又只剩她。"',
      '',
    ].join('\n')))
    expect(edits.map((edit) => [edit.line, edit.at[0]])).toEqual([[3, 'gf_duo_left'], [5, 'gf_duo_right']])
  })

  it('只对生成目录出手(script.rpy 是人的文件)', () => {
    const parsed = parseRpy([
      { name: 'script.rpy', text: 'label start:\n    show a_tang\n    show lin_bo\n' },
      { name: 'scenes/s1.rpy', text: 'label s1:\n    show a_tang\n    show lin_bo\n' },
    ])
    const { edits, report } = planStage(parsed)
    expect(edits.every((edit) => edit.file === 'scenes/s1.rpy')).toBe(true)
    // 但**报告**看全项目:手写文件里的重叠也要说出来(板子不该只看见一半)。
    expect(report.unplaced).toBe(4)
  })
})

describe('补 `at` 子句(不许吃掉行上的其它东西)', () => {
  it('`with dissolve` 原样留着', () => {
    expect(withPlacement('    show qiu_yan worried with dissolve', ['gf_solo']))
      .toBe('    show qiu_yan worried at gf_solo with dissolve')
  })

  it('换掉旧的自动站位,而不是叠一个上去', () => {
    expect(withPlacement('    show a_tang at gf_solo', ['gf_duo_left']))
      .toBe('    show a_tang at gf_duo_left')
    expect(withPlacement('    show a_tang at gf_solo, gf_breathe', ['gf_duo_left']))
      .toBe('    show a_tang at gf_duo_left, gf_breathe')
  })

  it('缩进保留;只动被点名的行', () => {
    const text = ['label s1:', '    show a_tang', '    "台词"', ''].join('\n')
    const next = applyPlacements(text, [{ file: 'scenes/s1.rpy', label: 's1', line: 2, at: ['gf_solo'] }])
    expect(next.split('\n')[2]).toBe('    "台词"')
    expect(next.split('\n')[1]).toBe('    show a_tang at gf_solo')
  })
})

describe('图片定义(用户报的"打开就报错" + 背景灰底)', () => {
  it('只为磁盘上真有的图写定义(还没有的槽不写:那会变成报错屏)', () => {
    const definitions = imageDefinitions({
      slots: ['bg ferry', 'qiu_yan worried', 'qiu_yan'],
      existing: new Set(['game/images/bg-ferry.png', 'game/images/qiu_yan.png']),
    })
    expect(definitions).toEqual([
      { name: 'bg ferry', assetPath: 'images/bg-ferry.png' },
      { name: 'qiu_yan', assetPath: 'images/qiu_yan.png' },
    ])
  })

  it('生成的文件里逐条有定义,并且带站位与调色板', () => {
    const content = renderStageFile({
      slots: ['bg ferry', 'qiu_yan worried'],
      existing: new Set(['game/images/bg-ferry.png', 'game/images/qiu_yan-worried.png']),
      spriteHeight: 1536,
      screenHeight: 720,
    })
    expect(content).toContain('image bg ferry = "images/bg-ferry.png"')
    // 这一行是"两个立绘都不重叠"与"差分不再崩"的共同前提:
    // 名字必须是 `tag 属性`(空格),而不是文件名的字面 `qiu_yan-worried`。
    expect(content).toContain('image qiu_yan worried = "images/qiu_yan-worried.png"')
    expect(content).toContain('define gf_sprite_zoom = 0.469')
    expect(content).toContain('transform gf_duo_left:')
    expect(content).toContain('transform gf_breathe:')
    expect(content).toContain('define gf_c_device = "#e0c060"')
    expect(content).toContain('gui.history_allow_tags.add("color")')
  })

  it('立绘图高变了,缩放自己跟上(不是写死一个魔法数)', () => {
    const content = renderStageFile({
      slots: ['a_tang'],
      existing: new Set(['game/images/a_tang.png']),
      spriteHeight: 1080,
      screenHeight: 720,
    })
    expect(content).toMatch(/define gf_sprite_zoom = 0\.667\b/)
  })
})

describe('生成物的自洽性', () => {
  it('文件头写明它是生成物(手改会被覆盖)', () => {
    const content = renderStageFile({ slots: [], existing: new Set(), spriteHeight: null })
    expect(content).toContain('生成物')
    expect(content).toContain('别在这里手改')
  })

  it('一个立绘都没有时,图片定义那一节如实说是空的(不写空行凑数)', () => {
    const content = renderStageFile({ slots: [], existing: new Set(), spriteHeight: null })
    expect(content).toContain('磁盘上还没有任何被剧本引用到的素材图')
  })
})

describe('指纹口径(整备不该让审读戳作废)', () => {
  it('剔掉插件写的站位子句,但留 `with` 那种子句', () => {
    expect(stripManagedPlacement('    show a_tang at gf_duo_left')).toBe('    show a_tang')
    expect(stripManagedPlacement('    show a_tang at gf_solo with dissolve')).toBe('    show a_tang with dissolve')
    expect(stripManagedPlacement('    show a_tang')).toBe('    show a_tang')
  })

  it('人写的 transform 一个字都不动(那是内容)', () => {
    expect(stripManagedPlacement('    show a_tang at right')).toBe('    show a_tang at right')
    expect(stripManagedPlacement('    show a_tang at gf_solo, gf_breathe')).toBe('    show a_tang at gf_solo, gf_breathe')
    expect(stripManagedPlacement('    show a_tang at my_transform')).toBe('    show a_tang at my_transform')
  })

  it('整备前后指纹相同 —— 点一次整备不会让人重盖一遍戳', () => {
    const before = 'label s1:\n    show a_tang\n    "台词。"\n'
    const after = applyPlacements(before, [{ file: 'scenes/s1.rpy', label: 's1', line: 2, at: ['gf_solo'] }])
    expect(after).not.toBe(before)
    expect(sceneTextForFingerprint(after)).toBe(sceneTextForFingerprint(before))
  })
})
