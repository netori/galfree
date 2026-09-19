/**
 * T16 seam tests — 参考链一致性回路(#24)。
 *
 * 契约来源(T16 票面 AC):
 *  1. **差分批量任务参数含正确链引用**(假上游断言):登记簿的参考图链是跨批次
 *     "同一张脸"的锚,差分任务要**自动**带上它,并指向真正能用的那一版;
 *  2. 链上有一张图还不存在时**如实降级并列出丢了哪张**(不假装链生效);
 *  3. **拒收注记**进任务历史,人和 agent 都回读得到。
 *
 * 断言面:只经 ProjectService 公共接口 + 磁盘终态 + 推导对象。
 * "自动携链"的证据落在**假上游收到的请求体**上 —— 不是看任务对象里写了什么,
 * 而是看真正发出去的是什么(链上的图以项目内文件的内联字节发出,远端才有得用)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { slotAssetPath } from './slot-naming.ts'
import { createNodeHttpClient, type GenerationTask, type ImageChannelSettings, type ImageModelDescriptor } from './images.ts'

/** 一个角色三个槽:主视觉 + 两个表情差分(差分的锚 = 主视觉)。 */
const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    scene bg school',
  '    show xiao_tang base',
  '    xiao_tang "你来啦。"',
  '    show xiao_tang smile',
  '    xiao_tang "今天天气不错。"',
  '    show xiao_tang angry',
  '    xiao_tang "……你迟到了。"',
  '    return',
  '',
].join('\n')

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/4B0dAAAAAABJRU5ErkJggg=='
const PNG_A_BYTES = Buffer.from(PNG_A, 'base64')
const PNG_B_BYTES = Buffer.from(PNG_B, 'base64')

interface UpstreamCall {
  path: string
  body: Record<string, unknown>
  raw: string
}

/** 假上游:OpenAI 兼容同步接口;记录发出去的原文(断言"链到底发了什么")。 */
class FakeUpstream {
  readonly calls: UpstreamCall[] = []
  payloads = [PNG_A, PNG_B]
  /** 让上游按这个应答(errors:测"失败原因可执行"那几条)。 */
  rejectWith: { status: number; body: string } | null = null
  #server: Server | null = null
  #served = 0

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

  /** 某次调用里带的参考图(没有 image 字段 = 那次是文生图)。 */
  referencesOf(call: UpstreamCall): Array<{ image_url?: string }> {
    const image = call.body.image
    return Array.isArray(image) ? image as Array<{ image_url?: string }> : []
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) as Record<string, unknown> } catch { body = {} }
    this.calls.push({ path: req.url ?? '', body, raw })
    if (this.rejectWith !== null) {
      res.writeHead(this.rejectWith.status, { 'content-type': 'application/json' })
      res.end(this.rejectWith.body)
      return
    }
    const payload = this.payloads[Math.min(this.#served++, this.payloads.length - 1)]!
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: payload }] }))
  }
}

function channel(baseUrl: string, models?: ImageModelDescriptor[]): ImageChannelSettings {
  return {
    baseUrl,
    apiKey: 'sk-test-plaintext',
    name: '假渠道',
    models: models ?? [
      {
        id: 'full',
        label: '全能力(支持参考链)',
        adapter: 'openai-compatible',
        capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
      },
      {
        id: 'no-chain',
        label: '不支持参考链',
        adapter: 'openai-compatible',
        capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
      },
      {
        // 实测形状(`live-chain.slow.test.ts` 在真上游上撞出来的那个 400):
        // 这个网关的 `image` 字段是 **string**,发数组会被原样拒掉。
        id: 'string-field',
        label: '参考图字段只收单个字符串',
        adapter: 'openai-compatible',
        referenceField: 'string',
        capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
      },
    ],
  }
}

describe('参考链一致性回路(T16)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService
  let upstream: FakeUpstream
  let root: string

  /** 登记簿:小棠的参考链 = 主视觉那一张(差分靠它保持一致)。 */
  const registerChain = async (references: Array<{ path: string; slot?: string; note?: string }>): Promise<void> => {
    await service.upsertCharacter('chain', {
      id: 'xiao_tang',
      name: '小棠',
      voice: 'xiao_tang',
      appearance: { hair: '黑色长直发', eyes: '琥珀色' },
      styleAnchor: 'clean anime lineart, soft cel shading',
      references,
    })
  }

  /** 三个槽都挂上"要小棠出场"的制作信息。 */
  const ledgerFor = async (): Promise<void> => {
    for (const slot of ['xiao_tang base', 'xiao_tang smile', 'xiao_tang angry']) {
      await service.upsertSlot('chain', { slot, requiresCharacters: ['xiao_tang'], prompt: `${slot} 的素材` })
    }
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t16-data-')
    projectsRoot = await makeTempDir('galfree-t16-projects-')
    upstream = new FakeUpstream()
    const baseUrl = await upstream.start()

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: { http: createNodeHttpClient(), channel: () => channel(baseUrl) },
    })
    const project = await service.createProject({ projectsRoot, name: 'chain', title: '链' })
    root = project.root
    const snap = await service.readProjectFile('chain', 'game/script.rpy')
    await service.writeProjectFiles('chain', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
  })

  afterEach(async () => {
    await service.dispose()
    await upstream.stop()
    await cleanupTempDirs()
  })

  /**
   * 任务应当成功到「待复审」;没到就把**失败原话**带进断言消息。
   *
   * 为什么值得单独一个 helper:这一组用例跑的是**真本地 HTTP**(假上游),
   * 满载时会偶发地连不上 —— 那时断言只会说 `expected 'failed' to be 'awaiting-review'`,
   * 而**为什么** failed 全在 `lastError` 里。少了这一句,下一次红又要从头复现一遍。
   * (与 `async-image.test.ts` 那条"传输层失败"的教训同一件事:两种失败要说得出区别。)
   */
  const expectAwaitingReview = (task: GenerationTask): void => {
    expect(
      task.state,
      `任务没到 awaiting-review(实际 ${task.state});lastError=${task.lastError ?? '(无)'}`,
    ).toBe('awaiting-review')
  }

  // ── AC1:差分批量任务参数含正确链引用 ────────────────────────────────

  it('AC1 差分批量:主视觉先出,每个差分自动携登记簿的链引用(假上游看得到)', async () => {
    await registerChain([{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' }])
    await ledgerFor()

    const tasks = await service.createDifferentialTasks('chain', { character: 'xiao_tang', model: 'full', run: true })

    // 1) 顺序:主视觉先出(差分要拿它当锚),差分的顺序不被人为打乱。
    expect(tasks.map((task) => task.slot)).toEqual(['xiao_tang base', 'xiao_tang smile', 'xiao_tang angry'])
    for (const task of tasks) expectAwaitingReview(task)

    // 2) 任务参数:主视觉不带链(自己参考自己没有意义),两个差分各带一条。
    expect(tasks[0]!.referenceImages).toEqual([])
    for (const task of tasks.slice(1)) {
      expect(task.referenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    }

    // 3) 真正发出去的请求:差分带 image,主视觉不带 —— 链不是账本上的一行字。
    const withImage = upstream.calls.filter((call) => Array.isArray(call.body.image))
    expect(withImage).toHaveLength(2)
    expect(upstream.calls[0]!.body.image).toBeUndefined()
    for (const call of withImage) {
      expect(call.body.prompt).toContain('的素材')
    }
  })

  it('AC1 链上的参考图以**内联字节**发出(远端拿不到项目内相对路径)', async () => {
    await registerChain([{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' }])
    await ledgerFor()

    await service.createDifferentialTasks('chain', { character: 'xiao_tang', model: 'full', run: true })

    const chainCall = upstream.calls.at(-1)!
    const references = upstream.referencesOf(chainCall)
    expect(references).toHaveLength(1)
    const url = references[0]!.image_url ?? ''
    // 内联字节:前缀是 data URL,解出来**就是主视觉那张图的字节**(不是路径字符串)。
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const decoded = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    expect(decoded.equals(PNG_A_BYTES)).toBe(true)
    // 落盘的主视觉确实就是上游刚给的那张(链路首尾对得上)。
    const onDisk = await readFile(join(root, ...slotAssetPath('xiao_tang base').split('/')))
    expect(decoded.equals(onDisk)).toBe(true)
  })

  it('AC1 链上的图还不存在 → 如实降级并列出丢了哪张(不假装链生效)', async () => {
    // 主视觉先出(它就是差分的锚),再往链上挂一张**还不存在**的图。
    await ledgerFor()
    await service.createGenerationTask('chain', { slot: 'xiao_tang base', model: 'full', prompt: '主视觉', run: true })
    await registerChain([
      { path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' },
      { path: 'game/images/xiao-tang-ghost.png', note: '人还没出的那一张' },
    ])

    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })

    // 存在的带上,不存在的那张被丢掉并**说清楚丢了什么**。
    expect(task.referenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    expect(task.degradation?.code).toBe('reference-missing')
    expect(task.degradation?.droppedReferenceImages.map((reference) => reference.path)).toEqual(['game/images/xiao-tang-ghost.png'])
    expect(task.degradation?.notes.join(' ')).toContain('还不存在')
    // 任务照样跑完 —— 降级不是失败(与 T14 的降级纪律同一条)。
    expectAwaitingReview(task)

    // 发出去的请求里没有那张不存在的图。
    const call = upstream.calls.at(-1)!
    expect(call.raw).not.toContain('xiao-tang-ghost.png')
  })

  it('AC1 模型声明不支持参考链 → 自动携的链照降级规矩丢弃并说明', async () => {
    await ledgerFor()
    await service.createGenerationTask('chain', { slot: 'xiao_tang base', model: 'full', prompt: '主视觉', run: true })
    await registerChain([{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base' }])

    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'no-chain', prompt: '微笑', run: true })

    expect(task.degradation?.code).toBe('reference-chain-unsupported')
    expect(task.degradation?.droppedReferenceImages).toHaveLength(1)
    expectAwaitingReview(task)
    expect(upstream.calls.at(-1)!.body.image).toBeUndefined()
  })

  it('AC1 自引用被排除:槽不会把**自己的产物**当参考(链视图如实标注)', async () => {
    await ledgerFor()
    await registerChain([{ path: slotAssetPath('xiao_tang smile'), slot: 'xiao_tang smile', note: '挂错了:挂成它自己' }])

    const view = await service.referenceChain('chain', 'xiao_tang smile')
    expect(view.references).toEqual([])
    expect(view.excludedSelf).toEqual([slotAssetPath('xiao_tang smile')])

    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })
    expect(task.referenceImages).toEqual([])
    expect(upstream.calls.at(-1)!.body.image).toBeUndefined()
  })

  it('AC1 链视图:来源角色、就绪与否、缺哪张,一眼可查(纯读,不写)', async () => {
    await ledgerFor()
    await service.createGenerationTask('chain', { slot: 'xiao_tang base', model: 'full', prompt: '主视觉', run: true })
    await registerChain([
      { path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' },
      { path: 'game/images/never-made.png' },
    ])

    const before = (await service.writeLog('chain')).length
    const view = await service.referenceChain('chain', 'xiao_tang smile')
    const after = (await service.writeLog('chain')).length

    expect(view.slot).toBe('xiao_tang smile')
    expect(view.characters).toEqual(['xiao_tang'])
    expect(view.references.map((reference) => [reference.path, reference.character, reference.exists])).toEqual([
      [slotAssetPath('xiao_tang base'), 'xiao_tang', true],
      ['game/images/never-made.png', 'xiao_tang', false],
    ])
    expect(view.missing.map((reference) => reference.path)).toEqual(['game/images/never-made.png'])
    // 链视图是**读**:它不该产生任何写(推导面不落盘)。
    expect(after).toBe(before)
  })

  it('AC1 "补全全部待填"走同一条闸门:被引用者先出,差分建任务时链已经就绪(不报缺链)', async () => {
    await registerChain([{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' }])
    await ledgerFor()

    const tasks = await service.createTasksForMissingSlots('chain', { model: 'full', run: true })
    const order = tasks.map((task) => task.slot)
    // 被引用者先出 —— 主视觉排在它的两个差分之前。
    expect(order.indexOf('xiao_tang base')).toBeLessThan(order.indexOf('xiao_tang smile'))
    expect(order.indexOf('xiao_tang base')).toBeLessThan(order.indexOf('xiao_tang angry'))

    // 差分的链是**真的**:主视觉那一张先跑完了,所以差分没有"缺链"降级。
    // (先建齐再统一跑的实现会在这里留下 reference-missing —— 那正是这条用例守的东西。)
    for (const slot of ['xiao_tang smile', 'xiao_tang angry']) {
      const task = tasks.find((candidate) => candidate.slot === slot)!
      expectAwaitingReview(task)
      expect(task.degradation).toBeUndefined()
      expect(task.referenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    }
  })

  it('AC1 上游那个字段只收**字符串**时:按声明发单个字符串,多张按链上顺序取第一张并如实降级', async () => {
    // 这是真上游教出来的一条(慢带在 seedance 上撞到的 400:
    // `json: cannot unmarshal array into Go struct field .Alias.image of type string`)。
    await ledgerFor()
    await service.createGenerationTask('chain', { slot: 'xiao_tang base', model: 'string-field', prompt: '主视觉', run: true })
    await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'string-field', prompt: '微笑', run: true })
    await registerChain([
      { path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' },
      { path: slotAssetPath('xiao_tang smile'), slot: 'xiao_tang smile', note: '第一个差分' },
    ])

    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang angry', model: 'string-field', prompt: '生气', run: true })

    // 发出去的是**字符串**(不是数组)—— 形状按目录声明,不猜。
    const call = upstream.calls.at(-1)!
    expect(typeof call.body.image).toBe('string')
    const image = call.body.image as string
    expect(image.startsWith('data:image/png;base64,')).toBe(true)
    const decoded = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64')
    expect(decoded.equals(Buffer.from(await readFile(join(root, ...slotAssetPath('xiao_tang base').split('/')))))).toBe(true)

    // 那个字段只收一张 → 第二张按链上顺序被截掉,并**如实记进降级**(不静默少发)。
    expect(task.referenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    expect(task.degradation?.code).toBe('reference-truncated')
    expect(task.degradation?.droppedReferenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang smile')])
    expect(task.degradation?.notes.join(' ')).toContain('只收一张')
    expectAwaitingReview(task)
  })

  it('AC1 上游拒掉参考图时,失败原因要**可执行**(不是一句"失败了")', async () => {
    // 实测两种拒绝(慢带在 seedance 上撞到的原话)+ 一种顺带断言的形状错配指引。
    await ledgerFor()
    await service.createGenerationTask('chain', { slot: 'xiao_tang base', model: 'full', prompt: '主视觉', run: true })
    await registerChain([{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base' }])

    upstream.rejectWith = {
      status: 400,
      body: JSON.stringify({ code: 'invalid_parameter', message: 'images must contain public HTTP(S) URLs' }),
    }
    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })
    expect(task.state).toBe('failed')
    // 上游原话照旧带着(不吞),外加一句"接下来该做什么"。
    expect(task.lastError).toContain('public HTTP(S) URLs')
    expect(task.lastError).toContain('公网可取的 HTTP(S) 图片地址')
    expect(task.lastError).toContain('参考链')

    upstream.rejectWith = {
      status: 400,
      body: JSON.stringify({ code: 'invalid_request', message: 'json: cannot unmarshal array into Go struct field .Alias.image of type string' }),
    }
    const second = await service.createGenerationTask('chain', { slot: 'xiao_tang angry', model: 'full', prompt: '生气', run: true })
    expect(second.lastError).toContain('单个字符串')
  })

  it('AC1 差分批量先过渠道与模型两道门(没配渠道时如实拒绝,不产假任务)', async () => {    await ledgerFor()
    await registerChain([{ path: slotAssetPath('xiao_tang base') }])
    const bare = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: { http: createNodeHttpClient(), channel: () => null },
    })
    try {
      await bare.createProject({ projectsRoot, name: 'nochannel', title: '没渠道' })
      await expect(bare.createDifferentialTasks('nochannel', { character: 'xiao_tang', model: 'full' }))
        .rejects.toMatchObject({ code: 'no-image-channel' })
    } finally {
      await bare.dispose()
    }
  })

  // ── AC3:拒收注记进任务历史,人和 agent 都回读得到 ────────────────────

  it('AC3 重 roll 携带人的拒收理由 → 进历史,并指向被拒的那一版', async () => {
    await ledgerFor()
    const first = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })

    const rerolled = await service.retryGenerationTask('chain', first.id, {
      run: true,
      prompt: '微笑,下巴更尖一点',
      note: '脸太圆了,下巴要尖',
      via: 'human',
    })

    expect(rerolled.rejections).toHaveLength(1)
    const rejection = rerolled.rejections[0]!
    expect(rejection.note).toBe('脸太圆了,下巴要尖')
    expect(rejection.via).toBe('human')
    // 注记指向**被拒的那一版**(它的指纹),不是空口一句话。
    expect(rejection.fingerprint).toBe(first.attempts[0]!.fingerprint)
    expect(rejection.attempt).toBe(1)
    // 两版产物都能对上:被替换的指纹 = 被拒那一版。
    expect(rerolled.attempts[1]!.replacedFingerprint).toBe(first.attempts[0]!.fingerprint)
  })

  it('AC3 拒收注记落盘且回读得到(人经账本、agent 经队列读的是同一份)', async () => {
    await ledgerFor()
    const first = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })
    await service.retryGenerationTask('chain', first.id, { run: true, note: '眼神太凶', via: 'human' })

    // 人:经接缝的账本读。
    const listed = await service.generationTasks('chain')
    expect(listed[0]!.rejections.map((entry) => entry.note)).toEqual(['眼神太凶'])
    // 单任务读也一样(agent 的 galfree_art_queue 走的是同一个对象)。
    const one = await service.generationTask('chain', first.id)
    expect(one?.rejections[0]?.note).toBe('眼神太凶')

    // 磁盘上的账本里也有它(拒收理由是**制作信息**,不是叙述内容)。
    const doc = JSON.parse(await readFile(join(root, '.studio', 'image-tasks.json'), 'utf8')) as { tasks: GenerationTask[] }
    expect(doc.tasks[0]!.rejections?.[0]?.note).toBe('眼神太凶')
  })

  it('AC3 空注记与超长注记都被拒(要么说清为什么拒,要么别记)', async () => {
    await ledgerFor()
    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })

    // 三种"空":纯空白、空串、超长 —— 都是调用方的错,如实拒绝(不要静默记一条没理由的打回)。
    await expect(service.retryGenerationTask('chain', task.id, { run: false, note: '   ' }))
      .rejects.toMatchObject({ code: 'empty-note' })
    await expect(service.retryGenerationTask('chain', task.id, { run: false, note: '' }))
      .rejects.toMatchObject({ code: 'empty-note' })
    await expect(service.retryGenerationTask('chain', task.id, { run: false, note: '很'.repeat(601) }))
      .rejects.toMatchObject({ code: 'note-too-long' })
    // 被拒的调用什么都没改:历史还是干干净净。
    expect((await service.generationTask('chain', task.id))?.rejections).toEqual([])
  })

  it('AC3 不写 via 时默认记成**人**的话(人的判断是默认,agent 转述要显式标)', async () => {
    await ledgerFor()
    const task = await service.createGenerationTask('chain', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑', run: true })
    const rerolled = await service.retryGenerationTask('chain', task.id, { run: false, note: '光照太平' })
    expect(rerolled.rejections[0]?.via).toBe('human')
  })
})
