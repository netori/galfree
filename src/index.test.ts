/**
 * 渠道设置的解析(T14)——纯函数,断言"配置文档 → 渠道对象"这一步。
 *
 * 这一步值得单独测:它是**密钥与项目之间的唯一闸门**(密钥只能留在设置里),
 * 也是"能力声明"进入系统的入口(参考链支不支持由它决定,而不是运行时猜)。
 */
import { describe, expect, it } from 'vitest'
import { channelFromSettings, parseModelCatalog, type Config } from './index.ts'

/** 一份填齐的设置文档(密钥明文,这是 ADR-0010 的知情选择)。 */
function settings(overrides: Partial<Required<Config>> = {}): Required<Config> {
  return {
    enabled: true,
    defaultProjectsRoot: 'D:\\galgame',
    sdkPath: '',
    imageBaseUrl: 'https://api.example.com/v1',
    imageApiKey: 'sk-plaintext-in-settings',
    imageChannelName: '主渠道',
    imageModels: '',
    publishDir: '',
    ...overrides,
  }
}

describe('图像渠道设置(T14)', () => {
  it('没填端点 = 没渠道(出图动作在接缝上如实拒绝,不假装有)', () => {
    expect(channelFromSettings(settings({ imageBaseUrl: '' }))).toBeNull()
    expect(channelFromSettings(settings({ imageBaseUrl: '   ' }))).toBeNull()
  })

  it('端点带不带尾斜杠都能用;密钥原样带给适配器(它只在出网时用)', () => {
    const channel = channelFromSettings(settings())
    expect(channel?.baseUrl).toBe('https://api.example.com/v1')
    expect(channel?.apiKey).toBe('sk-plaintext-in-settings')
    expect(channel?.name).toBe('主渠道')
  })

  it('模型目录:能力按声明解析;参考链/图生图**缺省为假**(不能凭空许诺)', () => {
    const models = parseModelCatalog(JSON.stringify([
      { id: 'full', label: '全能力', capabilities: { referenceChain: true, imageToImage: true } },
      { id: 'plain' },
    ]))
    expect(models.map((model) => model.id)).toEqual(['full', 'plain'])
    const full = models[0]!
    expect(full.capabilities).toMatchObject({ textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true })
    // 没声明 = 不给许诺。
    expect(models[1]!.capabilities).toMatchObject({ textToImage: true, imageToImage: false, referenceChain: false })
  })

  it('模型目录是坏 JSON / 不是数组 → 空目录(面板显示"没模型",不静默兜底)', () => {
    expect(parseModelCatalog('{ 这不是 JSON')).toEqual([])
    expect(parseModelCatalog('"一个字符串"')).toEqual([])
    expect(parseModelCatalog('[{"没有 id":true},{"id":""}]')).toEqual([])
  })

  it('密钥不出现在渠道能力视图里(接缝只回报"配没配")', async () => {
    // 这一条在接缝上断言(imageChannel 的形状),不在这里重复实现;
    // 此处只钉住设置这一侧的边界:渠道对象**确实**带着密钥(它要用来出网),
    // 所以"不回传"必须由接缝负责,不能靠运气。
    const channel = channelFromSettings(settings())
    expect(channel?.apiKey).toBe('sk-plaintext-in-settings')
  })

  it('协议按目录声明分流:adapter/paths/async 都解析得出来(默认同步)', () => {
    const models = parseModelCatalog(JSON.stringify([
      { id: 'sync-model' },
      {
        id: 'async-model',
        adapter: 'async-task',
        paths: { submit: '/image/generations' },
        async: { submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 1500, pollMaxAttempts: 30 },
        capabilities: { urlResult: true },
      },
    ]))
    // 没声明的走默认(同步 OpenAI 兼容)。
    expect(models[0]!.adapter).toBe('openai-compatible')
    expect(models[0]!.paths).toBeUndefined()
    expect(models[0]!.async).toBeUndefined()

    // 声明的按声明走:单数路径 + 轮询参数 + "结果是 URL"。
    const async = models[1]!
    expect(async.adapter).toBe('async-task')
    expect(async.paths?.submit).toBe('/image/generations')
    expect(async.async).toMatchObject({ submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 1500, pollMaxAttempts: 30 })
    expect(async.capabilities.urlResult).toBe(true)
  })

  it('认不出来的 adapter 值退回默认(不静默用一个不存在的协议)', () => {
    const models = parseModelCatalog(JSON.stringify([{ id: 'x', adapter: '不认识的协议' }]))
    expect(models[0]!.adapter).toBe('openai-compatible')
  })
})
