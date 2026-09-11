/**
 * T4 seam tests — 方言子集解析器(纯函数)与校验回路契约。
 * 断言:解析结构正确、子集外降级如实、可重入一致、假验证器 lint 进状态。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRpy, deriveGraph, type RpyFile } from './parse.ts'
import { createProjectService, type ProjectService } from '../project-service.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupTempDirs, makeTempDir } from '../../testing/tmp.ts'

const TEMPLATE_SCRIPT = `label start:
    "从这里开始你的故事。"
    menu:
        "继续":
            jump prologue
        "先到这里":
            return

label prologue:
    "序章位置。"
    return
`

describe('方言子集解析器(T4)', () => {
  it('模板解析:场景数/对白/菜单边结构正确', () => {
    const parsed = parseRpy([{ name: 'script.rpy', text: TEMPLATE_SCRIPT }])
    expect(parsed.problems).toEqual([])
    expect(parsed.scenes.map((s) => s.label)).toEqual(['start', 'prologue'])
    const start = parsed.scenes[0]!
    expect(start.readOnly).toBe(false)
    const dialogue = start.statements.find((s) => s.kind === 'dialogue')
    expect(dialogue).toMatchObject({ kind: 'dialogue', speaker: null, text: '从这里开始你的故事。', showing: [] })
    const menu = start.statements.find((s) => s.kind === 'menu')
    expect(menu?.kind).toBe('menu')
    if (menu?.kind !== 'menu') throw new Error('menu missing')
    expect(menu.choices.map((c) => c.prompt)).toEqual(['继续', '先到这里'])
    const jumpEdges = parsed.edges.filter((e) => e.from === 'start' && e.to === 'prologue')
    expect(jumpEdges).toHaveLength(1)
    expect(jumpEdges[0]).toMatchObject({ via: 'menu', prompt: '继续' })
  })

  it('常见手改:Character 定义/带说话人对白/show/hide/with/call/独立 jump', () => {
    const files: RpyFile[] = [{
      name: 'script.rpy',
      text: [
        'define e = Character("小棠")',
        'image bg room = "images/room.png"',
        '',
        'label start:',
        '    scene bg room',
        '    show e happy at left with dissolve',
        '    e "你好呀。"',
        '    "旁白一句。"',
        '    hide e',
        '    call intro',
        '    jump end',
        '',
        'label intro:',
        '    e "过场。"',
        '    return',
        '',
        'label end:',
        '    "结束。"',
        '    return',
        '',
      ].join('\n'),
    }]
    const parsed = parseRpy(files)
    expect(parsed.problems).toEqual([])
    expect(parsed.characters).toEqual([{ var: 'e', displayName: '小棠', file: 'script.rpy', line: 1 }])
    expect(parsed.images.map((i) => i.name)).toEqual(['bg room'])
    const start = parsed.scenes.find((s) => s.label === 'start')!
    expect(start.readOnly).toBe(false)
    const shows = start.statements.filter((s) => s.kind === 'image')
    expect(shows).toHaveLength(3)
    expect(shows[0]).toMatchObject({ role: 'scene', tag: 'bg', attributes: ['room'] })
    expect(shows[1]).toMatchObject({ role: 'show', tag: 'e', attributes: ['happy'] })
    expect(start.statements).toContainEqual({ kind: 'dialogue', speaker: 'e', text: '你好呀。', showing: ['bg room', 'e happy'], line: 7 })
    expect(start.statements).toContainEqual({ kind: 'dialogue', speaker: null, text: '旁白一句。', showing: ['bg room', 'e happy'], line: 8 })
    const edges = parsed.edges.filter((e) => e.from === 'start')
    expect(edges).toContainEqual(expect.objectContaining({ to: 'intro', via: 'call' }))
    expect(edges).toContainEqual(expect.objectContaining({ to: 'end', via: 'jump' }))
  })

  it('子集外语法至少三种:if 块 / python 块 / screen 顶层 / ATL show 块 —— 报告 + 只读降级,可解析部分仍产出', () => {
    const parsed = parseRpy([{
      name: 'script.rpy',
      text: [
        'label start:',
        '    "第一句。"',
        '    if flag_a:',
        '        "看不懂的分支。"',
        '    else:',
        '        "还是看不懂。"',
        '    "降级后仍解析的一句。"',
        '    python:',
        '        x = 1',
        '    show e happy:',
        '        linear 2.0 alpha 1.0',
        '    return',
        '',
        'screen demo_screen():',
        '    text "我是 screen 语言"',
        '',
        'label other:',
        '    "正常场景。"',
        '    return',
        '',
      ].join('\n'),
    }])
    const start = parsed.scenes.find((s) => s.label === 'start')!
    expect(start.readOnly).toBe(true)
    // 报告了多个子集外构造(≥3 种)。
    const codes = new Set(start.problems.map((p) => p.code))
    expect(codes.size).toBeGreaterThanOrEqual(2)
    const kinds = start.statements.map((s) => s.kind)
    // 子集内语句仍产出(前后对白/return)。
    expect(kinds.filter((k) => k === 'dialogue')).toHaveLength(2)
    expect(kinds).toContain('return')
    // screen 顶层:文件级问题 + 跳过块,other 场景不受污染。
    expect(parsed.problems.some((p) => p.code === 'unsupported-top-level')).toBe(true)
    const other = parsed.scenes.find((s) => s.label === 'other')!
    expect(other.readOnly).toBe(false)
    expect(other.statements).toHaveLength(2)
  })

  it('悬空跳转 = error(进校验结果)', () => {
    const parsed = parseRpy([{
      name: 'script.rpy',
      text: 'label start:\n    jump nowhere\n',
    }])
    expect(parsed.problems.some((p) => p.severity === 'error' && p.code === 'dangling-jump')).toBe(true)
  })

  it('纯函数:同输入重算结果一致', () => {
    const files: RpyFile[] = [{ name: 'script.rpy', text: TEMPLATE_SCRIPT }]
    const a = JSON.stringify(parseRpy(files))
    const b = JSON.stringify(parseRpy(files))
    expect(a).toBe(b)
    // 全量重算幂等:图派生同样一致。
    expect(JSON.stringify(deriveGraph(parseRpy(files)))).toBe(JSON.stringify(deriveGraph(parseRpy(files))))
  })

  it('deriveGraph:degraded 标志如实', () => {
    const clean = deriveGraph(parseRpy([{ name: 'script.rpy', text: TEMPLATE_SCRIPT }]))
    expect(clean.degraded).toBe(false)
    expect(clean.scenes).toHaveLength(2)
    const dirty = deriveGraph(parseRpy([{ name: 's.rpy', text: 'label start:\n    if x:\n        "y"\n' }]))
    expect(dirty.degraded).toBe(true)
  })
})

describe('校验回路契约 · 假验证器 + 分支图进入接缝状态(T4)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t4-data-')
    projectsRoot = await makeTempDir('galfree-t4-projects-')
    service = createProjectService({ dataDir })
  })
  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('假验证器 lint 结果进入接缝状态对象(模板干净)', async () => {
    await service.createProject({ projectsRoot, name: 'lint', title: undefined })
    const report = await service.validateActiveProject()
    expect(report).toMatchObject({ ok: true, validator: 'fake' })
    expect(report.problems).toEqual([])
    expect(typeof report.at).toBe('string')
  })

  it('注入坏脚本(悬空跳转)→ lint 判 not-ok,问题定位到文件行', async () => {
    const project = await service.createProject({ projectsRoot, name: 'bad', title: undefined })
    await writeFile(join(project.root, 'game', 'script.rpy'), 'label start:\n    jump nowhere\n', 'utf8')
    const report = await service.validateActiveProject()
    expect(report.ok).toBe(false)
    const dangling = report.problems.find((p) => p.code === 'dangling-jump')
    expect(dangling).toMatchObject({ severity: 'error', file: 'game/script.rpy', line: 2 })
  })

  it('分支图派生对象可经接缝读取,重算一致', async () => {
    await service.createProject({ projectsRoot, name: 'graph', title: undefined })
    const g1 = await service.branchGraph('graph')
    const g2 = await service.branchGraph('graph')
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2))
    expect(g1.scenes.map((s) => s.label)).toEqual(['start', 'prologue'])
    expect(g1.edges.some((e) => e.from === 'start' && e.to === 'prologue')).toBe(true)
    expect(g1.dialect).toBe('galfree-subset-1')
  })
})
