/**
 * 音频生成卡(T27 / ADR-0012)的**判断**部分 —— 纯函数,单独放这里是为了能守卫。
 *
 * 面板里那些"要不要给按钮、会花几次请求、为什么没配好"都不写在组件里:
 * ADR-0002 的老规矩是**面板只渲染,判断在推导层**;而测试要能直接喂数据验这两条:
 *  1. **跑之前看得见"这一跑要花几条上游请求"**(TTS 按台词行计费,不看清就点很危险);
 *  2. 渠道没配好时**如实短路**,而不是让人点了才发现失败。
 */

export interface AudioChannelFacts {
  configured: boolean
  apiKeyConfigured: boolean
  models: Array<{ id: string; purpose: 'music' | 'voice'; capabilities: Record<string, boolean> }>
}

export interface AudioTaskFacts {
  id: string
  state: 'queued' | 'running' | 'awaiting-review' | 'failed'
  purpose: 'music' | 'voice'
}

export interface AudioBoardSummary {
  /** 还排着队、点「跑队列」就会真发出去的条数(**这就是这一跑要花的请求数**)。 */
  queued: number
  running: number
  awaitingReview: number
  failed: number
  /** 能不能点「跑队列」:有 queued 且渠道配好了。 */
  canRun: boolean
  /** 不能跑的原因(人话;能跑时为 null)。**先说不为什么,再给按钮**。 */
  blockedBy: string | null
}

/**
 * 面板要显示的那份判断。
 *
 * 两条纪律:
 *  - `queued` 就是**这一跑的花费**(一条任务 = 一次上游请求;TTS 一条 = 一行台词);
 *  - 渠道没配 / 没配密钥 / 目录为空 → `blockedBy` 说清查,**不**给一个点了必然失败的按钮。
 */
export function summarizeAudioBoard(channel: AudioChannelFacts | null, tasks: AudioTaskFacts[]): AudioBoardSummary {
  const counts = { queued: 0, running: 0, awaitingReview: 0, failed: 0 }
  for (const task of tasks) {
    if (task.state === 'queued') counts.queued += 1
    else if (task.state === 'running') counts.running += 1
    else if (task.state === 'awaiting-review') counts.awaitingReview += 1
    else counts.failed += 1
  }
  const blockedBy = channel === null || !channel.configured
    ? '还没配音频生成渠道(设置 → 插件 → GALFree):先填端点、密钥与模型目录'
    : channel.models.length === 0
      ? '这个渠道的模型目录是空的:添一条模型(要声明用途、协议与能力)才能建任务'
      : !channel.apiKeyConfigured
        ? '这个渠道没填密钥:多数上游会拒(401)。填上再跑,免得白跑一趟'
        : null
  return {
    ...counts,
    // 「能跑」= 渠道没问题 **且** 有排队中的任务 —— 空队列跑一次是白点。
    canRun: blockedBy === null && counts.queued > 0,
    blockedBy,
  }
}
