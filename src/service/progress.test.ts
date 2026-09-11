/**
 * T6 seam tests — 推导进度引擎 + 审读戳(ADR-0008)。
 * 边界规则:客观可算的一律推导(纯函数、幂等、无手写通道);
 * 算不出的才允许戳 —— 场景级/素材槽级,只由人盖,覆盖写自动失效(待复审)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const SCENE_WITH_IMAGE = `label start:
    show xiao_tang angry
    "她瞪着你。"
    return
`

describe('推导进度 + 审读戳(T6)', () => {
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    dataDir = await makeTempDir('galfree-t6-data-')
    projectsRoot = await makeTempDir('galfree-t6-projects-')
    service = createProjectService({ dataDir })
    await service.createProject({ projectsRoot, name: 'prog', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('`.rpy` 新增一条图像引用(外部编辑器)→ 板自动标记对应槽缺失,无人工上报', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), SCENE_WITH_IMAGE, 'utf8')
    const progress = await service.progress('prog')
    const scene = progress.scenes.find((s) => s.label === 'start')!
    expect(scene).toBeDefined()
    expect(scene.missingSlots).toContain('xiao_tang angry')
    expect(progress.summary.missingSlots).toBeGreaterThanOrEqual(1)
  })

  it('缺对白推导:只有跳转没有对白的场景被标记 missingDialogue', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), 'label start:\n    jump other\n\nlabel other:\n    "在。\n    return\n'.replace('在。\n', '在。"\n'), 'utf8')
    const progress = await service.progress('prog')
    const start = progress.scenes.find((s) => s.label === 'start')!
    expect(start.missingDialogue).toBe(true)
    const other = progress.scenes.find((s) => s.label === 'other')!
    expect(other.missingDialogue).toBe(false)
  })

  it('盖戳(人)→ 覆盖写批 → 戳失效:状态=待复审并如实呈现', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), SCENE_WITH_IMAGE, 'utf8')
    // 人盖场景戳。
    await service.stampScene('prog', 'start', { via: 'human' })
    let progress = await service.progress('prog')
    expect(progress.scenes.find((s) => s.label === 'start')!.stamp).toBe('approved')
    expect(progress.summary.awaitingReview).toBe(0)

    // 重生成该场(经网关覆盖写)。
    const v = (await service.readProjectFile('prog', 'game/script.rpy')).version
    await service.writeProjectFiles('prog', [{ path: 'game/script.rpy', content: SCENE_WITH_IMAGE.replace('她瞪着你。', '她更生气地瞪着你。'), expectVersion: v }], { reason: 'scene-script', origin: 'agent', scene: 'start' })

    progress = await service.progress('prog')
    const scene = progress.scenes.find((s) => s.label === 'start')!
    expect(scene.stamp).toBe('stale')
    expect(progress.summary.awaitingReview).toBe(1)
    // 待复审不是待审:曾有人审读,内容变了才要求复审 —— 记录仍在(历史)。
    const stamps = await service.stampRecords('prog')
    expect(stamps.some((s) => s.target === 'scene:start')).toBe(true)
  })

  it('已盖戳场景新增子集外块 → 戳仍失效(指纹基于原始文本,不只看可解析语句)', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), SCENE_WITH_IMAGE, 'utf8')
    await service.stampScene('prog', 'start', { via: 'human' })
    expect((await service.progress('prog')).scenes.find((s) => s.label === 'start')!.stamp).toBe('approved')
    // 追加一段"解析器会跳过"的子集外块 —— 内容确实变了,戳必须失效。
    await writeFile(join(project!.root, 'game', 'script.rpy'), SCENE_WITH_IMAGE + '    if secret:\n        "藏进来的怪东西"\n', 'utf8')
    const progress = await service.progress('prog')
    expect(progress.scenes.find((s) => s.label === 'start')!.stamp).toBe('stale')
    expect(progress.scenes.find((s) => s.label === 'start')!.readOnly).toBe(true)
  })

  it('agent 工具尝试盖戳被接缝拒绝(负例)', async () => {
    await expect(service.stampScene('prog', 'start', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })
    await expect(service.stampSlot('prog', 'xiao_tang angry', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })
  })

  it('素材槽戳:图缺失→stamped 后产物被重roll覆盖 → 槽待复审', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), SCENE_WITH_IMAGE, 'utf8')
    // 槽未填时不可盖"已过审"戳(推导:文件不存在 → 拒)。
    await expect(service.stampSlot('prog', 'xiao_tang angry', { via: 'human' })).rejects.toMatchObject({ code: 'slot-not-filled' })
    // 产物落盘(模拟出图经网关写入)。
    const imageAbs = join(project!.root, 'game', 'images', 'xiao_tang-angry.png')
    await writeFile(imageAbs, 'PNGFAKE', 'utf8')
    let progress = await service.progress('prog')
    let scene = progress.scenes.find((s) => s.label === 'start')!
    expect(scene.missingSlots).toEqual([])
    expect(scene.slots.find((s) => s.slot === 'xiao_tang angry')!.stamp).toBe('pending')
    // 人盖槽戳。
    await service.stampSlot('prog', 'xiao_tang angry', { via: 'human' })
    progress = await service.progress('prog')
    scene = progress.scenes.find((s) => s.label === 'start')!
    expect(scene.slots.find((s) => s.slot === 'xiao_tang angry')!.stamp).toBe('approved')
    // 重roll:覆盖图片文件(外部写)→ 戳失效。
    await writeFile(imageAbs, 'PNGFAKE-NEW', 'utf8')
    progress = await service.progress('prog')
    scene = progress.scenes.find((s) => s.label === 'start')!
    expect(scene.slots.find((s) => s.slot === 'xiao_tang angry')!.stamp).toBe('stale')
    expect(progress.summary.awaitingReview).toBeGreaterThanOrEqual(1)
  })

  it('lint 未上过板:错误进场景视图与汇总(与校验回路同源)', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), 'label start:\n    jump nowhere\n', 'utf8')
    const progress = await service.progress('prog')
    expect(progress.lint.ok).toBe(false)
    expect(progress.problems.filter((p) => p.severity === 'error').length).toBeGreaterThanOrEqual(1)
    expect(progress.summary.lintErrors).toBeGreaterThanOrEqual(1)
  })

  it('进度重算幂等;状态对象无手写通道', async () => {
    const a = await service.progress('prog')
    const b = await service.progress('prog')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 推导对象不可变:接缝不暴露任何"设置进度字段"的方法(类型层面只有 stamp*/removeStamp*)。
    const stampish = Object.keys(service).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(service)))
    const setters = stampish.filter((k) => /^(set|write|patch).*progress/i.test(k))
    expect(setters).toEqual([])
  })

  it('子集外场景:板上如实带 degraded 只读标记(与 T4 同源)', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), 'label start:\n    if x:\n        "怪"\n    "正常句。"\n    return\n', 'utf8')
    const progress = await service.progress('prog')
    expect(progress.degraded).toBe(true)
    expect(progress.scenes.find((s) => s.label === 'start')!.readOnly).toBe(true)
  })

  it('舞台标记是推导:严重度、排序与文案都由接缝给,UI 不需要自己判断', async () => {
    const project = await service.getActiveProject()
    // 一场有 lint 错 + 缺素材 + 无对白;另一场只有只读降级。
    await writeFile(join(project!.root, 'game', 'script.rpy'), [
      'label start:',
      '    scene bg school',
      '    jump nowhere',
      '',
      'label quiet:',
      '    if x:',
      '        "怪"',
      '    return',
      '',
    ].join('\n'), 'utf8')
    const progress = await service.progress('prog')

    const start = progress.scenes.find((s) => s.label === 'start')!
    const codes = start.marks.map((mark) => mark.code)
    expect(codes).toContain('missing-slots')
    expect(codes).toContain('missing-dialogue')
    expect(codes).toContain('lint-error')
    // 顺序 = 优先级:error 全部排在 warn 之前,info 最后
    const rank = { error: 0, warn: 1, info: 2 } as const
    const severities = start.marks.map((mark) => rank[mark.severity])
    expect(severities).toEqual([...severities].sort((a, b) => a - b))
    // 计数走 count,文案里不带计数(否则界面上会出现"缺素材 1 1")
    const missingSlots = start.marks.find((mark) => mark.code === 'missing-slots')!
    expect(missingSlots.count).toBe(1)
    expect(missingSlots.label).not.toMatch(/\d/)

    // 只读降级:标记为 info,且这一场明确不可盖戳(带原因)
    const quiet = progress.scenes.find((s) => s.label === 'quiet')!
    expect(quiet.readOnly).toBe(true)
    expect(quiet.stampable).toBe(false)
    expect(quiet.stampableBlockedBy).toBeTruthy()
    expect(quiet.marks.map((mark) => mark.code)).toContain('read-only-degraded')

    expect(start.stampable).toBe(true)
    expect(start.stampableBlockedBy).toBeUndefined()

    // 幂等:同样的输入重算,marks 完全一致
    const again = await service.progress('prog')
    expect(JSON.stringify(again.scenes)).toBe(JSON.stringify(progress.scenes))
  })

  it('素材槽可盖性由接缝判定:未填不可盖并带原因,填了可盖,已认可仍可重盖', async () => {
    const project = await service.getActiveProject()
    await writeFile(join(project!.root, 'game', 'script.rpy'), 'label start:\n    scene bg school\n    "一句话。"\n    return\n', 'utf8')
    const before = await service.progress('prog')
    const slotBefore = before.scenes.find((s) => s.label === 'start')!.slots[0]!
    expect(slotBefore.filled).toBe(false)
    expect(slotBefore.approvable).toBe(false)
    expect(slotBefore.approvableBlockedBy).toBeTruthy()

    await writeFile(join(project!.root, 'game/images/bg-school.png'), 'not-a-real-png', 'utf8')
    const filled = await service.progress('prog')
    const slotFilled = filled.scenes.find((s) => s.label === 'start')!.slots[0]!
    expect(slotFilled.filled).toBe(true)
    expect(slotFilled.approvable).toBe(true)

    await service.stampSlot('prog', 'bg school', { via: 'human' })
    const approved = await service.progress('prog')
    const slotApproved = approved.scenes.find((s) => s.label === 'start')!.slots[0]!
    expect(slotApproved.stamp).toBe('approved')
    // 已认可仍然可盖(重新认可)—— UI 不再自行把已认可的槽锁死
    expect(slotApproved.approvable).toBe(true)
  })
})
