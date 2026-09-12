/**
 * agent 工具(宿主侧适配器):把接缝能力暴露给模型。
 *
 * **薄适配器,零独占逻辑**:参数校验、调用接缝、把结果讲清楚 —— 判断一律在
 * `ProjectService` 里(生成落在哪、一 label 一文件、上下文门禁、写批与快照)。
 *
 * 生成"失败"不抛异常,而是把事实(解析/校验/问题)如实交回:模型看到 lint 错才能当场修,
 * 而不是收到一句"失败了"再去猜。真正的接缝错误(归属违规、未定稿、空内容)才抛。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GalfreeError } from './error.ts'
import type { ProjectService } from './project-service.ts'

function describe(error: unknown): string {
  if (error instanceof GalfreeError) return `[${error.code}] ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** 注册 GALFree 的 agent 工具;返回 disposer(cordis effect 用)。 */
export function registerGalfreeTools(ctx: Context & { tools: { register: (tool: unknown) => () => void } }, service: ProjectService): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_generate_scene',
    description: [
      '在 GALFree 项目里生成/重生成**一场戏**,写入 game/scenes/<label>.rpy(经写网关 → 自动快照)。',
      '返回:落盘路径、解析结果、校验回路结果、问题清单、以及写完之后的推导板快照。',
      '校验不通过不会抛错,而是在返回里如实给出 issues/lint —— 请据它当场修正后**再调用一次同名 label** 重生成。',
      '一个 label 只归一个文件:若该 label 目前住在 game/script.rpy(手写/模板),本工具会拒绝并告诉你先搬走。',
      '生成内容只允许方言子集语法(见 dialect-subset 契约):label / 对白 / menu / jump / call / return /',
      'scene / show / hide / with / pause / play|stop music|sound|voice。子集外的构造会让该场降级只读。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      label: { type: 'string', required: true, description: '场景 label(标识符),如 scene_one' },
      source: { type: 'string', required: true, description: '完整的 .rpy 段落,含 `label <label>:` 起头,缩进 4 空格' },
      next_label: { type: 'string', description: '续接目标:下一场的 label(给了就校验它存在)' },
      require_final_bible: {
        type: 'boolean',
        description: '是否要求"定稿设定集"作为上下文(默认 true:生成要先有权威记忆源)',
      },
    },
    output: {
      // 规范输出:**一段给模型看的文本**(报告已经是 JSON 文本,内含结构化的 lint/issue)。
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const projectRef = args.project !== undefined && args.project !== '' ? args.project : undefined
      const active = projectRef ?? (await service.getActiveProject())?.id
      if (active === undefined || active === null) {
        return '没有激活项目:先在工作台新建或激活一个项目。'
      }
      try {
        const report = await service.generateScene(active, {
          label: args.label,
          source: args.source,
          nextLabel: args.next_label ?? null,
          // 默认要求定稿设定集:没有权威记忆源就生成,等于让模型凭空编。
          requireContext: args.require_final_bible ?? true,
          outline: undefined,
        })
        return JSON.stringify({
          ok: report.validation.ok && report.parseOk,
          path: report.path,
          action: report.action,
          parseOk: report.parseOk,
          validation: { validator: report.validation.validator, ok: report.validation.ok },
          issues: report.issues.map((issue) => ({
            severity: issue.severity, code: issue.code, file: issue.file, line: issue.line, message: issue.message,
          })),
          lint: report.progress.lint,
          scene: report.progress.scenes.find((scene) => scene.label === report.label) ?? null,
          derivedSlots: report.progress.slots.map((slot) => ({ slot: slot.slot, filled: slot.filled, stamp: slot.stamp })),
          awaitingReview: report.progress.summary.awaitingReview,
          bibleTheme: report.context?.theme ?? null,
        }, null, 2)
      } catch (error) {
        // 接缝的拒绝是**可执行的指令**(搬走 label / 先定稿),原样给模型,别吞成"失败了"。
        return `生成未执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_project_status',
    description: [
      '读 GALFree 项目的推导状态:场景(含戳状态)、素材槽、角色、设定集处境、lint 与试玩。',
      '与工作台阶段板**同源**(都是推导出来的),用于回答"这个项目到哪一步了 / 还缺什么"。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const projectRef = args.project !== undefined && args.project !== '' ? args.project : undefined
      const active = projectRef ?? (await service.getActiveProject())?.id
      if (active === undefined || active === null) return '没有激活项目。'
      try {
        const progress = await service.progress(active)
        return JSON.stringify({
          scenes: progress.scenes.map((scene) => ({
            label: scene.label, file: scene.file, stamp: scene.stamp, readOnly: scene.readOnly,
            missingDialogue: scene.missingDialogue, missingSlots: scene.missingSlots, marks: scene.marks,
          })),
          slots: progress.slots.map((slot) => ({ slot: slot.slot, filled: slot.filled, stamp: slot.stamp, scenes: slot.origin.scenes })),
          characters: progress.characters.map((character) => ({ id: character.id, defined: character.defined, hasStyleAnchor: (character.styleAnchor ?? '') !== '' })),
          bible: progress.bible,
          lint: progress.lint,
          playtest: progress.playtest,
          summary: progress.summary,
          problems: progress.problems.slice(0, 20),
        }, null, 2)
      } catch (error) {
        return `读不到项目状态:${describe(error)}`
      }
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
