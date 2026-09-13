/**
 * T26(#34)守卫 —— 对话 id + `config.auto_voice`(ADR-0013)。
 *
 * 为什么要这条:**不给显式 id 时,Ren'Py 的对话标识符是内容哈希**
 * (`renpy/translation/__init__.py:337-357`)—— 改一个字,那一句的语音文件就找不到。
 * 而本产品逐场重生成是常规动作。所以文件名锚必须是显式 `id <name>`
 * (语法见 `renpy/parser.py:1491`;实测见 ADR-0013 的实测节)。
 *
 * 另一半同样要紧:id 是**制作信息,不是叙述内容**(ADR-0003/0009)——
 * 写进去不许让审读戳失效,否则每生成一次语音,人都得把整场重盖一遍。
 */
import { describe, expect, it } from 'vitest'
import { parseRpy } from './rpy/parse.ts'
import { sceneFingerprint } from './progress.ts'
import { stampDialogueIds } from './dialogue-id.ts'

function parse(source: string) {
  return parseRpy([{ name: 'script.rpy', text: source }])
}

/** 一个场景里第一条对白语句(测试里到处要用)。 */
function firstDialogue(source: string) {
  const scene = parse(source).scenes[0]!
  const statement = scene.statements.find((candidate) => candidate.kind === 'dialogue')
  if (statement === undefined || statement.kind !== 'dialogue') throw new Error('没解析出对白语句')
  return statement
}

/** 场景里的对白语句(条数也要断言 —— 别让"整行没解析出来"空过)。 */
function dialogues(source: string) {
  const scene = parse(source).scenes[0]!
  return scene.statements.filter((statement): statement is Extract<typeof statement, { kind: 'dialogue' }> => statement.kind === 'dialogue')
}

const SCENE = [
  'label start:',
  '    e "第一句。"',
  '    return',
  '',
].join('\n')

describe('对话 id 子句(T26)', () => {
  it('带 id 的对白:解析得出 id,而且**不算**子集外(不降级只读)', () => {
    const source = [
      'label start:',
      '    e "这一句要配音。" id ch1_0007',
      '    return',
      '',
    ].join('\n')
    const parsed = parse(source)
    const scene = parsed.scenes[0]!
    expect(scene.readOnly).toBe(false)
    expect(scene.problems).toEqual([])
    // **条数也要断言**:只查 `id` 的话,"整行没解析出来 → id 是 null"会伪装成失败,
    // 而"整行被跳过"更糟 —— 它会伪装成通过(实测踩过一次,这条注释就是那次留下的)。
    const found = dialogues(source)
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('ch1_0007')
    expect(found[0]!.text).toBe('这一句要配音。')
  })

  it('子句顺序两种都要认(`id` 在 `with` 前/后 —— 引擎的解析器就是这么写的)', () => {
    const withFirstSource = [
      'label start:',
      '    e "甲。" with dissolve id ch1_0001',
      '    return',
      '',
    ].join('\n')
    const withFirst = dialogues(withFirstSource)
    expect(withFirst).toHaveLength(1)
    expect(withFirst[0]!.id).toBe('ch1_0001')
    expect(withFirst[0]!.speaker).toBe('e')
    expect(withFirst[0]!.text).toBe('甲。')

    const idFirstSource = [
      'label start:',
      '    e "乙。" id ch1_0002 with dissolve',
      '    return',
      '',
    ].join('\n')
    const idFirst = dialogues(idFirstSource)
    expect(idFirst).toHaveLength(1)
    expect(idFirst[0]!.id).toBe('ch1_0002')
    expect(idFirst[0]!.speaker).toBe('e')
    expect(idFirst[0]!.text).toBe('乙。')
  })

  it('没有 id 子句的对白:id 是 null(如实,不是空串、不是未定义)', () => {
    expect(firstDialogue(SCENE).id).toBeNull()
  })

  it('旁白也能带 id(旁白同样要配音)', () => {
    const statement = firstDialogue([
      'label start:',
      '    "雨还在下。" id ch1_0003',
      '    return',
      '',
    ].join('\n'))
    expect(statement.speaker).toBeNull()
    expect(statement.id).toBe('ch1_0003')
  })

  it('id 不合引擎的取名规则 → **error 级**如实拒绝(不是一句 warning 放过去)', () => {
    // 引擎那一条是 `l.require(l.name)`:首字符必须是字母/下划线,其余是字母数字下划线。
    for (const bad of ['1abc', 'has-dash', 'has space']) {
      const parsed = parse([
        'label start:',
        `    e "坏 id。" id ${bad}`,
        '    return',
        '',
      ].join('\n'))
      const problems = parsed.scenes[0]!.problems
      expect(problems.some((problem) => problem.code === 'invalid-dialogue-id' && problem.severity === 'error')).toBe(true)
    }
  })

  it('同一场里 id 重复 → error(重复的 id 会让两句抢同一个语音文件)', () => {
    const parsed = parse([
      'label start:',
      '    e "甲。" id ch1_0001',
      '    e "乙。" id ch1_0001',
      '    return',
      '',
    ].join('\n'))
    const problems = parsed.scenes[0]!.problems
    expect(problems.some((problem) => problem.code === 'duplicate-dialogue-id' && problem.severity === 'error')).toBe(true)
  })

  it('id 写在 `with` 之后但缺名字 → 如实拒绝(不是静默当成"没有 id")', () => {
    const parsed = parse([
      'label start:',
      '    e "丙。" with dissolve id',
      '    return',
      '',
    ].join('\n'))
    const scene = parsed.scenes[0]!
    const flagged = scene.problems.some((problem) => problem.code === 'invalid-dialogue-id') || scene.readOnly
    expect(flagged).toBe(true)
  })

  // ─── 这一半是这条票真正难的地方:指纹 ────────────────────────────────

  it('**加 id 子句不改变场景指纹**(id 是制作信息,不是叙述内容)', () => {
    const before = sceneFingerprint({ text: SCENE })
    const after = sceneFingerprint({ text: [
      'label start:',
      '    e "第一句。" id ch1_0001',
      '    return',
      '',
    ].join('\n') })
    expect(after).toBe(before)
  })

  it('换一个 id 也不改变指纹(重命名语音文件不该让人重盖戳)', () => {
    const a = sceneFingerprint({ text: ['label start:', '    e "第一句。" id ch1_0001', '    return', ''].join('\n') })
    const b = sceneFingerprint({ text: ['label start:', '    e "第一句。" id ch1_0002', '    return', ''].join('\n') })
    expect(b).toBe(a)
  })

  it('**改台词照样改变指纹**(剔除 id 不等于放过内容 —— 这是审读戳的底线)', () => {
    const before = sceneFingerprint({ text: SCENE })
    const after = sceneFingerprint({ text: ['label start:', '    e "改过的台词。" id ch1_0001', '    return', ''].join('\n') })
    expect(after).not.toBe(before)
  })

  it('剔除只发生**行尾的 id 子句**上:正文里出现 id 不会被误剔', () => {
    const a = sceneFingerprint({ text: ['label start:', '    e "这句话里有 id 这个词。"', '    return', ''].join('\n') })
    const b = sceneFingerprint({ text: ['label start:', '    e "这句话里有 id。"', '    return', ''].join('\n') })
    expect(a).not.toBe(b)
  })

  // ─── 生成侧:id 得**写得进去**,不然整套语音计划是空的 ────────────────

  describe('按场次给对白盖章(stampDialogueIds)', () => {
    const GENERATED = [
      'label scene_one:',
      '    scene bg school',
      '    e "第一句。"',
      '    "旁白也算一句。"',
      '    e "第三句。" with dissolve',
      '    return',
      '',
    ].join('\n')

    it('逐条对白按序号盖 id,其它行一行不动', () => {
      const out = stampDialogueIds(GENERATED, 'scene_one')
      expect(out.split('\n')[1]).toBe('    scene bg school')
      expect(out).toContain('e "第一句。" id scene_one_0000')
      expect(out).toContain('"旁白也算一句。" id scene_one_0001')
      // `with` 子句照样在,id 插在它后面(两种顺序引擎都认,我们统一成"id 在最后")。
      expect(out).toContain('e "第三句。" with dissolve id scene_one_0002')
      expect(out).toContain('    return')
    })

    it('**盖章是幂等的**:再盖一次不重复、不改已定的 id', () => {
      const once = stampDialogueIds(GENERATED, 'scene_one')
      const twice = stampDialogueIds(once, 'scene_one')
      expect(twice).toBe(once)
    })

    it('**改台词不掉 id**:同一个 label + 同序号永远是同一个 id(这就是它的全部意义)', () => {
      const before = stampDialogueIds(GENERATED, 'scene_one')
      const after = stampDialogueIds(GENERATED.replace('第一句。', '第一句(改过措辞)。'), 'scene_one')
      expect(after).toContain('id scene_one_0000')
      expect(after).not.toBe(before) // 台词变了,文本变了
      // 而 id 没变 —— 已经生出来的语音文件照样找得到。
      const idOfFirst = (text: string): string | null => dialogues(text)[0]!.id
      expect(idOfFirst(after)).toBe(idOfFirst(before))
    })

    it('盖完 id 的场景仍然是**子集内**、无 error、过得了指纹那关', () => {
      const stamped = stampDialogueIds(GENERATED, 'scene_one')
      const parsed = parse(stamped)
      expect(parsed.scenes[0]!.readOnly).toBe(false)
      expect(parsed.scenes[0]!.problems).toEqual([])
      // 指纹与"没盖章但台词一样"的版本相同(id 不进指纹)。
      const plain = GENERATED.replace(/ id scene_one_\d{4}/g, '')
      expect(sceneFingerprint({ text: stamped })).toBe(sceneFingerprint({ text: plain }))
    })

    it('子集外的行(块构造)不被碰 —— 盖不了章的照旧如实降级', () => {
      const withUnsupported = [
        'label scene_two:',
        '    e "能盖的盖。"',
        '    if flag:',
        '        e "块里的不碰。"',
        '    return',
        '',
      ].join('\n')
      const out = stampDialogueIds(withUnsupported, 'scene_two')
      expect(out).toContain('e "能盖的盖。" id scene_two_0000')
      // 块里的那句**在块内**,不去动它(它本来就子集外、整场只读)。
      expect(out).toContain('        e "块里的不碰。"')
    })
  })
})
