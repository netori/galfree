/**
 * 异步任务制适配器的 seam 测试(T14 续 · 第二种上游协议)。
 *
 * 为什么需要这条协议:实测的网关(one-api / new-api 系)与 OpenAI 同步接口不是一回事 ——
 * 提交 `POST /v1/image/generations`(**单数 image**)回一个**任务**,要按 `task_id` 轮询到
 * 终态,完成后给的是**图片 URL**。原适配器只认"同步 + b64",于是如实报了 404/无图片,
 * 这是对的;补齐协议后这条链路才通。
 *
 * 断言面:只经 ProjectService + 磁盘终态 + 推导对象;上游是**真的本地 HTTP 服务器**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { slotAssetPath } from './slot-naming.ts'
import { createNodeHttpClient, imageFormatOf } from './images.ts'

const SCRIPT = [
  'label start:',
  '    scene bg rooftop',
  '    "天台上没有别人。"',
  '    return',
  '',
].join('\n')

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

/** 假上游:照实测协议 —— 提交回任务,轮询若干次后 SUCCESS,再给一张图。 */
class FakeAsyncUpstream {
  #server: Server | null = null
  /** 轮询几次后才成功(1 = 第二次轮询就成功)。 */
  succeedAfterPolls = 1
  /** 永不成功(测超时)。 */
  neverSucceeds = false
  /** 直接失败并给原因(测 fail_reason)。 */
  failWith: string | null = null
  /** 结果图 URL 用 404(测"取图失败如实报")。 */
  breakImage = false
  taskId = 'task_TEST123'
  polls = 0
  submits = 0
  submitsBody: Record<string, unknown> | null = null
  submitPath = ''
  /** **提交那一次**的认证头(轮询/取图会覆盖,故只在 POST 里记)。 */
  submitAuth: string | undefined

  async start(): Promise<string> {
    this.#server = createServer((req: IncomingMessage, res: ServerResponse) => { void this.#handle(req, res) })
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve))
    const address = this.#server!.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    this.#origin = `http://127.0.0.1:${port}`
    this.baseUrl = `${this.#origin}/v1`
    return this.baseUrl
  }

  #origin = ''
  /** 启动时拿到的基址(测试里错配渠道要用它,别自己拼端口)。 */
  baseUrl = ''

  async stop(): Promise<void> {
    if (this.#server === null) return
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()))
    this.#server = null
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const url = req.url ?? ''

    // 结果图(公开 URL,不带 /v1 前缀)
    if (url === '/result.png') {
      if (this.breakImage) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }

    if (req.method === 'POST') {
      // 真上游**只认它自己的路径**:别的路径就是 404(`/images/generations` 复数正是这样被拒的)。
      if (!url.startsWith('/v1/image/generations')) {
        json(404, { error: { message: `Invalid URL (POST ${url})`, type: 'invalid_request_error' } })
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      try { this.submitsBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { this.submitsBody = null }
      this.submits += 1
      this.submitPath = url
      this.submitAuth = req.headers.authorization
      // 实测形状:提交只回任务,不回图片。
      json(200, { created_at: 1, id: this.taskId, model: 'fake', status: 'queued', task_id: this.taskId })
      return
    }

    // 轮询
    this.polls += 1
    if (this.failWith !== null) {      json(200, { code: 'success', data: { task_id: this.taskId, status: 'FAILURE', fail_reason: this.failWith, progress: '100%' } })
      return
    }
    if (this.neverSucceeds || this.polls < this.succeedAfterPolls) {
      json(200, { code: 'success', data: { task_id: this.taskId, status: 'QUEUED', progress: '10%' } })
      return
    }
    json(200, {
      code: 'success',
      data: {
        task_id: this.taskId,
        status: 'SUCCESS',
        progress: '100%',
        result_url: `${this.#origin}/result.png`,
        data: { content: { image_url: `${this.#origin}/result.png` } },
      },
    })
  }
}

/** 模型目录声明:异步任务制 + 单数路径 + 快轮询(生产是 3s)。 */
function asyncModel() {
  return {
    id: 'zhenzhen-image-g-v2.5-flare',
    adapter: 'async-task' as const,
    capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: false, urlResult: true },
    paths: { submit: '/image/generations' },
    async: { submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 0, pollMaxAttempts: 5 },
  }
}

describe('异步任务制适配器(T14 续)', () => {
  let dataDir: string
  let sdkDir: string
  let projectsRoot: string
  let service: ProjectService
  let upstream: FakeAsyncUpstream
  let root: string

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-async-data-')
    projectsRoot = await makeTempDir('galfree-async-projects-')
    upstream = new FakeAsyncUpstream()
    const baseUrl = await upstream.start()

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: { http: createNodeHttpClient(), channel: () => ({ baseUrl, apiKey: 'sk-async', models: [asyncModel()] }) },
    })
    const project = await service.createProject({ projectsRoot, name: 'async', title: '异步' })
    root = project.root
    const snap = await service.readProjectFile('async', 'game/script.rpy')
    await service.writeProjectFiles('async', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
  })

  afterEach(async () => {
    await service.dispose()
    await upstream.stop()
    await cleanupTempDirs()
  })

  it('提交 → 轮询到终态 → 取图落盘,板转已填(整条链路走通)', async () => {
    const task = await service.createGenerationTask('async', { slot: 'bg rooftop', model: asyncModel().id, prompt: '雨中的天台', run: true })

    expect(task.state).toBe('awaiting-review')
    expect(task.attempts).toHaveLength(1)
    expect(task.attempts[0]!.outcome).toBe('ok')

    // 提交走的是**单数**路径(实测如此),prompt 与 model 都在。
    expect(upstream.submitPath).toBe('/v1/image/generations')
    expect(upstream.submitsBody?.model).toBe(asyncModel().id)
    expect(upstream.submitsBody?.prompt).toBe('雨中的天台')
    // 轮询确实发生了(假上游这一次在第一次轮询就返回 SUCCESS)。
    expect(upstream.polls).toBeGreaterThanOrEqual(1)
    // 密钥发到了上游。
    expect(upstream.submitAuth).toBe('Bearer sk-async')

    // 磁盘终态:结果图被下载并落盘,字节一致。
    const onDisk = await readFile(join(root, ...slotAssetPath('bg rooftop').split('/')))
    expect(Buffer.compare(onDisk, PNG_BYTES)).toBe(0)

    const progress = await service.progress('async')
    expect(progress.slots.find((slot) => slot.slot === 'bg rooftop')?.filled).toBe(true)
    expect(progress.slots.find((slot) => slot.slot === 'bg rooftop')?.awaitingReview).toBe(true)
  })

  it('上游明说失败:fail_reason 进任务历史(不吞成"失败了")', async () => {
    upstream.failWith = '内容审核未通过'
    const task = await service.createGenerationTask('async', { slot: 'bg rooftop', model: asyncModel().id, prompt: 'x', run: true })

    expect(task.state).toBe('failed')
    expect(task.lastError).toContain('内容审核未通过')
    // 失败不产半成品。
    const progress = await service.progress('async')
    expect(progress.slots.find((slot) => slot.slot === 'bg rooftop')?.filled).toBe(false)
  })

  it('轮询到上限还没终态:如实说"没在时限内",并附最后一次状态', async () => {
    upstream.neverSucceeds = true
    const task = await service.createGenerationTask('async', { slot: 'bg rooftop', model: asyncModel().id, prompt: 'x', run: true })

    expect(task.state).toBe('failed')
    expect(task.lastError).toContain('没在时限内')
    expect(task.lastError).toContain('QUEUED')
    // 轮询次数正好用满声明里的上限(5)。
    expect(upstream.polls).toBe(5)
  })

  it('终态给了地址但图取不到:也算失败并说清(不落空文件)', async () => {
    upstream.breakImage = true
    const task = await service.createGenerationTask('async', { slot: 'bg rooftop', model: asyncModel().id, prompt: 'x', run: true })

    expect(task.state).toBe('failed')
    expect(task.lastError).toContain('取图失败')
    const progress = await service.progress('async')
    expect(progress.slots.find((slot) => slot.slot === 'bg rooftop')?.filled).toBe(false)
  })

  it('同步适配器遇到异步上游:如实拒绝并**指向 async-task**(不猜协议)', async () => {
    // 同一个假上游(异步任务制)挂到 openai-compatible 适配器上:它拿到的是任务 JSON,
    // 不是图片 —— 适配器必须如实说不匹配,并指出该换成哪个协议。
    const misconfigured = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: createNodeHttpClient(),
        channel: () => ({
          baseUrl: upstream.baseUrl,
          models: [{ id: 'm', adapter: 'openai-compatible' as const, capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true } }],
        }),
      },
    })
    try {
      await misconfigured.createProject({ projectsRoot, name: 'mismatch', title: '错配' })
      const snap = await misconfigured.readProjectFile('mismatch', 'game/script.rpy')
      await misconfigured.writeProjectFiles('mismatch', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
      const task = await misconfigured.createGenerationTask('mismatch', { slot: 'bg rooftop', model: 'm', prompt: 'x', run: true })
      expect(task.state).toBe('failed')
      // 错误里要**指向正确的适配器**,而不是一句"失败了"。
      expect(task.lastError).toContain('async-task')
    } finally {
      await misconfigured.dispose()
    }
  })

  it('同步适配器撞上 404:错误信息直接提示"提交路径可能是单数 / 该换 async-task"', async () => {
    // 假上游只认单数路径 → 复数路径 404(这正是用户实际遇到的那个 404)。
    const misconfigured = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      images: {
        http: createNodeHttpClient(),
        channel: () => ({
          baseUrl: upstream.baseUrl,
          // 把 paths.submit 指到复数(OpenAI 口径),但假上游只认单数 → 404
          models: [{
            id: 'm', adapter: 'openai-compatible' as const,
            capabilities: { textToImage: true, imageToImage: false, referenceChain: false, aspectRatioParam: true, b64Json: true },
            paths: { submit: '/nope/generations' },
          }],
        }),
      },
    })
    try {
      await misconfigured.createProject({ projectsRoot, name: 'notfound', title: '404' })
      const snap = await misconfigured.readProjectFile('notfound', 'game/script.rpy')
      await misconfigured.writeProjectFiles('notfound', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
      const task = await misconfigured.createGenerationTask('notfound', { slot: 'bg rooftop', model: 'm', prompt: 'x', run: true })
      expect(task.state).toBe('failed')
      expect(task.lastError).toContain('404')
      expect(task.lastError).toContain('async-task')
    } finally {
      await misconfigured.dispose()
    }
  })

  it('格式判定:content-type 与扩展名都认,判不出按 png', () => {
    expect(imageFormatOf('image/png', 'https://x/y')).toBe('png')
    expect(imageFormatOf('image/jpeg', 'https://x/y')).toBe('jpg')
    expect(imageFormatOf('image/webp', 'https://x/y')).toBe('webp')
    expect(imageFormatOf('', 'https://x/y.webp?token=1')).toBe('webp')
    expect(imageFormatOf('', 'https://x/y.jpeg')).toBe('jpg')
    expect(imageFormatOf('', 'https://x/noext')).toBe('png')
  })
})
