/**
 * T34 守卫 —— **落盘时的格式核对**(真机踩出来的那一类)。
 *
 * 2026-09-13 真机上真实发生过:上游给的是 **mp3**,而目标路径写的是 `.ogg`,
 * 于是项目里躺了一个 4.6 MB 的"扩展名撒谎"文件 —— Ren'Py **按扩展名选解码器**,
 * 那个文件在游戏里就是读不出来("看着生成了、玩的时候没声音")。
 *
 * 所以两件事各有守卫:
 *  1. **字节的真实格式**按**魔数**认(ID3 / OggS / RIFF / fLaC / ftyp),content-type 只兜底
 *     (很多上游只给 `application/octet-stream`);
 *  2. 真实格式与目标后缀不一致时**换后缀落盘 + 在任务上如实记一笔**(不静默改、也不写错东西)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProjectService, type ProjectService } from './project-service.ts'
import {
  audioExtensionOf, audioFormatOfBytes, clearAudioAdapters, registerAudioAdapter, withAudioExtension,
  type AudioHttpRequest,
} from './audio-generation.ts'
import { createMusicRestAdapter } from './audio-adapter-music-rest.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

/** 认得出/认不出的字节各一份(ID3 = mp3 标签;OggS = ogg)。 */
const MP3 = new TextEncoder().encode('ID3\u0004\u0000\u0000\u0000\u0000\u0001\u006fTXXXmp3-body')
const OGG = new TextEncoder().encode('OggS\u0000\u0002mp3-looking-name-but-ogg')

describe('音频落盘:格式核对(T34)', () => {
  it('真实格式看**魔数**,不看扩展名、也不只看 content-type', () => {
    expect(audioFormatOfBytes(MP3)).toBe('mp3')
    expect(audioFormatOfBytes(OGG)).toBe('ogg')
    expect(audioFormatOfBytes(new TextEncoder().encode('RIFF....WAVEfmt '))).toBe('wav')
    expect(audioFormatOfBytes(new TextEncoder().encode('fLaC\u0000\u0000\u0000"'))).toBe('flac')
    // 无 ID3 的裸 mp3(帧同步字)。
    expect(audioFormatOfBytes(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3')
    // 魔数认不出时才退到 content-type;两个都没有 = null(**不猜**)。
    expect(audioFormatOfBytes(new TextEncoder().encode('not-audio'), 'audio/mpeg')).toBe('mp3')
    expect(audioFormatOfBytes(new TextEncoder().encode('not-audio'))).toBeNull()
    expect(audioFormatOfBytes(new TextEncoder().encode('not-audio'), 'application/octet-stream')).toBeNull()
  })

  it('路径后缀的取与换:只动后缀,别的字符一字不动', () => {
    expect(audioExtensionOf('game/audio/bgm/rain_theme.ogg')).toBe('ogg')
    expect(audioExtensionOf('game/audio/bgm/no-extension')).toBe('')
    expect(withAudioExtension('game/audio/bgm/rain_theme.ogg', 'mp3')).toBe('game/audio/bgm/rain_theme.mp3')
    expect(withAudioExtension('game/voice/scene_one_0000.ogg', 'wav')).toBe('game/voice/scene_one_0000.wav')
  })
})

describe('音频落盘:上游格式与目标后缀不一致时(T34)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  /** 上游"下载"回来的字节(每个用例自己定)。 */
  let payload: { bytes: Uint8Array; contentType: string }

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-fmt-data-')
    projectsRoot = await makeTempDir('galfree-fmt-projects-')
    payload = { bytes: MP3, contentType: 'application/octet-stream' }
    clearAudioAdapters()
    registerAudioAdapter(createMusicRestAdapter())
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          send: async (request: AudioHttpRequest) => {
            if (request.url.includes('/music/tasks/')) {
              return {
                status: 200,
                text: JSON.stringify({
                  code: 200,
                  data: { status: 'completed', result: { music: [{ audio_url: 'https://cdn.example/a.mp3' }] } },
                }),
              }
            }
            return { status: 200, text: JSON.stringify({ code: 200, data: [{ status: 'submitted', task_id: 't-1' }] }) }
          },
          download: async () => ({ status: 200, bytes: payload.bytes, contentType: payload.contentType }),
        },
        channel: (purpose) => purpose === 'music'
          ? {
              name: 'seedance-music', baseUrl: 'https://api.seedance.nz/v1',
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
    await service.createProject({ projectsRoot, name: 'fmt', title: undefined })
  })

  afterEach(async () => {
    await service.dispose()
    clearAudioAdapters()
    await cleanupTempDirs()
  })

  it('上游给 mp3、目标写 .ogg → **落在 .mp3 上**,并在任务上如实记一笔(不写一个撒谎的扩展名)', async () => {
    const task = await service.createAudioTask('fmt', {
      outputPath: 'game/audio/bgm/rain_theme.ogg', model: 'suno-generation', prompt: '雨前教室', run: true,
    })
    expect(task.state).toBe('awaiting-review')
    // **产物在 .mp3 上**(那个路径真的存在),而 .ogg 不存在。
    const pool = await service.audioPool('fmt')
    expect(pool.files.map((file) => file.path)).toEqual(['audio/bgm/rain_theme.mp3'])
    // 账本上写着"为什么路径和我要的不一样"(降级说明就是干这个的)。
    expect(task.degradation?.code).toBe('audio-format-mismatch')
    expect(task.degradation?.message).toContain('mp3')
    expect(task.degradation?.message).toContain('rain_theme.mp3')
    expect(task.degradation?.notes.join(' ')).toContain('game/audio/bgm/rain_theme.ogg')
  })

  it('格式对得上时**一个字都不多说**(没有降级说明)', async () => {
    const task = await service.createAudioTask('fmt', {
      outputPath: 'game/audio/bgm/rain_theme.mp3', model: 'suno-generation', prompt: '雨前教室', run: true,
    })
    expect(task.state).toBe('awaiting-review')
    expect(task.degradation).toBeUndefined()
    expect((await service.audioPool('fmt')).files.map((file) => file.path)).toEqual(['audio/bgm/rain_theme.mp3'])
  })

  it('认不出格式(content-type 也是 octet-stream)→ 照原路径写,但**如实说明**', async () => {
    payload = { bytes: new TextEncoder().encode('some-unknown-container'), contentType: 'application/octet-stream' }
    const task = await service.createAudioTask('fmt', {
      outputPath: 'game/audio/bgm/mystery.ogg', model: 'suno-generation', prompt: '?', run: true,
    })
    expect(task.state).toBe('awaiting-review')
    expect((await service.audioPool('fmt')).files.map((file) => file.path)).toEqual(['audio/bgm/mystery.ogg'])
    expect(task.degradation?.code).toBe('audio-format-mismatch')
    expect(task.degradation?.message).toContain('认不出')
  })
})
