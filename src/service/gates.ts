/**
 * 环节闸门(T19)—— **链路上那些"拒绝码"的唯一出处**。
 *
 * 为什么单独一份:同一批码有两个读者。
 *
 *  - 接缝在**抛**它们(`project-service` / `playtest` / `publish`);
 *  - 流程指引(playbook)在**讲**它们 —— "没盖定稿戳时生成会被 `bible-not-final` 拒"。
 *
 * 各写一份字面量的话,改了一边另一边会静默过期:模型会照着指引去撞一堵**不存在的墙**,
 * 或者撞上一堵指引没提过的墙。所以两边读同一个常量,而守卫
 * (`playbook.test.ts`)再**真去撞一遍**、拿接缝实际抛出来的码跟文本比对。
 *
 * 这里的码是"挡住了这一步"的意思 —— 撞上它不是故障,是"该做另一件事了"
 * (多半是请人盖戳 / 去设置里配一下)。指引里逐条写了对应的"怎么办"。
 */
export const GATE = {
  /** 下游生成要有「设定定稿」戳(没盖 / 盖过之后内容又改了,都拒)。 */
  bibleNotFinal: 'bible-not-final',
  /** 审读戳(场景 / 素材槽 / 设定定稿)只能人盖(ADR-0008):agent 侧没有这个动作。 */
  stampForbidden: 'stamp-forbidden',
  /** 出图要有图像渠道(端点 + 密钥 + 模型目录)。 */
  noImageChannel: 'no-image-channel',
  /** 试玩与发布都要钉版 SDK 就绪。 */
  sdkNotReady: 'sdk-not-ready',
} as const

/** 闸门码(接缝抛出的那些)。 */
export type GateCode = typeof GATE[keyof typeof GATE]
