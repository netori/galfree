/**
 * 慢带:**参考链在真上游上到底成不成** —— T14 起一直欠着的那条"真适配器"验证。
 *
 * 为什么它必须存在:模型目录里的 `referenceChain: true` 是**人写的声明**,而
 * "能力声明是降级的唯一依据"这条契约,一直靠这个从未被真模型验过的声明在跑。
 * 这条慢带把声明拿到真上游面前对一次。
 *
 * 它**不谎报结论**,只断言能断言的三件事:
 *  1. **链真的发出去了**:出网被一个记录型客户端包着,请求体里能看到内联的字节
 *     (`data:image/png;base64,…`)—— 这条与上游支不支持无关,是我们自己的形状;
 *  2. **文生图基线真的通**:主视觉那一张要么落盘(真 PNG 字节)、要么带着上游原话失败 ——
 *     端点、密钥、模型三样有一样不对,这里就红;
 *  3. **结论如实**:任务状态与磁盘事实必须一致(`awaiting-review` ⟺ 文件在;
 *     `failed` ⟹ 失败原因非空且是上游说的);链被接受还是被拒,原样打印出来。
 *
 * **它花钱**:每次跑都会真出 2 张图(用户的额度)。
 * 因此默认**不跑**,要显式给三样环境变量才生效:
 *
 * ```
 * $env:GALFREE_LIVE_BASE_URL = "https://api.seedance.nz/v1"
 * $env:GALFREE_LIVE_API_KEY  = "<密钥>"
 * $env:GALFREE_LIVE_MODEL    = "zhenzhen-image-g-v2.5-flare"
 * $env:GALFREE_LIVE_ADAPTER  = "async-task"   # 可选,默认 openai-compatible
 * npm run test:slow -- src/service/live-chain.slow.test.ts
 * ```
 *
 * 没给环境变量时它**跳过并出声**(打印怎么跑),不是静默通过 ——
 * 一条"悄悄不跑"的守卫等于没有守卫。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { createNodeHttpClient, type HttpRequest, type ImageChannelSettings } from './images.ts'
import { slotAssetPath } from './slot-naming.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const BASE_URL = process.env.GALFREE_LIVE_BASE_URL ?? ''
const API_KEY = process.env.GALFREE_LIVE_API_KEY ?? ''
const MODEL = process.env.GALFREE_LIVE_MODEL ?? ''
const ADAPTER = process.env.GALFREE_LIVE_ADAPTER ?? 'openai-compatible'

const LIVE = BASE_URL !== '' && API_KEY !== '' && MODEL !== ''
if (!LIVE) {
  console.warn([
    '',
    '⚠ 参考链真上游验证**没有跑**(缺环境变量) —— 这条守卫验的是"声明的能力在真上游上成不成立",',
    '  没跑就等于没验。要跑:给 GALFREE_LIVE_BASE_URL / GALFREE_LIVE_API_KEY / GALFREE_LIVE_MODEL',
    '  (可选 GALFREE_LIVE_ADAPTER=async-task),然后 `npm run test:slow -- src/service/live-chain.slow.test.ts`。',
    '  ⚠ 它会真出图,消耗上游额度。',
    '',
  ].join('\n'))
}

/** 出网记录器:包住生产客户端,原样转发,同时把请求抄下来(不改协议形状)。 */
function recordingClient(): { client: ReturnType<typeof createNodeHttpClient>; requests: HttpRequest[] } {
  const inner = createNodeHttpClient()
  const requests: HttpRequest[] = []
  return {
    requests,
    client: {
      send: async (request) => {
        requests.push(request)
        return await inner.send(request)
      },
      download: inner.download,
    },
  }
}

const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    show xiao_tang base',
  '    xiao_tang "你来啦。"',
  '    show xiao_tang smile',
  '    xiao_tang "今天天气不错。"',
  '    return',
  '',
].join('\n')

/** PNG 魔数:产物必须真是图片,不是一段 JSON/错误页被当成图片存下来。 */
function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

/** 建项目要从真 SDK 拷界面模板(与别的慢带同一口径)。 */
function sdkDirFor(): string {
  const fromEnv = process.env.GALFREE_SDK_DIR
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-galfree', 'sdk')
}

describe.skipIf(!LIVE)('参考链真上游验证(慢带,真模型,花钱)', () => {
  let service: ProjectService | null = null

  afterEach(async () => {
    await service?.dispose()
    service = null
    await cleanupTempDirs()
  })

  it('主视觉真出图 → 登记进链 → 差分携链真出图;上游不接受时如实报出原话', async () => {
    const base = await makeTempDir('galfree-live-chain-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const { client, requests } = recordingClient()
    const channel: ImageChannelSettings = {
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      name: 'live',
      models: [{
        id: MODEL,
        adapter: ADAPTER === 'async-task' ? 'async-task' : 'openai-compatible',
        capabilities: { textToImage: true, imageToImage: true, referenceChain: true, aspectRatioParam: true, b64Json: true },
        ...(ADAPTER === 'async-task'
          ? { paths: { submit: '/image/generations' }, async: { submitPath: '/image/generations', pollPath: '/image/generations/{taskId}', pollIntervalMs: 3000, pollMaxAttempts: 60 } }
          : {}),
      }],
    }
    service = createProjectService({
      dataDir: join(base, 'data'),
      images: { http: client, channel: () => channel },
    })

    const project = await service.createProject({ projectsRoot, name: 'live', title: '真上游', sdkDir: sdkDirFor() })
    const root = project.root
    const snap = await service.readProjectFile('live', 'game/script.rpy')
    await service.writeProjectFiles('live', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })
    await service.upsertSlot('live', { slot: 'xiao_tang base', requiresCharacters: ['xiao_tang'], prompt: '一个黑长直发少女的半身主视觉立绘,干净的动画线稿上色,白底' })
    await service.upsertSlot('live', { slot: 'xiao_tang smile', requiresCharacters: ['xiao_tang'], prompt: '同一个少女的微笑表情差分,半身,保持同一张脸与同一身衣服' })

    // ── 1) 文生图基线:主视觉 ────────────────────────────────────────────
    const baseTask = await service.createGenerationTask('live', {
      slot: 'xiao_tang base',
      model: MODEL,
      prompt: '一个黑长直发少女的半身主视觉立绘,干净的动画线稿上色,白底',
      run: true,
    })
    console.info(`[live] 主视觉:state=${baseTask.state}${baseTask.lastError === undefined ? '' : ` lastError=${baseTask.lastError}`}`)
    // 端点/密钥/模型/协议有一样不对,这里就红 —— 这条基线是后面那条链的前提。
    expect(baseTask.state, `主视觉没出成:${baseTask.lastError ?? '(无原因)'}`).toBe('awaiting-review')

    const baseBytes = await readFile(join(root, ...slotAssetPath('xiao_tang base').split('/')))
    expect(isPng(baseBytes), '产物不是 PNG —— 上游可能返回了错误页/JSON').toBe(true)
    expect(baseBytes.byteLength).toBeGreaterThan(1000)

    // ── 2) 把刚出的主视觉登记进参考链 ────────────────────────────────────
    await service.upsertCharacter('live', {
      id: 'xiao_tang',
      name: '小棠',
      voice: 'xiao_tang',
      appearance: { hair: '黑色长直发', eyes: '琥珀色' },
      styleAnchor: 'clean anime lineart, soft cel shading',
      references: [{ path: slotAssetPath('xiao_tang base'), slot: 'xiao_tang base', note: '主视觉(真上游验证)' }],
    })
    const chain = await service.referenceChain('live', 'xiao_tang smile')
    expect(chain.ready.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    expect(chain.missing).toEqual([])

    // ── 3) 差分携链出图 ─────────────────────────────────────────────────
    const before = requests.length
    const variant = await service.createGenerationTask('live', {
      slot: 'xiao_tang smile',
      model: MODEL,
      prompt: '同一个少女的微笑表情差分,半身,保持同一张脸与同一身衣服',
      run: true,
    })

    // 3a) **链真的发出去了**(与上游支不支持无关,是我们自己的形状):
    //     提交请求体里能看到内联的图片字节,而且解出来正是主视觉那张。
    const submitted = requests.slice(before).filter((request) => request.method === 'POST')
    expect(submitted.length, '差分这一次没有发出提交请求').toBeGreaterThan(0)
    const body = JSON.stringify(submitted[0]!.body ?? {})
    expect(body, '请求体里没有内联的参考图 —— 链没发出去').toContain('data:image/png;base64,')
    const inlineBase64 = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(body)?.[1] ?? ''
    expect(Buffer.from(inlineBase64, 'base64').equals(baseBytes), '发出去的参考图不是主视觉那张').toBe(true)

    // 3b) **结论如实**:状态与磁盘事实必须一致(这条与上游支不支持无关)。
    console.info(`[live] 差分(state=${variant.state}):${variant.lastError ?? '(无失败原因)'}`)
    if (variant.state === 'awaiting-review') {
      const bytes = await readFile(join(root, ...slotAssetPath('xiao_tang smile').split('/')))
      expect(isPng(bytes)).toBe(true)
      console.info('[live] 上游接受了参考链(差分已落盘,是 PNG)。')
    } else {
      expect(variant.state).toBe('failed')
      expect(variant.lastError ?? '', '失败必须带原因(上游原话),不能只说"失败了"').not.toBe('')
      console.warn([
        '',
        '⚠ 真上游**没有接受这条链**(差分出图失败)。这不是本测试的失败 —— 它正是这条慢带存在的意义:',
        `  上游原话:${variant.lastError}`,
        '  要如实报告的事实:模型目录里 `referenceChain: true` 这条声明在真上游上**未被证实**;',
        '  在此之前,"声明是降级的唯一依据"这条契约对这种模型是**未经检验**的。',
        '',
      ].join('\n'))
    }

    // 3c) 任务账本上是真的:历史里有一次尝试,且降级说明(若有)说的是实话。
    expect(variant.attempts.length).toBeGreaterThan(0)
    if (variant.degradation !== undefined) {
      console.info(`[live] 降级说明:${variant.degradation.code} —— ${variant.degradation.message}`)
      expect(variant.referenceImages, '声称降级丢了参考图,任务里却还留着它').toEqual([])
    } else {
      expect(variant.referenceImages.map((reference) => reference.path)).toEqual([slotAssetPath('xiao_tang base')])
    }
  })
})
