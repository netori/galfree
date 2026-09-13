/**
 * T34 守卫 —— **资源式 REST 的异步任务**适配器(`async-task-rest`)。
 *
 * 协议事实全部抄自服务商文档的 `suno-generation` 那一页(发起人 2026-09-13 给的截图),
 * **不是猜的** —— 所以这里逐条对着文档断言:
 *
 *  - 提交:`POST {base}/music/generations`,体 `{model:"suno", custom:false, version:"v6", prompt, instrumental, audio_format}`
 *  - 轮询:`GET {base}/music/tasks/{id}` —— **id 在路径里**(与 sunoapi 那套最要紧的差别)
 *  - 完成:`{code:200, data:{status:"completed", …}}`
 *  - 路径/模型/版本/格式都可在模型目录的 `note` 里覆盖(ADR-0012:端点可填,不写死厂商)
 *
 * 另外两条**如实标注的不确定**(文档那一页被截断):提交响应里任务 id 的字段名、
 * 完成响应里音频地址的字段名 —— 取不到必须**贴原话**,不许假装成功、不许写空文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { clearAudioAdapters, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'
import {
  buildMusicRestSubmitBody, createMusicRestAdapter, findAudioUrl,
  musicRestPathsFromNote, readMusicRestPoll, readMusicRestSubmit,
} from './audio-adapter-music-rest.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

describe('资源式 REST 异步适配器(T34)', () => {
  it('提交体逐字段对着文档:`model` + `version` + `custom:false` + `audio_format`', () => {
    const body = buildMusicRestSubmitBody({
      prompt: '雨前的教室,钢琴与弦乐',
      instrumental: true,
      model: 'suno',
      version: 'v6',
      format: 'mp3',
    })
    // 文档的调用示例字段名:`model` / `custom` / `version` / `prompt`;参数表另有 `instrumental` / `audio_format`。
    expect(body).toEqual({
      model: 'suno',
      custom: false,
      version: 'v6',
      prompt: '雨前的教室,钢琴与弦乐',
      instrumental: true,
      audio_format: 'mp3',
    })
    // **不是** sunoapi 那套的 `customMode` / `callBackUrl`。
    expect(body).not.toHaveProperty('customMode')
    expect(body).not.toHaveProperty('callBackUrl')
  })

  it('路径与版本可在 `note` 里覆盖(端点可填,不写死厂商)', () => {
    const paths = musicRestPathsFromNote('submit=/v1/music/generations;poll=/v1/music/tasks/{id};model=suno;version=v6-5;format=wav')
    expect(paths).toEqual({
      submit: '/v1/music/generations',
      poll: '/v1/music/tasks/{id}',
      model: 'suno',
      version: 'v6-5',
      format: 'wav',
    })
    // 不给 note 时是文档里的缺省。
    expect(musicRestPathsFromNote(undefined)).toEqual({
      submit: '/music/generations',
      poll: '/music/tasks/{id}',
      model: 'suno',
      version: 'v6',
      format: 'mp3',
    })
  })

  it('提交响应:认得出任务 id 就成;认不出**贴原话**(不猜一个空 id)', () => {
    expect(readMusicRestSubmit(JSON.stringify({ code: 200, data: { id: 'task-1' } })))
      .toEqual({ ok: true, taskId: 'task-1' })
    expect(readMusicRestSubmit(JSON.stringify({ code: 200, data: { task_id: 'task-2' } })))
      .toEqual({ ok: true, taskId: 'task-2' })
    expect(readMusicRestSubmit(JSON.stringify({ code: 200, data: { taskId: 'task-3' } })))
      .toEqual({ ok: true, taskId: 'task-3' })
    // 上游拒绝:带上它的 code 与原话。
    expect(readMusicRestSubmit(JSON.stringify({ code: 429, msg: '积分不足' })))
      .toMatchObject({ ok: false, error: expect.stringContaining('积分不足') as unknown as string })
    const noId = readMusicRestSubmit(JSON.stringify({ code: 200, data: { status: 'queued' } }))
    expect(noId.ok).toBe(false)
    expect(noId.ok === false && noId.error).toMatch(/却没给任务 id/)
    expect(noId.ok === false && noId.error).toMatch(/queued/)
  })

  it('轮询:completed + 找得到音频 → done;failed / 中间态各有去处', () => {
    const done = readMusicRestPoll(JSON.stringify({
      code: 200,
      data: { status: 'completed', audio_url: 'https://cdn.example/a.mp3', usage: { amount: 8.75, currency: 'CNY' } },
    }))
    expect(done).toEqual({ kind: 'done', audioUrl: 'https://cdn.example/a.mp3' })

    // 变体数组(一次请求出多个)只取第一个 —— 与 suno 那条同一取舍。
    expect(readMusicRestPoll(JSON.stringify({
      code: 200,
      data: { status: 'completed', items: [{ url: 'https://cdn.example/1.mp3' }, { url: 'https://cdn.example/2.mp3' }] },
    }))).toEqual({ kind: 'done', audioUrl: 'https://cdn.example/1.mp3' })

    expect(readMusicRestPoll(JSON.stringify({ code: 200, data: { status: 'pending' } })))
      .toEqual({ kind: 'running', note: 'pending' })
    expect(readMusicRestPoll(JSON.stringify({ code: 200, data: { status: 'failed', error: '敏感词' } })))
      .toMatchObject({ kind: 'failed', error: expect.stringContaining('敏感词') as unknown as string })
  })

  it('说 completed 却找不到音频地址 → **贴原话**(不假装成功,也不写空文件)', () => {
    const step = readMusicRestPoll(JSON.stringify({ code: 200, data: { status: 'completed', usage: { amount: 8.75 } } }))
    expect(step.kind).toBe('failed')
    expect(step.kind === 'failed' && step.error).toMatch(/找不到音频地址/)
    // 原话要在里面(改解析的人照着它改)。
    expect(step.kind === 'failed' && step.error).toContain('"amount":8.75')
  })

  it('找音频地址:名字优先于位置(http(s) 链接 / 音频扩展名)', () => {
    expect(findAudioUrl({ data: { audio_url: 'https://x/a.mp3' } })).toBe('https://x/a.mp3')
    expect(findAudioUrl({ data: { output: { url: 'https://x/b.wav' } } })).toBe('https://x/b.wav')
    expect(findAudioUrl({ data: { note: 'no url here' } })).toBeNull()
    // 没有名字线索时,退而认"像音频的链接"。
    expect(findAudioUrl({ data: { something: 'https://x/c.m4a' } })).toBe('https://x/c.m4a')
  })
})

describe('资源式 REST 适配器:端到端(注入假上游)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let sent: Array<{ url: string; method: string; body: string }>
  let downloaded: string[]

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t34-data-')
    projectsRoot = await makeTempDir('galfree-t34-projects-')
    sent = []
    downloaded = []
    clearAudioAdapters()
    registerAudioAdapter(createMusicRestAdapter())
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          send: async (request: AudioHttpRequest) => {
            sent.push({ url: request.url, method: request.method, body: request.body })
            // 轮询:路径里带 id(`/music/tasks/t-9`)。
            if (request.url.includes('/music/tasks/')) {
              return {
                status: 200,
                text: JSON.stringify({ code: 200, data: { status: 'completed', audio_url: 'https://cdn.example/rain.mp3' } }),
              }
            }
            return { status: 200, text: JSON.stringify({ code: 200, data: { id: 't-9' } }) }
          },
          download: async (url: string) => {
            downloaded.push(url)
            return { status: 200, bytes: new TextEncoder().encode('MP3-bytes'), contentType: 'audio/mpeg' }
          },
        },
        channel: (purpose) => purpose === 'music'
          ? {
              name: 'seedance-music',
              baseUrl: 'https://api.seedance.nz/v1',
              apiKey: 'sk-test',
              models: [{
                id: 'suno-generation', purpose: 'music', adapter: 'async-task-rest',
                capabilities: {
                  textToMusic: true, instrumental: true, lyrics: false, audioReference: false,
                  textToSpeech: false, voiceCloning: false, voiceId: false, urlResult: true,
                },
              }],
            }
          : null,
      },
    })
    await service.createProject({ projectsRoot, name: 'rest', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  it('建任务 → 跑:提交到文档那条路径、轮询把 id 放在路径里、产物经网关落盘', async () => {
    const task = await service.createAudioTask('rest', {
      outputPath: 'game/audio/bgm/rain_theme.ogg',
      model: 'suno-generation',
      prompt: '雨前的教室,钢琴与弦乐,慢速',
      run: true,
    })
    expect(task.state).toBe('awaiting-review')

    // 提交:文档那条路径 + 那种体。
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.url).toBe('https://api.seedance.nz/v1/music/generations')
    expect(JSON.parse(sent[0]!.body)).toEqual({
      model: 'suno',
      custom: false,
      version: 'v6',
      prompt: '雨前的教室,钢琴与弦乐,慢速',
      instrumental: true,
      audio_format: 'mp3',
    })
    // 轮询:**id 在路径里**(如果这条断言变成 `?taskId=`,说明又拿 sunoapi 的形状发错了)。
    expect(sent[1]!.method).toBe('GET')
    expect(sent[1]!.url).toBe('https://api.seedance.nz/v1/music/tasks/t-9')
    expect(downloaded).toEqual(['https://cdn.example/rain.mp3'])

    const pool = await service.audioPool('rest')
    expect(pool.files.map((file) => file.path)).toEqual(['audio/bgm/rain_theme.ogg'])
  })

  it('未注册的协议如实拒绝(注册是显式的,不做隐式兜底)', async () => {
    clearAudioAdapters()
    const task = await service.createAudioTask('rest', {
      outputPath: 'game/audio/bgm/x.ogg', model: 'suno-generation', prompt: 'x', run: true,
    })
    expect(task.state).toBe('failed')
    expect(task.lastError).toMatch(/适配器还没实现/)
  })
})
