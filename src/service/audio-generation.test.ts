/**
 * T27(#35)守卫 —— 音频生成通道骨架(渠道 + 任务账本 + 三道门)。
 *
 * 这一票是**音乐与语音两条渠道共用的地基**(ADR-0012:三条线各自一条渠道),所以守卫盯的是
 * "地基那几条纪律" —— 其中一条就是**两条渠道各算各的**:
 *  1. **那条**渠道没配 = 没渠道:如实拒绝(`no-music-channel` / `no-voice-channel`),不假装能生成;
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
import { assertAudioOutputPath, AUDIO_TASKS_FILE, clearAudioAdapters, purposeOfPath, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'

/**
 * 两条**假**渠道(端点都是假的,快带不出网)。
 *
 * 刻意给**不同的端点与密钥**:拆渠道这件事如果只在类型上成立、装配处还读同一组键,
 * 这里就会露馅(别名与真名的差别正是这条守卫要抓的)。
 */
const CHANNELS = {
  music: {
    name: 'test-music',
    baseUrl: 'http://127.0.0.1:9/music',
    apiKey: 'sk-music-secret',
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
    ],
  },
  voice: {
    name: 'test-voice',
    baseUrl: 'http://127.0.0.1:9/voice',
    apiKey: 'sk-voice-secret',
    models: [
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
  },
}

type FakeChannels = { music: (typeof CHANNELS)['music'] | null; voice: (typeof CHANNELS)['voice'] | null }

describe('音频生成通道骨架(T27)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  /** 造一个服务;哪条渠道传 null = 那条没配(两条独立)。 */
  function makeService(tag: string, channels: FakeChannels): ProjectService {
    const bare = channels.music === null && channels.voice === null
    return createProjectService({
      dataDir: dataDir + tag,
      uiTemplate: fakeUiTemplate(sdkDir),
      ...(bare ? {} : {
        audio: {
          http: { send: async () => ({ status: 200, text: '{}' }) },
          channel: (purpose) => channels[purpose],
        },
      }),
    })
  }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t27-data-')
    projectsRoot = await makeTempDir('galfree-t27-projects-')
    service = makeService('-main', CHANNELS)
    await service.createProject({ projectsRoot, name: 'audio', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ─── 纪律 1:没配渠道 = 无渠道 ──────────────────────────────────────

  it('那条渠道没配 → 建任务如实拒绝,而且**报的是哪一条**(音乐 / 语音两个码)', async () => {
    const bare = makeService('-bare', { music: null, voice: null })
    await bare.createProject({ projectsRoot, name: 'bare', title: undefined })
    await expect(bare.createAudioTask('bare', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'music-3.0', prompt: '雨天的钢琴',
    })).rejects.toMatchObject({ code: 'no-music-channel' })
    await expect(bare.createAudioTask('bare', {
      outputPath: 'game/voice/start_0000.ogg', model: 'speech-2.6', prompt: '平静地读',
    })).rejects.toMatchObject({ code: 'no-voice-channel' })
    // 而且**一个任务都没建**(不是"建了但跑不了")。
    expect(await bare.audioTasks('bare')).toEqual([])
    await bare.dispose()
  })

  it('**两条渠道各算各的**:语音配好了、音乐没配 → 语音能建、音乐如实拒', async () => {
    // 这正是拆开渠道的意义:人可以先只把本地 TTS 配上,音乐那条留着以后再说。
    const half = makeService('-half', { music: null, voice: CHANNELS.voice })
    await half.createProject({ projectsRoot, name: 'half', title: undefined })
    await expect(half.createAudioTask('half', {
      outputPath: 'game/audio/bgm/rain.ogg', model: 'music-3.0', prompt: '雨天的钢琴',
    })).rejects.toMatchObject({ code: 'no-music-channel' })
    const task = await half.createAudioTask('half', {
      outputPath: 'game/voice/start_0000.ogg', model: 'speech-2.6', prompt: '平静地读',
    })
    expect(task).toMatchObject({ purpose: 'voice', model: 'speech-2.6', channel: 'test-voice' })
    await half.dispose()
  })

  it('渠道读法:**两条一起给**,各自报模型与"配没配" —— 但**不报密钥本身**', async () => {
    const view = await service.audioChannels()
    expect(view.music.configured).toBe(true)
    expect(view.music.name).toBe('test-music')
    expect(view.music.apiKeyConfigured).toBe(true)
    expect(view.music.models.map((model) => model.id)).toEqual(['music-3.0'])
    expect(view.voice.configured).toBe(true)
    expect(view.voice.name).toBe('test-voice')
    expect(view.voice.models.map((model) => model.id)).toEqual(['speech-2.6'])
    // 关键:整个视图里不许出现**任何一把**密钥明文。
    const text = JSON.stringify(view)
    expect(text).not.toContain('sk-music-secret')
    expect(text).not.toContain('sk-voice-secret')
  })

  it('音乐模型的 id 递到语音那条 → 拒绝(两条目录**不互相兜底**)', async () => {
    // 拆渠道之后这条是新的错法:模型名对了、但不属于这条渠道 —— 不能"在另一条里找到了就用它"。
    await expect(service.createAudioTask('audio', {
      outputPath: 'game/voice/start_0000.ogg', model: 'music-3.0', prompt: '平静地读',
    })).rejects.toMatchObject({ code: 'unknown-audio-model' })
    await expect(service.createAudioTask('audio', {
      outputPath: 'game/voice/start_0000.ogg', model: 'music-3.0', prompt: '平静地读',
    })).rejects.toThrow(/语音/)
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
      model: 'music-3.0', channel: 'test-music', loop: true, dialogueId: null,
      attempts: [], rejections: [],
    })
    // 账本真的落盘了(项目文件,经网关 → 进快照)。
    const root = (await service.listProjects()).find((project) => project.name === 'audio')!.root
    const text = await readFile(join(root, AUDIO_TASKS_FILE), 'utf8')
    expect(JSON.parse(text).tasks).toHaveLength(1)
    // **密钥不许出现在账本里**(ADR-0010/0012 的硬边界)。
    expect(text).not.toContain('sk-music-secret')
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

  // ─── 切片三:适配器 + 执行队列 ─────────────────────────────────────

  describe('执行(适配器 → 网关落盘 → 池)', () => {
    /** 一个"同步一次拿回字节"的假适配器(不出网:出网走注入的端口)。 */
    function fakeAdapter(bytes: Uint8Array, onRequest?: (request: AudioHttpRequest) => void) {
      registerAudioAdapter({
        id: 'sync-http',
        buildRequest: (input) => {
          const request = {
            url: `${input.channel.baseUrl}/music_generation`,
            method: 'POST',
            headers: { authorization: `Bearer ${input.channel.apiKey ?? ''}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: input.model.id, prompt: input.task.prompt }),
          }
          onRequest?.(request)
          return { request, adapter: 'sync-http' }
        },
        onSubmit: () => ({ kind: 'bytes', bytes, contentType: 'audio/ogg' }),
      })
    }

    afterEach(() => {
      // 注册表是模块级的:每条用例跑完清掉,免得互相污染。
      clearAudioAdapters()
    })

    it('跑一个音乐任务:出网 → 经**写网关**落盘 → 状态转 `awaiting-review`、历史记一条', async () => {
      const bytes = new Uint8Array([79, 103, 103, 83, 1, 2, 3])
      let sent: AudioHttpRequest | null = null
      fakeAdapter(bytes, (request) => { sent = request })
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/rain.ogg', model: 'music-3.0', prompt: '雨天的钢琴',
      })
      const run = await service.runAudioTask('audio', task.id)
      expect(run).toMatchObject({ state: 'awaiting-review' })
      expect(run!.attempts).toHaveLength(1)
      expect(run!.attempts[0]).toMatchObject({ outcome: 'ok', bytes: bytes.byteLength })
      // 请求真的发出去了,而且**带上渠道密钥的只有请求头**(账本里没有)。
      expect(sent!.url).toBe('http://127.0.0.1:9/music/music_generation')
      expect(sent!.headers.authorization).toBe('Bearer sk-music-secret')
      // 产物经网关落盘:文件真在,而且**池里立刻有它**(与手丢文件同一条推导)。
      const root = (await service.listProjects()).find((project) => project.name === 'audio')!.root
      expect(new Uint8Array(await readFile(join(root, 'game/audio/bgm/rain.ogg')))).toEqual(bytes)
      const pool = await service.audioPool('audio')
      expect(pool.files.map((file) => file.path)).toContain('audio/bgm/rain.ogg')
    })

    it('上游拒绝 → 如实记 `failed` + 原话进历史(不吞成"失败了")', async () => {
      registerAudioAdapter({
        id: 'sync-http',
        buildRequest: (input) => ({
          request: { url: `${input.channel.baseUrl}/x`, method: 'POST', headers: {}, body: '{}' },
          adapter: 'sync-http',
        }),
        onSubmit: () => ({ kind: 'failed', error: 'model not found: music-3.0(HTTP 404)' }),
      })
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/x.ogg', model: 'music-3.0', prompt: 'x',
      })
      const run = await service.runAudioTask('audio', task.id)
      expect(run).toMatchObject({ state: 'failed', lastError: expect.stringContaining('model not found') })
      expect(run!.attempts[0]).toMatchObject({ outcome: 'failed' })
      // 失败不产生产物(不写一个空文件糊过去)。
      const root = (await service.listProjects()).find((project) => project.name === 'audio')!.root
      await expect(readFile(join(root, 'game/audio/bgm/x.ogg'))).rejects.toThrow()
    })

    it('**适配器还没实现** → 如实记失败并指名道姓(不假装成功、也不静默不动)', async () => {
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/y.ogg', model: 'music-3.0', prompt: 'y',
      })
      // 清空注册表 = T28/T29 之前的**真实状态**(这个协议还没写)。
      clearAudioAdapters()
      const run = await service.runAudioTask('audio', task.id)
      expect(run!.state).toBe('failed')
      expect(run!.lastError).toMatch(/还没实现/)
      expect(run!.lastError).toContain('sync-http') // 指名道姓:哪个协议没有适配器
      // 也没产生产物。
      const root = (await service.listProjects()).find((project) => project.name === 'audio')!.root
      await expect(readFile(join(root, 'game/audio/bgm/y.ogg'))).rejects.toThrow()
    })

    it('跑队列:只推进 `queued` 的;失败留在 `failed`(重试是人的动作)', async () => {
      fakeAdapter(new Uint8Array([1, 2, 3, 4]))
      await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/q1.ogg', model: 'music-3.0', prompt: 'q1' })
      await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/q2.ogg', model: 'music-3.0', prompt: 'q2' })
      const ran = await service.runAudioQueue('audio')
      expect(ran.map((task) => task.state)).toEqual(['awaiting-review', 'awaiting-review'])
      // 再跑一次:没有 queued 的了 → 什么都不动(不重复出)。
      const again = await service.runAudioQueue('audio')
      expect(again).toEqual([])
      const all = await service.audioTasks('audio')
      expect(all.every((task) => task.attempts.length === 1)).toBe(true)
    })

    it('跑队列:**按用途分开跑** —— 音乐那一下不动语音的任务(两张卡各写各的"会发出 N 条")', async () => {
      fakeAdapter(new Uint8Array([7, 7]))
      await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/m1.ogg', model: 'music-3.0', prompt: 'm1' })
      await service.createAudioTask('audio', { outputPath: 'game/voice/v1.ogg', model: 'speech-2.6', prompt: '平静地读' })

      // 音乐卡那一下:只跑音乐那条 —— 语音的任务**必须原封不动**留在 queued。
      const musicRun = await service.runAudioQueue('audio', { purpose: 'music' })
      expect(musicRun.map((task) => task.purpose)).toEqual(['music'])
      const afterMusic = await service.audioTasks('audio')
      expect(afterMusic.find((task) => task.purpose === 'voice')).toMatchObject({ state: 'queued', attempts: [] })

      // 语音卡那一下:才轮到语音那条。
      const voiceRun = await service.runAudioQueue('audio', { purpose: 'voice' })
      expect(voiceRun.map((task) => task.purpose)).toEqual(['voice'])
      expect((await service.audioTasks('audio')).every((task) => task.state === 'awaiting-review')).toBe(true)

      // 不给用途 = 全跑(CLI/工具那条路的语义没变):再排两条,一次跑完。
      await service.createAudioTask('audio', { outputPath: 'game/audio/bgm/m2.ogg', model: 'music-3.0', prompt: 'm2' })
      await service.createAudioTask('audio', { outputPath: 'game/voice/v2.ogg', model: 'speech-2.6', prompt: '平静地读' })
      expect((await service.runAudioQueue('audio')).map((task) => task.purpose).sort()).toEqual(['music', 'voice'])
    })

    it('重 roll:保留历史、追加一次尝试,并记下**被覆盖那一版**的指纹', async () => {
      fakeAdapter(new Uint8Array([9, 9, 9]))
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/r.ogg', model: 'music-3.0', prompt: '第一版',
      })
      const first = await service.runAudioTask('audio', task.id)
      const again = await service.retryAudioTask('audio', task.id, { prompt: '第二版,更安静', run: true })
      expect(again!.attempts).toHaveLength(2)
      expect(again!.prompt).toBe('第二版,更安静')
      // 第二次尝试里记着"我覆盖掉的是哪一版"(指纹来自第一次的产物)。
      expect(again!.attempts[1]!.replacedFingerprint).toBe(first!.attempts[0]!.fingerprint)
    })

    it('拒收注记:只追加、指向被拒那一版;空注记/超长注记都拒(要么说清为什么、要么别记)', async () => {
      fakeAdapter(new Uint8Array([5, 5]))
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/n.ogg', model: 'music-3.0', prompt: 'x',
      })
      await service.runAudioTask('audio', task.id)
      await expect(service.retryAudioTask('audio', task.id, { note: '   ' })).rejects.toMatchObject({ code: 'empty-note' })
      await expect(service.retryAudioTask('audio', task.id, { note: 'x'.repeat(700) })).rejects.toMatchObject({ code: 'note-too-long' })
      const noted = await service.retryAudioTask('audio', task.id, { note: '太吵了,钢琴轻一点', via: 'human' })
      expect(noted!.rejections).toHaveLength(1)
      expect(noted!.rejections[0]).toMatchObject({ note: '太吵了,钢琴轻一点', via: 'human' })
    })

    it('密钥**不进快照**:写批留下的 git 提交里,消息与 diff 都不含它', async () => {
      // AC 第五条的另一半。账本那一半已经验过(直接读盘);这一半要真去看**快照历史** ——
      // 快照就是项目目录的 git 提交,所以"密钥没混进写批"这件事可以用 git 自己来证。
      const bytes = new Uint8Array([1, 1, 2, 2, 3])
      registerAudioAdapter({
        id: 'sync-http',
        buildRequest: (input) => ({
          request: {
            url: `${input.channel.baseUrl}/music_generation`,
            method: 'POST',
            // 密钥当然**要**出现在请求头里(否则上游不认);它只是不能落在项目里。
            headers: { authorization: `Bearer ${input.channel.apiKey ?? ''}` },
            body: '{}',
          },
          adapter: 'sync-http',
        }),
        onSubmit: () => ({ kind: 'bytes', bytes, contentType: 'audio/ogg' }),
      })
      const task = await service.createAudioTask('audio', {
        outputPath: 'game/audio/bgm/s.ogg', model: 'music-3.0', prompt: '探针',
      })
      await service.runAudioTask('audio', task.id)

      for (const path of ['.studio/audio-tasks.json', 'game/audio/bgm/s.ogg']) {
        const history = await service.snapshotHistory('audio', path)
        expect(history.length).toBeGreaterThan(0)
        for (const entry of history) {
          // 提交消息里不能有(消息里塞了 `channel:<名>` 这类上下文,正是容易漏的地方)。
          expect(entry.subject).not.toContain('sk-music-secret')
          // 内容 diff 里也不能有(账本是文本,产物是二进制 —— 两条都扫)。
          const diff = await service.snapshotDiff('audio', path, `${entry.commit}^`, entry.commit)
          expect(diff).not.toContain('sk-music-secret')
        }
      }
    })
  })
})
