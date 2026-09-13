/**
 * T29 守卫 —— Suno 类聚合站适配器(**协议层**,纯函数 + 一条端到端)。
 *
 * 协议事实来自公开文档(见 `audio-adapter-suno.ts` 文件头的表格);这一组守卫盯三件事:
 *  1. **提交体**符合文档的必填项(非自定义模式只给 prompt;`callBackUrl` 是占位而非假域名);
 *  2. **响应解释**如实:code≠200 的原话带上(它的 code 有语义:429 = 积分不足)、
 *     SUCCESS 没给 audio_url 要报错、中间态要说"还在跑"、失败态要指名道姓;
 *  3. **端到端**:提交 → 轮询 → **下载音频** → 经网关落盘 → 池里有它。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createProjectService, type ProjectService } from './project-service.ts'
import { registerAudioAdapter, clearAudioAdapters } from './audio-generation.ts'
import { createSunoAdapter } from './audio-adapter-suno-register.ts'
import { buildSunoSubmitBody, readSunoPoll, readSunoSubmit, sunoPathsFromNote, SUNO_CALLBACK_PLACEHOLDER } from './audio-adapter-suno.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

describe('Suno 类聚合站适配器(T29)', () => {
  describe('协议层(纯函数)', () => {
    it('提交体:非自定义模式只给 prompt;callBackUrl 是**明确的占位**不是假域名', () => {
      const body = buildSunoSubmitBody({ prompt: '雨天的钢琴,安静', instrumental: true, model: 'V6' })
      expect(body).toMatchObject({ customMode: false, instrumental: true, model: 'V6', prompt: '雨天的钢琴,安静' })
      expect(body.callBackUrl).toBe(SUNO_CALLBACK_PLACEHOLDER)
      // 我们不假装有公网回调:占位指向本机一个没人听的端口。
      expect(String(body.callBackUrl)).toContain('127.0.0.1')
    })

    it('提交响应:code≠200 → **原话带上**(它的 code 有语义,别压成"提交失败")', () => {
      const rejected = readSunoSubmit(JSON.stringify({ code: 429, msg: '积分不足' }))
      expect(rejected).toEqual({ ok: false, error: expect.stringContaining('积分不足') })
      expect((rejected as { error: string }).error).toContain('429')
      expect(readSunoSubmit(JSON.stringify({ code: 200, data: { taskId: 'abc' } }))).toEqual({ ok: true, taskId: 'abc' })
      expect(readSunoSubmit(JSON.stringify({ code: 200, data: {} }))).toMatchObject({ ok: false })
      expect(readSunoSubmit('<html>502</html>')).toMatchObject({ ok: false })
    })

    it('轮询:中间态说"还在跑"、SUCCESS 取第一条 audio_url、失败态指名道姓', () => {
      expect(readSunoPoll(JSON.stringify({ code: 200, data: { status: 'PENDING' } }))).toEqual({ kind: 'running', note: 'PENDING' })
      expect(readSunoPoll(JSON.stringify({ code: 200, data: { status: 'TEXT_SUCCESS' } }))).toMatchObject({ kind: 'running' })
      const done = readSunoPoll(JSON.stringify({
        code: 200,
        data: { status: 'SUCCESS', response: { sunoData: [{ audio_url: 'https://cdn/x.mp3', duration: 42 }] } },
      }))
      expect(done).toEqual({ kind: 'done', audioUrl: 'https://cdn/x.mp3', durationSeconds: 42 })
      // SUCCESS 却没给链接 → 如实报(不把"没有产物"记成成功)。
      expect(readSunoPoll(JSON.stringify({ code: 200, data: { status: 'SUCCESS', response: { sunoData: [{}] } } })))
        .toMatchObject({ kind: 'failed' })
      // 失败态(四个终态之一)。
      expect(readSunoPoll(JSON.stringify({ code: 200, data: { status: 'GENERATE_AUDIO_FAILED', errorMessage: '爆了' } })))
        .toEqual({ kind: 'failed', error: '上游判定这次生成失败(GENERATE_AUDIO_FAILED):爆了' })
      // 敏感词那条也要认出来。
      expect(readSunoPoll(JSON.stringify({ code: 200, data: { status: 'SENSITIVE_WORD_ERROR' } }))).toMatchObject({ kind: 'failed' })
    })

    it('路径与模型可在 note 里覆盖(ADR-0012 的"端点可填")', () => {
      expect(sunoPathsFromNote(undefined)).toEqual({ submit: '/api/v1/generate', record: '/api/v1/generate/record-info', model: 'V6' })
      expect(sunoPathsFromNote('model=V6_MINI;submit=/music/submit;record=/music/query')).toEqual({
        submit: '/music/submit', record: '/music/query', model: 'V6_MINI',
      })
      // 认不出的键忽略(不因为一个错字就让整条不可用)。
      expect(sunoPathsFromNote('nonsense;model=V6').model).toBe('V6')
    })
  })

  describe('端到端(假上游照文档回话)', () => {
    let sdkDir: string
    let dataDir: string
    let projectsRoot: string
    let service: ProjectService
    let upstream: { server: Server; requests: Array<{ url: string; method: string; body: string }>; url: () => string }
    let polls = 0

    function fakeSuno(): typeof upstream {
      const requests: Array<{ url: string; method: string; body: string }> = []
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          requests.push({ url: req.url ?? '', method: req.method ?? '', body })
          if ((req.url ?? '').includes('/generate/record-info')) {
            polls += 1
            // 第一次还在跑,第二次成功(验"轮询真的在轮")。
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(polls === 1
              ? JSON.stringify({ code: 200, msg: 'success', data: { status: 'PENDING' } })
              : JSON.stringify({
                  code: 200,
                  msg: 'success',
                  data: { status: 'SUCCESS', response: { sunoData: [{ audio_url: `${upstream.url()}/cdn/rain.mp3`, duration: 33 }] } },
                }))
            return
          }
          if ((req.url ?? '').includes('/cdn/rain.mp3')) {
            // 产物下载(音频字节)。
            res.writeHead(200, { 'content-type': 'audio/mpeg' })
            res.end(Buffer.from('ID3-fake-mp3-bytes'))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 200, msg: 'success', data: { taskId: 'task-abc' } }))
        })
      })
      return {
        server,
        requests,
        url: () => {
          const address = server.address()
          return typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
        },
      }
    }

    beforeEach(async () => {
      sdkDir = await makeFakeSdk()
      dataDir = await makeTempDir('galfree-suno-data-')
      projectsRoot = await makeTempDir('galfree-suno-projects-')
      polls = 0
      upstream = fakeSuno()
      await new Promise<void>((resolve) => upstream.server.listen(0, '127.0.0.1', resolve))
      registerAudioAdapter(createSunoAdapter())
      service = createProjectService({
        dataDir,
        uiTemplate: fakeUiTemplate(sdkDir),
        audio: {
          http: {
            send: async (request) => {
              // 与生产实现**同一条纪律**:GET/HEAD 不能带 body(轮询就是 GET)。
              const method = request.method.toUpperCase()
              const response = await fetch(request.url, {
                method,
                headers: request.headers,
                ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body }),
              })
              return { status: response.status, text: await response.text() }
            },
            // **二进制下载口的唯一用途**:产物是音频 URL(文本读不了),所以下载走这里。
            download: async (url) => {
              const response = await fetch(url)
              return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? '' }
            },
          },
          channel: () => ({
            name: 'image-aggregator',
            baseUrl: upstream.url(),
            apiKey: 'sk-music-secret',
            models: [{
              id: 'suno-generation',
              purpose: 'music',
              adapter: 'async-task',
              // 模型版本可覆盖(那家聚合商未必叫 V6);这里就用缺省验别的东西。
              capabilities: {
                textToMusic: true, instrumental: true, lyrics: true, audioReference: false,
                textToSpeech: false, voiceCloning: false, voiceId: false, urlResult: true,
              },
            }],
          }),
        },
      })
      await service.createProject({ projectsRoot, name: 'music', title: undefined })
    })

    afterEach(async () => {
      await service.dispose()
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
      clearAudioAdapters()
      await cleanupTempDirs()
    })

    it('提交 → 轮询到 SUCCESS → 下载音频 → 经网关落盘 → 池里有它', async () => {
      const task = await service.createAudioTask('music', {
        outputPath: 'game/audio/bgm/rain.mp3', model: 'suno-generation', prompt: '雨天的钢琴,安静', loop: true,
      })
      const run = await service.runAudioTask('music', task.id)
      // 失败时把**上游原话**打出来(否则只看到一句 failed,查不出是哪一步)。
      expect(run, run?.lastError ?? '(没有 lastError)').toMatchObject({ state: 'awaiting-review' })
      expect(run!.attempts[0]).toMatchObject({ outcome: 'ok', bytes: 'ID3-fake-mp3-bytes'.length })

      // 提交体符合文档(非自定义模式只给 prompt)。
      const submit = upstream.requests.find((request) => request.url === '/api/v1/generate')!
      expect(submit.method).toBe('POST')
      expect(JSON.parse(submit.body)).toMatchObject({ customMode: false, instrumental: true, prompt: '雨天的钢琴,安静' })
      // 轮询了两次(PENDING → SUCCESS),第二次带上了 taskId。
      const records = upstream.requests.filter((request) => request.url.includes('record-info'))
      expect(records).toHaveLength(2)
      expect(records[1]!.url).toContain('taskId=task-abc')

      // 产物真落进项目,池里立刻有它。
      const pool = await service.audioPool('music')
      expect(pool.files.map((file) => file.path)).toEqual(['audio/bgm/rain.mp3'])
    })
  })
})
