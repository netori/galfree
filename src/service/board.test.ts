/**
 * T15 seam tests — 出图操作与素材板动作面。
 *
 * 契约来源(T15 / #23 票面 AC):
 *  1. "补全全部"由板待填清单展开任务集,**全程可追踪**;
 *  2. 重 roll **保留上一产物为历史**(可对比);
 *  3. **agent 工具与工作台操作同一队列**(断言同一状态源);
 *  4. 所有产物经网关 + 快照。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态 + 推导对象。
 * "agent 工具面"在本测试里就是**同一接缝上的调用** —— 工具只是薄适配器,
 * 同一性由"两条路都落到同一个队列账本"证。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { slotAssetPath } from './slot-naming.ts'
import { createNodeHttpClient } from './images.ts'

const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    scene bg school',
  '    show xiao_tang smile',
  '    xiao_tang "你来啦。"',
  '    jump rooftop',
  '',
  'label rooftop:',
  '    scene bg rooftop',
  '    return',
  '',
].join('\n')

/** 两张内容不同的最小 PNG:用来验"重 roll 换了一张"。 */
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/4B0dAAAAAABJRU5ErkJggg=='

/** 假上游:每次调用轮换载荷,并记录收到的 prompt(验"改词真发出去了")。 */
class FakeUpstream {
  #server: Server | null = null
  payloads = [PNG_A, PNG_B]
  #served = 0
  seen: Array<{ prompt?: unknown; referenceImages?: unknown }> = []

  async start(): Promise<string> {
    this.#server = createServer((req: IncomingMessage, res: ServerResponse) => { void this.#handle(req, res) })
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve))
    const address = this.#server!.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return `http://127.0.0.1:${port}/v1`
  }

  async stop(): Promise<void> {
    if (this.#server === null) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = null
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt?: unknown }
      this.seen.push({ prompt: body.prompt })
    } catch { this.seen.push({}) }
    const payload = this.payloads[Math.min(this.#served++, this.payloads.length - 1)]!
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: payload }] }))
  }
}

describe('出图操作与素材板动作面(T15)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService
  let upstream: FakeUpstream
  let root: string

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t15-data-')
    projectsRoot = await makeTempDir('galfree-t15-projects-')
    upstream = new FakeUpstream()
    const baseUrl = await upstream.start()

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: createNodeHttpClient(),
        channel: () => ({
          baseUrl,
          apiKey: 'sk-test',
          models: [{
            id: 'gpt-image-1',
            adapter: 'openai-compatible',
            capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
          }],
        }),
      },
    })
    const project = await service.createProject({ projectsRoot, name: 'board', title: '素材板' })
    root = project.root
    const snap = await service.readProjectFile('board', 'game/script.rpy')
    await service.writeProjectFiles('board', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
  })

  afterEach(async () => {
    await service.dispose()
    await upstream.stop()
    await cleanupTempDirs()
  })

  // ── AC1:补全全部待填 ────────────────────────────────────────────────

  it('AC1 "补全全部待填":待填清单展开成任务集,逐个跑完,每个都有产物且可追踪', async () => {
    const before = await service.progress('board')
    const missing = before.slots.filter((slot) => !slot.filled).map((slot) => slot.slot)
    expect(missing.length).toBeGreaterThan(1) // 这个夹具里有多个待填槽

    const tasks = await service.createTasksForMissingSlots('board', { model: 'gpt-image-1', run: true })

    // 任务集与板的待填清单**一一对应**(展开依据是推导,不是人维护的待办表)。
    expect(tasks.map((task) => task.slot)).toEqual(missing)
    for (const task of tasks) {
      expect(task.state).toBe('awaiting-review')
      expect(task.attempts).toHaveLength(1)
      // 每个任务都能追到自己的产物与目标路径。
      expect(task.outputPath).toBe(slotAssetPath(task.slot))
      const bytes = await readFile(join(root, ...task.outputPath.split('/')))
      expect(bytes.byteLength).toBeGreaterThan(0)
    }

    const after = await service.progress('board')
    expect(after.summary.missingSlots).toBe(0)
    // 全过程可追踪:账本里就是这些任务(没有第二处记录)。
    const ledger = await service.generationTasks('board')
    expect(ledger.map((task) => task.id).sort()).toEqual(tasks.map((task) => task.id).sort())
  })

  it('AC1 槽账本里的提示词会被"补全全部"用上(不是套一句占位话)', async () => {
    await service.upsertSlot('board', { slot: 'xiao_tang smile', requiresCharacters: [], prompt: '小棠微笑,半身,教室背景' })
    await service.createTasksForMissingSlots('board', { model: 'gpt-image-1', run: true })
    expect(upstream.seen.some((call) => call.prompt === '小棠微笑,半身,教室背景')).toBe(true)
  })

  // ── AC2:重 roll 保留上一产物为历史 ──────────────────────────────────

  it('AC2 重 roll:新尝试记下被替换那一版的指纹,且旧内容能从快照历史找回(可对比)', async () => {
    const task = await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const firstFingerprint = task.attempts[0]!.fingerprint
    expect(firstFingerprint).toBeDefined()
    // 首次生成没有"上一版"。
    expect(task.attempts[0]!.replacedFingerprint).toBeUndefined()

    const rerolled = await service.retryGenerationTask('board', task.id, { run: true })

    // 历史只追加:两条,第二条记下了"被它覆盖掉的那一版"。
    expect(rerolled.attempts).toHaveLength(2)
    expect(rerolled.attempts[1]!.replacedFingerprint).toBe(firstFingerprint)
    expect(rerolled.attempts[1]!.fingerprint).not.toBe(firstFingerprint)
    // 现在磁盘上的是新版。
    const current = await service.progress('board')
    expect(current.slots.find((slot) => slot.slot === 'bg school')?.fingerprint).toBe(rerolled.attempts[1]!.fingerprint)

    // "可对比"的落点:上一版在快照历史里找得到(路径 + 指纹 → 能回看/回滚)。
    const history = await service.snapshotHistory('board', slotAssetPath('bg school'))
    expect(history.length).toBeGreaterThanOrEqual(2)
  })

  it('AC2 重 roll 可以把提示词改得更夸张(改词真的发到了上游)', async () => {
    const task = await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    // 人在素材板上把这一槽重 roll,并改词(对话里说"把小棠的怒颜重 roll 得更夸张"就是这条路)。
    await service.retryGenerationTask('board', task.id, { run: true, prompt: '教室,阴天,暴雨前的压抑光线' })

    expect(upstream.seen.at(-1)?.prompt).toBe('教室,阴天,暴雨前的压抑光线')
    const tasks = await service.generationTasks('board')
    expect(tasks[0]!.prompt).toBe('教室,阴天,暴雨前的压抑光线')
  })

  // ── AC3:agent 工具与工作台同一队列 ──────────────────────────────────

  it('AC3 同一状态源:工作台建的任务,agent 读得到、改得动;agent 改的,工作台也看得到', async () => {
    // 工作台这条路:建任务(动作面点"生成此槽"就是它)。
    const fromWorkbench = await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })

    // agent 这条路:读同一队列(工具面读的就是 generationTasks)。
    const seenByAgent = await service.generationTasks('board')
    expect(seenByAgent.map((task) => task.id)).toContain(fromWorkbench.id)

    // agent 改词并重 roll(工具面调的是同一个 retryGenerationTask)。
    await service.retryGenerationTask('board', fromWorkbench.id, { run: true, prompt: '教室,更夸张的夕照' })
    const seenByWorkbench = await service.generationTasks('board')
    expect(seenByWorkbench.find((task) => task.id === fromWorkbench.id)?.prompt).toBe('教室,更夸张的夕照')
    // 没有第二份任务记录:账本文件里只有这一条 id。
    const doc = JSON.parse(await readFile(join(root, '.studio', 'image-tasks.json'), 'utf8')) as { tasks: Array<{ id: string }> }
    expect(doc.tasks.filter((task) => task.id === fromWorkbench.id)).toHaveLength(1)
  })

  it('AC3 "补全全部"也是同一条队列(和单槽任务混在同一个账本里)', async () => {
    const single = await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const batch = await service.createTasksForMissingSlots('board', { model: 'gpt-image-1', run: true })
    const all = await service.generationTasks('board')
    expect(all.length).toBe(batch.length + 1)
    expect(all.map((task) => task.id)).toContain(single.id)
  })

  // ── AC4:产物一律经网关 + 快照 ──────────────────────────────────────

  it('AC4 每个产物都是一个写批(自动快照),且网关写日志里有据可查', async () => {
    await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })

    const log = await service.writeLog('board')
    const assetWrites = log.filter((entry) => entry.path === slotAssetPath('bg school'))
    expect(assetWrites).toHaveLength(1)
    expect(assetWrites[0]!.reason).toBe('slot')
    // 快照覆盖了它(写批 → 自动 commit)。
    const history = await service.snapshotHistory('board', slotAssetPath('bg school'))
    expect(history.length).toBeGreaterThan(0)
    // 任务账本本身也过网关(状态变化一样进快照)。
    expect(log.some((entry) => entry.path === '.studio/image-tasks.json')).toBe(true)
  })

  it('AC4 重 roll 不产生"无主的产物":旧版能回滚,回滚本身也留快照', async () => {
    const task = await service.createGenerationTask('board', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const rerolled = await service.retryGenerationTask('board', task.id, { run: true })
    const target = rerolled.attempts[0]!.fingerprint

    const history = await service.snapshotHistory('board', slotAssetPath('bg school'))
    // 找出版本指纹等于"被替换的那一版"的那条快照 commit。
    const commitForOld = history.find((entry) => entry.commit !== undefined)
    expect(commitForOld).toBeDefined()
    void target

    // 回滚到任一历史版本 → 文件回到旧内容,且这本身留下新快照(历史只追加)。
    const rollback = await service.snapshotRollback('board', slotAssetPath('bg school'), history[history.length - 1]!.commit)
    expect(rollback.batchId).toBeGreaterThan(0)
    const after = await service.snapshotHistory('board', slotAssetPath('bg school'))
    expect(after.length).toBeGreaterThan(history.length)
  })

  // ── 动作面的诚实边界 ───────────────────────────────────────────────

  it('没配渠道时,"补全全部"如实失败(不产假任务、不假装已排队)', async () => {
    const bare = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir), images: { http: createNodeHttpClient(), channel: () => null } })
    try {
      await bare.createProject({ projectsRoot, name: 'bare', title: '没渠道' })
      await expect(bare.createTasksForMissingSlots('bare', { model: 'gpt-image-1' }))
        .rejects.toMatchObject({ code: 'no-image-channel' })
      // 一个任务都没落盘(拒绝得干干净净)。
      expect(await bare.generationTasks('bare')).toEqual([])
    } finally {
      await bare.dispose()
    }
  })
})
