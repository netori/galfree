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
import { PLAYTEST_DEFAULT_WAIT_MINUTES, PLAYTEST_MAX_WAIT_MS, PLAYTEST_TIMEOUT_MS } from './playtest.ts'
import { COVER_TARGETS, expectedCoverSize } from './covers.ts'
import { renderVoiceBatchCsv, renderVoiceBatchJson } from './voice-batch.ts'
import { voiceProfileFromInput } from './voice-anchor.ts'
import type { ProjectService } from './project-service.ts'
import type { BibleChapter } from './bible.ts'
import type { SceneEdit } from './scene-form.ts'

function describe(error: unknown): string {
  if (error instanceof GalfreeError) return `[${error.code}] ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * 工具面要用、而接缝不拥有的那点**环境事实**(与面板同一个来源:设置文档)。
 *
 * 只有两件,都是"新建项目"必需的 —— 接缝的 `createProject` 要父目录与 SDK 界面模板,
 * 而这两样由宿主设置决定(面板经 `deps.config` / `deps.sdk` 拿同一份)。缺省 = 都没有,
 * 于是 `galfree_create_project` 如实拒绝并说清怎么补(不猜一个目录、不假装拷到了界面文件)。
 */
export interface GalfreeToolPorts {
  /** 新建项目的默认父目录(空 = 没配,让调用方显式给 `projects_root`)。 */
  defaultProjectsRoot?: () => string
  /** 钉版 SDK 目录(新建项目要从它拷 `screens.rpy` 等界面文件)。 */
  sdkDir?: () => string
}

/** 注册 GALFree 的 agent 工具;返回 disposer(cordis effect 用)。 */
export function registerGalfreeTools(
  ctx: Context & { tools: { register: (tool: unknown) => () => void } },
  service: ProjectService,
  ports: GalfreeToolPorts = {},
): () => void {
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
      '读 GALFree 项目的推导状态:场景(含戳状态)、素材槽、角色、设定集处境、音频池与引用处境、',
      'lint 与试玩。与工作台阶段板**同源**(都是推导出来的),用于回答"这个项目到哪一步了 / 还缺什么"。',
      '**`nextActions` 是"接着做什么"**:纯推导的行动清单,每条带 `actor`(human = 只有人能做的:',
      '盖审读戳 / 认可 / 发布拍板;agent = 你能自己做的)与 `target`(该动哪一场 / 哪个槽)。',
      '**不要自己从 problems 里推顺序** —— 就用这份(与面板上那行「下一步」同源)。',
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
          // 发布(T18):上次发布的产物在哪、还新不新(没发布过 = null);能不能发看 blockers。
          publish: progress.publish,
          // 音频(T17):池是派生的(扫 game/ 下的音频文件);悬空引用在 problems 里(定位到场景与行)。
          audio: {
            files: progress.audio.files.map((file) => file.path),
            references: progress.audio.references.map((reference) => ({
              ref: reference.ref, scene: reference.scene, line: reference.line, channel: reference.channel, found: reference.found,
            })),
            missing: progress.audio.missing.map((reference) => reference.ref),
            unused: progress.audio.unused,
            note: '接线写在 .rpy 里(`play music "audio/x.ogg" [loop]` / `stop music`);引用是**相对 game/ 的路径**。音乐与语音**也能生成**(v3 已批准:各自一条渠道,见 `galfree_audio_channel`),但接线与生成是两件事;试听靠试玩,认可靠人盖场景戳。',
          },
          lint: progress.lint,
          playtest: progress.playtest,
          // 界面主题(T31):换过皮没有、现在是什么主题、项目分辨率;`stale` = 记录的分辨率
          // 与项目现在的不一致(整套图要重出)。
          theme: progress.theme,
          // 「下一步」(T21):与面板那行「下一步」读的是**同一份推导** —— agent 不必自己从
          // problems 里推顺序(推法只有一份,长在 progress.ts 里)。
          nextActions: progress.nextActions,
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
          return '还没有配置图像渠道。请人到「设置 → 插件 → GALFree」填端点与密钥,点「获取模型」勾选模型 —— 没渠道时建任务会被如实拒绝。'
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
            attempts: task.attempts.map((attempt) => {
              const rejection = (task.rejections ?? []).find((entry) => entry.attempt === attempt.n)
              return {
                n: attempt.n,
                outcome: attempt.outcome,
                fingerprint: attempt.fingerprint ?? null,
                replacedFingerprint: attempt.replacedFingerprint ?? null,
                error: attempt.error ?? null,
                // 这一版被谁打回过、为什么(谁说的也是历史的一部分)。
                rejection: rejection === undefined ? null : { note: rejection.note, via: rejection.via, at: rejection.at },
                at: attempt.finishedAt,
              }
            }),
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
          history: task.attempts.map((attempt) => {
            const rejection = (task.rejections ?? []).find((entry) => entry.attempt === attempt.n)
            return {
              n: attempt.n,
              outcome: attempt.outcome,
              replaced: attempt.replacedFingerprint ?? null,
              error: attempt.error ?? null,
              rejection: rejection === undefined ? null : { note: rejection.note, via: rejection.via, at: rejection.at },
            }
          }),
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
      '用来回答"这张差分是拿谁当锚生成的""链断在哪一张"。',
      '**可以写链**:给了 `references` 就把这个角色的参考链整条换掉 —— 刚出好主视觉时,',
      '把它的路径写进链,之后这个角色的差分才会自动携链。这是**设定改动**(写登记簿),',
      '不是主观认可(审读戳仍然只能由人盖)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      character: { type: 'string', description: '只看/只改一个角色(省略 = 全部只读)' },
      references: {
        type: 'array',
        description: '要写进链的参考图(给 `character` 才有效;省略 = 只读)。每项 {path, note?};path 是项目内相对路径',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: '项目内相对路径,如 game/images/xiao_tang-base.png' },
            note: { type: 'string', description: '为什么挑它(制作备注)' },
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        const character = args.character ?? ''
        const references = Array.isArray(args.references) ? args.references : null
        if (references !== null) {
          if (character === '') return '写参考链需要 `character`(要改哪个角色的链)。'
          if (references.length === 0) return '写参考链至少要给一条 `{path}`;想清空就说清楚(本项目不支持空链写入)。'
          const [record] = (await service.characters(active)).filter((candidate) => candidate.id === character)
          if (record === undefined) {
            return `登记簿里没有角色「${character}」:先用登记簿把它登记上(galfree_project_status 能看到登记簿里的 id)。`
          }
          await service.upsertCharacter(active, {
            ...record,
            references: references.map((entry) => {
              const reference = (entry ?? {}) as { path?: unknown; note?: unknown }
              return {
                path: String(reference.path ?? ''),
                ...(typeof reference.note === 'string' && reference.note !== '' ? { note: reference.note } : {}),
              }
            }),
          })
        }
        const grid = await service.differentialGrid(active)
        const rows = character !== '' ? grid.characters.filter((entry) => entry.character === character) : grid.characters
        return JSON.stringify({
          wrote: references === null ? null : character,
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
                task: entry.taskId,
                n: entry.n,
                outcome: entry.outcome,
                fingerprint: entry.fingerprint ?? null,
                replacedFingerprint: entry.replacedFingerprint ?? null,
                error: entry.error ?? null,
                rejected: entry.rejection === undefined ? null : { note: entry.rejection.note, via: entry.rejection.via },
              })),
              degradation: cell.degradation?.code ?? null,
              lastError: cell.lastError ?? null,
            })),
          })),
        }, null, 2)
      } catch (error) {
        return `参考链操作没执行:${describe(error)}`
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_publish',
    description: [
      '把项目**发布成可发行物**(T18:钉版 SDK 的 `build_dists`,默认 `pc` 包)。',
      '前置没过(板上有 lint 错 / 素材缺 / 音频引用悬空 / SDK 未就绪)**就不构建**,',
      '如实把缺项列出来 —— 先照着修,再发。产物落在**项目源树之外**的输出目录里,',
      '路径与状态进推导板。平台上传与在线分发**不做**(spec Out of Scope)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      packages: {
        type: 'array',
        description: '要打哪些包(省略 = ["pc"] = Windows+Linux;Android 需要另配 Android SDK)',
        items: { type: 'string' },
      },
      readiness_only: { type: 'boolean', description: '只看前置检查、不构建(默认 false)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      try {
        if (args.readiness_only === true) {
          return JSON.stringify(await service.publishReadiness(active), null, 2)
        }
        const report = await service.publish(active, {
          ...(Array.isArray(args.packages) && args.packages.length > 0 ? { packages: args.packages } : {}),
        })
        return JSON.stringify({
          ok: report.ok,
          ready: report.ready,
          // 被阻止时:逐项列缺项(与推导板同一份判断)。
          blockers: report.blockers,
          destination: report.destination,
          packages: report.packages,
          run: report.run === undefined
            ? null
            : {
                at: report.run.at,
                exitCode: report.run.exitCode,
                artifacts: report.run.artifacts.map((artifact) => ({ name: artifact.name, path: artifact.path, bytes: artifact.bytes })),
                logTail: report.run.ok ? null : report.run.logTail,
              },
        }, null, 2)
      } catch (error) {
        return `发布未执行:${describe(error)}`
      }
    },
  })))

  // ─── 项目工作周期(T20):建项目 / 列项目 / 切激活位 ──────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_create_project',
    description: [
      '项目工作周期:新建一个 GALFree 项目 / 列出全部项目 / 切换激活项目。',
      '**新建**从插件模板落一个真的 Ren\'Py 项目目录(界面文件从钉版 SDK 拷),并立刻切为激活项目;',
      '父目录取 `projects_root`,没给就用设置里的默认父目录 —— 两处都没有会如实拒绝,请人先在设置里填。',
      '**删除不做**(这一票没有这个动作):项目目录是人的东西,删只有在文件管理器里删。',
      '这是全流程的第一步:没有项目时,别的 galfree 工具都只会让你先建一个。',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'create = 新建;list = 列出;activate = 切换激活项目' },
      name: { type: 'string', description: 'create 用:项目名(slug:小写字母/数字/下划线/连字符)' },
      title: { type: 'string', description: 'create 用:显示标题(缺省 = 项目名)' },
      projects_root: { type: 'string', description: 'create 用:父目录绝对路径(省略 = 用设置里的默认父目录)' },
      project: { type: 'string', description: 'activate 用:项目 id 或唯一 name' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const action = String(args.action ?? '')
      try {
        if (action === 'list') {
          const projects = await service.listProjects()
          return JSON.stringify({
            projects: projects.map((project) => ({
              id: project.id, name: project.name, title: project.title,
              root: project.root, active: project.active, missing: project.missing,
            })),
            active: projects.find((project) => project.active)?.name ?? null,
          }, null, 2)
        }
        if (action === 'activate') {
          const ref = String(args.project ?? '')
          if (ref === '') return 'activate 需要 `project`(项目 id 或唯一 name);先 action: "list" 看一眼。'
          // 一次解析(id 或唯一 name,与别的工具的 `project` 同口径),不自己另立一套匹配规则。
          const projects = await service.listProjects()
          const hit = projects.find((project) => project.id === ref || project.name === ref)
          if (hit === undefined) {
            const known = projects.map((project) => project.name)
            return `没有这个项目:${ref}${known.length === 0 ? '(现在一个项目都没有,先 action: "create")' : `(现有:${known.join('、')})`}`
          }
          await service.setActive(hit.id)
          return JSON.stringify({ ok: true, active: { id: hit.id, name: hit.name, root: hit.root } }, null, 2)
        }
        if (action !== 'create') {
          return `不认识的 action:${action || '(空)'} —— 只有 create / list / activate(删除不做)。`
        }

        const name = String(args.name ?? '')
        if (name === '') return 'create 需要 `name`(slug:小写字母/数字/下划线/连字符)。'
        const projectsRoot = String(args.projects_root ?? '') !== '' ? String(args.projects_root) : (ports.defaultProjectsRoot?.() ?? '').trim()
        if (projectsRoot === '') {
          throw new GalfreeError('no-projects-root', '未指定项目父目录:给 `projects_root`,或请人在设置里填「新建项目的默认父目录」')
        }
        const project = await service.createProject({
          projectsRoot,
          name,
          ...(String(args.title ?? '') === '' ? {} : { title: String(args.title) }),
          // 界面文件从钉版 SDK 的 GUI 模板拷 —— 少了它们项目连关窗都会崩(见契约「模板的界面层」)。
          ...(ports.sdkDir === undefined ? {} : { sdkDir: ports.sdkDir() }),
        })
        return JSON.stringify({
          ok: true,
          project: { id: project.id, name: project.name, title: project.title, root: project.root },
          next: '立刻可以写设定集(galfree_story_bible),然后请人盖「设定定稿」戳 —— 没盖章时逐场生成会被 bible-not-final 拒。',
        }, null, 2)
      } catch (error) {
        return `项目操作未执行:${describe(error)}`
      }
    },
  })))

  // ─── 设定集(T20):它是下游所有生成的唯一记忆源 ──────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_story_bible',
    description: [
      '设定集(项目的第一记忆源):读 / 写 / 导入人写的大纲原文。',
      '**write** 写世界观与章节(存**意图**,不存正文;单字段上限见接缝),给 `characters` 会同步落**角色登记簿**',
      '(同一张脸只有一处说明)。写设定集是**设定改动**,不是主观认可 —— agent 可以写。',
      '**import_outline** 只搬**人写的**原文,逐字落盘:不要顺手改写/整理它(原文即权威)。',
      '**「设定定稿」戳只有人能盖**:没盖章时逐场生成会被 `bible-not-final` 拒 —— 那不是故障,是"去请人盖戳"。',
      '改过已定稿的设定集,戳会自动变成"待复审",下游生成同样被拒。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', required: true, description: 'read = 读;write = 写; import_outline = 导入人写的大纲原文' },
      theme: { type: 'string', description: 'write 用:一句话主题' },
      world: { type: 'string', description: 'write 用:世界观(人的意图,不是叙述正文)' },
      chapters: {
        type: 'array',
        description: 'write 用:章节骨架(**整段替换**,不做逐字段合并)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '章节 id(slug,如 ch1)' },
            title: { type: 'string', required: true, description: '章节标题' },
            outline: { type: 'string', description: '这一章的梗概(存意图,不抄正文)' },
            scenes: { type: 'array', required: true, description: '这一章覆盖的场景 label(还没有就填空数组 —— 接缝要求它是数组)', items: { type: 'string' } },
          },
        },
      },
      characters: {
        type: 'array',
        description: 'write 用:角色设定卡(同步落角色登记簿;外观是**结构化字段**,不是散文)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '角色 id(登记簿 key,slug,如 xiao_tang)' },
            name: { type: 'string', required: true, description: '显示名(如 小棠)' },
            voice: { type: 'string', description: '.rpy 里 define 的变量名(如 xiao_tang)—— 对剧本的引用' },
            appearance: {
              type: 'object',
              description: '外观设定卡(生成时的一致性锚)',
              additionalProperties: false,
              properties: {
                hair: { type: 'string', description: '发色/发型' },
                eyes: { type: 'string', description: '瞳色' },
                outfit: { type: 'string', description: '服装' },
                build: { type: 'string', description: '体型/年龄感' },
                notes: { type: 'string', description: '其他外观要点' },
              },
            },
            style_anchor: { type: 'string', description: '画风锚:出图时强制带上的风格提示词' },
            note: { type: 'string', description: '制作备注(不是叙述内容)' },
          },
        },
      },
      text: { type: 'string', description: 'import_outline 用:人写的原文(**逐字**落盘,不要改写)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const action = String(args.action ?? '')
      try {
        if (action === 'read') {
          const [doc, outline, progress] = await Promise.all([
            service.bible(active),
            service.bibleOutline(active),
            service.progress(active),
          ])
          return JSON.stringify({
            bible: doc,
            outline,
            board: progress.bible,
            outlineFingerprintOk: progress.bible.outlineFingerprintOk,
            next: progress.bible.stamp === 'approved' ? null : '还没定稿:请人在工作台盖「设定定稿」戳,盖上才能逐场生成。',
          }, null, 2)
        }

        if (action === 'import_outline') {
          const text = String(args.text ?? '')
          if (text.trim() === '') throw new GalfreeError('bible-invalid', '大纲原文不能为空')
          await service.importOutline(active, text)
          const progress = await service.progress(active)
          return JSON.stringify({
            ok: true,
            chars: text.length,
            board: progress.bible,
            next: '原文已逐字落盘。要让它变成可生成的骨架,再 write 章节与角色(原文不要改)。',
          }, null, 2)
        }

        if (action !== 'write') {
          return `不认识的 action:${action || '(空)'} —— 只有 read / write / import_outline。`
        }

        // 有给的字段才写(缺省 = 不动那一格);章节**整段替换**(接缝的口径,不做逐字段合并)。
        const records = args.characters === undefined
          ? undefined
          : await mergeCharacterCards(service, active, args.characters as Array<Record<string, unknown>>)
        await service.writeBible(active, {
          ...(args.theme === undefined ? {} : { theme: String(args.theme) }),
          ...(args.world === undefined ? {} : { world: String(args.world) }),
          ...(args.chapters === undefined ? {} : { chapters: args.chapters as BibleChapter[] }),
          ...(records === undefined ? {} : { characters: records as never }),
        }, { via: 'agent' })

        const progress = await service.progress(active)
        return JSON.stringify({
          ok: true,
          bible: progress.bible,
          characters: (await service.characters(active)).map((record) => record.id),
          next: progress.bible.stamp === 'approved'
            ? null
            : '请人在工作台盖「设定定稿」戳:没盖章时生成会被 bible-not-final 拒(这是设计,不是故障)。',
        }, null, 2)
      } catch (error) {
        return `设定集操作未执行:${describe(error)}`
      }
    },
  })))

  // ─── 场景编辑(T20):与面板「场景」卡同一条写路 ──────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_edit_scene',
    description: [
      '逐行编辑一场戏(读行模型 / 改一行 / 整段换源),与工作台「场景」卡**同一条写路**:经写网关 + 自动快照 + 归属规则。',
      '**read** 给行模型(每行是什么:对白/图像/跳转/音频…)与源文本,改之前先看它。',
      '**edit** 的 `edit` 是一个结构化指令:`setDialogue` / `setImage` / `insertStatement` / `deleteStatement` / `replaceSource`。',
      '**结构编辑只对生成目录(`game/scenes/<label>.rpy`)里的场景开放** —— 手写文件里的场景要么用 `replaceSource`',
      '(直接改那个文件),要么请人在工作台点「搬进生成目录」(搬家重写的是人的手写文件,**只能由人发起**)。',
      '改完不会抛错:返回落盘路径、解析/校验结果与问题清单 —— 照它当场修,别换个名字绕开。',
      '接线音频用 `galfree_wire_audio`(它写的是同一种行,但会把池与悬空引用一并报回来)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', required: true, description: 'read = 读行模型;edit = 应用一条编辑指令' },
      label: { type: 'string', required: true, description: '场景 label(如 scene_one)' },
      edit: {
        type: 'object',
        description: 'edit 用:一条结构化编辑指令(kind 决定其余字段)',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, description: 'setDialogue / setImage / insertStatement / deleteStatement / replaceSource' },
          line: { type: 'number', description: 'setDialogue / setImage / deleteStatement:改哪一行(行号见 read 的 rows)' },
          speaker: { type: 'string', description: 'setDialogue:说话人变量名(空 = 旁白)' },
          text: { type: 'string', description: 'setDialogue:台词(只写台词,不写引号)' },
          role: { type: 'string', description: 'setImage:show / scene / hide' },
          tag: { type: 'string', description: 'setImage:图像 tag(如 bg / xiao_tang)' },
          attributes: { type: 'array', description: 'setImage:属性(如 ["smile"])', items: { type: 'string' } },
          after_line: { type: 'number', description: 'insertStatement:插在这一行之后' },
          anchor: { type: 'string', description: 'insertStatement:插在这一行**原文**之后(比行号稳;要插在某行之前,锚它的上一行)' },
          source: { type: 'string', description: 'insertStatement / replaceSource:要写进去的 `.rpy` 源文本' },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const label = String(args.label ?? '')
      if (label === '') return '需要 `label`(要编辑哪一场;先 galfree_project_status 看有哪些)。'
      try {
        if (String(args.action ?? '') === 'read') {
          const form = await service.sceneForm(active, label)
          return JSON.stringify({
            label: form.label,
            path: form.path,
            file: form.file,
            readOnly: form.readOnly,
            readOnlyReason: form.readOnlyReason ?? null,
            rows: form.rows,
            source: form.source,
          }, null, 2)
        }
        if (String(args.action ?? '') !== 'edit') {
          return `不认识的 action:${String(args.action ?? '') || '(空)'} —— 只有 read / edit(搬家只能由人发起,没有这个动作)。`
        }
        const parsed = sceneEditOf(args.edit)
        if ('problem' in parsed) return parsed.problem
        const report = await service.editScene(active, { label, edit: parsed.edit })
        const scene = report.progress.scenes.find((candidate) => candidate.label === label) ?? null
        return JSON.stringify({
          // `ok` 说的是**这次编辑**(解析 + 这一场的校验,都是接缝给的布尔,适配器不重算规则);
          // 整块板的处境看 `lint` 与 `scene.marks` —— 项目别处的毛病不算这次编辑的账。
          ok: report.parseOk && report.validation.ok,
          path: report.path,
          parseOk: report.parseOk,
          validation: { validator: report.validation.validator, ok: report.validation.ok },
          issues: report.issues.map((issue) => ({ severity: issue.severity, code: issue.code, file: issue.file, line: issue.line, message: issue.message })),
          lint: report.progress.lint,
          scene: scene === null ? null : { stamp: scene.stamp, readOnly: scene.readOnly, marks: scene.marks },
          next: '改完请人读一遍、盖场景戳才算这一幕定稿(戳只有人能盖)。',
        }, null, 2)
      } catch (error) {
        return `场景编辑未执行:${describe(error)}`
      }
    },
  })))

  // ─── 音频接线(T20):池是派生的,接线就是写 `.rpy` 那一行 ─────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_wire_audio',
    description: [
      '音频:看池 / 接线 / 停声道。**接线**这一半是把文件接进来(池是派生的:文件在 `game/` 下就有它);**生成**那一半走 galfree_audio_channel 看渠道。',
      '**pool** 列 `game/` 下的音频文件(池是派生的:人把文件丢进去就有它,删掉就没了)与引用处境。',
      '**wire / stop** 就是往场景里写一行 `play music "audio/rain.ogg" loop` / `stop music` —— 引用是',
      '**相对 `game/` 的路径**。写完当场把池与引用处境报回来:文件不在池里会**立刻**显示成悬空',
      '(板上是 error,发布前置也会被它拦下),别留着不管。',
      '试听靠试玩;认可靠人盖场景戳。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', required: true, description: 'pool = 看池与引用;wire = 接一行 play;stop = 停声道' },
      label: { type: 'string', description: 'wire / stop 用:写在哪一场' },
      line: { type: 'number', description: 'wire / stop 用:写在哪一行(galfree_edit_scene 的 read 给行号)' },
      channel: { type: 'string', description: 'wire / stop 用:music / sound / voice' },
      file: { type: 'string', description: 'wire 用:音频文件(相对 game/ 的路径,如 audio/rain.ogg)' },
      loop: { type: 'boolean', description: 'wire 用:循环播放(默认 false)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const action = String(args.action ?? '')
      try {
        if (action === 'pool') {
          const pool = await service.audioPool(active)
          return JSON.stringify({
            ...audioViewOf(pool),
            note: '接线的写法:`play music "audio/rain.ogg" [loop]` / `stop music`;引用是**相对 game/ 的路径**。',
          }, null, 2)
        }
        if (action !== 'wire' && action !== 'stop') {
          return `不认识的 action:${action || '(空)'} —— 只有 pool / wire / stop。`
        }
        const label = String(args.label ?? '')
        if (label === '') return `${action} 需要 \`label\`(写在哪一场)。`
        // 声道 / 动作 / 必填文件的闸门在**接缝**上(`editScene` → invalid-audio):这里只搬运,
        // 规则不在这条路上单独存在,面板走同一条路也吃同一套判断。
        await service.editScene(active, {
          label,
          edit: {
            kind: 'setAudio',
            line: Number(args.line ?? 0),
            action: action === 'stop' ? 'stop' : 'play',
            channel: String(args.channel ?? '') as 'music' | 'sound' | 'voice',
            file: action === 'stop' ? null : String(args.file ?? ''),
            loop: args.loop === true,
          },
        })
        const pool = await service.audioPool(active)
        const view = audioViewOf(pool)
        return JSON.stringify({
          ok: true,
          wrote: action === 'stop' ? `stop ${String(args.channel ?? '')}` : `play ${String(args.channel ?? '')} "${String(args.file ?? '')}"${args.loop === true ? ' loop' : ''}`,
          audio: view,
          next: view.missing.length === 0
            ? '引用都落地了。试听靠试玩(galfree_playtest);认可靠人盖场景戳。'
            : `**悬空引用**:${view.missing.map((entry) => `${entry.ref}(${entry.scene}:${entry.line})`).join('、')} —— 把文件放进 game/(相对路径照上面写的那个),或改成池里已有的路径。`,
        }, null, 2)
      } catch (error) {
        return `音频操作未执行:${describe(error)}`
      }
    },
  })))

  // ─── 快照历史与回滚(T20):spec US22 说"从工作台/对话里都能查" ─────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_snapshot',
    description: [
      '快照历史 / 版本对比 / 回滚(**每个写批自动一条快照**,作者 GALFree;永不 push)。',
      '**history** 给一个文件的历次快照(最新在前,带 commit / 说明 / 时间);',
      '**diff** 给两个版本之间改了什么(原话,不是摘要);',
      '**rollback** 把一个文件回滚到历史版本 —— 它**也是写**:经网关,于是回滚本身也留下一条新快照(可以再回滚回去)。',
      '回滚会覆盖当前内容:回之前先 `diff` 看清要丢掉什么。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', required: true, description: 'history = 历次快照;diff = 两版对比;rollback = 回滚到某一版' },
      path: { type: 'string', required: true, description: '项目内相对路径(如 game/scenes/scene_one.rpy / .studio/bible/bible.json)' },
      from: { type: 'string', description: 'diff 用:起始 commit(history 里的 commit)' },
      to: { type: 'string', description: 'diff 用:目标 commit;rollback 用:回滚到哪个 commit' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const path = String(args.path ?? '')
      if (path === '') return '需要 `path`(项目内相对路径)。'
      const action = String(args.action ?? '')
      try {
        if (action === 'history') {
          const entries = await service.snapshotHistory(active, path)
          return JSON.stringify({
            path,
            entries: entries.map((entry) => ({ commit: entry.commit, subject: entry.subject, author: entry.author, at: entry.at })),
            note: entries.length === 0 ? '这个文件还没有快照(没写过?路径对不对?)' : '最新在前;diff/rollback 用其中的 commit。',
          }, null, 2)
        }
        if (action === 'diff') {
          const from = String(args.from ?? '')
          const to = String(args.to ?? '')
          if (from === '' || to === '') return 'diff 需要 `from` 与 `to`(两个 commit;先 action: "history")。'
          return JSON.stringify({ path, from, to, diff: await service.snapshotDiff(active, path, from, to) }, null, 2)
        }
        if (action === 'rollback') {
          const to = String(args.to ?? '')
          if (to === '') return 'rollback 需要 `to`(回滚到哪个 commit;先 action: "history")。'
          const result = await service.snapshotRollback(active, path, to)
          return JSON.stringify({
            ok: true,
            path,
            to,
            batchId: result.batchId,
            next: '回滚本身也是一条快照:再 action: "history" 能看到它,想反悔就回滚到回滚前那一版。',
          }, null, 2)
        }
        return `不认识的 action:${action || '(空)'} —— 只有 history / diff / rollback。`
      } catch (error) {
        return `快照操作未执行:${describe(error)}`
      }
    },
  })))

  // ─── 试玩(T20):用钉版 SDK 真跑一次,退出回传 ───────────────────────
  //
  // 描述里那几句"要人去点关窗口""默认等 3 分钟"是**契约不是客套**(T24 / #32):
  // 用户报的"卡住"就发生在模型与人都以为这是条快命令的时候。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_playtest',
    description: [
      '一键试玩:用**钉版 SDK** 真跑一次游戏(会开真窗口,退出后回传)。',
      '**这条命令会等 —— 等的是人去把那个游戏窗口关掉**(窗口没关,它就一直在等):',
      `默认最多等 ${PLAYTEST_DEFAULT_WAIT_MINUTES} 分钟,到点中止进程并如实报"等满多久、为什么停";`,
      '想等更久/更短用 `timeout_seconds`。取消(打断这一轮)会让它**立刻**停,不会拖到上限',
      '(取消是中止信号,不保证游戏进程当场就没了 —— 若那个窗口还开着,请人手动关掉)。',
      '所以别把它当成一条"几百毫秒"的快命令来安排:跑之前告诉人"游戏窗口要开了,看完请关掉它"。',
      '技术通过是**推导**(退出码 + 日志干净),不是人盖的戳:退出码非 0 或日志里有 traceback 就如实报失败,',
      '并把 traceback 摘要带回来给你照它修。**"玩过了、行"只有人能说**(盖场景戳)—— 技术通过不等于好玩。',
      '`from` 给一个场景 label 就**从那一场开始**(做法是在副本里覆写 start,你的项目一个字节都不动)。',
      'SDK 没就绪会如实拒绝(`sdk-not-ready`):先去工作台/设置完成 SDK 供给。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      from: { type: 'string', description: '从哪一场开始试玩(省略 = 从头);label 必须在剧本里存在' },
      timeout_seconds: {
        type: 'number',
        description: `等多久算久(秒;省略 = ${PLAYTEST_DEFAULT_WAIT_MINUTES * 60} 秒)。到点会中止游戏进程并如实报"等满多久"`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const requested = Number(args.timeout_seconds ?? Number.NaN)
      const timeoutMs = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.round(requested * 1000), PLAYTEST_MAX_WAIT_MS)
        : PLAYTEST_TIMEOUT_MS
      try {
        const run = await service.playtestStart(active, String(args.from ?? '') === '' ? null : String(args.from), {
          // 宿主的协作式取消:谁等谁就得自己观察这个信号。**不能指望注册表** ——
          // `defineTool` 的 `timeoutMs` 只是声明,没人执行它(本部署也没装那个 policy)。
          signal: exec?.signal,
          timeoutMs,
        })
        const waitedSeconds = Math.round(run.elapsedMs / 1000)
        const board = (await service.progress(active)).playtest
        return JSON.stringify({
          ok: run.technicalPass,
          exitCode: run.exitCode,
          technicalPass: run.technicalPass,
          timedOut: run.timedOut,
          waitedSeconds,
          // "进程真停了没有"照实说:没停就别替它说"已杀掉"(窗口可能还开着)。
          processStopped: run.killed,
          traceback: run.traceback,
          from: run.from ?? null,
          at: run.at,
          board: board === null ? null : { state: board.state, technicalPass: board.technicalPass, from: board.from },
          next: run.timedOut
            ? (run.killed
                ? `窗口一直没关,等满 ${waitedSeconds} 秒就中止了(进程已停,账本记的是"没跑成")。`
                : `窗口一直没关,等满 ${waitedSeconds} 秒我发了中止信号,但它**没有退出** —— 那个窗口可能还开着,请人手动关掉它。`)
              + '要么请人把窗口关掉后重跑;要么这次本来就只是看一眼窗口能不能开 —— 那就够了。'
            : run.technicalPass
              ? '技术通过。请人玩一遍并盖场景戳("玩过了、行"只有人能说);界面图也是这一刻生成进项目的。'
              : `没通过,照 traceback 修完再跑一次:${run.traceback ?? '(没有 traceback,看退出码)'}`,
        }, null, 2)
      } catch (error) {
        // 取消不是"试玩失败":如实说它没发生,而且账本没记 —— 别让人以为板上多了一条事实。
        // **也不替它说"进程已停"**:那一刻的确认结果(`killed`)在失败路径上拿不到,
        // 说不准的事就只说信号那半句。
        if (error instanceof GalfreeError && error.code === 'aborted') {
          return '试玩被取消:这一轮的取消信号到了,这次运行不再往下走,账本没有记这一条(它不是一个结果)。'
            + '如果那个游戏窗口还开着,说明它没响应中止信号 —— 请人手动关掉它。'
        }
        return `试玩未执行:${describe(error)}`
      }
    },
  })))

  // ─── 封面(T30 / #38):主菜单 / 游戏内菜单 / 窗口图标 ────────────────
  //
  // 这三张是 Ren'Py 的界面生成器**不覆盖**的那三张(`gui7/images.py` 的 `overwrite=False`);
  // 走**同一个图像渠道与同一条任务队列** —— 所以本工具是搬运工,不另造一条管线。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_cover_art',
    description: [
      "出**封面类**的图:主菜单背景 / 游戏内菜单背景 / 窗口图标(这三张正是 Ren'Py 的界面生成器**不会覆盖**的那三张)。",
      '走**同一个图像渠道、同一条任务队列**(与素材槽出图一样):产物经写网关落盘、进快照。',
      '`action: "targets"` 先看有哪些目标与各自的尺寸规格 —— **尺寸别猜**:菜单背景要项目分辨率的宽高比,'
        + '图标要正方形;尺寸错了引擎不报错、只是画面歪。',
      '`action: "create"` 建任务(要 `target` + `model` + `prompt`);`run: true` 则建完立刻跑(会真花一次上游额度)。',
      '**出得来不等于好看**:"这封面行不行"只有人能说 —— 重 roll 与拒收注记走 `galfree_reroll_image` 那一套。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', description: 'targets = 看有哪些目标与规格;create = 建任务(缺省)' },
      target: { type: 'string', description: 'main_menu / game_menu / window_icon(先 action:"targets" 看规格)' },
      model: { type: 'string', description: '图像渠道里的模型 id(先 galfree_image_channel 看目录)' },
      prompt: { type: 'string', description: '制作指令(风格/情绪/画面;不是叙述内容)' },
      size: { type: 'string', description: '尺寸/宽高比(模型不支持会被降级并说明)' },
      run: { type: 'boolean', description: '建完立刻跑(缺省 false:入队,等跑队列)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const action = String(args.action ?? 'create')
      if (action === 'targets') {
        return JSON.stringify({
          targets: COVER_TARGETS.map((target) => ({
            id: target.id,
            path: target.path,
            readBy: target.readBy,
            expected: expectedCoverSize(target),
            note: target.spec.note,
          })),
          note: "这三张是 Ren'Py 的界面生成器**不覆盖**的(其余界面图由引擎首次运行时生成)。"
            + '尺寸规格从钉版 SDK 的 gui7 参数读出;挑模型用 galfree_image_channel。',
        }, null, 2)
      }
      if (action !== 'create') return `不认识的 action:${action} —— 只有 targets / create。`
      try {
        const task = await service.createCoverTask(active, {
          target: String(args.target ?? ''),
          model: String(args.model ?? ''),
          prompt: String(args.prompt ?? ''),
          ...(typeof args.size === 'string' && args.size !== '' ? { size: args.size } : {}),
          ...(args.run === true ? { run: true } : {}),
        })
        return JSON.stringify({
          ok: task.state !== 'failed',
          target: task.target ?? null,
          outputPath: task.outputPath,
          state: task.state,
          model: task.model,
          ...(task.degradation === undefined ? {} : { degradation: task.degradation }),
          ...(task.lastError === undefined ? {} : { lastError: task.lastError }),
          next: task.state === 'failed'
            ? `没出成:${task.lastError ?? '(看账本)'}`
            : task.state === 'awaiting-review'
              ? '出好了 → 请人看一眼("这封面行不行"只有人能说);不满意用 galfree_reroll_image 重 roll,并把"为什么不行"记成注记。'
              : '已入队。跑它:在工作台的「素材板」点跑队列,或用 galfree_art_queue 看队列。',
        }, null, 2)
      } catch (error) {
        return `封面任务没建起来:${describe(error)}`
      }
    },
  })))

  // ─── 语音批量清单(T29 / #37):不花上游额度的那条路 ──────────────────
  //
  // 为什么给它一个 agent 入口:这是"没有 TTS 渠道也能把语音做出来"的那条路 ——
  // agent 能导出清单、能在人跑完本地工具之后导回,而**不需要**先有一家 API。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_voice_batch',
    description: [
      '**语音批量清单**(不花上游额度):把每一句对白摊成"谁、哪一句、id、目标文件名",导出给本地 TTS 批量跑,再把音频按文件名收回来。',
      '`action: "list"` 给清单(CSV 与 JSON 都在返回里;id **就是文件名** `game/voice/<id>.ogg`,与 `config.auto_voice` 同口径 —— ADR-0013)。',
      '`action: "import"` 把 `drop_dir` 里那些按 id 命名的音频**经写网关**收进 `game/voice/`。',
      '导回会逐条报四类:**收进来的 / 缺的 / 重复的 / 对不上 id 的** —— 静默跳过等于"以为配齐了、玩的时候没声音"。',
      '**没有本地 TTS 也能用**:清单里就有台词原文,你把它交给任何能"文本 → 音频文件"的工具即可。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', description: 'list = 导出清单(缺省);import = 把本地产物收回来' },
      drop_dir: { type: 'string', description: 'import 用:本地 TTS 产出所在的**绝对目录**(文件名 = id)' },
      format: { type: 'string', description: 'list 用:csv(缺省)或 json' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const action = String(args.action ?? 'list')
      try {
        if (action === 'list') {
          const batch = await service.voiceBatch(active)
          const format = String(args.format ?? 'csv')
          const payload = format === 'json' ? renderVoiceBatchJson(batch) : renderVoiceBatchCsv(batch)
          return JSON.stringify({
            rows: batch.rows.length,
            missingVoiceFiles: batch.missingVoiceFiles,
            extension: batch.extension,
            note: 'id **就是文件名**:导回时按 `<id>.<ext>` 命名即可(后缀 ogg/mp3/wav 都认)。'
              + '已经生成过的那些在清单里标着 missing:false,不用重跑。',
            [format === 'json' ? 'json' : 'csv']: payload,
          }, null, 2)
        }
        if (action === 'import') {
          const dropDir = String(args.drop_dir ?? '')
          if (dropDir === '') return 'import 需要 `drop_dir`(本地 TTS 产出所在的绝对目录)。'
          const report = await service.importVoiceFiles(active, { dropDir })
          return JSON.stringify({
            ok: true,
            imported: report.imported,
            missing: report.missing.map((row) => ({ dialogueId: row.dialogueId, scene: row.scene, text: row.text })),
            duplicates: report.duplicates,
            unknownFiles: report.unknownFiles,
            next: report.missing.length === 0
              ? '齐了 —— 语音文件都在 game/voice/ 下。**听还是靠试玩**;认可由人盖场景戳。'
              : `还欠 ${report.missing.length} 条(见 missing)。缺的那些在试玩里就是"这一句没声音"。`,
          }, null, 2)
        }
        return `不认识的 action:${action} —— 只有 list / import。`
      } catch (error) {
        return `语音批量清单没跑成:${describe(error)}`
      }
    },
  })))

  // ─── 音频生成渠道(T27 / ADR-0012):**音乐与语音各一条**,建任务之前先看这个 ──
  //
  // 为什么给它一个读入口:建音乐/语音任务要一个**属于那条渠道**的 model id,
  // 而"音乐那条配了没、语音那条配了没、各自的目录里有什么"在别处看不到
  // (账本只记跑过什么)。两张卡各配各的之后,这一步更必要:两条渠道的模型目录**不通用**。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_audio_channel',
    description: [
      '读**两条**音频生成渠道的处境:音乐一条、语音(TTS)一条(配没配、有哪些模型、每个模型声明了什么能力)。',
      '**建音频任务之前先看这个**:模型的 id 必须属于**那条**渠道的目录 —— 两条目录不通用',
      '(把音乐模型 id 递到语音那条会被如实拒绝)。',
      '**不含密钥**:只说配没配。没配时照着返回里的 `where` 去设置那一段填(音乐与语音是两段)。',
      '语音还有一条**不花额度**的路:没有 TTS 渠道也能做 —— 用 `galfree_voice_batch` 导出清单,本地工具跑完再按 id 导回。',
    ].join(' '),
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      try {
        const channels = await service.audioChannels()
        const view = (purpose: 'music' | 'voice') => {
          const channel = channels[purpose]
          const label = purpose === 'music' ? '音乐生成' : '语音(TTS)生成'
          const where = purpose === 'music'
            ? '设置 → 插件 → GALFree 的「音乐生成渠道」那一段(端点 + 密钥 + 模型目录)'
            : '设置 → 插件 → GALFree 的「语音生成渠道」那一段(端点 + 模型目录);或者走 galfree_voice_batch 那条不花额度的路'
          return {
            purpose,
            configured: channel.configured,
            ...(channel.name === undefined ? {} : { name: channel.name }),
            ...(channel.baseUrl === undefined ? {} : { baseUrl: channel.baseUrl }),
            apiKeyConfigured: channel.apiKeyConfigured,
            models: channel.models.map((model) => ({ id: model.id, label: model.label, adapter: model.adapter, capabilities: model.capabilities, note: model.note })),
            ...(channel.configured && channel.models.length > 0 ? {} : { where }),
            note: channel.configured
              ? `${label}渠道配好了:${channel.models.length} 个模型`
              : `还没配${label}渠道 —— 建那一类任务会被如实拒绝(不假装能生成)`,
          }
        }
        return JSON.stringify({ music: view('music'), voice: view('voice') }, null, 2)
      } catch (error) {
        return `读不到音频渠道:${describe(error)}`
      }
    },
  })))

  // ─── 声音锚(T32 / #40):每个角色一份参考音频 ─────────────────────────
  //
  // 这一票的起因是发起人的那个问题:「IndexTTS 没有设计音色的功能,该如何保持声音一致性?」
  // 答案(调研 `docs/research-indextts-voice.md` 坐实的):音色**只由参考音频决定**,
  // 所以"同一把嗓子"= 每个角色固定一段音色库里的参考样本,建语音任务时**自动带上**。
  // 工具面因此只需要一件事:读处境 + 写那条档案(读目录/清掉/读音色库各一个 action)。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_voice_anchor',
    description: [
      '**声音锚**(T32):每个角色一份参考音频(音色档案),让跨场同角色**同一把嗓子**。',
      '`action: "read"`(缺省)给整部戏的嗓子清单:每个角色用的是哪段参考、谁还没有档案、',
      '剧本里哪些说话人还没登记。建语音任务时会**自动**按 `dialogueId` 派生的说话人携链 —— 所以缺档案的角色会听起来跟别人一样。',
      '`action: "set"` 给一个角色写/改音色档案(要 `character` + `sample`);`action: "clear"` 清掉它。',
      '`action: "library"` 去问那台语音服务**它有哪些嗓子**(`GET /health` `/speakers` `/voices`;不花额度)——',
      '`voices` 是**参考样本文件名**,`dir` 是你要把音频文件丢进去的那个目录。',
      '**硬事实**(实测,不是猜):`sample` 与 `ref_sample` 是**服务端音色库里的文件名**,不是项目内路径 ——',
      '那台服务没有上传接口,只能人把文件放进 `voices/`;`speaker` 是 LoRA 适配器名(**不是音色**,缺省 `default`);',
      '改音色是**设定改动**,不是主观认可(审读戳仍只能由人盖)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', description: 'read(缺省)/ set / clear / library' },
      character: { type: 'string', description: 'set / clear 用:登记簿里的角色 id(如 xiao_tang)' },
      sample: { type: 'string', description: 'set 用:**服务端音色库里的文件名**(如 xiao_tang.wav),不是项目内路径' },
      speaker: { type: 'string', description: 'set 用:LoRA 适配器名(缺省 default;**它不是音色**)' },
      lang: { type: 'string', description: 'set 用:语言(缺省由适配器给,如 ZH)' },
      emotion: {
        type: 'object',
        additionalProperties: false,
        description: 'set 用:情感输入(不给 = 服务端自己的缺省,通常是"跟着参考样本走")',
        properties: {
          mode: { type: 'string', description: 'follow = 跟着参考样本 / reference = 另给情感参考音频 / vector = 8 维向量 / text = 情感描述文本' },
          ref_sample: { type: 'string', description: 'mode=reference:情感参考音频(**也在音色库里**按文件名找)' },
          weight: { type: 'number', description: '情感强度 0–1' },
          vector: { type: 'array', items: { type: 'number' }, description: 'mode=vector:**恰好 8 个数**(喜/怒/哀/惧/厌恶/低落/惊喜/平静)' },
          text: { type: 'string', description: 'mode=text:情感描述' },
        },
      },
      note: { type: 'string', description: 'set 用:制作备注(这段样本哪儿来的、什么情绪)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目。'
      const action = String(args.action ?? 'read')
      try {
        if (action === 'set' || action === 'clear') {
          const id = String(args.character ?? '')
          if (id === '') return `${action} 需要 \`character\`(要改哪个角色的嗓子;id 见 read 的返回)。`
          const record = (await service.characters(active)).find((candidate) => candidate.id === id)
          if (record === undefined) return `登记簿里没有角色「${id}」:先把它登记上,再给它记音色档案。`
          if (action === 'clear') {
            await service.upsertCharacter(active, { ...record, voiceProfile: undefined })
          } else {
            const emotion = args.emotion as Record<string, unknown> | undefined
            await service.upsertCharacter(active, {
              ...record,
              // **解析走同一个函数**(路由与工具是同一份形状判断):自己手工拼一遍
              // 会让两条入口的规矩分叉(trim 与否、哪些字段能空),而那种分叉只在真合成时才显形。
              voiceProfile: voiceProfileFromInput({
                sample: args.sample,
                ...(typeof args.speaker === 'string' ? { speaker: args.speaker } : {}),
                ...(typeof args.lang === 'string' ? { lang: args.lang } : {}),
                ...(emotion === undefined
                  ? {}
                  : {
                      emotion: {
                        mode: emotion.mode,
                        refSample: emotion.ref_sample,
                        weight: emotion.weight,
                        vector: emotion.vector,
                        text: emotion.text,
                      },
                    }),
                ...(typeof args.note === 'string' ? { note: args.note } : {}),
              }),
            })
          }
        } else if (action !== 'read' && action !== 'library') {
          return `不认识的 action:${action} —— 只有 read / set / clear / library。`
        }

        const library = action === 'library' ? await service.readVoiceLibrary(active) : null
        const board = await service.voiceAnchors(active)
        return JSON.stringify({
          wrote: action === 'set' || action === 'clear' ? String(args.character ?? '') : null,
          rows: board.rows.map((row) => ({
            character: row.character,
            name: row.name,
            speakerVar: row.speakerVar ?? null,
            sample: row.sample,
            speaker: row.speaker,
            emotion: row.emotion?.mode ?? null,
            inLibrary: row.inLibrary,
            note: row.note ?? null,
          })),
          withoutProfile: board.withoutProfile,
          unregisteredSpeakers: board.unregisteredSpeakers,
          unusedSamples: board.unusedSamples,
          library: {
            files: board.library.files,
            dir: board.library.dir ?? null,
            /** `null` = 还没核对过(不是"库里没有")。 */
            readAt: service.voiceLibrary()?.at ?? null,
            ...(library === null ? {} : {
              reachable: library.reachable,
              speakers: library.speakers ?? null,
              // `default` 是**LoRA 名**(本机没训过 LoRA ⇒ 恒只有它),不是"一个可选音色"。
              speakersNote: '这些是 LoRA 适配器名(不是音色);只有 default = 没训过任何说话人模型',
              health: library.health ?? null,
              problems: library.problems,
            }),
          },
          next: board.withoutProfile.length === 0
            ? '每个角色都有音色档案了 —— 建语音任务时会自动带上(触发重合成要看账本里的 queued)。'
            : `还差 ${board.withoutProfile.length} 个角色没嗓子(见 withoutProfile):给它们各记一条音色档案,否则那几句会用服务端缺省(听起来跟别人一样)。`,
        }, null, 2)
      } catch (error) {
        return `声音锚操作没执行:${describe(error)}`
      }
    },
  })))

  // ─── 界面换皮(T31 / #39):给 Ren'Py 自带的界面生成器一组参数 ──────────
  //
  // 这一票**不是 AI 出图**:`game/gui/*.png` 那一整套是引擎自己按九宫格模板画的
  // (`launcher/game/gui7/` + `_gui_images()`)。所以入口是"给参数":主色 / 辅色 / 明暗 /
  // 分辨率。产物经写网关落盘 + 一条快照;人看得见"当前主题是什么"。

  disposers.push(ctx.tools.register(defineTool({
    name: 'galfree_theme',
    description: [
      "**游戏内界面换皮**:给 Ren'Py 自带的界面生成器一组参数(主色 accent / 辅色 boring / 明暗 light / 分辨率),",
      '在 staging 副本里跑一次钉版 SDK,把整套界面图(`game/gui/`,五十来张)**经写网关**写进项目 + 一条快照。',
      '`action: "read"` 先看现状:当前是什么主题、项目分辨率、这套颜色长什么样(`palette` 按引擎的 tint/shade/HSV 规则算)。',
      '`action: "preview"` 看这一下要动多少文件(整套替换,不是增量)。',
      '`action: "apply"` 真换(要 `accent`;会真起一次引擎、真写几十个文件)。',
      '**分辨率**默认取项目当前的那个:界面图是按它缩放的,给一个对不上的值会被**如实拒绝**'
        + '(不出一套歪的图)。',
      '**整套替换**:`game/gui/` 下新的一套里没有的旧图会被删掉(留一张旧主题的图 = 界面上留一块旧颜色)。',
      '封面 / 主菜单背景 / 窗口图标是**例外**(生成器不覆盖那三张)—— 那三张走 `galfree_cover_art`。',
      '**好不好看只有人能说**:换完请人跑一次试玩看一眼(本工具不替人拍板)。',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: '项目 id 或唯一 name;省略 = 当前激活项目' },
      action: { type: 'string', description: 'read = 看现状(缺省);preview = 看要动多少;apply = 真换' },
      accent: { type: 'string', description: 'apply 用:主色(#rrggbb),如 #c94f7c' },
      boring: { type: 'string', description: 'apply 用:辅色(文本框/底衬那一族;缺省 #000000)' },
      light: { type: 'boolean', description: 'apply 用:亮色主题(缺省 false = 暗色)' },
      width: { type: 'number', description: 'apply 用:分辨率宽(缺省 = 项目当前那个;对不上会被拒)' },
      height: { type: 'number', description: 'apply 用:分辨率高(缺省 = 项目当前那个)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const active = await resolveProject(service, args.project)
      if (active === null) return '没有激活项目:先建一个(galfree_create_project)。'
      const action = String(args.action ?? 'read')
      try {
        if (action === 'read') {
          const view = await service.theme(active)
          return JSON.stringify({
            applied: view.applied,
            appliedAt: view.appliedAt,
            resolution: view.resolution,
            palette: view.palette,
            stale: view.stale,
            label: view.label,
            note: 'palette 是按引擎的 tint/shade/HSV 规则算出来的那一套(会写进 gui.rpy 的颜色 define)。'
              + 'stale = 记录的分辨率与项目现在的不一致 → 整套图要按新分辨率重出。'
              + '封面那三张(main_menu / game_menu / window_icon)不在这里,走 galfree_cover_art。',
          }, null, 2)
        }
        const spec = {
          ...(typeof args.accent === 'string' && args.accent !== '' ? { accent: args.accent } : {}),
          ...(typeof args.boring === 'string' && args.boring !== '' ? { boring: args.boring } : {}),
          ...(typeof args.light === 'boolean' ? { light: args.light } : {}),
          ...(typeof args.width === 'number' ? { width: args.width } : {}),
          ...(typeof args.height === 'number' ? { height: args.height } : {}),
        }
        if (action === 'preview') {
          const preview = await service.previewTheme(active, { spec })
          return JSON.stringify({
            spec: preview.spec,
            resolution: preview.resolution,
            from: preview.from,
            // 图归图、别的那两份(`gui.rpy` 与 `.studio/theme.json`)另记 —— 混成一个数
            // 会让"整套替换"那句话对不上账。
            images: preview.images,
            extraWrites: preview.extraWrites,
            added: preview.added,
            replaced: preview.replaced,
            removed: preview.removed,
            note: `换皮是**整套替换**:这一次要写 ${preview.images} 张界面图`
              + `(${preview.replaced} 张覆盖 + ${preview.added} 张新增),另加 ${preview.extraWrites} 份`
              + `(gui.rpy 的颜色 define 与 .studio/theme.json)`
              + `${preview.removed.length === 0 ? ';删掉哪些旧图要等出完图才知道' : `,并删掉 ${preview.removed.length} 个旧图`}`
              + ' —— 一条快照,可回滚。',
          }, null, 2)
        }
        if (action !== 'apply') return `不认识的 action:${action} —— 只有 read / preview / apply。`
        if (spec.accent === undefined) return 'apply 至少要给 `accent`(主色,如 #c94f7c)。'
        const report = await service.applyTheme(active, { spec }, { via: 'agent' })
        return JSON.stringify({
          ok: true,
          label: report.label,
          images: report.images,
          added: report.added,
          replaced: report.replaced,
          removed: report.removed,
          batchId: report.batchId,
          next: '整套界面图换完了。**好不好看只有人能说** —— 请人跑一次试玩(工作台/`galfree_playtest`)看一眼。'
            + '不满意就用同样的参数换一个配色,或改 accent / light 再来一次(每次一条快照,能回滚)。',
        }, null, 2)
      } catch (error) {
        return `界面换皮没成:${describe(error)}`
      }
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * 工具面的 `edit` → 接缝的 `SceneEdit`。
 *
 * 这是**参数搬运**(适配器的本职):认不出来的 kind 返回 null,由调用方给出"怎么给"的说明。
 * **枚举与范围一律不在这里判** —— 声道 / role / 行号这些规则住在接缝(`editScene` 与
 * `applySceneEdit`),因为写进 `.rpy` 的每一行都要是引擎认的语法,而别的适配器(面板路由)
 * 也走同一条路。适配器自己判一遍,就等于规则只活在一条路上。
 */
function sceneEditOf(raw: unknown): { edit: SceneEdit } | { problem: string } {
  if (raw === null || typeof raw !== 'object') return { problem: '需要 `edit`(一条结构化编辑指令,kind 决定其余字段;先 action: "read" 看行号)。' }
  const edit = raw as Record<string, unknown>
  switch (String(edit.kind ?? '')) {
    case 'setDialogue':
      return { edit: { kind: 'setDialogue', line: Number(edit.line ?? 0), speaker: String(edit.speaker ?? '') === '' ? null : String(edit.speaker), text: String(edit.text ?? '') } }
    case 'setImage':
      return {
        edit: {
          kind: 'setImage',
          line: Number(edit.line ?? 0),
          role: String(edit.role ?? '') as 'show' | 'scene' | 'hide',
          tag: String(edit.tag ?? ''),
          attributes: Array.isArray(edit.attributes) ? edit.attributes.map(String) : [],
        },
      }
    case 'insertStatement':
      return {
        edit: {
          kind: 'insertStatement',
          ...(edit.anchor === undefined ? {} : { anchor: String(edit.anchor) }),
          ...(edit.after_line === undefined ? {} : { afterLine: Number(edit.after_line) }),
          source: String(edit.source ?? ''),
        },
      }
    case 'deleteStatement':
      return { edit: { kind: 'deleteStatement', line: Number(edit.line ?? 0) } }
    case 'replaceSource':
      return { edit: { kind: 'replaceSource', source: String(edit.source ?? '') } }
    // 音频那一行**不在这里改**:它有自己的工具(池 + 悬空引用的回执都在那边),
    // 免得同一个动作有两条入口、两套回执。
    case 'setAudio':
      return { problem: '改音频那一行请用 `galfree_wire_audio`(它会顺带把音频池与悬空引用报回来);这里只管对白 / 图像 / 插入 / 删除 / 整段换源。' }
    default:
      return { problem: `不认识的 edit.kind:${String(edit.kind ?? '') || '(空)'} —— 只有 setDialogue / setImage / insertStatement / deleteStatement / replaceSource(音频用 galfree_wire_audio)。` }
  }
}

/**
 * 角色设定卡:**读-改-写**,保住参考链。
 *
 * 为什么必须在这里合并:登记簿的 `upsertCharacter` 是**整条替换**,而这张工具契约里
 * 根本没有 `references` 这个字段(链归 `galfree_reference_chain`)。若照直送一个空数组,
 * 写一次设定卡就会把 T16 攒起来的链**静默抹掉** —— 而契约明写"不给空链入口"。
 * 所以:没给链 = 不动它(拿现有记录的那条填回去);给了 `references` 的调用方另有其人。
 */
async function mergeCharacterCards(
  service: ProjectService,
  project: string,
  cards: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const existing = new Map((await service.characters(project)).map((record) => [record.id, record]))
  return cards.map((card) => {
    const keep = existing.get(String(card.id ?? ''))
    return {
      id: String(card.id ?? ''),
      name: String(card.name ?? ''),
      ...(card.voice === undefined ? {} : { voice: String(card.voice) }),
      appearance: (card.appearance ?? {}) as Record<string, string>,
      ...(card.style_anchor === undefined ? {} : { styleAnchor: String(card.style_anchor) }),
      references: keep?.references ?? [],
      ...(card.note === undefined ? {} : { note: String(card.note) }),
    }
  })
}

/** 音频池 → 工具面那份视图(两个 action 用的是同一份投影,不写两遍)。 */
function audioViewOf(pool: Awaited<ReturnType<ProjectService['audioPool']>>): {
  files: string[]
  references: Array<{ ref: string; scene: string; line: number; channel: string; found: boolean }>
  missing: Array<{ ref: string; scene: string; line: number }>
  unused: string[]
} {
  return {
    files: pool.files.map((file) => file.path),
    references: pool.references.map((reference) => ({ ref: reference.ref, scene: reference.scene, line: reference.line, channel: reference.channel, found: reference.found })),
    missing: pool.missing.map((reference) => ({ ref: reference.ref, scene: reference.scene, line: reference.line })),
    unused: pool.unused,
  }
}

/** 项目 id 或唯一 name → 激活项目 id(工具面统一的入口解析)。 */
async function resolveProject(service: ProjectService, project: string | undefined): Promise<string | null> {
  if (project !== undefined && project !== '') return project
  return (await service.getActiveProject())?.id ?? null
}
