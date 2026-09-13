/**
 * 音频生成卡(T27 / ADR-0012)的**判断**部分 —— 纯函数,单独放这里是为了能守卫。
 *
 * 面板里那些"要不要给按钮、会花几次请求、为什么没配好"都不写在组件里:
 * ADR-0002 的老规矩是**面板只渲染,判断在推导层**;而测试要能直接喂数据验这两条:
 *  1. **跑之前看得见"这一跑要花几条上游请求"**(TTS 按台词行计费,不看清就点很危险);
 *  2. 渠道没配好时**如实短路**,而不是让人点了才发现失败。
 *
 * 2026-09-13:音乐与语音**各一张卡**(各自一条渠道)。所以这里的入参多了一个 `purpose` ——
 * 卡的标题、"没配哪条渠道"、"模型目录是空的"这几句话都由它决定,而判断本身只有一份。
 */

/** 一条渠道的处境(面板读的那几个字段;密钥永远不在里面)。 */
export interface AudioChannelFacts {
  configured: boolean
  apiKeyConfigured: boolean
  models: Array<{ id: string; purpose: AudioPurpose; capabilities: Record<string, boolean> }>
}

/**
 * 用途类型**只定义在 service**(领域概念的唯一出处)—— 面板这一个 re-export
 * 是为了让"面板里到处 import 的仍是同一个名字",而不是又抄一份字面量联合。
 * 抄一份的代价很实在:哪天多一类(例如 sfx),客户端那几份不会跟着红。
 */
export type { AudioPurpose } from '../service/audio-generation.ts'
import type { AudioPurpose } from '../service/audio-generation.ts'

export interface AudioTaskFacts {
  id: string
  state: 'queued' | 'running' | 'awaiting-review' | 'failed'
  purpose: AudioPurpose
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

/** 用途 → 那张卡的说法(标题、渠道名、"没配"那句)。两块卡共用一份判断,只有措辞不同。 */
export function audioPurposeLabel(purpose: AudioPurpose): {
  /** 卡标题。 */
  title: string
  /** 设置里那一段叫什么(错误信息里要指得准)。 */
  section: string
  /** 没配时那句(错误码按用途分,面板也按用途说)。 */
  notConfigured: string
  /** 模型目录空时那句。 */
  emptyCatalog: string
} {
  return purpose === 'music'
    ? {
      title: '音乐生成',
      section: '音乐生成渠道',
      notConfigured: '还没配**音乐生成**渠道(设置 → 插件 → GALFree 的「音乐生成渠道」那一段):先填端点、密钥与模型目录',
      emptyCatalog: '音乐渠道的模型目录是空的:添一条音乐模型(如 Suno 类聚合站那条)才能建任务',
    }
    : {
      title: '语音生成',
      section: '语音(TTS)生成渠道',
      notConfigured: '还没配**语音(TTS)**渠道(设置 → 插件 → GALFree 的「语音生成渠道」那一段):先填端点与模型目录'
        + ' —— 或者走「语音批量清单」那条不花额度的路',
      emptyCatalog: '语音渠道的模型目录是空的:添一条 TTS 模型(要声明能不能克隆音色、收不收参考音频)才能建任务',
    }
}

/**
 * 面板要显示的那份判断(**只数这一条用途的任务**)。
 *
 * 三条纪律:
 *  - `queued` 就是**这一跑的花费**(一条任务 = 一次上游请求;TTS 一条 = 一行台词);
 *  - 渠道没配 / 没配密钥 / 目录为空 → `blockedBy` 说清查,**不**给一个点了必然失败的按钮;
 *  - 数的是**本用途**的:音乐那张卡上的"排队 3 条"不该把语音的任务算进来
 *    (点了「跑队列」音乐卡不会去跑语音的任务)。
 */
export function summarizeAudioBoard(purpose: AudioPurpose, channel: AudioChannelFacts | null, tasks: AudioTaskFacts[]): AudioBoardSummary {
  const counts = { queued: 0, running: 0, awaitingReview: 0, failed: 0 }
  for (const task of tasks) {
    if (task.purpose !== purpose) continue
    if (task.state === 'queued') counts.queued += 1
    else if (task.state === 'running') counts.running += 1
    else if (task.state === 'awaiting-review') counts.awaitingReview += 1
    else counts.failed += 1
  }
  const label = audioPurposeLabel(purpose)
  const blockedBy = channel === null || !channel.configured
    ? label.notConfigured
    : channel.models.length === 0
      ? label.emptyCatalog
      : !channel.apiKeyConfigured
        // 密钥那一条**只对音乐说**:语音那条多半是本机服务,根本不要密钥
        // (对着一个"没填密钥"的本地服务报 401 是猜的,不是事实)。
        ? purpose === 'music' ? '这个渠道没填密钥:多数上游会拒(401)。填上再跑,免得白跑一趟' : null
        : null
  return {
    ...counts,
    // 「能跑」= 渠道没问题 **且** 有排队中的任务 —— 空队列跑一次是白点。
    canRun: blockedBy === null && counts.queued > 0,
    blockedBy,
  }
}
