/**
 * T21(板上的「下一步」)守卫 —— `progress.nextActions[]`。
 *
 * 契约来源(`netori/galfree#29`):
 *  1. **纯推导**:同一份输入两次调用结果相同,而且**不产生任何写**(网关写日志长度不变);
 *  2. **顺序稳定**:阻塞生成的在前,打磨在后;
 *  3. **actor 是推导的一部分**:要人主观判断的一律 `human`(盖戳 / 认可 / 发布拍板),
 *     生成 / 补素材 / 接线 / 跑试玩是 `agent`(跑试玩有工具入口,`human` 的那一份是
 *     **认同**"玩过了、行",由场景戳承载);
 *  4. **不是"哪里坏了"的第二份**:`problems` 说哪里坏了,`nextActions` 说接着做什么 ——
 *     两边可以同时出现同一件事,但措辞与用途不同(一个定位缺陷,一个给动作);
 *  5. 板上没毛病时给一条 `publish-ready`(**不是空数组**)。
 *
 * 断言面:只经 `ProjectService` 公共接口(推导对象 + 写日志 + git 历史)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import type { NextAction } from './progress.ts'
import type { PublishPorts } from './publish.ts'

/** 找一条 action(按 code);没有就给出实际拿到的那份,便于读失败原因。 */
function action(actions: NextAction[], code: string): NextAction | undefined {
  return actions.find((candidate) => candidate.code === code)
}

describe('板上的「下一步」(T21)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let outDir: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t21-data-')
    projectsRoot = await makeTempDir('galfree-t21-projects-')
    outDir = await makeTempDir('galfree-t21-out-')
    const publishPorts: PublishPorts = {
      resolveLauncher: async () => join(sdkDir, 'renpy.exe'),
      run: async (input) => {
        await mkdir(input.destination, { recursive: true })
        await writeFile(join(input.destination, 'next-0.1.0-pc.zip'), Buffer.from('fake-dist'))
        return { code: 0, log: 'built\n' }
      },
    }
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      playtest: { resolveLauncher: async () => '/fake/renpy.exe', spawn: async () => ({ code: 0, log: "Ren'Py 8.5.3 starting\n" }) },
      publish: { ports: publishPorts, destination: () => join(outDir, 'dist') },
    })
    await service.createProject({ projectsRoot, name: 'next', title: '下一步' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  /** 把项目推到"全绿"那一档(定稿戳由人盖,试玩跑过)。 */
  async function makeGreen(): Promise<void> {
    await service.writeBible('next', { theme: '雨天的天台', chapters: [{ id: 'ch1', title: '第一场雨', scenes: ['scene_one'] }] }, { via: 'agent' })
    expect((await service.bible('next')).chapters.length, 'makeGreen:设定集没写进去').toBe(1)
    await service.stampBible('next', { via: 'human' })
    const script = await service.readProjectFile('next', 'game/script.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/script.rpy',
      content: `label start:\n    jump scene_one\n\n${script.content.slice(script.content.indexOf('label prologue:'))}`,
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })
    await service.generateScene('next', {
      label: 'scene_one',
      source: 'label scene_one:\n    "（开场）雨还没停。"\n    jump prologue\n',
      outline: undefined,
    })
    await service.playtestStart('next')
  }

  // ── 纯推导与稳定性 ──────────────────────────────────────────────────

  it('纯推导:两次调用结果完全相同,而且**一个字节都不写**(写日志与 git 历史都不动)', async () => {
    const before = await service.progress('next')
    const writesBefore = (await service.writeLog('next')).length
    const historyBefore = await service.snapshotHistory('next', 'game/script.rpy')

    const again = await service.progress('next')

    expect(again.nextActions).toEqual(before.nextActions)
    expect((await service.writeLog('next')).length).toBe(writesBefore)
    expect((await service.snapshotHistory('next', 'game/script.rpy')).map((entry) => entry.commit))
      .toEqual(historyBefore.map((entry) => entry.commit))
  })

  it('顺序稳定且是"阻塞在前、打磨在后":同一份输入两次拿到同一个次序', async () => {
    const first = (await service.progress('next')).nextActions.map((entry) => entry.code)
    const second = (await service.progress('next')).nextActions.map((entry) => entry.code)
    expect(second).toEqual(first)
    // 空设定集时**只**说"去写" —— 内容都没有,催人盖戳是废话(两件事不会同时出现)。
    expect(first).toContain('bible-missing')
    expect(first).not.toContain('bible-needs-stamp')
    expect(first[0]).toBe('bible-missing')

    // 写完有了内容 → 动作换成"请人盖戳",而且排在打磨类(盖场景戳)之前。
    await service.writeBible('next', { theme: '雨天的天台', chapters: [{ id: 'ch1', title: '第一场雨', scenes: [] }] }, { via: 'agent' })
    const codes = (await service.progress('next')).nextActions.map((entry) => entry.code)
    expect(codes).not.toContain('bible-missing')
    expect(codes.indexOf('bible-needs-stamp')).toBeGreaterThanOrEqual(0)
    expect(codes.indexOf('bible-needs-stamp')).toBeLessThan(codes.indexOf('scenes-awaiting-review'))
  })

  // ── actor:谁能做这件事 ──────────────────────────────────────────────

  it('actor:缺设定集 = agent(内容生成归 agent),有内容没盖戳 = human(只有人能盖)', async () => {
    // 新项目:没设定集 → agent 的活。
    let progress = await service.progress('next')
    expect(action(progress.nextActions, 'bible-missing')?.actor).toBe('agent')

    await service.writeBible('next', { theme: '雨天的天台', world: '放学后的天台。', chapters: [{ id: 'ch1', title: '第一场雨', scenes: [] }] }, { via: 'agent' })
    progress = await service.progress('next')
    // 写完没盖戳 → 轮到人:这个动作**只有**人能完成。
    const stamp = action(progress.nextActions, 'bible-needs-stamp')
    expect(stamp?.actor).toBe('human')
    expect(stamp?.label).toMatch(/定稿|盖/)
    expect(stamp?.target).toEqual({ kind: 'bible' })
    // 生成类动作不再提示"写设定集"。
    expect(action(progress.nextActions, 'bible-missing')).toBeUndefined()
  })

  it('actor:缺素材 = agent(带槽名),有图没人认可 = human(盖槽戳)', async () => {
    const script = await service.readProjectFile('next', 'game/script.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/script.rpy',
      content: script.content.replace('label prologue:', 'label prologue:\n    show xiao_tang smile'),
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })

    let progress = await service.progress('next')
    const missing = action(progress.nextActions, 'missing-slots')
    expect(missing?.actor).toBe('agent')
    expect(missing?.detail).toContain('xiao_tang smile')
    expect(missing?.target).toEqual({ kind: 'slot', slot: 'xiao_tang smile' })

    // 把图放上去(没盖戳)→ 动作翻成"请人认可"。
    await service.writeProjectFiles('next', [{ path: 'game/images/xiao_tang-smile.png', content: Buffer.from([0x89, 0x50]), expectVersion: 'absent' }], { origin: 'workbench', reason: 'asset' })
    progress = await service.progress('next')
    const review = action(progress.nextActions, 'art-awaiting-review')
    expect(review?.actor).toBe('human')
    expect(review?.detail).toContain('xiao_tang smile')
    expect(action(progress.nextActions, 'missing-slots')).toBeUndefined()

    // 人盖上戳 → 这一条消失(推导跟着戳走,不是自己记状态)。
    await service.stampSlot('next', 'xiao_tang smile', { via: 'human' })
    progress = await service.progress('next')
    expect(action(progress.nextActions, 'art-awaiting-review')).toBeUndefined()
  })

  it('actor:悬空音频引用 = agent 能修(改路径或请人放文件),试玩没跑过 = agent 能跑', async () => {
    const script = await service.readProjectFile('next', 'game/script.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/script.rpy',
      content: script.content.replace('label prologue:', 'label prologue:\n    play music "audio/not-there.ogg"'),
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })

    const progress = await service.progress('next')
    const audio = action(progress.nextActions, 'missing-audio')
    expect(audio?.actor).toBe('agent')
    expect(audio?.detail).toContain('audio/not-there.ogg')
    expect(audio?.target).toEqual({ kind: 'audio', scene: 'prologue', line: expect.any(Number) })
    // 试玩有 agent 入口(T20 的 galfree_playtest),所以这一步是 agent 的活;
    // 人的那一份是"认可"(`scenes-awaiting-review`),不是"点按钮"。
    expect(action(progress.nextActions, 'playtest-not-run')?.actor).toBe('agent')
  })

  it('actor:发布相关的都等**人**拍板(agent 有入口,但发不发是人的事)', async () => {
    await makeGreen()
    const progress = await service.progress('next')
    const ready = action(progress.nextActions, 'publish-ready')
    expect(ready?.actor).toBe('human')
    expect(ready?.target).toEqual({ kind: 'publish' })
    expect(ready?.label).toMatch(/发|人/)
  })

  // ── 可红的守卫:摆一个已知缺陷上去 ──────────────────────────────────

  it('可红守卫:删掉定稿戳 → `bible-needs-stamp` 出现;盖上 → 消失', async () => {
    await makeGreen()
    // 全绿:没有"请人盖定稿戳"这件事。
    expect(action((await service.progress('next')).nextActions, 'bible-needs-stamp')).toBeUndefined()

    // 改一下设定集 → 定稿戳失效(待复审)→ 这一步必须**重新**出现在最前面。
    await service.writeBible('next', { theme: '改了主题' }, { via: 'agent' })
    const progress = await service.progress('next')
    const stamp = action(progress.nextActions, 'bible-needs-stamp')
    expect(stamp, `定稿戳失效了却没提示去盖戳:推导没跟着戳走(${JSON.stringify(progress.bible)} / ${JSON.stringify(progress.nextActions)})`).toBeDefined()
    expect(stamp!.actor).toBe('human')
    // 而且它排在"打磨类"动作之前(生成会被它挡住)。
    const codes = progress.nextActions.map((entry) => entry.code)
    expect(codes.indexOf('bible-needs-stamp')).toBeLessThan(codes.indexOf('scenes-awaiting-review'))
  })

  it('可红守卫:lint 错 → 修结构排在前;修完 → 消失', async () => {
    await makeGreen()
    const current = await service.readProjectFile('next', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/scenes/scene_one.rpy',
      content: current.content.replace('jump prologue', 'jump nowhere'),
      expectVersion: current.version,
    }], { origin: 'agent', reason: 'scenario' })

    const broken = await service.progress('next')
    const lint = action(broken.nextActions, 'lint-errors')
    expect(lint?.actor).toBe('agent')
    expect(lint?.detail).toMatch(/nowhere|dangling|悬空/)
    // 结构坏了时不该同时催人去盖场景戳 / 发布(先修再谈)。
    expect(action(broken.nextActions, 'publish-ready')).toBeUndefined()

    const fixed = await service.readProjectFile('next', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/scenes/scene_one.rpy',
      content: fixed.content.replace('jump nowhere', 'jump prologue'),
      expectVersion: fixed.version,
    }], { origin: 'agent', reason: 'scenario' })
    expect(action((await service.progress('next')).nextActions, 'lint-errors')).toBeUndefined()
  })

  it('板上没毛病 → 给一条 publish-ready(而不是空数组);措辞不许说成"板上齐了"', async () => {
    await makeGreen()
    const progress = await service.progress('next')
    // 这一档里还剩"人还没盖场景戳 / 槽戳"这类打磨项 —— 它挡不住发布,但也不该被说成
    // "板上齐了"(那会跟同一行里的"请人盖戳"自相矛盾)。措辞说的是"挡着发布的东西都没了"。
    expect(progress.nextActions.length).toBeGreaterThan(0)
    const ready = action(progress.nextActions, 'publish-ready')!
    expect(ready).toBeDefined()
    expect(ready.label).not.toMatch(/板上齐了/)
    // 而且如实说清:真能不能发要以发布前置检查为准(那份检查不在这份推导里)。
    expect(ready.detail).toMatch(/前置检查|SDK|界面图/)
  })

  it('上一次构建**失败** → 推的是 publish-failed(不是"产物就是当前这一版")', async () => {
    await makeGreen()
    // 造一次失败:构建端口返回非 0 → 账本里 ok:false 且**没有产物**。
    service = createProjectService({
      dataDir: dataDir + '-fail',
      uiTemplate: fakeUiTemplate(sdkDir),
      playtest: { resolveLauncher: async () => '/fake/renpy.exe', spawn: async () => ({ code: 0, log: "Ren'Py 8.5.3 starting\n" }) },
      publish: {
        ports: { resolveLauncher: async () => join(sdkDir, 'renpy.exe'), run: async () => ({ code: 1, log: 'Error: 打包时炸了\n' }) },
        destination: () => join(outDir, 'dist-fail'),
      },
    })
    await service.createProject({ projectsRoot, name: 'next-bad', title: '失败' })
    await service.writeBible('next-bad', { theme: '雨天', chapters: [{ id: 'ch1', title: '一', scenes: [] }] }, { via: 'agent' })
    await service.stampBible('next-bad', { via: 'human' })
    const script = await service.readProjectFile('next-bad', 'game/script.rpy')
    await service.writeProjectFiles('next-bad', [{
      path: 'game/script.rpy',
      content: `label start:\n    jump scene_one\n\n${script.content.slice(script.content.indexOf('label prologue:'))}`,
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })
    await service.generateScene('next-bad', { label: 'scene_one', source: 'label scene_one:\n    "雨。"\n    jump prologue\n', outline: undefined })
    await service.playtestStart('next-bad')
    const published = await service.publish('next-bad')
    expect(published.ok).toBe(false)
    expect(published.run?.artifacts).toEqual([])

    const progress = await service.progress('next-bad')
    expect(action(progress.nextActions, 'publish-ready'), '"产物就是当前这一版"是假话:那次构建没产出任何东西').toBeUndefined()
    const failed = action(progress.nextActions, 'publish-failed')!
    expect(failed).toBeDefined()
    expect(failed.actor).toBe('agent')
    // 失败原因原话带上(照着修),而不是一句"失败了"。
    expect(failed.detail).toContain('打包时炸了')
  })

  it('发布过之后内容又改了 → 动作换成 publish-stale(产物代表的不再是这一版)', async () => {
    await makeGreen()
    const published = await service.publish('next')
    expect(published.ok).toBe(true)
    expect(action((await service.progress('next')).nextActions, 'publish-stale')).toBeUndefined()

    const script = await service.readProjectFile('next', 'game/scenes/scene_one.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/scenes/scene_one.rpy',
      content: script.content.replace('雨还没停', '雨停了'),
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })

    const progress = await service.progress('next')
    expect(action(progress.nextActions, 'publish-stale')?.actor).toBe('human')
    expect(action(progress.nextActions, 'publish-ready')).toBeUndefined()
  })

  // ── 与 problems 的分工 ──────────────────────────────────────────────

  it('与 problems 分工:两边可以同时出现同一件事,但一个定位缺陷、一个给动作', async () => {
    const script = await service.readProjectFile('next', 'game/script.rpy')
    await service.writeProjectFiles('next', [{
      path: 'game/script.rpy',
      content: script.content.replace('label prologue:', 'label prologue:\n    jump nowhere'),
      expectVersion: script.version,
    }], { origin: 'agent', reason: 'scenario' })

    const progress = await service.progress('next')
    // problems:哪里坏了(带 file/line)。
    const problem = progress.problems.find((entry) => entry.code === 'dangling-jump')!
    expect(problem.file).toBe('script.rpy')
    // nextActions:接着做什么(带 actor,target 指向那一场)。
    const lint = action(progress.nextActions, 'lint-errors')!
    expect(lint.actor).toBe('agent')
    expect(lint.target).toEqual({ kind: 'scene', label: 'prologue' })
    // 同一条事实,两种用途 —— 不是一个数组抄了两遍。
    expect(lint.code).not.toBe(problem.code)
  })

  it('每条动作都有 code / label / actor;有 target 的 target 形状合法', async () => {
    await makeGreen()
    const progress = await service.progress('next')
    for (const entry of progress.nextActions) {
      expect(entry.code).toMatch(/^[a-z0-9-]+$/)
      expect(entry.label.trim()).not.toBe('')
      expect(['agent', 'human']).toContain(entry.actor)
      if (entry.target !== undefined) expect(['bible', 'scene', 'slot', 'audio', 'playtest', 'publish']).toContain(entry.target.kind)
    }
  })

  // ── agent 不需要自己推:工具带回同一份 ──────────────────────────────

  it('galfree_project_status 带回**同一份** nextActions(agent 不自己推顺序)', async () => {
    await service.writeBible('next', { theme: '雨天的天台' }, { via: 'agent' })
    const tools: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<string> }> = []
    const { registerGalfreeTools } = await import('./tools.ts')
    registerGalfreeTools(
      { tools: { register: (tool: unknown) => { tools.push(tool as never); return () => {} } } } as never,
      service,
    )
    const status = JSON.parse(await tools.find((tool) => tool.name === 'galfree_project_status')!.execute({ project: 'next' })) as {
      nextActions: unknown[]
    }
    // 与接缝读出来的一模一样(同一个数组的内容,不是工具自己又算了一遍)。
    expect(status.nextActions).toEqual((await service.progress('next')).nextActions)
    // 而且给的是**动作**(带 actor),不是"哪里坏了"的清单。
    const first = status.nextActions[0] as { actor?: string; label?: string }
    expect(['agent', 'human']).toContain(first.actor)
    expect(typeof first.label).toBe('string')
  })
})
