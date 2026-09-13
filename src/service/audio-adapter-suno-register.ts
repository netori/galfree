/**
 * Suno 类聚合站适配器的**装配那半**(协议层在 `audio-adapter-suno.ts`)。
 *
 * 为什么拆两个文件:**协议层是纯函数**(提交体、响应解释、路径覆盖),守卫能直接喂字符串验;
 * 这一层要出网、要把 `async-task` 那套(提交 → 拿 taskId → 轮询 → 下载)接到
 * `AudioAdapter` 接口上。混在一个文件里,纯的那半就没法单测了。
 */
import type { AudioAdapter, AudioSubmission, AudioPollStep } from './audio-generation.ts'
import { buildSunoSubmitBody, readSunoPoll, readSunoSubmit, sunoPathsFromNote } from './audio-adapter-suno.ts'

export function createSunoAdapter(): AudioAdapter {
  return {
    id: 'async-task',
    buildRequest: (input) => {
      const paths = sunoPathsFromNote(input.model.note)
      return {
        adapter: 'async-task',
        request: {
          url: `${input.channel.baseUrl.replace(/\/+$/, '')}${paths.submit}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
              ? {}
              : { authorization: `Bearer ${input.channel.apiKey}` }),
          },
          body: JSON.stringify(buildSunoSubmitBody({
            // 音乐那边 `prompt` 是**制作指令**(风格/情绪/场景),不是歌词 ——
            // 非自定义模式下上游按它自动生成歌词;纯音乐则完全不要歌词。
            prompt: input.task.prompt,
            instrumental: input.model.capabilities.instrumental,
            model: paths.model,
          })),
        },
      }
    },
    onSubmit: (response): AudioSubmission => {
      if (response.status < 200 || response.status >= 300) {
        return { kind: 'failed', error: `提交被拒(HTTP ${response.status}):${response.text.slice(0, 300)}` }
      }
      const parsed = readSunoSubmit(response.text)
      return parsed.ok ? { kind: 'pending', taskId: parsed.taskId } : { kind: 'failed', error: parsed.error }
    },
    // 异步任务制:轮询到终态。
    buildPollRequest: (input, taskId) => {
      const paths = sunoPathsFromNote(input.model.note)
      return {
        url: `${input.channel.baseUrl.replace(/\/+$/, '')}${paths.record}?taskId=${encodeURIComponent(taskId)}`,
        method: 'GET',
        headers: {
          ...(input.channel.apiKey === undefined || input.channel.apiKey === ''
            ? {}
            : { authorization: `Bearer ${input.channel.apiKey}` }),
        },
        body: '',
      }
    },
    poll: (response): AudioPollStep => {
      if (response.status < 200 || response.status >= 300) {
        return { kind: 'failed', error: `轮询被拒(HTTP ${response.status}):${response.text.slice(0, 300)}` }
      }
      // 协议层给的是"音频 URL 或失败";`AudioPollStep` 的 `done` 正好能吃 URL,
      // 由接缝去下载(它手上有下载口)—— 详见 `#awaitAudioResult`。
      const step = readSunoPoll(response.text)
      if (step.kind === 'running') return { kind: 'running', note: step.note }
      if (step.kind === 'failed') return { kind: 'failed', error: step.error }
      return { kind: 'done', url: step.audioUrl }
    },
  }
}
