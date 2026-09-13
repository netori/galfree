/**
 * **任务账本**的通用层(T27 / ADR-0012):状态机、尝试历史、拒收注记、读写纯函数。
 *
 * 为什么单列:图像那套(ADR-0010)本来就是"生成任务的形状",与**产什么**无关 ——
 * 状态机(`queued → running → awaiting-review | failed`)、"每次尝试一条历史(含被覆盖
 * 那一版的指纹)"、"拒收注记只追加"、"降级必须明说",这些纪律对音乐与语音是同一套。
 *
 * ADR-0012 的原话是"**任务队列复用图像那套**",不是"再写一份像它的"。所以:
 *  - 共性在这里(**一份**);
 *  - 每种产物只提供自己的那点差异:`KIND = { file, label, normalize }`
 *    —— 盘上路径、人话标签、以及"这个字段形状对不对"。
 *
 * **落盘格式不变**(`.studio/image-tasks.json` 依然是 `{schemaVersion, tasks[]}`)。
 * 泛化的是**代码**,不是文件格式 —— 已经生成过的账本一个字节都不用动。
 */

export type GenerationTaskState = 'queued' | 'running' | 'awaiting-review' | 'failed'

/** 一次尝试的历史条目(重试历史就是这一串,只追加)。 */
export interface GenerationAttempt {
  n: number
  startedAt: string
  finishedAt: string
  outcome: 'ok' | 'failed'
  /** 失败的**原因原文**(状态码 + 上游说的那句话),不吞。 */
  error?: string
  /** 成功时的产物指纹(内容哈希),与板上槽位的指纹同口径。 */
  fingerprint?: string
  /** 成功时的字节数。 */
  bytes?: number
  /**
   * **被这一次覆盖掉的那一版的指纹**(T15:重 roll 保留上一产物为历史)。
   *
   * 文件必然被覆盖(目标路径只有一个),但覆盖前的快照里有它的内容 ——
   * 有了这个指纹,人就能从快照历史里精确找回"上一版是哪个",对比才有依据。
   * 首次生成时缺省(没有上一版)。
   */
  replacedFingerprint?: string
}

/**
 * **拒收注记**(T16):人对某一版的否决理由。
 *
 * 它是**制作信息**(为什么这张不行:脸太圆 / 眼神太凶 / 这段太吵),不是叙述内容 ——
 * 长度有上限,超了会被挡在写入之前。注记只追加、永不改写,并指向**被拒的那一版**
 * (尝试号 + 产物指纹),所以"这一版为什么被打回"在历史里对得上号,而不是一句无主的话。
 */
export interface GenerationRejection {
  /** 被拒的那一次尝试(第几次)。 */
  attempt: number
  /** 被拒那一版的产物指纹(可从快照历史精确找回那一版)。 */
  fingerprint?: string
  /** 人的原话(拒收理由)。 */
  note: string
  /** 谁记的:工作台上的人,还是替人转述的 agent。 */
  via: 'human' | 'agent'
  at: string
}

/**
 * 降级说明:**给出去的参数为什么与要求的不一样**。
 * 有它 = 请求被改了;没有 = 请求原样发出。不存在"改了但不说"的第三种。
 *
 * `code` 是**开放的字符串**而不是联合类型:图像有它那套,音乐/语音有各自那套
 * (见 `images.ts` 的说明),写死在通用层就成了"加一种产物要改这一处"。
 */
export interface GenerationDegradation {
  code: string
  /** 面向人的一句话(中文;面板与 agent 直接显示)。 */
  message: string
  /** 被丢掉的参考(给人确认"到底丢了什么";图像是参考图,音频可能是参考音频)。 */
  droppedReferenceImages: Array<{ path: string; note?: string }>
  /** 其余被改动的参数说明。 */
  notes: string[]
}

/** 任何产物都有的那部分(图像 / 音乐 / 语音共用)。 */
export interface GenerationTaskBase {
  schemaVersion: 1
  id: string
  /** 产物目标路径(相对项目根)。 */
  outputPath: string
  state: GenerationTaskState
  /** 渠道名 + 模型 id(账本里**不记密钥**)。 */
  channel?: string
  model: string
  /** 提示词(制作指令;**不是**叙述内容)。 */
  prompt: string
  /** 被降级掉的事实(缺省 = 没降级)。 */
  degradation?: GenerationDegradation
  attempts: GenerationAttempt[]
  /** 拒收注记(只追加)。老账本里没有这个字段 —— 读的时候按空数组归一。 */
  rejections: GenerationRejection[]
  createdAt: string
  updatedAt: string
  /** 失败时的最后原因(与 attempts 末条一致,方便一眼看)。 */
  lastError?: string
}

/** 账本文档:一个文件放一种产物的任务(路径由 `TaskKind.file` 定)。 */
export interface TaskDocument<TTask extends GenerationTaskBase> {
  schemaVersion: 1
  tasks: TTask[]
}

/**
 * 一种产物的差异点(其余共性在通用层)。
 *
 * `normalize` 是**这个产物唯一的形状所有者**:它把盘上读到的原始 JSON 变成一个可用文档,
 * 或者抛(带上"哪个文件坏了"这句话)。老账本缺字段的归一也在这里做 ——
 * 所以"某天给某产物加一个字段"只改一行。
 */
export interface TaskKind<TTask extends GenerationTaskBase> {
  /** 项目内相对路径(如 `.studio/image-tasks.json`)。 */
  file: string
  /** 人话标签(错误信息里用:"不是有效的<label>账本")。 */
  label: string
  /** 原始 JSON → 文档;坏形状在这里抛。 */
  normalize: (raw: Partial<TaskDocument<TTask>>, file: string) => TaskDocument<TTask>
}

export const TASK_SCHEMA = 1

/**
 * 拒收注记的长度上限(与设定卡字段同一把尺子,但**单独取名**:
 * "账本字段上限"与"设定卡字段上限"是两件事,改一个不该动另一个)。
 */
export const MAX_REJECTION_NOTE_CHARS = 600

export function emptyTasksDocument<TTask extends GenerationTaskBase>(): TaskDocument<TTask> {
  return { schemaVersion: TASK_SCHEMA, tasks: [] }
}

/** 解析账本;坏文档不静默当成空(宁可抛,让人看到 .studio 被改坏了)。 */
export function parseTasksDocument<TTask extends GenerationTaskBase>(
  kind: TaskKind<TTask>,
  text: string,
): TaskDocument<TTask> {
  if (text.trim() === '') return emptyTasksDocument<TTask>()
  const parsed = JSON.parse(text) as Partial<TaskDocument<TTask>>
  if (parsed.schemaVersion !== TASK_SCHEMA || !Array.isArray(parsed.tasks)) {
    throw new Error(`${kind.file} 不是有效的${kind.label}账本(schemaVersion 应为 ${TASK_SCHEMA})`)
  }
  return kind.normalize(parsed, kind.file)
}

export function tasksDocument<TTask extends GenerationTaskBase>(document: TaskDocument<TTask>): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function findTask<TTask extends GenerationTaskBase>(document: TaskDocument<TTask>, id: string): TTask | undefined {
  return document.tasks.find((task) => task.id === id)
}

/** 追加/替换一个任务(只动这一个;别处逐字保留)。 */
export function upsertTask<TTask extends GenerationTaskBase>(document: TaskDocument<TTask>, task: TTask): TaskDocument<TTask> {
  const index = document.tasks.findIndex((entry) => entry.id === task.id)
  const tasks = index < 0
    ? [...document.tasks, task]
    : document.tasks.map((entry, i) => (i === index ? task : entry))
  return { schemaVersion: TASK_SCHEMA, tasks }
}

/**
 * **一个账本的读写手柄**(T27):把"读 → 改 → 写回"和串行纪律收在一处。
 *
 * 为什么要有它:图像与音频各有一份账本文件,但"读网关 → 解析 → 改 → 经网关写回"
 * 这段**一模一样**。抄第二份就等于把"读-改-写必须串行"这条纪律抄两遍,
 * 而纪律抄两遍的必然结局是**其中一份先被忘掉**。
 *
 * 两个接口(接缝实现它):
 *  - `read(projectRef)` → `{ content, version }`(`version` 是网关的版本戳,CAS 用);
 *  - `write(projectRef, path, content, expectVersion)` → 经网关落盘(自动快照)。
 *
 * `path` 由 `kind.file` 给,不从这里传 —— 一个手柄只服务一个文件。
 */
export interface TaskLedgerHost {
  read: (projectRef: string, path: string) => Promise<{ content: string; missing: boolean; version: string }>
  write: (projectRef: string, path: string, content: string, expectVersion: string) => Promise<void>
}

export interface TaskLedger<TTask extends GenerationTaskBase> {
  /** 读账本(坏文档抛,不静默当空)。 */
  read: (projectRef: string) => Promise<TaskDocument<TTask>>
  /**
   * 读-改-写:`mutate` 里往 `writers` 里塞的任务会被写回(没塞 = 只读,不产生写批)。
   * 并发调用**串行**(每个文件一条队列)。
   */
  mutate: <T>(
    projectRef: string,
    mutate: (document: TaskDocument<TTask>, writers: TTask[]) => Promise<T> | T,
  ) => Promise<T>
}

export function makeTaskLedger<TTask extends GenerationTaskBase>(
  kind: TaskKind<TTask>,
  host: TaskLedgerHost,
): TaskLedger<TTask> {
  // 每个账本一条队列(图像与音频各排各的:它们写的是不同文件,互不相干)。
  let queue: Promise<unknown> = Promise.resolve()
  const read = async (projectRef: string): Promise<TaskDocument<TTask>> => {
    const current = await host.read(projectRef, kind.file)
    return current.missing ? emptyTasksDocument<TTask>() : parseTasksDocument(kind, current.content)
  }
  return {
    read,
    async mutate(projectRef, mutate) {
      // **先把队尾摘下来再挂自己**:mutate 内部若再调 `mutate`(例如"建完立刻跑"),
      // 嵌套调用排队等的是**前一个**调用,不会等自己(否则死锁)。
      const previous = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => { release = resolve })
      await previous.catch(() => {})
      try {
        const current = await host.read(projectRef, kind.file)
        const document = current.missing ? emptyTasksDocument<TTask>() : parseTasksDocument(kind, current.content)
        const writers: TTask[] = []
        const result = await mutate(document, writers)
        if (writers.length > 0) {
          let next = document
          for (const task of writers) next = upsertTask(next, task)
          await host.write(projectRef, kind.file, tasksDocument(next), current.version)
        }
        return result
      } finally {
        release()
      }
    },
  }
}
