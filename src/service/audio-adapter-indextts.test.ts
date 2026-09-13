/**
 * T29 守卫 —— IndexTTS 本地服务的适配器(契约从 `app_api.py` 读出,不是猜的)。
 *
 * 用一个**照契约回话的假上游**验三件:
 *  1. 请求形状对不对(`POST /tts`、必传三项、`return_type: json`);
 *  2. 它回的那个**服务端路径**真的被读成产物字节(同机部署的那条路);
 *  3. 上游拒绝 / 说 ok 却没给 path / 路径读不到 —— **三种都如实报**,不静默成"成功了但没声音"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { registerAudioAdapter, clearAudioAdapters, type AudioHttpRequest } from './audio-generation.ts'
import { createIndexttsAdapter } from './audio-adapter-indextts.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

/** 假上游:照 `app_api.py` 的契约回话(`_do_and_respond` 的 json 分支)。 */
function fakeIndextts(options: {
  /** 产物写到哪(不写 = 回一个不存在的路径,验"读不到要如实报")。 */
  wavPath?: string
  status?: number
  body?: string
}): { server: Server; requests: Array<{ url: string; method: string; body: string }>; url: () => string } {
  const requests: Array<{ url: string; method: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', method: req.method ?? '', body })
      if (options.status !== undefined && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' })
        res.end(options.body ?? JSON.stringify({ detail: '合成失败:测试夹具' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(options.body ?? JSON.stringify({
        ok: true,
        sampling_rate: 22050,
        segments: 1,
        path: options.wavPath ?? join(process.env.TEMP ?? '.', 'definitely-not-here.wav'),
        filename: 'out.wav',
      }))
    })
  })
  return { server, requests, url: () => {
    const address = server.address()
    return typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
  } }
}

describe('IndexTTS 适配器(T29)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let dropDir: string
  let upstream: ReturnType<typeof fakeIndextts>

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t29i-data-')
    projectsRoot = await makeTempDir('galfree-t29i-projects-')
    dropDir = await makeTempDir('galfree-t29i-wav-')
  })

  afterEach(async () => {
    await service.dispose()
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  /** 造一个"服务端已生成好的 wav"并起假上游;返回服务。 */
  async function setup(options: Parameters<typeof fakeIndextts>[0] = {}): Promise<void> {
    upstream = fakeIndextts(options)
    await new Promise<void>((resolve) => upstream.server.listen(0, '127.0.0.1', resolve))
    registerAudioAdapter(createIndexttsAdapter())
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        // 真出网(打到假上游上)。
        http: {
          send: async (request: AudioHttpRequest) => {
            const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body })
            return { status: response.status, text: await response.text() }
          },
        },
        channel: () => ({
          name: 'indextts-local',
          baseUrl: upstream.url(),
          models: [{
            id: 'indextts-2.5',
            purpose: 'voice',
            adapter: 'sync-http',
            // 说话人与参考音频写在这里(IndexTTS 必传的两项)。
            note: 'speaker=default;audio=xiao_tang.wav;lang=ZH',
            capabilities: {
              textToMusic: false, instrumental: false, lyrics: false, audioReference: true,
              textToSpeech: true, voiceCloning: true, voiceId: true,
            },
          }],
        }),
      },
    })
    await service.createProject({ projectsRoot, name: 'tts', title: undefined })
  }

  it('请求形状:POST /tts、必传三项齐、`return_type: json`;产物被读成字节并经网关落盘', async () => {
    const wav = join(dropDir, 'out.wav')
    await mkdir(dropDir, { recursive: true })
    await writeFile(wav, Buffer.from('RIFF-fake-wav-bytes'))
    await setup({ wavPath: wav })

    const task = await service.createAudioTask('tts', {
      outputPath: 'game/voice/scene_one_0000.wav',
      model: 'indextts-2.5',
      prompt: '第一句,要念的台词。',
      dialogueId: 'scene_one_0000',
    })
    const run = await service.runAudioTask('tts', task.id)
    expect(run).toMatchObject({ state: 'awaiting-review' })
    expect(run!.attempts[0]).toMatchObject({ outcome: 'ok', bytes: 'RIFF-fake-wav-bytes'.length })

    // 请求形状(照 `app_api.py` 的契约)。
    expect(upstream.requests).toHaveLength(1)
    const sent = upstream.requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe('/tts')
    expect(JSON.parse(sent.body)).toMatchObject({
      speaker: 'default', audio: 'xiao_tang.wav', text: '第一句,要念的台词。', lang: 'ZH', return_type: 'json',
    })

    // 产物真落进项目,池里立刻有它。
    const pool = await service.audioPool('tts')
    expect(pool.files.map((file) => file.path)).toEqual(['voice/scene_one_0000.wav'])
  })

  it('`voiceId` 能覆盖模型目录里的说话人(按角色给不同的嗓子)', async () => {
    const wav = join(dropDir, 'out.wav')
    await mkdir(dropDir, { recursive: true })
    await writeFile(wav, Buffer.from('RIFF'))
    await setup({ wavPath: wav })
    const task = await service.createAudioTask('tts', {
      outputPath: 'game/voice/x.wav', model: 'indextts-2.5', prompt: '台词', voiceId: 'xiao_tang_speaker',
    })
    await service.runAudioTask('tts', task.id)
    expect(JSON.parse(upstream.requests[0]!.body).speaker).toBe('xiao_tang_speaker')
  })

  it('上游拒绝(400/500)→ **原话**进历史(不吞成"失败了")', async () => {
    await setup({ status: 500, body: JSON.stringify({ detail: '合成失败:显存不够' }) })
    const task = await service.createAudioTask('tts', {
      outputPath: 'game/voice/y.wav', model: 'indextts-2.5', prompt: '台词',
    })
    const run = await service.runAudioTask('tts', task.id)
    expect(run!.state).toBe('failed')
    expect(run!.lastError).toContain('显存不够')
    // 而且没产生产物(不写一个空文件糊过去)。
    expect((await service.audioPool('tts')).files).toEqual([])
  })

  it('说 ok 却没给 path → 如实报(不把"没有产物"记成成功)', async () => {
    await setup({ body: JSON.stringify({ ok: true, sampling_rate: 22050 }) })
    const task = await service.createAudioTask('tts', {
      outputPath: 'game/voice/z.wav', model: 'indextts-2.5', prompt: '台词',
    })
    const run = await service.runAudioTask('tts', task.id)
    expect(run!.state).toBe('failed')
    expect(run!.lastError).toMatch(/却没给 path/)
  })

  it('服务端路径读不到(跨机部署)→ 明说"要求同机",并指向批量清单那条路', async () => {
    await setup({ wavPath: join(dropDir, 'never-written.wav') })
    const task = await service.createAudioTask('tts', {
      outputPath: 'game/voice/w.wav', model: 'indextts-2.5', prompt: '台词',
    })
    const run = await service.runAudioTask('tts', task.id)
    expect(run!.state).toBe('failed')
    expect(run!.lastError).toMatch(/同一台机器/)
    expect(run!.lastError).toMatch(/批量清单/)
  })

  it('缺参考音频 → **建任务那一步就如实拒绝**(不拿空字符串去撞上游 400)', async () => {
    await setup({})
    service = createProjectService({
      dataDir: dataDir + '-2',
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: { send: async () => ({ status: 200, text: '{}' }) },
        channel: () => ({
          name: 'indextts-local',
          baseUrl: upstream.url(),
          models: [{
            id: 'indextts-2.5', purpose: 'voice', adapter: 'sync-http',
            // **没写 audio**:这个模型不知道用谁的声音。
            capabilities: {
              textToMusic: false, instrumental: false, lyrics: false, audioReference: true,
              textToSpeech: true, voiceCloning: true, voiceId: true,
            },
          }],
        }),
      },
    })
    await service.createProject({ projectsRoot, name: 'tts2', title: undefined })
    const task = await service.createAudioTask('tts2', {
      outputPath: 'game/voice/n.wav', model: 'indextts-2.5', prompt: '台词',
    })
    const run = await service.runAudioTask('tts2', task.id)
    expect(run!.state).toBe('failed')
    expect(run!.lastError).toMatch(/参考音频/)
  })
})
