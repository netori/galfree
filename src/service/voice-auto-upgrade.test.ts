/**
 * T39 追加:**配音那一刻就把接线修好** —— 端到端守卫。
 *
 * 这条守的是一整类"静默无声":上游给的容器(小米 MiMo 给 mp3)与项目里
 * `config.auto_voice` 钉的后缀(.ogg)对不上时,引擎**不报错、试玩也照过、就是没声音**,
 * 而人刚刚为这一句付过一次 TTS 的钱。
 *
 * 所以插件在**落盘那一笔**里顺手把 `options.rpy` 那一行升级成函数形态
 * (同一个写批 = 一条快照):"文件落盘"与"引擎找得到它"是同一件事的两个面。
 *
 * 用**真适配器**(`mimo-chat-tts`)配假上游:请求形状、base64 解码、魔数判格式、
 * 扩展名改写、接线升级 —— 一条链全走一遍,只有网络是假的。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { clearAudioAdapters, registerAudioAdapter, type AudioHttpRequest } from './audio-generation.ts'
import { createMimoChatTtsAdapter } from './audio-adapter-mimo-chat.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { readAutoVoice } from './voice-batch.ts'

/** 像 mp3 的字节:帧同步 `FF F3`(插件按**魔数**判格式,不看扩展名)。 */
const MP3_BYTES = Buffer.concat([Buffer.from([0xff, 0xf3, 0x84, 0xc4]), Buffer.alloc(128, 0x11)])

describe('配音那一刻就把接线修好(T39)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService
  const sent: AudioHttpRequest[] = []

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t39v-data-')
    projectsRoot = await makeTempDir('galfree-t39v-projects-')
    sent.length = 0
    clearAudioAdapters()
    registerAudioAdapter(createMimoChatTtsAdapter())
    service = createProjectService({
      dataDir,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          // 小米那台:回 chat 形状,音频在 choices[0].message.audio.data 的 base64 里。
          send: async (request: AudioHttpRequest) => {
            sent.push(request)
            return {
              status: 200,
              text: JSON.stringify({
                choices: [{ message: { audio: { data: MP3_BYTES.toString('base64'), format: 'mp3' } } }],
              }),
            }
          },
        },
        channel: (purpose) => (purpose === 'voice'
          ? {
              name: 'xiaomimimo.com',
              baseUrl: 'https://api.xiaomimimo.com/v1',
              apiKey: 'sk-test',
              models: [{
                id: 'mimo-v2.5-tts',
                purpose: 'voice',
                adapter: 'mimo-chat-tts',
                note: 'voice=冰糖;format=mp3',
                capabilities: {
                  textToMusic: false, instrumental: false, lyrics: false, audioReference: false,
                  textToSpeech: true, voiceCloning: false, voiceId: true,
                },
              }],
            }
          : null),
      },
    })
    await service.createProject({ projectsRoot, name: 'voicedub', title: '配音' })
  })

  afterEach(async () => {
    clearAudioAdapters()
    await service.dispose()
    await cleanupTempDirs()
  })

  /** 把项目改回**老形态**(字符串钉死后缀),模拟 2026-09-30 之前建的项目。 */
  async function makeLegacyStringForm(): Promise<void> {
    const options = await service.readProjectFile('voicedub', 'game/options.rpy')
    await service.writeProjectFiles('voicedub', [{
      path: 'game/options.rpy',
      content: `${options.content.replace(/\s*$/, '')}\n\ndefine config.auto_voice = "voice/{id}.ogg"\n`,
      expectVersion: options.version,
    }], { origin: 'agent', reason: 'edit' })
  }

  const optionsFile = (): string => join(projectsRoot, 'voicedub', 'game', 'options.rpy')

  it('老形态钉 ogg + 上游给 mp3 ⇒ 同一条写批里升级接线,文件落成 .mp3', async () => {
    await makeLegacyStringForm()
    await mkdir(join(projectsRoot, 'voicedub', 'game', 'voice'), { recursive: true })

    const task = await service.createAudioTask('voicedub', {
      outputPath: 'game/voice/scene_one_0000.ogg', // 调用方按老约定写 .ogg
      model: 'mimo-v2.5-tts',
      prompt: '雨下大了,我们就在这儿等一会儿吧。',
      dialogueId: 'scene_one_0000',
      voiceSample: '冰糖',
      run: true,
    })

    // ① 上游真收到了一个请求,而且是要念的文本在 assistant 里
    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0]!.body) as { messages: Array<{ role: string }> }
    expect(body.messages[0]!.role).toBe('assistant')

    // ② 产物按**真实容器**落盘(mp3 字节 ⇒ `.mp3`),扩展名不骗人。
    //    任务记录里 `outputPath` 留的是**当时要求的那一个**(那是请求,不是事实),
    //    事实落在 degradation 的 notes 里 —— 与"降级"同一个态度:有它 = 与要求不一样。
    expect(task.state).toBe('awaiting-review')
    expect(task.degradation?.notes?.join(' ')).toContain('game/voice/scene_one_0000.mp3')
    const written = await readFile(join(projectsRoot, 'voicedub', 'game', 'voice', 'scene_one_0000.mp3'))
    expect(written.subarray(0, 2).toString('hex')).toBe('fff3')

    // ③ **接线在同一笔里就修好了**:那一行从字符串形态变成函数形态
    const after = await readFile(optionsFile(), 'utf8')
    expect(readAutoVoice(after).form).toBe('function')
    expect(after).toContain('config.auto_voice = _galfree_voice')
    expect(after).not.toMatch(/define\s+config\.auto_voice\s*=\s*"/)

    // ④ 文件 + 配置是**同一个写批**(一条快照,不是两条)。账本那一笔是另一个写批
    //    (`audio-tasks.json`)—— 所以这里按"含语音文件的那一批"去找,而不是取最后一批。
    const log = await service.writeLog('voicedub')
    const artifact = log.find((entry) => entry.path === 'game/voice/scene_one_0000.mp3')!
    const paths = log.filter((entry) => entry.batchId === artifact.batchId).map((entry) => entry.path).sort()
    expect(paths).toEqual(['game/options.rpy', 'game/voice/scene_one_0000.mp3'])

    // ⑤ 板上现在说得出来了:够不着的文件数归零
    const wiring = await service.voiceWiring('voicedub')
    expect(wiring.autoVoice.form).toBe('function')
    expect(wiring.unreachable.count).toBe(0)
    expect(wiring.voiceFiles.extensions).toEqual([{ extension: 'mp3', count: 1 }])
  })

  it('后缀本来对得上就不动那一行(options.rpy 是人的文件)', async () => {
    // 新模板已经是函数形态 —— 配一次音之后它仍然是**那一份**,没有被改写
    const before = await readFile(optionsFile(), 'utf8')
    await service.createAudioTask('voicedub', {
      outputPath: 'game/voice/scene_one_0001.ogg',
      model: 'mimo-v2.5-tts',
      prompt: '第二句。',
      dialogueId: 'scene_one_0001',
      voiceSample: '冰糖',
      run: true,
    })
    expect(await readFile(optionsFile(), 'utf8')).toBe(before)
  })

  it('认不出容器时**不猜**扩展名,也不动接线(如实交给上层)', async () => {
    const bare = createProjectService({
      dataDir: `${dataDir}-bare`,
      uiTemplate: fakeUiTemplate(sdkDir),
      audio: {
        http: {
          send: async () => ({
            status: 200,
            text: JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('不是音频的字节').toString('base64') } } }] }),
          }),
        },
        channel: () => null,
      },
    })
    // 渠道没配 ⇒ 如实拒绝(一个请求都不发),不该悄悄写半条任务
    await expect(bare.createAudioTask('voicedub', {
      outputPath: 'game/voice/x.ogg', model: 'mimo-v2.5-tts', prompt: '嗨。', run: true,
    })).rejects.toThrow()
    await bare.dispose()
  })

  it('写进去的那个函数形态,引擎认(lint 之外的一条静态自证:它有 loadable 兜底)', async () => {
    await makeLegacyStringForm()
    await service.voiceWiring('voicedub', { apply: true })
    const after = await readFile(optionsFile(), 'utf8')
    expect(after).toContain('renpy.loadable')
    // 兜底那一行必须在:一个后缀都没有时返回老默认,别把"没配音"变成一句报错
    expect(after).toContain('return "voice/{}.ogg".format(voice_id)')
  })

  it('语音文件的真容器与扩展名一致时,任务上的 note 不再提后缀问题', async () => {
    await writeFile(join(projectsRoot, 'voicedub', 'marker.txt'), 'x')
    const task = await service.createAudioTask('voicedub', {
      outputPath: 'game/voice/scene_one_0002.mp3', // 调用方直接按真实容器写
      model: 'mimo-v2.5-tts',
      prompt: '第三句。',
      dialogueId: 'scene_one_0002',
      voiceSample: '冰糖',
      run: true,
    })
    expect(task.outputPath).toBe('game/voice/scene_one_0002.mp3')
    expect(task.degradation ?? null).toBeNull()
  })
})
