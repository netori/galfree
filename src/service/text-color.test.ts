/**
 * 演出字色的守卫。
 *
 * 盯的是那份调研里**立得住**的几条(出处见 `text-color.ts` 文件头与
 * `.scratch/research-text-color.md`),不是传闻:
 *  - 调色板每一档与描边色的对比度 ≥ 4.5:1(WCAG SC 1.4.3 Note 5:描边可计入);
 *  - 未知文本标签会被引擎在运行时抛(但项目能自定义标签 ⇒ 只警告);
 *  - 分寸是建议(密度 / 色数 / 整行 / 用在哪一场)—— 全部 warning,不拦发布。
 */
import { describe, expect, it } from 'vitest'
import { parseRpy } from './rpy/parse.ts'
import { contrastRatio, deriveTextColor, isPerformanceScene, paletteHex, TEXT_OUTLINE_COLOR, TEXT_PALETTE } from './text-color.ts'

function parse(text: string, name = 'scenes/s1.rpy') {
  return parseRpy([{ name, text }])
}

function codesOf(text: string): string[] {
  return deriveTextColor(parse(text)).problems.map((problem) => problem.code)
}

const PERF = '# galfree:perf'

describe('调色板', () => {
  it('每一档与描边色的对比度都过 4.5:1(过不了就不该进调色板)', () => {
    for (const entry of TEXT_PALETTE) {
      const ratio = contrastRatio(entry.hex, TEXT_OUTLINE_COLOR)
      expect(ratio, `${entry.name} ${entry.hex}`).not.toBeNull()
      expect(ratio!, `${entry.name} ${entry.hex}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('文件里写的那个对比度数字是真的算出来的(不是抄的)', () => {
    for (const entry of TEXT_PALETTE) {
      expect(contrastRatio(entry.hex, TEXT_OUTLINE_COLOR)!).toBeCloseTo(entry.contrast, 1)
    }
  })

  it('调色板名与 hex 都收;别的名字不收(不猜一个颜色出来)', () => {
    expect(paletteHex('gf_c_warn')).toBe('#e8564f')
    expect(paletteHex('#e8564f')).toBe('#e8564f')
    expect(paletteHex('red')).toBeNull()
    expect(paletteHex('')).toBeNull()
  })

  it('task 里举例的那个警示红确实不过线(闸门不是摆设)', () => {
    expect(contrastRatio('#c0504d', TEXT_OUTLINE_COLOR)!).toBeLessThan(4.5)
  })
})

describe('演出场标记', () => {
  it('认 `# galfree:perf` 那一行注释', () => {
    expect(isPerformanceScene({ text: `label s1:\n    ${PERF}\n    "……"\n` })).toBe(true)
    expect(isPerformanceScene({ text: 'label s1:\n    "……"\n' })).toBe(false)
  })
})

describe('体检', () => {
  it('没上色的戏:一条问题都不报(基线本该是单调的)', () => {
    expect(codesOf('label s1:\n    scene bg hall\n    "普通的一句。"\n')).toEqual([])
  })

  it('数得出着色处数、色种数与整行着色', () => {
    const census = deriveTextColor(parse([
      'label s1:',
      `    ${PERF}`,
      '    "他抬起头。{color=gf_c_warn}雨停了。{/color}"',
      '    "又一句。"',
      '',
    ].join('\n'))).census[0]!
    expect(census.coloredSpans).toBe(1)
    expect(census.distinctColors).toEqual(['gf_c_warn'])
    expect(census.wholeLineColored).toBe(0)
    expect(census.perf).toBe(true)
    expect(census.dialogueLines).toBe(2)
  })

  it('整行着色只允许装置色', () => {
    const whole = (name: string): string[] => codesOf([
      'label s1:',
      `    ${PERF}`,
      `    "{color=${name}}整行。{/color}"`,
      '',
    ].join('\n'))
    expect(whole('gf_c_device')).not.toContain('text-color-whole-line')
    expect(whole('gf_c_warn')).toContain('text-color-whole-line')
  })

  it('没标演出场就用色 → 说出来(那是分寸,不是错误)', () => {
    const problems = deriveTextColor(parse([
      'label s1:',
      '    "他抬起头。{color=gf_c_warn}雨停了。{/color}"',
      '',
    ].join('\n'))).problems
    const hit = problems.find((problem) => problem.code === 'text-color-off-scene')!
    expect(hit.severity).toBe('warning')
    expect(hit.message).toContain('galfree:perf')
  })

  it('调色板外的颜色 / 认不出的颜色:当场说(引擎会抛)', () => {
    expect(codesOf('label s1:\n    "x{color=red}y{/color}"\n')).toContain('text-color-unknown')
    expect(codesOf('label s1:\n    "x{color=#8c2f2b}y{/color}"\n')).not.toContain('text-color-unknown')
    // 但暗红与描边的对比度只有 2.31:1 —— 不知道"引擎认不认",知道"看不看得清"。
    expect(codesOf('label s1:\n    "x{color=#8c2f2b}y{/color}"\n')).toContain('text-color-low-contrast')
  })

  it('未知文本标签只警告(项目能自定义标签,不该被当成结构错)', () => {
    const problems = deriveTextColor(parse('label s1:\n    "x{nosuchtag}y"\n')).problems
    const hit = problems.find((problem) => problem.code === 'text-tag-unknown')!
    expect(hit.severity).toBe('warning')
    expect(hit.message).toContain('运行时')
  })

  it('`vert` 不算未知标签(8.5.3 的 lint 自己都会误报它,我们不许跟着错)', () => {
    expect(codesOf('label s1:\n    "{vert}纵排{/vert}"\n')).not.toContain('text-tag-unknown')
  })

  it('正文里的裸 `[` 会被插值吞掉 —— 说出来(插入调色板引用之后更容易踩)', () => {
    expect(codesOf('label s1:\n    "他说 [这里] 不对。"\n')).toContain('text-bare-bracket')
    expect(codesOf('label s1:\n    "他说 [[这里]] 对。"\n')).not.toContain('text-bare-bracket')
  })

  it('密度与色数有上限(判断值,但要有)', () => {
    const dense = ['label s1:', `    ${PERF}`]
    for (let i = 0; i < 12; i += 1) dense.push(`    "第 ${i} 句 {color=gf_c_cold}着色{/color}"`)
    dense.push('')
    expect(codesOf(dense.join('\n'))).toContain('text-color-budget')

    const many = [
      'label s1:', `    ${PERF}`,
      '    "{color=gf_c_warn}a{/color}"',
      '    "{color=gf_c_cold}b{/color}"',
      '    "{color=gf_c_device}c{/color}"',
      '',
    ].join('\n')
    expect(codesOf(many)).toContain('text-color-palette-budget')
  })

  it('只读降级的场景不参与(它本来就没人改得动)', () => {
    const parsed = parse('label s1:\n    python:\n        pass\n    "{color=gf_c_warn}x{/color}"\n')
    expect(deriveTextColor(parsed).census).toEqual([])
  })
})
