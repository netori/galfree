/**
 * **渠道模板** —— 给新手的"填一组值"起点(不是"厂商数据库",也不是推荐位)。
 *
 * ## 为什么要有它
 *
 * 渠道三条线(图像 / 音乐 / 语音)每个键都要人自己填:端点、密钥、渠道名、
 * 一段模型目录 JSON。老手照文档抄一遍就完了,新手卡在**"我不知道该填什么"** ——
 * 而默认值全是空串(没有一个内置厂商),于是新手看到的是一张空表。
 * 这里的每条模板就是把**一次已经跑通的配置**固化下来:端点 + 一段模型目录 + 渠道名。
 *
 * ## 四条纪律(与 ADR-0012 的模板修订同源)
 *
 * 1. **密钥永远不填**:模板只管"端点与模型目录",密钥一律留给人 —— 缺 key 是
 *    "还差一步"的**显式状态**(工作台会如实拦住),不是"看起来配好了"的假象。
 * 2. **标签用域名,不用站方自称**:域名是可核对的**事实**;站方的自我形容,
 *    插件替它背书不合适。渠道名同理,只写域名。
 * 3. **模板不构成推荐或代销**:`consoleUrl` 只是"这家的充值页在哪"的**指路**,指向站点
 *    自己的页面、**不带任何推广码**(挂码就等于插件在替它拉客)。插件与这些站点无利益关系。
 * 4. **上游会变**:`capturedAt` 记的是"这条模板是哪天抄的";上游改了形状模板就会过期,
 *    所以这个日期必须带着,面板才能如实说"可能已过期",而不是假装它还是对的。
 *
 * ## 它**不是**什么
 *
 * · 不是适配器命名(适配器按**协议形状**命名,见 `src/service/audio-generation.ts`);
 * · 不是"预设数据库"(与 `theme-card.tsx` 那几套配色同一个态度:**给个起点**,填完照样能改);
 * · 不是 `presets/` 那个目录(那是「Galgame 制作」**agent 模式**,名字已被占用)。
 */
import type { AudioPurpose } from '../service/audio-generation.ts'

/** 三条会用到模板的渠道(发布输出目录没有端点与协议,不需要模板)。 */
export type TemplateChannel = 'image' | 'music' | 'voice'

export interface ChannelTemplate {
  /** 站点域名(**标签用它**:可核对的事实,不是站方自称)。 */
  site: string
  /** 这条模板管哪条线。 */
  channel: TemplateChannel
  /** 端点,直接写进 `{channel}BaseUrl`。 */
  baseUrl: string
  /** 渠道名,写进 `{channel}ChannelName`(默认与站点域名一致)。 */
  channelName: string
  /** 模型目录 JSON,写进 `{channel}Models` —— 与面板保存的格式**逐字同形**。 */
  models: string
  /**
   * **充值页**(站点自己的余额/充值页)。面板据此显示"去充值"。
   *
   * 两条硬规矩:指向**站点自己的页面**、**不带推广码**。
   * 我们不知道那家的充值页在哪时**不猜**(条目里没这一栏就不显示那个入口)。
   */
  consoleUrl?: string
  /** 抄这条模板的日期(YYYY-MM-DD)。上游会变,面板据此提示"可能已过期"。 */
  capturedAt: string
  /** 这条模板**实测到什么程度**,如实写(别把"照文档抄的"说成"跑通过的")。 */
  basis: string
  /** 给用户看的一行说明(代价、限制、注意事项)。 */
  note: string
}

/**
 * 图像目录(OpenAI 兼容基址那条线)。
 *
 * **能力只声明能确证的部分**:没勾的等于"不能干"(缺省为假),于是需要参考链/图生图的动作
 * 会**如实降级**,而不是发一个上游看不懂的请求 —— 这条比"多勾几个显得强"要紧得多。
 */
const SEEDANCE_IMAGE_MODELS = JSON.stringify([
  {
    id: 'zhenzhen-image-g-v2.5-flare',
    label: 'seedance.nz · 图像(v2.5-flare)',
    capabilities: {
      textToImage: true,
      imageToImage: false,
      referenceChain: false,
      aspectRatioParam: true,
      b64Json: false,
      urlResult: true,
    },
  },
], null, 2)

/** 音乐:那家网关自己的资源式协议(`async-task-rest`),`note` 里的键由 `musicRestPathsFromNote` 读。 */
const SEEDANCE_MUSIC_MODELS = JSON.stringify([
  {
    id: 'suno-generation',
    purpose: 'music',
    adapter: 'async-task-rest',
    label: 'seedance.nz · Suno 文生曲',
    note: 'model=suno;version=v6;format=mp3',
    capabilities: { textToMusic: true, instrumental: true },
  },
], null, 2)

/** 语音:同一家网关的异步音频任务(`/v1/audio/generations`),终态 `SUCCESS` + `data.result_url`。 */
const SEEDANCE_VOICE_MODELS = JSON.stringify([
  {
    id: 'doubao-seed-audio-1.0',
    purpose: 'voice',
    adapter: 'async-task-rest',
    label: 'seedance.nz · Seed Audio(豆包语音)',
    capabilities: { textToSpeech: true, voiceId: true },
  },
], null, 2)

/**
 * 小米 MiMo TTS 的模型目录。两条模型走**同一个端点**(`/v1/chat/completions`),
 * 只差 `model` 的值 —— 所以一个适配器写一次,两条都通。
 *
 * `voiceId` 勾的是"能给一个嗓子名字"这件事:`mimo-v2.5-tts` 用 9 个**预置音色 id**
 * (`冰糖`/`茉莉`/`苏打`…),`-voicedesign` 用的是**登记簿里那个角色的音色描述文字**。
 */
const MIMO_VOICE_MODELS = JSON.stringify([
  {
    id: 'mimo-v2.5-tts',
    purpose: 'voice',
    adapter: 'mimo-chat-tts',
    label: 'xiaomimimo.com · 预置音色(9 个)',
    note: 'voice=冰糖;format=mp3',
    capabilities: { textToSpeech: true, voiceId: true },
  },
  {
    id: 'mimo-v2.5-tts-voicedesign',
    purpose: 'voice',
    adapter: 'mimo-chat-tts',
    label: 'xiaomimimo.com · 文字设计音色(每个角色一段描述)',
    note: 'format=mp3',
    capabilities: { textToSpeech: true, voiceId: true },
  },
], null, 2)

/**
 * 四条模板。**顺序即面板上的顺序**(按渠道分组,同渠道内按常用度)。
 *
 * `basis` 一栏是**实测口径**,逐条如实:
 *  · seedance.nz 三条:端点在**发起人的生产配置里跑通过**(不是我们验证的),形状来自该站官方文档;
 *    音乐那条另有仓库里 2026-09-13 的真机验收记录(真发一次上游 + 只读轮询一次)。
 *  · 小米那条:协议由 2026-09-26 真机探针实测(音频在 `choices[0].message.audio.data` 的 base64;
 *    `format` 请求 mp3 回 MP3、请求 wav 回 WAV —— 两个 magic 字节都验过);
 *    适配器本身另走过一次**闭环验证**(调真适配器 → 真出网 → 落盘 → ffprobe 认成 24kHz 单声道 mp3)。
 *  两份记录都不是"照文档抄的"那一类 —— 但也**不是**"我们跑遍了所有路径":
 *  出图、出曲、Seed Audio 这三条我们没跑过(发起人自己跑过前两条)。
 */
export const CHANNEL_TEMPLATES: readonly ChannelTemplate[] = [
  {
    site: 'seedance.nz',
    channel: 'image',
    baseUrl: 'https://api.seedance.nz/v1',
    channelName: 'seedance.nz',
    models: SEEDANCE_IMAGE_MODELS,
    consoleUrl: 'https://api.seedance.nz/console/topup',
    capturedAt: '2026-09-26',
    basis: '端点与模型名照**发起人正在用的生产配置**抄(他那边出图跑通过);我们没跑过出图。能力只声明能确证的那几项。',
    note: '基址**带 `/v1`**(那家网关的路径都在 `/v1` 下)。没声明的能力(参考链/图生图)= 需要它们的动作会如实降级。',
  },
  {
    site: 'seedance.nz',
    channel: 'music',
    baseUrl: 'https://api.seedance.nz/v1',
    channelName: 'seedance.nz',
    models: SEEDANCE_MUSIC_MODELS,
    consoleUrl: 'https://api.seedance.nz/console/topup',
    capturedAt: '2026-09-26',
    basis: '提交/轮询形状 2026-09-13 在那家网关做过真机验收(真发一次上游 + 只读轮询一次);**发起人也说这条在他生产配置里跑通过**。',
    note: '计费按**路径 SKU**(`suno-*`),不是请求体里的 model;跑完上游回真扣费金额(`usage.amount`)。',
  },
  {
    site: 'seedance.nz',
    channel: 'voice',
    baseUrl: 'https://api.seedance.nz/v1',
    channelName: 'seedance.nz',
    models: SEEDANCE_VOICE_MODELS,
    consoleUrl: 'https://api.seedance.nz/console/topup',
    capturedAt: '2026-09-26',
    basis: '端点与终态口径来自该站文档(`SUCCESS` + `data.result_url`),适配器认的终态集合里已含 `success`;⚠️ **这条语音我们没真跑过** —— 发起人跑通的是图像与音乐。',
    note: '同一把嗓子靠 `metadata.speaker`(音色 id)或参考音频 —— 二选一且互斥。牌价约 ¥0.004/秒。',
  },
  {
    site: 'xiaomimimo.com',
    channel: 'voice',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    channelName: 'xiaomimimo.com',
    models: MIMO_VOICE_MODELS,
    consoleUrl: 'https://platform.xiaomimimo.com/console/balance',
    capturedAt: '2026-09-26',
    basis: '协议 2026-09-26 真机探针实测,适配器另走过一次**闭环验证**:调真适配器 → 真出网 → 落盘,ffprobe 认成 24kHz 单声道 mp3(预置音色与 voicedesign 两条都过)。',
    note: '**限时免费,官方没有公布免费期结束后的价格** —— 这条模板可能过期,以站点价格页为准。',
  },
]

/** 这条渠道有哪些模板(面板按渠道分组显示)。 */
export function templatesFor(channel: TemplateChannel): ChannelTemplate[] {
  return CHANNEL_TEMPLATES.filter((template) => template.channel === channel)
}

/** 面板草稿里与模板有关的那几个键(**只列名字,不 import 组件**:本模块要能被守卫单独 import)。 */
export interface TemplateDraftLike {
  imageBaseUrl: string
  imageChannelName: string
  imageModels: string
  musicBaseUrl: string
  musicChannelName: string
  musicModels: string
  voiceBaseUrl: string
  voiceChannelName: string
  voiceModels: string
}

/** 模板要写进草稿的那几个键(**类型上就没有密钥字段**)。 */
export interface TemplatePatch {
  baseUrl: string
  channelName: string
  models: string
}

/**
 * 模板 → 草稿补丁。套错了渠道会**抛**(而不是把音乐模板写进语音那一段)。
 *
 * **为什么在类型上就不给密钥字段**:套用模板最常见的场景是"我原来配了别家、现在换这家的
 * 端点试试"。这时若顺手把 `apiKey` 清掉或改空,人会在下一次跑任务时看到另一种失败,
 * 而**原因是他刚点了一个看起来无害的按钮** —— 那是"帮忙帮成了事故"。
 * 密钥只能由人在密钥框里自己改,所以这里不是"记得别写",是**根本写不出来**。
 */
export function templatePatchFor(channel: TemplateChannel, template: ChannelTemplate): TemplatePatch {
  if (template.channel !== channel) {
    throw new Error(`模板「${template.site}」是给「${template.channel}」那条线的,不能套到「${channel}」上`)
  }
  return { baseUrl: template.baseUrl, channelName: template.channelName, models: template.models }
}

/** 渠道 → 草稿里那三个键的名字(面板用它把补丁铺进草稿)。 */
export function templateKeys(channel: TemplateChannel): {
  baseUrl: keyof TemplateDraftLike
  channelName: keyof TemplateDraftLike
  models: keyof TemplateDraftLike
} {
  const prefix = channel === 'image' ? 'image' : channel
  return {
    baseUrl: `${prefix}BaseUrl` as keyof TemplateDraftLike,
    channelName: `${prefix}ChannelName` as keyof TemplateDraftLike,
    models: `${prefix}Models` as keyof TemplateDraftLike,
  }
}

/** 音频模板的用途(守卫用:音乐模板的目录必须声明 `purpose:"music"`,否则会被渠道过滤掉)。 */
export function templatePurpose(channel: TemplateChannel): AudioPurpose | undefined {
  return channel === 'music' ? 'music' : channel === 'voice' ? 'voice' : undefined
}
