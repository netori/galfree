/**
 * agent 工具(宿主侧适配器):把接缝能力暴露给模型。
 *
 * **薄适配器,零独占逻辑**:参数校验、调用接缝、把结果讲清楚 —— 判断一律在
 * `ProjectService` 里(生成落在哪、一 label 一文件、上下文门禁、写批与快照)。
 *
 * 生成"失败"不抛异常,而是把事实(解析/校验/问题)如实交回:模型看到 lint 错才能当场修,
 * 而不是收到一句"失败了"再去猜。真正的接缝错误(归属违规、未定稿、空内容)才抛。
 *
 * 工具面与工作台**同一条队列 / 同一份推导**(T15 的 AC3):这里没有任何"工具专用的状态",
 * 每个工具都是接缝方法的搬运工 —— 所以"agent 改的,工作台上立刻看得到"是结构保证,不是巧合。
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

  // ─── 美术指导(T15):与工作台**同一条队列** ─────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_image_channel',
    description: [
      '读 GALFree 项目的图像渠道处境:配没配、有哪些模型可用、每个模型声明了什么能力。',
      '**建任务之前先看这个**:出图必须要一个渠道里的 model id;能力声明决定了哪些参数能发',
      '(不支持的会被如实降级,降级会记在任务上)。',
    ].join(' '),
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const channel = await service.imageChannel()
        if (!channel.configured) {
          return '还没有配置图像渠道。请人到「设置 → GALFree」填端点与密钥,点「获取模型」勾选模型 —— 没渠道时建任务会被如实拒绝。'
        }
        return JSON.stringify({
          channel: channel.name ?? channel.baseUrl,
          apiKeyConfigured: channel.apiKeyConfigured,
          models: channel.models.map((model) => ({ id: model.id, label: model.label, capabilities: model.capabilities, note: model.note })),
        }, null, 2)
      } catch (error) {
        return `读不到渠道:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_art_queue',
    description: [
      '读 GALFree 的素材出图队列:每个任务的目标槽、状态(排队/执行/待复审/失败)、提示词、',
      '降级说明、**完整重试历史**(含被替换掉的那一版的指纹)、以及**拒收注记**',
      '(人对某一版的否决理由,含是谁记的)。',
      '与工作台素材板**同源**(同一份任务账本),用来回答"哪些图还没出/出成什么样了/这张为什么被打回"。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      slot: { type: 'string', description: '只看某一个槽的任务(省略 = 全部)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const progress = await service.progress(active)
        const tasks = await service.generationTasks(active)
        const filtered = args.slot !== undefined && args.slot !== '' ? tasks.filter((task) => task.slot === args.slot) : tasks
        return JSON.stringify({
          pendingSlots: progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot),
          awaitingReview: progress.slots.filter((slot) => slot.awaitingReview).map((slot) => slot.slot),
          tasks: filtered.map((task) => ({
            id: task.id,
            slot: task.slot,
            state: task.state,
            model: task.model,
            prompt: task.prompt,
            outputPath: task.outputPath,
            referenceImages: task.referenceImages.map((reference) => reference.path),
            degradation: task.degradation ?? null,
            lastError: task.lastError ?? null,
            attempts: task.attempts.map((attempt) => ({
              n: attempt.n,
              outcome: attempt.outcome,
              fingerprint: attempt.fingerprint ?? null,
              replacedFingerprint: attempt.replacedFingerprint ?? null,
              error: attempt.error ?? null,
              // 这一版被谁打回过、为什么(空 = 没人打回过)。
              rejection: (task.rejections ?? []).find((entry) => entry.attempt === attempt.n)?.note ?? null,
              at: attempt.finishedAt,
            })),
            rejections: (task.rejections ?? []).map((entry) => ({ attempt: entry.attempt, note: entry.note, via: entry.via, at: entry.at })),
          })),
        }, null, 2)
      } catch (error) {
        return `读不到队列:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_generate_image',
    description: [
      '为一个**素材槽**建出图任务(Host 直连执行,不消耗对话回合)。槽必须是',
      '`galfree_project_status` 里列出的槽(它从 .rpy 的 show/scene 派生);提示词是给上游的',
      '制作指令。产物经写网关落盘 → 自动快照 → 板的"已填/待复审"推导立刻变绿。',
      '模型不支持你要的参数时,**任务参数会被自动降级并附说明**(降级不是失败)。',
      '批量补全待填槽用 `galfree_fill_missing_art`。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      slot: { type: 'string', required: true, description: '目标槽名(如 "xiao_tang smile";必须是派生的槽)' },
      model: { type: 'string', required: true, description: '渠道里的模型 id(先看 galfree_image_channel)' },
      prompt: { type: 'string', required: true, description: '给上游的制作指令(不是台词;不要抄叙述内容)' },
      size: { type: 'string', description: '尺寸/宽高比(模型不支持会被降级并说明)' },
      run: { type: 'boolean', description: '是否立刻执行(默认 true)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const task = await service.createGenerationTask(active, {
          slot: args.slot,
          model: args.model,
          prompt: args.prompt,
          ...(args.size === undefined || args.size === '' ? {} : { size: args.size }),
          run: args.run ?? true,
        })
        return JSON.stringify({
          ok: task.state === 'awaiting-review',
          id: task.id,
          slot: task.slot,
          state: task.state,
          outputPath: task.outputPath,
          degradation: task.degradation ?? null,
          lastError: task.lastError ?? null,
          attempts: task.attempts.length,
          next: task.state === 'awaiting-review' ? '产物已落盘,等人在素材板上盖审读戳;不满意可以重 roll。' : '没跑成,看 lastError。',
        }, null, 2)
      } catch (error) {
        // 接缝的拒绝是**可执行的指令**(先配渠道 / 槽名不对),原样给模型,别吞成"失败了"。
        return `出图未执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_reroll_image',
    description: [
      '重 roll 一个已存在的出图任务(不满意就再来一次)。**保留完整重试历史** ——',
      '这一次会记下"被它覆盖掉的那一版"的指纹,所以两版可以对比、旧版能从快照找回。',
      '可只改词不改槽:`prompt` 给了就用新词(比如"把小棠的怒颜重 roll 得更夸张")。',
      '**拒收注记**:人说了"这张为什么不行"(脸太圆/眼神太凶)就把它放进 `note` ——',
      '注记只追加、指向被拒的那一版,之后人和 agent 读 `galfree_art_queue` 都看得到。',
      '人没给理由就**不要**编一个:没理由就不记(note 省略)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      task_id: { type: 'string', description: '要重 roll 的任务 id(看 galfree_art_queue)' },
      slot: { type: 'string', description: '或者按槽名找最近一个任务(与 task_id 二选一)' },
      prompt: { type: 'string', description: '新的制作指令(省略 = 沿用原词)' },
      note: { type: 'string', description: '**人的**拒收理由原话(省略 = 没给理由,不编)' },
      run: { type: 'boolean', description: '是否立刻执行(默认 true)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        let id = args.task_id !== undefined && args.task_id !== '' ? args.task_id : undefined
        if (id === undefined) {
          const slot = args.slot ?? ''
          if (slot === '') return '需要 task_id 或 slot 之一(先看 galfree_art_queue)。'
          const hit = (await service.generationTasks(active)).find((task) => task.slot === slot)
          if (hit === undefined) return `槽「${slot}」还没有出图任务:先用 galfree_generate_image 建一个。`
          id = hit.id
        }
        const task = await service.retryGenerationTask(active, id, {
          ...(args.prompt === undefined || args.prompt === '' ? {} : { prompt: args.prompt }),
          // 注记是**替人转述**(`via:'agent'`),历史里能分清谁说的。
          ...(args.note === undefined || args.note.trim() === '' ? {} : { note: args.note, via: 'agent' as const }),
          run: args.run ?? true,
        })
        return JSON.stringify({
          ok: task.state === 'awaiting-review',
          id: task.id,
          slot: task.slot,
          state: task.state,
          prompt: task.prompt,
          attempts: task.attempts.length,
          history: task.attempts.map((attempt) => ({
            n: attempt.n,
            outcome: attempt.outcome,
            replaced: attempt.replacedFingerprint ?? null,
            error: attempt.error ?? null,
            rejection: (task.rejections ?? []).find((entry) => entry.attempt === attempt.n)?.note ?? null,
          })),
          lastError: task.lastError ?? null,
        }, null, 2)
      } catch (error) {
        return `重 roll 未执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_fill_missing_art',
    description: [
      '把板上**所有待填的素材槽**展开成出图任务并依次跑完(补全全部待填)。',
      '展开依据是推导(哪些槽还没有图),不是人维护的待办表;每个槽用它在'.concat('`') + '.studio/slots.json` 里挂的提示词,没挂就按槽名凑一句。',
      '与工作台素材板上的同一个按钮走同一条队列。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      model: { type: 'string', required: true, description: '渠道里的模型 id(先看 galfree_image_channel)' },
      run: { type: 'boolean', description: '是否立刻执行(默认 true)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const tasks = await service.createTasksForMissingSlots(active, { model: args.model, run: args.run ?? true })
        const progress = await service.progress(active)
        return JSON.stringify({
          created: tasks.length,
          tasks: tasks.map((task) => ({ id: task.id, slot: task.slot, state: task.state, degradation: task.degradation?.code ?? null, lastError: task.lastError ?? null })),
          stillMissing: progress.slots.filter((slot) => !slot.filled).map((slot) => slot.slot),
          awaitingReview: progress.slots.filter((slot) => slot.awaitingReview).map((slot) => slot.slot),
        }, null, 2)
      } catch (error) {
        return `补全未执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_character_art',
    description: [
      '把一个**角色**还没出的差分一次补齐(T16 的差分批量):主视觉先出,表情/姿势差分',
      '**自动携登记簿的参考链**(跨批次"同一张脸"靠它)。顺序由引用关系派生 ——',
      '谁的产物出现在别人的参考链里,谁先出;不是按槽名猜。',
      '链上有图还不存在时,该次任务会**如实降级并列出丢了哪张**(降级不是失败)。',
      '只想补全所有角色用 `galfree_fill_missing_art`;只想出一张用 `galfree_generate_image`。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      character: { type: 'string', required: true, description: '登记簿里的角色 id(如 "xiao_tang")' },
      model: { type: 'string', required: true, description: '渠道里的模型 id(先看 galfree_image_channel)' },
      run: { type: 'boolean', description: '是否立刻执行(默认 true)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const tasks = await service.createDifferentialTasks(active, {
          character: args.character,
          model: args.model,
          run: args.run ?? true,
        })
        const grid = await service.differentialGrid(active)
        const row = grid.characters.find((entry) => entry.character === args.character)
        return JSON.stringify({
          character: args.character,
          created: tasks.length,
          main: row?.main ?? null,
          references: (row?.references ?? []).map((reference) => ({ path: reference.path, exists: reference.exists })),
          tasks: tasks.map((task) => ({
            id: task.id,
            slot: task.slot,
            state: task.state,
            referenceImages: task.referenceImages.map((reference) => reference.path),
            degradation: task.degradation?.code ?? null,
            lastError: task.lastError ?? null,
          })),
          remaining: (row?.cells ?? []).filter((cell) => !cell.filled).map((cell) => cell.slot),
          awaitingReview: (row?.cells ?? []).filter((cell) => cell.awaitingReview).map((cell) => cell.slot),
        }, null, 2)
      } catch (error) {
        // 接缝的拒绝是可执行的指令(角色没登记 / 模型不在目录),原样交回。
        return `差分批量未执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_reference_chain',
    description: [
      '读参考链与槽位对比视图(T16):每个角色的差分网格 —— 哪一格是**主视觉**',
      '(登记簿的参考链指到的那一格)、链上每张参考此刻在不在磁盘上、以及每一格历史上',
      '出过哪几版、哪一版被人打回、理由是什么(拒收注记)。',
      '用来回答"这张差分是拿谁当锚生成的""链断在哪一张"。改链请让**人**在工作台的',
      '角色视图里改(那是制作设定),本工具只读。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      character: { type: 'string', description: '只看一个角色(省略 = 全部)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const grid = await service.differentialGrid(active)
        const rows = args.character !== undefined && args.character !== ''
          ? grid.characters.filter((entry) => entry.character === args.character)
          : grid.characters
        return JSON.stringify({
          characters: rows.map((row) => ({
            character: row.character,
            name: row.name,
            main: row.main,
            references: row.references.map((reference) => ({
              path: reference.path,
              exists: reference.exists,
              note: reference.note ?? null,
            })),
            cells: row.cells.map((cell) => ({
              slot: cell.slot,
              role: cell.role,
              filled: cell.filled,
              stamp: cell.stamp,
              awaitingReview: cell.awaitingReview,
              history: cell.history.map((entry) => ({
                n: entry.n,
                outcome: entry.outcome,
                fingerprint: entry.fingerprint ?? null,
                replacedFingerprint: entry.replacedFingerprint ?? null,
                error: entry.error ?? null,
                rejected: entry.rejection?.note ?? null,
              })),
              degradation: cell.degradation?.code ?? null,
              lastError: cell.lastError ?? null,
            })),
          })),
        }, null, 2)
      } catch (error) {
        return `读不到参考链:${describe(error)}`
      }
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 项目 id 或唯一 name → 激活项目 id(工具面统一的入口解析)。 */
async function resolveProject(service: ProjectService, project: string | undefined): Promise<string | null> {
  if (project !== undefined && project !== '') return project
  return (await service.getActiveProject())?.id ?? null
}
