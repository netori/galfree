/**
 * 渠道自动化的 seam 测试(T14 续)。
 *
 * 契约来源:用户要求的"几乎全自动" —— **只填 URL 与密钥 → 拉模型 → 选模型**。
 *  1. 拉取走注入的出网端口,打到**本地假上游**(真 HTTP);
 *  2. 已知家族自动识别能力(**标为确定**);不认识的保守默认(**标为待确认**);
 *  3. 非图像模型**不隐藏**(排后面),人仍能手选;
 *  4. 失败如实报,带上游原话(401/404 一眼看出是密钥还是端点的问题)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  catalogJsonToModels, discoverModels, inferCapabilities, modelsToCatalogJson, normalizeBaseUrl,
} from './discovery.ts'
import { createNodeHttpClient } from './images.ts'

/** 假上游:只实现 /models(以及可选的失败模式)。 */
class FakeModelsUpstream {
  #server: Server | null = null
  port = 0
  ids: Array<{ id: string }> = []
  status = 200
  body = ''
  /** 收到的 Authorization 头(断言密钥确实发出去了)。 */
  seenAuth: string | undefined

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
    this.seenAuth = req.headers.authorization
    res.writeHead(this.status, { 'content-type': 'application/json' })
    res.end(this.status === 200 ? JSON.stringify({ object: 'list', data: this.ids }) : (this.body === '' ? JSON.stringify({ error: { message: '假的失败' } }) : this.body))
  }
}

describe('渠道自动化:拉模型 + 推能力(T14 续)', () => {
  let upstream: FakeModelsUpstream
  let baseUrl: string

  beforeEach(async () => {
    upstream = new FakeModelsUpstream()
    baseUrl = await upstream.start()
  })

  afterEach(async () => {
    await upstream.stop()
  })

  it('只给 URL 与密钥 → 拉到模型清单,并把图像模型排在前面', async () => {
    upstream.ids = [
      { id: 'text-embedding-3-large' },
      { id: 'gpt-image-1' },
      { id: 'deepseek-chat' },
      { id: 'flux-1.1-pro' },
    ]
    const result = await discoverModels(createNodeHttpClient(), { baseUrl, apiKey: 'sk-test' })

    expect(result.total).toBe(4)
    // 图像模型在前,非图像的在后(但**都在**,不隐藏)。
    expect(result.models.map((model) => model.id)).toEqual(['gpt-image-1', 'flux-1.1-pro', 'text-embedding-3-large', 'deepseek-chat'])
    expect(result.models.filter((model) => model.imageLikely).map((model) => model.id)).toEqual(['gpt-image-1', 'flux-1.1-pro'])
    // 密钥确实发到了上游(Authorization: Bearer)。
    expect(upstream.seenAuth).toBe('Bearer sk-test')
  })

  it('已知家族按已知给能力,并标为"确定"', () => {
    const gptImage = inferCapabilities('gpt-image-1')
    expect(gptImage.needsConfirmation).toBe(false)
    expect(gptImage.family).toBe('gpt-image')
    expect(gptImage.capabilities).toMatchObject({ textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true })

    // DALL·E:不支持多图参考链 —— 不能跟着 gpt-image 一起"全开"。
    const dalle = inferCapabilities('dall-e-3')
    expect(dalle.capabilities.referenceChain).toBe(false)
    expect(dalle.capabilities.imageToImage).toBe(true)
  })

  it('不认识的模型:保守默认(只文生图)并标为"待确认"', () => {
    const unknown = inferCapabilities('acme-mystery-diffusion-9000')
    expect(unknown.needsConfirmation).toBe(true)
    expect(unknown.family).toBeUndefined()
    expect(unknown.capabilities).toMatchObject({
      textToImage: true, aspectRatioParam: true, b64Json: true,
      // 没验过的能力一律不开:开了就会发出上游看不懂的请求。
      imageToImage: false, referenceChain: false,
    })
    // 默认也要有话说(面板直接显示给人看)。
    expect(unknown.basis).toContain('保守')
  })

  it('能力的字段是**全量**的(写进设置文档时不会缺字段)', () => {
    const caps = inferCapabilities('whatever-model').capabilities
    expect(Object.keys(caps).sort()).toEqual(['aspectRatioParam', 'b64Json', 'imageToImage', 'referenceChain', 'textToImage'])
  })

  it('失败如实报:401 带上游原话(一眼看出是密钥问题)', async () => {
    upstream.status = 401
    upstream.body = JSON.stringify({ error: { message: 'invalid api key' } })
    await expect(discoverModels(createNodeHttpClient(), { baseUrl, apiKey: 'wrong' }))
      .rejects.toThrow(/401.*invalid api key/s)
  })

  it('失败如实报:端点不是 OpenAI 兼容形状时点明(而不是"拉取失败")', async () => {
    upstream.status = 200
    const http = {
      send: async () => ({ status: 200, text: '{"models":[]}' }),
      download: async () => ({ status: 200, bytes: new Uint8Array(), contentType: '' }),
    }
    await expect(discoverModels(http, { baseUrl }))
      .rejects.toThrow(/没有 data 数组/)
  })

  it('基址规范化:末尾斜杠不影响;选中的模型编成设置项要的 JSON', () => {
    expect(normalizeBaseUrl('  https://api.example.com/v1/  ')).toBe('https://api.example.com/v1')

    const json = modelsToCatalogJson([
      { id: 'gpt-image-1', label: '全能力', capabilities: inferCapabilities('gpt-image-1').capabilities },
      { id: 'acme-mystery', capabilities: inferCapabilities('acme-mystery').capabilities },
    ])
    const parsed = JSON.parse(json) as Array<{ id: string; capabilities: Record<string, boolean> }>
    expect(parsed.map((model) => model.id)).toEqual(['gpt-image-1', 'acme-mystery'])
    expect(parsed[0]!.capabilities.referenceChain).toBe(true)
    expect(parsed[1]!.capabilities.referenceChain).toBe(false)

    // 编出来的 JSON 能原样解回去(面板下次打开还能编辑)。
    expect(catalogJsonToModels(json).map((model) => model.id)).toEqual(['gpt-image-1', 'acme-mystery'])
    expect(catalogJsonToModels('{坏 JSON')).toEqual([])
  })
})
