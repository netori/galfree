/**
 * T27(#35)守卫 —— 音频生成通道骨架(渠道 + 任务账本 + 三道门)。
 *
 * 这一票是**音乐与语音共用的地基**,所以守卫盯的是"地基那几条纪律":
 *  1. **没配渠道 = 无渠道**:如实拒绝(`no-audio-channel`),不假装能生成;
 *  2. 模型不在目录里 → 拒绝并**列出目录里有什么**(不猜、不静默换个模型);
 *  3. 目标路径的形状:必须落在 `game/` 下、必须是相对路径(引擎的 searchpath 只有 `game/`);
 *  4. **密钥不进项目/账本**:账本里只许有渠道名与模型 id;
 *  5. 账本与图像那套**同一底层**(状态机/尝试历史/拒收注记形状一致),但**各落各的文件**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { assertAudioOutputPath, AUDIO_TASKS_FILE, purposeOfPath } from './audio-generation.ts'

/** 一条能用假的音频渠道(端点是假的,快带不出网)。 */
const CHANNEL = {
  name: 'test-audio',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'sk-audio-secret',
  models: [
    {
      id: 'music-3.0',
      purpose: 'music' as const,
      adapter: 'sync-http' as const,
      capabilities: {
        textToMusic: true, instrumental: true, lyrics: true, audioReference: false,
        textToSpeech: false, voiceCloning: false, voiceId: false,
      },
    },
    {
      id: 'speech-2.6',
      purpose: 'voice' as const,
      adapter: 'sync-http' as const,
      capabilities: {
        textToMusic: false, instrumental: false, lyrics: false, audioReference: true,
        textToSpeech: true, voiceCloning: true, voiceId: true,
      },
    },
  ],
}

describe('音频生成通道骨架(T27)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  /** 造一个服务;`channel` 传 null = 没配渠道。 */
  function makeService(tag: string, channel: typeof CHANNEL | null): ProjectService {
    return createProjectService({
      dataDir: dataDir + tag,
      uiTemplate: fakeUiTemplate(sdkDir),
      ...(channel === null ? {} : { audio: { http: { send: async () => ({ status: 200, text: '{}' }) }, channel: () => channel } }),
    })
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t27-data-')
    projectsRoot = await makeTempDir('galfree-t27-projects-')
    service = makeService('-main', CHANNEL)
    await service.createProject({ projectsRoot, name: 'audio', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ─── 纪律 1:没配渠道 = 无渠道 ──────────────────────────────────────

  it('没配渠道 → 建任务如实拒绝(`no-audio-channel`),不假装能生成', async () => {
    const bare = makeService('-bare', null)
    await bare.createProject({ projectsRoot, name: 'bare', title: undefined })
    await expect(bare.createAudioTask('bare', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'music-3.0', prompt: '雨天的钢琴',
    })).rejects.toMatchObject({ code: 'no-audio-channel' })
    // 而且**一个任务都没建**(不是"建了但跑不了")。
    expect(await bare.audioTasks('bare')).toEqual([])
    await bare.dispose()
  })

  it('渠道读法:报得出配没配、有哪些模型、每个模型声明了什么 —— 但**不报密钥本身**', async () => {
    const view = await service.audioChannel()
    expect(view.configured).toBe(true)
    expect(view.name).toBe('test-audio')
    expect(view.apiKeyConfigured).toBe(true)
    // 关键:整个视图里不许出现密钥明文。
    expect(JSON.stringify(view)).not.toContain('sk-audio-secret')
    expect(view.models.map((model) => model.id).sort()).toEqual(['music-3.0', 'speech-2.6'])
    expect(view.models.find((model) => model.id === 'music-3.0')?.capabilities.instrumental).toBe(true)
  })

  // ─── 纪律 2:模型目录是唯一出处 ────────────────────────────────────

  it('模型不在目录里 → 拒绝,并**列出目录里有什么**(不猜、不静默换一个)', async () => {
    await expect(service.createAudioTask('audio', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'no-such-model', prompt: 'x',
    })).rejects.toMatchObject({ code: 'unknown-audio-model' })
    await expect(service.createAudioTask('audio', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'no-such-model', prompt: 'x',
    })).rejects.toThrow(/music-3\.0/)
  })

  // ─── 纪律 3:目标路径的形状 ────────────────────────────────────────

  it('产物路径必须落在 game/ 下、且是相对路径(引擎的 searchpath 只有 game/)', () => {
    expect(() => assertAudioOutputPath('game/audio/bgm/rain.ogg')).not.toThrow()
    expect(() => assertAudioOutputPath('game/voice/scene_one_0000.ogg')).not.toThrow()
    // 绝对路径(实测:绝对路径会被静默回退)。
    expect(() => assertAudioOutputPath('E:/proj/game/audio/rain.ogg')).toThrow(/相对路径/)
    expect(() => assertAudioOutputPath('/home/me/game/audio/rain.ogg')).toThrow(/相对路径/)
    // 不在 game/ 下。
    expect(() => assertAudioOutputPath('audio/rain.ogg')).toThrow(/game\//)
  })

  it('用途按路径推:`voice/` 下 = 语音,其余 = 音乐(ADR-0013 的目录口径)', () => {
    expect(purposeOfPath('game/voice/scene_one_0000.ogg')).toBe('voice')
    expect(purposeOfPath('game/audio/bgm/rain.ogg')).toBe('music')
  })

  // ─── 纪律 4 + 5:账本落盘、密钥不进账本 ───────────────────────────

  it('建任务:落进 `.studio/audio-tasks.json`,状态 queued,**账本里没有密钥**', async () => {
    const task = await service.createAudioTask('audio', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'music-3.0', prompt: '雨天的钢琴,安静', loop: true,
    })
    expect(task).toMatchObject({
      kind: 'music', purpose: 'music', state: 'queued', outputPath: 'game/audio/bgm/rain.ogg',
      model: 'music-3.0', channel: 'test-audio', loop: true, dialogueId: null,
      attempts: [], rejections: [],
    })
    // 账本真的落盘了(项目文件,经网关 → 进快照)。
    const root = (await service.listProjects()).find((project) => project.name === 'audio')!.root
    const text = await readFile(join(root, AUDIO_TASKS_FILE), 'utf8')
    expect(JSON.parse(text).tasks).toHaveLength(1)
    // **密钥不许出现在账本里**(ADR-0010/0012 的硬边界)。
    expect(text).not.toContain('sk-audio-secret')
    // 与图像各落各的文件:图像那个账本不该被动过。
    await expect(readFile(join(root, '.studio/image-tasks.json'), 'utf8')).rejects.toThrow()
  })

  it('语音任务:带上对话 id(ADR-0013 的锚)与音色档案 id', async () => {
    const task = await service.createAudioTask('audio', {
      outputPath: 'game/voice/scene_one_0000.ogg', model: 'speech-2.6',
      prompt: '平静地读出来', dialogueId: 'scene_one_0000', voiceId: 'xiao_tang',
    })
    expect(task).toMatchObject({
      kind: 'voice', purpose: 'voice', dialogueId: 'scene_one_0000', voiceId: 'xiao_tang',
    })
  })

  it('路径形状不对 → 拒绝(接缝上拦,不是在路由或面板里各判一遍)', async () => {
    await expect(service.createAudioTask('audio', {
      outputPath: 'bgm/rain.ogg', model: 'music-3.0', prompt: 'x',
    })).rejects.toMatchObject({ code: 'invalid-audio-path' })
    expect(await service.audioTasks('audio')).toEqual([])
  })

  it('账本读法:最新的在前;没建过任务 = 空数组(不是报错)', async () => {
    expect(await service.audioTasks('audio')).toEqual([])
    await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/a.ogg', model: 'music-3.0', prompt: '第一首' })
    await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/b.ogg', model: 'music-3.0', prompt: '第二首' })
    const tasks = await service.audioTasks('audio')
    expect(tasks.map((task) => task.prompt)).toEqual(['第二首', '第一首'])
  })
})
