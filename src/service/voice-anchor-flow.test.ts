/**
 * T32 守卫 —— **声音锚自动携链**(登记簿 → 任务 → 请求体)。
 *
 * 这一条回路回答的是发起人那句「IndexTTS 没有设计音色的功能,该如何保持声音一致性?」:
 * 音色只由**参考音频**决定(调研 §1),所以"同一把嗓子"= **每次都用同一个音色库文件名**。
 * 于是三件事各要一条守卫:
 *
 *  1. **自动携链**:建语音任务时按 `dialogueId` 从 `.rpy` 派生的说话人反查登记簿,
 *     把参考样本写进任务 —— 不要求人每次手填(手填就会漏,漏了就换嗓子);
 *  2. **没有就如实降级**:档案缺失时任务上留一条说明,而且**不打扰上游**(请求根本没发出去);
 *  3. **两个命名空间不许混**:项目内路径(`game/voice/…`)不许被当成音色库文件名发出去
 *     (服务端只在它自己的 `voices/` 里按名找,那条兜底**必然**吃 400)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { clearAudioAdapters, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'
import { createIndexttsAdapter } from './audio-adapter-indextts.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

/** 两个角色、三句台词:第一句与第三句是同一个角色(跨批次同一把嗓子的那条回路)。 */
const SCRIPT = [
  'define xiao_tang = Character("小棠")',
  'define ghost = Character("幽灵")',
  '',
  'label start:',
  '    scene bg school',
  '    xiao_tang "你来啦。"',
  '    ghost "……"',
  '    xiao_tang "走吧。"',
  '    return',
  '',
].join('\n')

describe('声音锚:自动携链(T32)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let wavPath: string
  /** 假上游收到的每一个请求(空数组 = 一个都没发出去)。 */
  let sent: Array<{ url: string; method: string; body: string }>

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t32-data-')
    projectsRoot = await makeTempDir('galfree-t32-projects-')
    const wavDir = await makeTempDir('galfree-t32-wav-')
    wavPath = join(wavDir, 'out.wav')
    await mkdir(wavDir, { recursive: true })
    await writeFile(wavPath, Buffer.from('RIFF-fake'))
    sent = []
    registerAudioAdapter(createIndexttsAdapter())
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        // 出网口是**注入**的:请求被记下来,一个字节都没真出去。
        http: {
          send: async (request: AudioHttpRequest) => {
            sent.push({ url: request.url, method: request.method, body: request.body })
            return { status: 200, text: JSON.stringify({ ok: true, path: wavPath, filename: 'out.wav' }) }
          },
        },
        channel: () => ({
          name: 'indextts-local',
          baseUrl: 'http://tts.local',
          models: [{
            id: 'indextts-2.5',
            purpose: 'voice',
            adapter: 'sync-http',
            // **模型目录里什么都没写**:音色只能来自登记簿的音色档案(这正是 T32 那条路)。
            capabilities: {
              textToMusic: false, instrumental: false, lyrics: false, audioReference: true,
              textToSpeech: true, voiceCloning: true, voiceId: true,
            },
          }],
        }),
      },
    })
    await service.createProject({ projectsRoot, name: 'anchor', title: undefined })
    const script = await service.readProjectFile('anchor', 'game/script.rpy')
    await service.writeProjectFiles('anchor', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: script.version }], { origin: 'agent', reason: 'scenario' })
  })

  afterEach(async () => {
    await service.dispose()
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  const bodyOf = (index: number): Record<string, unknown> => JSON.parse(sent[index]!.body) as Record<string, unknown>

  it('按 `dialogueId` 派生的说话人自动携链:任务上有样本,请求体里就是那个文件名', async () => {
    await service.upsertCharacter('anchor', {
      id: 'xiao_tang',
      name: '小棠',
      voice: 'xiao_tang',
      appearance: {},
      references: [],
      voiceProfile: { sample: 'xiao_tang.wav', speaker: 'default', lang: 'ZH' },
    })

    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav',
      model: 'indextts-2.5',
      prompt: '你来啦。',
      dialogueId: 'start_0000',
    })
    // 任务上看得见"这条用的是哪段参考"(面板与账本读同一份)。
    expect(task).toMatchObject({ voiceId: 'xiao_tang', voiceSample: 'xiao_tang.wav', voiceSpeaker: 'default', voiceLang: 'ZH' })
    expect(task.degradation).toBeUndefined()

    const run = await service.runAudioTask('anchor', task.id)
    expect(run!.state).toBe('awaiting-review')
    expect(bodyOf(0)).toMatchObject({ speaker: 'default', audio: 'xiao_tang.wav', text: '你来啦。', lang: 'ZH' })
  })

  it('**跨批次同一把嗓子**:同一个角色的两次任务,请求体里的 `audio` 逐字相同', async () => {
    await service.upsertCharacter('anchor', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [],
      voiceProfile: { sample: 'xiao_tang.wav' },
    })

    const first = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', dialogueId: 'start_0000',
    })
    await service.runAudioTask('anchor', first.id)
    // 第二个批次:同角色、另一句(不同场景也一样 —— 锚在登记簿上,不在任务里)。
    const later = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0002.wav', model: 'indextts-2.5', prompt: '走吧。', dialogueId: 'start_0002',
    })
    await service.runAudioTask('anchor', later.id)

    expect(sent).toHaveLength(2)
    expect(bodyOf(0).audio).toBe('xiao_tang.wav')
    expect(bodyOf(1).audio).toBe(bodyOf(0).audio)
    expect(bodyOf(1).speaker).toBe(bodyOf(0).speaker)
  })

  it('角色还没有音色档案 → 任务上如实降级,而且**一个请求都没发出去**', async () => {
    await service.upsertCharacter('anchor', {
      id: 'ghost', name: '幽灵', voice: 'ghost', appearance: {}, references: [],
    })
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0001.wav', model: 'indextts-2.5', prompt: '……', dialogueId: 'start_0001',
    })
    expect(task.degradation?.code).toBe('voice-anchor-missing')
    expect(task.degradation?.message).toContain('音色档案')
    expect(task.voiceSample).toBeUndefined()

    const run = await service.runAudioTask('anchor', task.id)
    expect(run!.state).toBe('failed')
    // 掐在**发请求之前**:拿空值去撞上游 400 是白花一次额度。
    expect(sent).toEqual([])
    expect(run!.lastError).toMatch(/参考样本/)
    expect(run!.lastError).toMatch(/音色档案/)
  })

  it('`voiceId` 是**登记簿 id**,不再被当成 `speaker` 发出去(那是 LoRA 适配器名)', async () => {
    await service.upsertCharacter('anchor', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [],
      voiceProfile: { sample: 'xiao_tang.wav' },
    })
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', voiceId: 'xiao_tang',
    })
    await service.runAudioTask('anchor', task.id)
    // 服务端的 `speaker` 只选 LoRA 目录(本机 runs/ 是空的 ⇒ 只有 default)。
    expect(bodyOf(0)).toMatchObject({ speaker: 'default', audio: 'xiao_tang.wav' })
  })

  it('给了一个登记簿里没有的 `voiceId` → 如实说"没这个角色",`speaker` 仍是 default', async () => {
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', voiceId: 'someone_lora',
    })
    expect(task.degradation?.code).toBe('voice-anchor-missing')
    expect(task.degradation?.message).toContain('someone_lora')
    expect(task.voiceId).toBe('someone_lora')
    const run = await service.runAudioTask('anchor', task.id)
    expect(run!.state).toBe('failed')
    expect(sent).toEqual([])
  })

  it('项目内路径(`game/voice/…`)不会被当成音色库文件名发出去', async () => {
    // 老形状:参考音频挂在任务的 `referenceAudio` 上(项目内相对路径)。
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', dialogueId: 'start_0000',
      referenceAudio: [{ path: 'game/voice/some_other_line.wav', note: '想拿它当音色参考' }],
    })
    const run = await service.runAudioTask('anchor', task.id)
    expect(sent).toEqual([])
    expect(run!.state).toBe('failed')
    // 说明里要指路:音色库是**另一个命名空间**。
    expect(run!.lastError).toMatch(/音色库/)
    expect(run!.lastError).toMatch(/voices\//)
  })

  it('情感显式化:档案里配了就按它发,没配就一个字段都不加(服务端自己的缺省)', async () => {
    await service.upsertCharacter('anchor', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [],
      voiceProfile: { sample: 'xiao_tang.wav', emotion: { mode: 'vector', vector: [0, 0, 0, 0, 0, 0, 0, 1], weight: 0.5 } },
    })
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', dialogueId: 'start_0000',
    })
    await service.runAudioTask('anchor', task.id)
    expect(bodyOf(0)).toMatchObject({ emo_control_method: 2, emo_vector: [0, 0, 0, 0, 0, 0, 0, 1], emo_weight: 0.5 })

    // 没配情感的角色:请求体里**没有**情感那几个键(不替它编一个 0)。
    await service.upsertCharacter('anchor', {
      id: 'ghost', name: '幽灵', voice: 'ghost', appearance: {}, references: [],
      voiceProfile: { sample: 'ghost.wav' },
    })
    const plain = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0001.wav', model: 'indextts-2.5', prompt: '……', dialogueId: 'start_0001',
    })
    await service.runAudioTask('anchor', plain.id)
    const body = bodyOf(1)
    expect(body.audio).toBe('ghost.wav')
    for (const key of ['emo_control_method', 'emo_ref_audio', 'emo_vector', 'emo_text', 'emo_weight']) {
      expect(body).not.toHaveProperty(key)
    }
  })

  it('显式给了 `voiceSample` 就以它为准(临时换一段参考,不动登记簿)', async () => {
    await service.upsertCharacter('anchor', {
      id: 'xiao_tang', name: '小棠', voice: 'xiao_tang', appearance: {}, references: [],
      voiceProfile: { sample: 'xiao_tang.wav' },
    })
    const task = await service.createAudioTask('anchor', {
      outputPath: 'game/voice/start_0000.wav', model: 'indextts-2.5', prompt: '你来啦。', dialogueId: 'start_0000',
      voiceSample: 'xiao_tang_whisper.wav',
    })
    expect(task.voiceSample).toBe('xiao_tang_whisper.wav')
    await service.runAudioTask('anchor', task.id)
    expect(bodyOf(0).audio).toBe('xiao_tang_whisper.wav')
  })
})
