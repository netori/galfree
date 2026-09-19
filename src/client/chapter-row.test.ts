/**
 * 章节行的排版守卫(2026-09-19)。
 *
 * ## 这是怎么来的
 *
 * 作者截图:设定集卡里,章节标题「第四章:安静的一周」被渲染成**一列汉字**(一个字一行),
 * 右边那一长串场景 label 溢出到面板之外。
 *
 * 根因是**复用了 git 提交行的样式**:`.commitRow` 是"一个固定宽的(哈希)+ 一个弹性的(主题)
 * + 一个固定的(时间)"——时间戳很短,所以 `.commitWhen { flex: none }` 是对的。
 * 但章节行把**整章的 label** 塞进了那个不收缩的格子:它把行撑出容器,
 * 同时把中间 `flex: 1; min-width: 0` 的标题挤到近乎零宽 ——
 * 而中文**任意两字之间都能断行**,于是标题变成一列。
 *
 * ## 为什么是"读源码"的断言
 *
 * 这个仓库**没有渲染夹具**(vitest 跑在 `environment: 'node'`,没有 jsdom / testing-library),
 * 所以没法把组件渲染出来量宽度。退而求其次:守住**这条 bug 之所以发生的三个结构事实** ——
 * 章节行用自己的类、标题有容得下中文的最小宽度、场景列表另起一行。
 * 谁要是把章节行改回 `commitRow`,这里会带着上面那段解释红掉。
 *
 * (浏览器那侧我也试过:DSH 的 GUI 对非面板来源回 403,所以**没能亲眼验**。
 *  这一条守卫就是"没人看着的时候别再坏一次"的替代品。)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const clientDir = join(import.meta.dirname)
const card = readFileSync(join(clientDir, 'bible-card.tsx'), 'utf8')
const css = readFileSync(join(clientDir, 'panel.module.css'), 'utf8')

/** 取一个 CSS 规则体(`.name { … }`),没有就抛。 */
function ruleOf(selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
  if (match === null) throw new Error(`CSS 里找不到规则:${selector}`)
  return match[1]!
}

describe('设定集的章节行排版', () => {
  it('章节行**不复用** git 提交行的样式(那是这个 bug 的根因)', () => {
    // 章节那一段必须用自己的类。`commitWhen` 是"不收缩的窄格子",塞不下整章 label。
    expect(card).toContain('s.chapterRow')
    expect(card).toContain('s.chapterTitle')
    expect(card).toContain('s.chapterScenes')
    // 反向:章节那一段**不许**再出现 commit 那一套的名字。
    const chapterBlock = card.slice(card.indexOf('chapters.map'), card.indexOf(') : (', card.indexOf('chapters.map')))
    expect(chapterBlock).not.toContain('s.commitRow')
    expect(chapterBlock).not.toContain('s.commitWhen')
    expect(chapterBlock).not.toContain('s.commitSubject')
  })

  it('标题有**容得下中文**的最小宽度(否则会被右边的 label 挤成一列汉字)', () => {
    const title = ruleOf('.chapterTitle')
    expect(title).toMatch(/min-width:\s*\d/)
    // 这一条是"能收缩但不许收缩到没有":光有 flex 而没有 min-width 正是出事的那版。
    expect(title).toContain('flex')
  })

  it('场景列表另起一行、自己换行(它没有理由跟标题抢同一行)', () => {
    const scenes = ruleOf('.chapterScenes')
    // `flex: 1 1 100%` = 永远独占一行。
    expect(scenes).toMatch(/flex:\s*1\s+1\s+100%/)
    expect(scenes).toContain('overflow-wrap')
    // 行长也应该允许换行,否则窄面板里还是会溢出。
    expect(ruleOf('.chapterRow')).toContain('flex-wrap')
  })
})
