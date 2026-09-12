/**
 * T14 seam tests — 图像渠道 + 任务队列(Host 直连)。
 *
 * 契约来源(T14 / #22 票面 AC):
 *  1. 接缝建任务 → **假 HTTP 上游**应答 → 产物落槽位目标路径,板转「待复审」;
 *  2. 槽位人盖素材审读戳;重生成清戳(复用 T6);
 *  3. 不支持参考链的模型 → 任务参数**自动降级成文生图并附说明**(不静默);
 *  4. 队列批量:进度、失败重试、历史可查。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态 + 推导对象。
 * 上游是**真的本地 HTTP 服务器**(假上游),HTTP 客户端是注入端口 —— 生产用 fetch,
 * 这里用同一端口的另一个实现,协议形状不因测试而变。
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
import type { GenerationTask, ImageChannelSettings } from './images.ts'

/** 两个场景:一个引用缺素材的槽(待出图),一个有对白与角色。 */
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

/** 一张最小的合法 PNG(1x1),冒充"上游生成的图"。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')
/** 另一张"重 roll 出来的图"(字节不同 → 指纹不同)。 */
const OTHER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/4B0dAAAAAABJRU5ErkJggg=='

/** 假上游收到的请求记录(断言"发出去的到底是什么")。 */
interface UpstreamCall {
  path: string
  body: Record<string, unknown>
  raw: string
}

/** 假 HTTP 上游:OpenAI 兼容 /images/generations(也接 /images/edits)。 */
class FakeUpstream {
  readonly calls: UpstreamCall[] = []
  #server: Server | null = null
  port = 0
  /** 让第 N 次调用失败(测重试历史)。 */
  failNext = 0
  /** 返回的 b64 载荷(默认最小 PNG)。给一串 = 每次调用换一张(测"重生成指纹变了")。 */
  payload = PNG_BASE64
  payloads: string[] = []

  #served = 0

  async start(): Promise<string> {
    this.#server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.#handle(req, res)
    })
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve))
    const address = this.#server!.address()
    this.port = typeof address === 'object' && address !== null ? address.port : 0
    return `http://127.0.0.1:${this.port}/v1`
  }

  async stop(): Promise<void> {
    if (this.#server === null) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = null
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) as Record<string, unknown> } catch { body = {} }
    this.calls.push({ path: req.url ?? '', body, raw })

    if (this.failNext > 0) {
      this.failNext -= 1
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '上游临时故障(测试注入)' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const payload = this.payloads.length === 0
      ? this.payload
      : this.payloads[Math.min(this.#served++, this.payloads.length - 1)]!
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: payload }] }))
  }
}

/** 渠道设置:一个支持参考链的模型 + 一个不支持的(降级用)。 */
function channel(baseUrl: string, overrides: Partial<ImageChannelSettings> = {}): ImageChannelSettings {
  return {
    baseUrl,
    apiKey: 'sk-test-plaintext',
    models: [
      {
        id: 'gpt-image-1',
        label: '假上游·全能力',
        adapter: 'openai-compatible',
        capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
      },
      {
        id: 'basic-only',
        label: '假上游·不支持参考链',
        adapter: 'openai-compatible',
        capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: false, b64Json: true },
      },
    ],
    ...overrides,
  }
}

describe('图像渠道 + 任务队列(T14)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService
  let upstream: FakeUpstream
  let baseUrl: string
  let root: string

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t14-data-')
    projectsRoot = await makeTempDir('galfree-t14-projects-')
    upstream = new FakeUpstream()
    baseUrl = await upstream.start()

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: createNodeHttpClient(),
        channel: () => channel(baseUrl),
      },
    })
    const project = await service.createProject({ projectsRoot, name: 'art', title: '美术' })
    root = project.root
    const snap = await service.readProjectFile('art', 'game/script.rpy')
    await service.writeProjectFiles('art', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
  })

  afterEach(async () => {
    await service.dispose()
    await upstream.stop()
    await cleanupTempDirs()
  })

  // ── AC1:任务 → 假上游 → 落盘 → 板转待复审 ────────────────────────────

  it('AC1 建任务 → 假 HTTP 上游应答 → 产物落槽位目标路径,板转待复审', async () => {
    const task = await service.createGenerationTask('art', {
      slot: 'bg school',
      model: 'gpt-image-1',
      prompt: '黄昏的教室,夕照穿过窗',
      run: true,
    })

    // 任务状态机:跑完 = 待复审,产物路径与槽位的约定路径一致。
    expect(task.attempts[0]?.error ?? '(没有失败原因)').toBe('(没有失败原因)')
    expect(task.state).toBe('awaiting-review')
    expect(task.outputPath).toBe(slotAssetPath('bg school'))
    expect(task.attempts).toHaveLength(1)
    expect(task.attempts[0]!.outcome).toBe('ok')

    // 磁盘终态:字节与上游给的完全一致(二进制没在途中被当文本糟践)。
    const onDisk = await readFile(join(root, 'game', 'images', 'bg-school.png'))
    expect(Buffer.compare(onDisk, PNG_BYTES)).toBe(0)

    // 推导板:槽从"缺素材"变成"已填 + 待复审",且没有可手改的进度字段。
    const progress = await service.progress('art')
    const slot = progress.slots.find((entry) => entry.slot === 'bg school')
    expect(slot?.filled).toBe(true)
    expect(slot?.stamp).toBe('pending')
    expect(slot?.awaitingReview).toBe(true)
    // 这一场引用的两个槽里只出图了一个:另一个(角色立绘)仍然缺 —— 补全属 T15 的动作面。
    expect(progress.summary.missingSlots).toBe(2)
  })

  it('AC1 产物经写网关落盘并被快照覆盖(可回滚)', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const history = await service.snapshotHistory('art', slotAssetPath('bg school'))
    expect(history.length).toBeGreaterThan(0)
    expect(history[0]!.subject).toContain('slot')
  })

  it('AC1 请求形状照 OpenAI 兼容协议:model/prompt/size 都在,密钥走 Authorization', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '黄昏的教室', size: '16:9', run: true })
    const call = upstream.calls.at(-1)!
    expect(call.path).toBe('/v1/images/generations')
    expect(call.body.model).toBe('gpt-image-1')
    expect(call.body.prompt).toBe('黄昏的教室')
    expect(call.body.size).toBe('16:9')
    expect(call.body.n).toBe(1)
  })

  // ── AC3:协议不合要如实降级,不静默 ──────────────────────────────────

  it('AC3 不支持参考链的模型 → 任务参数自动降级为文生图,并附说明(不静默)', async () => {
    const refs = [{ path: 'game/images/xiao-tang-smile.png', note: '主视觉锚' }]
    const task = await service.createGenerationTask('art', {
      slot: 'bg school',
      model: 'basic-only',
      prompt: '小棠站在教室门口',
      referenceImages: refs,
      run: true,
    })

    // 降级是**记在任务上**的事实,人和 agent 都读得到(读到的是跑完之后的终态)。
    expect(task.degradation).toBeDefined()
    expect(task.degradation?.code).toBe('reference-chain-unsupported')
    expect(task.degradation?.message).toContain('不支持参考链')
    expect(task.degradation?.droppedReferenceImages).toHaveLength(1)
    // 任务照样跑完 —— 降级不是失败。
    expect(task.state).toBe('awaiting-review')

    // 发出去的请求里**没有**参考图:降级是真的降级,不是嘴上说说。
    const call = upstream.calls.at(-1)!
    expect(call.raw).not.toContain('xiao-tang-smile.png')
    expect(call.body.image).toBeUndefined()
    expect(call.body.prompt).toContain('小棠站在教室门口')
  })

  it('AC3 模型做不到图生图时,连尺寸降级也如实记录(不给假承诺)', async () => {
    const task = await service.createGenerationTask('art', {
      slot: 'bg school', model: 'basic-only', prompt: '教室', size: '16:9', referenceImages: [{ path: 'a.png' }], run: true,
    })
    // 参考图被丢 + 尺寸参数不支持,两条都要说出来。
    expect(task.degradation?.notes.join(' ')).toContain('尺寸')
    expect(task.degradation?.notes.join(' ')).toContain('参考图链')
    // 尺寸确实没发出去(降级是真的降级)。
    const call = upstream.calls.at(-1)!
    expect(call.body.size).toBeUndefined()
  })

  // ── AC4:队列批量 + 重试历史 ────────────────────────────────────────

  it('AC4 队列批量:待填槽展开成任务集,逐个跑完,每个都有产物', async () => {
    const before = await service.progress('art')
    const missingBefore = before.slots.filter((slot) => !slot.filled).map((slot) => slot.slot)
    const tasks = await service.createTasksForMissingSlots('art', { model: 'gpt-image-1' })
    expect(tasks.map((task) => task.slot)).toEqual(missingBefore)
    for (const task of tasks) expect(task.state).toBe('queued')

    const done = await service.runGenerationQueue('art')
    expect(done.map((task) => task.state)).toEqual(missingBefore.map(() => 'awaiting-review'))

    const progress = await service.progress('art')
    expect(progress.summary.missingSlots).toBe(0)
  })

  it('AC4 失败有重试历史:第一次 500 → 任务 failed 且记因;重试成功 → 历史两条,状态翻正', async () => {
    upstream.failNext = 1
    const task = await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    expect(task.state).toBe('failed')
    expect(task.attempts).toHaveLength(1)
    expect(task.attempts[0]!.outcome).toBe('failed')
    expect(task.attempts[0]!.error).toContain('500')

    // 素材没落盘(失败不产半成品),板仍是待填。
    let progress = await service.progress('art')
    expect(progress.slots.find((s) => s.slot === 'bg school')?.filled).toBe(false)

    const retried = await service.retryGenerationTask('art', task.id, { run: true })
    expect(retried.state).toBe('awaiting-review')
    expect(retried.attempts).toHaveLength(2)
    expect(retried.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'ok'])

    progress = await service.progress('art')
    expect(progress.slots.find((s) => s.slot === 'bg school')?.filled).toBe(true)
  })

  it('AC4 任务与历史可查:列表带全部任务,单个任务带完整重试史', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    await service.createGenerationTask('art', { slot: 'bg rooftop', model: 'gpt-image-1', prompt: '天台', run: true })

    const listed = await service.generationTasks('art')
    expect(listed).toHaveLength(2)
    expect(listed.map((task) => task.slot).sort()).toEqual(['bg rooftop', 'bg school'])

    const one = await service.generationTask('art', listed[0]!.id)
    expect(one?.prompt).toBeDefined()
    expect(one?.attempts.length).toBe(1)
    expect(one?.createdAt).toBeDefined()
  })

  // ── AC2:戳的生命周期(复用 T6)────────────────────────────────────

  it('AC2 人盖素材戳 → 已过审;重生成 → 清戳并待复审', async () => {
    // 第一次出一张,重 roll 换一张 —— 内容变了,旧戳才该失效(T6 的指纹机制)。
    upstream.payloads = [PNG_BASE64, OTHER_PNG_BASE64]
    const task = await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })

    await service.stampSlot('art', 'bg school', { via: 'human' })
    let progress = await service.progress('art')
    expect(progress.slots.find((s) => s.slot === 'bg school')?.stamp).toBe('approved')
    expect(progress.slots.find((s) => s.slot === 'bg school')?.awaitingReview).toBe(false)

    // 重生成:产物被覆盖写 → 指纹变化 → 旧戳变 stale(T6 机制,没有新代码)。
    await service.retryGenerationTask('art', task.id, { run: true })
    progress = await service.progress('art')
    const slot = progress.slots.find((s) => s.slot === 'bg school')
    expect(slot?.stamp).toBe('stale')
    expect(slot?.awaitingReview).toBe(true)
  })

  it('AC2 agent 盖素材戳被拒(只有人能盖)', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    await expect(service.stampSlot('art', 'bg school', { via: 'agent' })).rejects.toMatchObject({ code: 'stamp-forbidden' })
  })

  // ── 渠道与设置的诚实边界 ───────────────────────────────────────────

  it('没配渠道 → 建任务如实拒绝(不假装能出图)', async () => {
    const bare = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir), images: { http: createNodeHttpClient(), channel: () => null } })
    try {
      await bare.createProject({ projectsRoot, name: 'nochannel', title: '没渠道' })
      await expect(bare.createGenerationTask('nochannel', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室' }))
        .rejects.toMatchObject({ code: 'no-image-channel' })
    } finally {
      await bare.dispose()
    }
  })

  it('模型不在渠道目录里 → 拒绝(只能用配过的模型)', async () => {
    await expect(service.createGenerationTask('art', { slot: 'bg school', model: 'not-configured', prompt: '教室' }))
      .rejects.toMatchObject({ code: 'unknown-image-model' })
  })

  it('任务落盘在 .studio/,且**不含叙述内容**(铁律:只放引用与制作信息)', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const doc = JSON.parse(await readFile(join(root, '.studio', 'image-tasks.json'), 'utf8')) as {
      schemaVersion: number
      tasks: GenerationTask[]
    }
    expect(doc.schemaVersion).toBe(1)
    const record = doc.tasks[0]!
    // prompt 是**制作信息**(给上游的指令),不是叙述内容;台词/正文一个字都不许进来。
    expect(Object.keys(record)).not.toContain('script')
    expect(JSON.stringify(doc)).not.toContain('你来啦')
  })

  it('API 密钥明文进设置文档,但**不进任务账本**(账本读得到的是渠道名与模型,不是密钥)', async () => {
    await service.createGenerationTask('art', { slot: 'bg school', model: 'gpt-image-1', prompt: '教室', run: true })
    const doc = await readFile(join(root, '.studio', 'image-tasks.json'), 'utf8')
    expect(doc).not.toContain('sk-test-plaintext')
  })
})
