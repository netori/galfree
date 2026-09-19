/**
 * **OpenAI 兼容语音**的**端到端**守卫(T36):假上游 → 真端口形状 → 经写网关落盘。
 *
 * 为什么除了协议层那八条还要这一条:这一票真正缺的东西在**端口那一格能力** ——
 * `send` 此前只回 `{status, text}`,而这条协议的**响应体就是音频**。
 * 协议层用假响应验不了"字节有没有真的从端口走到磁盘",所以这里给一个
 * **回字节的假上游**,把整条路走一遍。
 *
 * 断言面:请求发到哪、发了什么字段、产物字节**逐字节相同**、落到了哪。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { clearAudioAdapters, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'
import { createOpenAiSpeechAdapter } from './audio-adapter-openai-speech.ts'
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

/** 假的 OpenAI 兼容语音上游:响应体**就是音频字节**(这正是这一条协议的特征)。 */
const AUDIO_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x21, 0x54, 0x53, 0x53, 0x45])

describe('OpenAI 兼容语音 · 端到端(T36)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  let seen: Array<{ url: string; method: string; body: Record<string, unknown>; auth: string | undefined }>

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t36-data-')
    projectsRoot = await makeTempDir('galfree-t36-projects-')
    seen = []
    clearAudioAdapters()
    registerAudioAdapter(createOpenAiSpeechAdapter())

    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          // **注意返回里的 bytes**:真端口就是这么给的(这一票给它加的那一格)。
          // 少了它,适配器会如实报"端口没给回字节",而不是把 text 当音频用。
          send: async (request: AudioHttpRequest) => {
            seen.push({
              url: request.url,
              method: request.method,
              body: JSON.parse(request.body) as Record<string, unknown>,
              auth: request.headers.authorization,
            })
            return { status: 200, text: '', bytes: AUDIO_BYTES, contentType: 'audio/mpeg' }
          },
        },
        channel: () => ({
          name: '硅基流动',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-cloud',
          models: [{
            id: 'FunAudioLLM/CosyVoice2-0.5B',
            purpose: 'voice' as const,
            adapter: 'openai-speech' as const,
            note: 'voice=FunAudioLLM/CosyVoice2-0.5B:alex',
            capabilities: { textToMusic: false, instrumental: false, lyrics: false, audioReference: false, textToSpeech: true, voiceCloning: true, voiceId: true },
          }],
        }),
      },
    })
  })

  afterEach(async () => {
    await service.dispose()
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  it('建一条语音任务 → 跑 → 上游收到的形状对、音频字节**逐字节**落进 game/voice/', async () => {
    const project = await service.createProject({ projectsRoot, name: 'cloud', title: '云端语音' })
    const snap = await service.readProjectFile('cloud', 'game/script.rpy')
    await service.writeProjectFiles('cloud', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })

    // 建任务:产物路径落在 game/voice/ 下 ⇒ 用途判为语音(T33 的口径)。
    const created = await service.createAudioTask('cloud', {
      outputPath: 'game/voice/start_0001.mp3',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      prompt: '你来啦。',
      run: true,
    })
    expect(created.state).toBe('awaiting-review')

    // 上游收到的那一次:路径 / 方法 / 字段名 / 密钥
    expect(seen).toHaveLength(1)
    const call = seen[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe('https://api.siliconflow.cn/v1/audio/speech')
    expect(call.body.model).toBe('FunAudioLLM/CosyVoice2-0.5B')
    expect(call.body.input).toBe('你来啦。')
    expect(call.body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:alex')
    expect(call.auth).toBe('Bearer sk-cloud')

    // **产物逐字节相同** —— 这是"端口那一格能力真的通了"的证据。
    const landed = await readFile(join(project.root, 'game', 'voice', 'start_0001.mp3'))
    expect(new Uint8Array(landed)).toEqual(AUDIO_BYTES)
  })

  it('端口没给字节 ⇒ 如实记失败(**不落盘一个坏文件**)', async () => {
    // 换一个"老形状"的端口:只回 text。这正是这一票要修的那个缺口。
    const old = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: { send: async () => ({ status: 200, text: 'ID3\u0004' }) },
        channel: () => ({
          baseUrl: 'https://api.siliconflow.cn/v1',
          models: [{
            id: 'm',
            purpose: 'voice' as const,
            adapter: 'openai-speech' as const,
            note: 'voice=alex',
            capabilities: { textToMusic: false, instrumental: false, lyrics: false, audioReference: false, textToSpeech: true, voiceCloning: false, voiceId: true },
          }],
        }),
      },
    })
    try {
      const project = await old.createProject({ projectsRoot, name: 'oldport', title: '老端口' })
      const snap = await old.readProjectFile('oldport', 'game/script.rpy')
      await old.writeProjectFiles('oldport', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { reason: 'scenario', origin: 'agent' })

      const task = await old.createAudioTask('oldport', { outputPath: 'game/voice/start_0001.mp3', model: 'm', prompt: '你来啦。', run: true })

      expect(task.state).toBe('failed')
      expect(task.lastError).toContain('没给回字节')
      // 关键:**不许**落一个把文本当音频的坏文件。
      await expect(readFile(join(project.root, 'game', 'voice', 'start_0001.mp3'))).rejects.toBeTruthy()
    } finally {
      await old.dispose()
    }
  })
})
