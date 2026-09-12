/**
 * **流程闸门码的唯一出处**(T19)—— 挡住某个环节的那些码。
 *
 * 两个家族,同一份清单:
 *
 *  - **接缝抛出的拒绝**(`bible-not-final` / `stamp-forbidden` / `no-image-channel` /
 *    `sdk-not-ready`):撞上它不是故障,是"该做另一件事了"(多半是请人盖戳 / 去设置里配一下);
 *  - 有的闸门不是一条拒绝,而是板上的 error / 发布前置里的一项 —— 那种在 `playbook.ts` 的
 *    `gate` 里只讲**形状**(例如 `blockers[]`),不在这里编一个码出来。
 *
 * 为什么单独一份:同一批码有两个读者 —— 接缝在**抛**它们(`project-service` / `playtest` /
 * `publish` / 路由的状态码映射),流程指引在**讲**它们("没盖定稿戳时生成会被 `bible-not-final` 拒")。
 * 各写一份字面量的话,改了一边另一边会静默过期:模型会照着指引去撞一堵**不存在的墙**。
 * 守卫(`playbook.test.ts`)再真去撞一遍,拿接缝实际抛出来的码跟文本比对。
 *
 * 这里**只收指引会讲到的那几道闸门** —— 不是"所有错误码的字典"
 * (项目里还有几十个别的码,它们不需要跟提示词对齐)。
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
