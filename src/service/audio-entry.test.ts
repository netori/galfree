/**
 * T33 守卫 —— **建音频任务的入口**(音乐与语音共用一条)。
 *
 * 这一票补的是 #36/#37 之间那条缺口:适配器、队列、落盘、面板卡都通了,但**没有人能"建"一条任务**
 * (21 个 agent 工具里没有它;面板只有"跑队列/重 roll")。所以这里的守卫围绕四件事:
 *
 *  1. **真能建、真能跑**:音乐走 Suno 类异步那道(提交 → 轮询 → 下载 → 落盘),
 *     语音走本地服务那道,产物都进 `game/` 且池里立刻有它;
 *  2. **用途按路径判**(`game/voice/` 下 = 语音):同一条入口两种产物,不靠调用方声明;
 *  3. **闸门如实**:没配渠道 / 模型不在目录 / 路径形状不对 / 空提示词 —— 四种都带回**可执行**的那句话;
 *  4. **成本看得见**:建完就报"这一跑会真发几条"(音乐单次最贵,TTS 按台词行计费)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createProjectService, type ProjectService } from './project-service.ts'
import { clearAudioAdapters, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'
import { createIndexttsAdapter } from './audio-adapter-indextts.ts'
import { createSunoAdapter } from './audio-adapter-suno-register.ts'
import { registerGalfreeTools } from './tools.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  '',
  'label start:',
  '    scene bg school',
  '    xiao_tang "你来啦。"',
  '    return',
  '',
].join('\n')

interface FakeTool {
  name: string
  parameters: { required?: string[]; properties: Record<string, { type?: string }> }
  execute: (args: Record<string, unknown>) => Promise<string>
}

describe('建音频任务的入口(T33)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let tools: FakeTool[]
  let wavPath: string
  /** 假上游收到的请求(提交 / 轮询 / 下载各记各的)。 */
  let upstream: { submit: string[]; poll: string[]; downloads: string[] }

  const find = (name: string): FakeTool => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (tool === undefined) throw new Error(`工具面里没有 ${name}`)
    return tool
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t33-data-')
    projectsRoot = await makeTempDir('galfree-t33-projects-')
    const wavDir = await makeTempDir('galfree-t33-wav-')
    wavPath = join(wavDir, 'out.wav')
    await mkdir(wavDir, { recursive: true })
    await writeFile(wavPath, Buffer.from('RIFF-fake'))
    upstream = { submit: [], poll: [], downloads: [] }
    clearAudioAdapters()
    registerAudioAdapter(createSunoAdapter())
    registerAudioAdapter(createIndexttsAdapter())

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          send: async (request: AudioHttpRequest) => {
            // 语音那台(本机服务):一次 POST 拿回服务端路径。
            if (request.url.endsWith('/tts')) {
              upstream.submit.push(request.body)
              return { status: 200, text: JSON.stringify({ ok: true, path: wavPath, filename: 'out.wav' }) }
            }
            // 音乐那家(Suno 类):提交拿 taskId,轮询拿音频 URL。
            if (request.url.includes('/generate/record-info')) {
              upstream.poll.push(request.url)
              return {
                status: 200,
                text: JSON.stringify({
                  code: 200,
                  data: { status: 'SUCCESS', response: { sunoData: [{ audio_url: 'http://music.local/a.mp3', duration: 92 }] } },
                }),
              }
            }
            upstream.submit.push(request.body)
            return { status: 200, text: JSON.stringify({ code: 200, msg: 'ok', data: { taskId: 't1' } }) }
          },
          download: async (url: string) => {
            upstream.downloads.push(url)
            return { status: 200, bytes: new TextEncoder().encode('MP3-fake'), contentType: 'audio/mpeg' }
          },
        },
        // **两条渠道各一条**(ADR-0012):音乐是 Suno 类异步,语音是本机服务。
        channel: (purpose) => purpose === 'music'
          ? {
              name: 'music-aggregator',
              baseUrl: 'http://music.local',
              models: [{
                id: 'suno-generation', purpose: 'music', adapter: 'async-task',
                capabilities: {
                  textToMusic: true, instrumental: true, lyrics: false, audioReference: false,
                  textToSpeech: false, voiceCloning: false, voiceId: false, urlResult: true,
                },
              }],
            }
          : {
              name: 'indextts-local',
              baseUrl: 'http://tts.local',
              models: [{
                id: 'indextts-2.5', purpose: 'voice', adapter: 'sync-http',
                capabilities: {
                  textToMusic: false, instrumental: false, lyrics: false, audioReference: true,
                  textToSpeech: true, voiceCloning: true, voiceId: true,
                },
              }],
            },
      },
    })
    await service.createProject({ projectsRoot, name: 'entry', title: undefined })
    const script = await service.readProjectFile('entry', 'game/script.rpy')
    await service.writeProjectFiles('entry', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: script.version }], { origin: 'agent', reason: 'scenario' })
    await service.upsertCharacter('entry', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [],
      voiceProfile: { sample: 'xiao_tang.wav' },
    })

    const collected: FakeTool[] = []
    registerGalfreeTools(
      { tools: { register: (tool: unknown) => { collected.push(tool as FakeTool); return () => {} } } } as unknown as Context & { tools: { register: (tool: unknown) => () => void } },
      service,
    )
    tools = collected
  })

  afterEach(async () => {
    await service.dispose()
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  it('一句话建音乐任务并立刻跑:提交 → 轮询 → 下载 → 经网关落盘 → 池里立刻有它', async () => {
    const out = JSON.parse(await find('galfree_generate_audio').execute({
      project: 'entry',
      output_path: 'game/audio/bgm/rain.ogg',
      model: 'suno-generation',
      prompt: '雨夜的天台,钢琴与弦乐,慢速,忧郁',
    })) as { ok: boolean; purpose: string; state: string; outputPath: string; attempts: number }

    expect(out.ok).toBe(true)
    expect(out.purpose).toBe('music')
    expect(out.state).toBe('awaiting-review')
    expect(out.outputPath).toBe('game/audio/bgm/rain.ogg')
    expect(out.attempts).toBe(1)

    // 上游真被打过三道:提交体里是那句制作指令。
    expect(upstream.submit).toHaveLength(1)
    expect(JSON.parse(upstream.submit[0]!)).toMatchObject({ prompt: '雨夜的天台,钢琴与弦乐,慢速,忧郁', instrumental: true })
    expect(upstream.poll).toHaveLength(1)
    expect(upstream.downloads).toEqual(['http://music.local/a.mp3'])

    // 产物落进项目,池里立刻有它(池是派生的)。
    const pool = await service.audioPool('entry')
    expect(pool.files.map((file) => file.path)).toEqual(['audio/bgm/rain.ogg'])
  })

  it('**不跑**那一下:建完就入队,而且报出"这一跑会真发几条"', async () => {
    await find('galfree_generate_audio').execute({
      project: 'entry', output_path: 'game/audio/bgm/a.ogg', model: 'suno-generation', prompt: '第一首', run: false,
    })
    const second = JSON.parse(await find('galfree_generate_audio').execute({
      project: 'entry', output_path: 'game/audio/bgm/b.ogg', model: 'suno-generation', prompt: '第二首', run: false,
    })) as { state: string; cost: { queued: number; music: number; voice: number; note: string } }

    expect(second.state).toBe('queued')
    // 一个字节都没出网(建 ≠ 跑)。
    expect(upstream.submit).toEqual([])
    expect(second.cost.music).toBe(2)
    expect(second.cost.voice).toBe(0)
    expect(second.cost.note).toMatch(/最贵|计费/)
  })

  it('**同一条入口**建语音任务:用途按路径判,而且自动携音色档案', async () => {
    const out = JSON.parse(await find('galfree_generate_audio').execute({
      project: 'entry',
      output_path: 'game/voice/start_0000.wav',
      model: 'indextts-2.5',
      prompt: '你来啦。',
      dialogue_id: 'start_0000',
    })) as { ok: boolean; purpose: string; voice: { character: string | null; sample: string | null } }

    expect(out.purpose).toBe('voice')
    // 音色锚(T32)跟着进来了 —— 不需要调用方手填样本名。
    expect(out.voice).toMatchObject({ character: 'xiao_tang', sample: 'xiao_tang.wav' })
    expect(JSON.parse(upstream.submit[0]!)).toMatchObject({ audio: 'xiao_tang.wav', text: '你来啦。' })
    expect((await service.audioTasks('entry')).map((task) => task.purpose)).toEqual(['voice'])
  })

  it('闸门如实(四种):没配渠道 / 模型不在目录 / 路径形状 / 空提示词', async () => {
    const tool = find('galfree_generate_audio')
    // 路径形状:绝对路径 / 不在 game/ 下。
    expect(await tool.execute({ project: 'entry', output_path: 'D:/x.ogg', model: 'suno-generation', prompt: 'x' }))
      .toMatch(/相对路径/)
    expect(await tool.execute({ project: 'entry', output_path: 'assets/x.ogg', model: 'suno-generation', prompt: 'x' }))
      .toMatch(/game\//)
    // 模型不在**那条**渠道的目录里(把语音模型递给音乐那条)。
    const wrongChannel = await tool.execute({ project: 'entry', output_path: 'game/audio/bgm/x.ogg', model: 'indextts-2.5', prompt: 'x' })
    expect(wrongChannel).toMatch(/音乐/)
    expect(wrongChannel).toMatch(/suno-generation/)
    // 空提示词。
    expect(await tool.execute({ project: 'entry', output_path: 'game/audio/bgm/x.ogg', model: 'suno-generation', prompt: '  ' }))
      .toMatch(/提示词/)
    // 一个请求都没发出去。
    expect(upstream.submit).toEqual([])
  })

  it('没配**音乐**渠道 → 说的是音乐那一条(与语音分开报)', async () => {
    const bare = createProjectService({
      dataDir: `${dataDir}-bare`,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: { http: { send: async () => ({ status: 200, text: '{}' }) }, channel: (purpose) => (purpose === 'voice' ? null : null) },
    })
    await bare.createProject({ projectsRoot, name: 'bare', title: undefined })
    const collected: FakeTool[] = []
    registerGalfreeTools(
      { tools: { register: (tool: unknown) => { collected.push(tool as FakeTool); return () => {} } } } as unknown as Context & { tools: { register: (tool: unknown) => () => void } },
      bare,
    )
    const out = await collected.find((tool) => tool.name === 'galfree_generate_audio')!.execute({
      project: 'bare', output_path: 'game/audio/bgm/x.ogg', model: 'suno-generation', prompt: 'x',
    })
    expect(out).toMatch(/音乐/)
    expect(out).toMatch(/设置/)
    await bare.dispose()
  })

  it('工具契约:必填三项 + 语音那两个可选参数 + 成本在返回里', () => {
    const tool = find('galfree_generate_audio')
    expect(tool.parameters.required?.sort()).toEqual(['model', 'output_path', 'prompt'])
    for (const key of ['loop', 'dialogue_id', 'voice_id', 'run']) expect(tool.parameters.properties[key]).toBeDefined()
    expect(tool.parameters.properties.dialogue_id?.type).toBe('string')
  })

  it('队列那三个动作(读 / 跑 / 重 roll)都在,而且**跑之前先说清真发几条**', async () => {
    // 先攒两条(不跑)—— 这正是 `run: false` 存在的理由:攒一批,再一次性看清成本。
    await find('galfree_generate_audio').execute({
      project: 'entry', output_path: 'game/audio/bgm/a.ogg', model: 'suno-generation', prompt: '第一首', run: false,
    })
    await find('galfree_generate_audio').execute({
      project: 'entry', output_path: 'game/audio/bgm/b.ogg', model: 'suno-generation', prompt: '第二首', run: false,
    })

    const listed = JSON.parse(await find('galfree_audio_queue').execute({ project: 'entry' })) as {
      tasks: Array<{ state: string; purpose: string }>
      queued: { music: number; voice: number }
    }
    expect(listed.tasks).toHaveLength(2)
    expect(listed.tasks.every((task) => task.state === 'queued')).toBe(true)
    expect(listed.queued).toMatchObject({ music: 2, voice: 0 })

    const ran = JSON.parse(await find('galfree_audio_queue').execute({ project: 'entry', action: 'run', purpose: 'music' })) as {
      ran: number
      failed: number
      spend: string
    }
    expect(ran.ran).toBe(2)
    expect(ran.failed).toBe(0)
    // 成本那句必须在返回里(音乐单次最贵)。
    expect(ran.spend).toContain('2')

    // 重 roll:改词重来一次,历史保留(attempts 累加)。
    const retried = JSON.parse(await find('galfree_audio_queue').execute({
      project: 'entry', action: 'retry', task_id: (await service.audioTasks('entry'))[0]!.id, prompt: '第一首(改过)',
    })) as { state: string }
    expect(retried.state).toBe('awaiting-review')
    const first = (await service.audioTasks('entry')).find((task) => task.prompt === '第一首(改过)')
    expect(first?.attempts.length).toBe(2)
  })
})
