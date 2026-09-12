/**
 * T16 seam tests — 槽位对比视图(#24 AC2:渲染自**登记簿 + 槽位历史**)。
 *
 * 这个视图要回答三个问题,而且答案只能是**推导**出来的:
 *  1. 同一个角色的差分各是哪几格(来自登记簿的 `requiresCharacters` 与槽账本);
 *  2. 哪一格是**主视觉**(登记簿的参考链指到了它的产物);
 *  3. 每一格历史上出过哪几版、哪一版被人打回过、为什么(来自任务账本的尝试与拒收注记)。
 *
 * "纯渲染"在这里是**可断言的**:调它不产生任何写(网关写日志长度不变)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { slotAssetPath } from './slot-naming.ts'
import { createNodeHttpClient } from './images.ts'

const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
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

class FakeUpstream {
  payloads = [PNG_A, PNG_B]
  #server: Server | null = null
  #served = 0

  async start(): Promise<string> {
    this.#server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      const payload = this.payloads[Math.min(this.#served++, this.payloads.length - 1)]!
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: payload }] }))
    })
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve))
    const address = this.#server!.address()
    return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/v1`
  }

  async stop(): Promise<void> {
    if (this.#server === null) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = null
  }
}

describe('槽位对比视图(T16)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService
  let upstream: FakeUpstream

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t16g-data-')
    projectsRoot = await makeTempDir('galfree-t16g-projects-')
    upstream = new FakeUpstream()
    const baseUrl = await upstream.start()
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: createNodeHttpClient(),
        channel: () => ({
          baseUrl,
          models: [{
            id: 'full',
            adapter: 'openai-compatible',
            capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
          }],
        }),
      },
    })
    const project = await service.createProject({ projectsRoot, name: 'grid', title: '差分对比' })
    const snap = await service.readProjectFile('grid', 'game/script.rpy')
    await service.writeProjectFiles('grid', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
    for (const slot of ['xiao_tang base', 'xiao_tang smile', 'xiao_tang angry']) {
      await service.upsertSlot('grid', { slot, requiresCharacters: ['xiao_tang'], prompt: `${slot} 的素材` })
    }
    await service.upsertCharacter('grid', {
      id: 'xiao_tang',
      name: '小棠',
      voice: 'xiao_tang',
      appearance: { hair: '黑色长直发' },
      styleAnchor: 'clean anime lineart',
      references: [
        { path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉' },
        { path: 'game/images/xiao_tang-ghost.png', note: '还没出的那一张' },
      ],
    })
  })

  afterEach(async () => {
    await service.dispose()
    await upstream.stop()
    await cleanupTempDirs()
  })

  it('AC2 网格自登记簿 + 槽位历史:格子、主视觉、版本谱系都在', async () => {
    await service.createDifferentialTasks('grid', { character: 'xiao_tang', model: 'full', run: true })

    const grid = await service.differentialGrid('grid')
    const row = grid.characters.find((entry) => entry.character === 'xiao_tang')
    expect(row).toBeDefined()

    // 格子来自槽账本(要小棠出场的那些),顺序 = 剧本里首次引用的顺序。
    expect(row!.cells.map((cell) => cell.slot)).toEqual(['xiao_tang base', 'xiao_tang smile', 'xiao_tang angry'])
    // 主视觉 = 登记簿的参考链指到的那一格(差分靠它保持一致)。
    expect(row!.main).toBe('xiao_tang base')
    expect(row!.cells.map((cell) => cell.role)).toEqual(['main', 'variant', 'variant'])

    // 参考链的处境如实带上:在的那张在,不在的那张如实标 false。
    expect(row!.references.map((reference) => [reference.path, reference.exists])).toEqual([
      [slotAssetPath('xiao_tang base'), true],
      ['game/images/xiao_tang-ghost.png', false],
    ])

    // 槽位历史:每一格都能看到出过的版本(成功尝试的指纹)。
    const base = row!.cells[0]!
    expect(base.filled).toBe(true)
    expect(base.assetPath).toBe(slotAssetPath('xiao_tang base'))
    expect(base.history).toHaveLength(1)
    expect(base.history[0]!.outcome).toBe('ok')
    expect(base.history[0]!.fingerprint).toBeDefined()
  })

  it('AC2 拒收与"被它替换掉的那一版"都进格子历史(人一眼看得出这张为什么回炉)', async () => {
    const tasks = await service.createDifferentialTasks('grid', { character: 'xiao_tang', model: 'full', run: true })
    const smile = tasks.find((task) => task.slot === 'xiao_tang smile')!
    const firstFingerprint = smile.attempts[0]!.fingerprint

    await service.retryGenerationTask('grid', smile.id, { run: true, prompt: '微笑,下巴更尖', note: '脸太圆了', via: 'human' })

    const grid = await service.differentialGrid('grid')
    const cell = grid.characters.find((entry) => entry.character === 'xiao_tang')!.cells.find((entry) => entry.slot === 'xiao_tang smile')!
    expect(cell.history).toHaveLength(2)
    // 第二次尝试记着"它替换掉的是哪一版",并带着人对那一版的拒收理由。
    expect(cell.history[1]!.replacedFingerprint).toBe(firstFingerprint)
    expect(cell.history[0]!.rejection?.note).toBe('脸太圆了')
    expect(cell.history[0]!.rejection?.via).toBe('human')
    // 当前那一版仍是"待复审"(人还没认可新的一版)。
    expect(cell.awaitingReview).toBe(true)
  })

  it('AC2 同一格先后有过两个任务:两边的版本与拒收理由都留在网格里', async () => {
    const first = await service.createGenerationTask('grid', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑 v1', run: true })
    await service.retryGenerationTask('grid', first.id, { run: true, note: '第一版脸太圆', via: 'human' })
    // 再**新建**一个任务(不是重 roll):旧任务上的拒收注记不许从视图里消失 ——
    // "只取最近一个任务"的实现在这里会丢掉它。
    const second = await service.createGenerationTask('grid', { slot: 'xiao_tang smile', model: 'full', prompt: '微笑 v2', run: true })

    const grid = await service.differentialGrid('grid')
    const cell = grid.characters.find((entry) => entry.character === 'xiao_tang')!.cells.find((entry) => entry.slot === 'xiao_tang smile')!
    expect(new Set(cell.history.map((entry) => entry.taskId))).toEqual(new Set([first.id, second.id]))
    expect(cell.history.some((entry) => entry.rejection?.note === '第一版脸太圆')).toBe(true)
    // 当前那一格指向**最新**的任务(重 roll 从它走)。
    expect(cell.taskId).toBe(second.id)
  })

  it('AC2 还没出图的格子如实空着(不拿"没有图"假装成有图)', async () => {
    const grid = await service.differentialGrid('grid')
    const row = grid.characters.find((entry) => entry.character === 'xiao_tang')!
    for (const cell of row.cells) {
      expect(cell.filled).toBe(false)
      expect(cell.fingerprint).toBe('absent')
      expect(cell.history).toEqual([])
    }
    // 槽位历史是空的,但"要出哪几格"仍然清清楚楚(格子来自派生,不是来自已出的图)。
    expect(row.cells.map((cell) => cell.slot)).toEqual(['xiao_tang base', 'xiao_tang smile', 'xiao_tang angry'])
  })

  it('AC2 对比视图是**读**:调它不产生任何写(推导面不落盘)', async () => {
    await service.createDifferentialTasks('grid', { character: 'xiao_tang', model: 'full', run: true })
    const before = (await service.writeLog('grid')).length
    await service.differentialGrid('grid')
    await service.differentialGrid('grid')
    expect((await service.writeLog('grid')).length).toBe(before)
  })

  it('AC2 登记簿里没有的角色不出现在网格里(网格的根是登记簿)', async () => {
    const grid = await service.differentialGrid('grid')
    expect(grid.characters.map((entry) => entry.character)).toEqual(['xiao_tang'])
  })
})
