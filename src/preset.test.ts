/**
 * 「Galgame 制作」preset(T22 / #30)的守卫 —— 断言的是**我们交付的那个产物**,不是运行时代码。
 *
 * 为什么要它:preset 是**部署产物**(组装文件 + 一个前置检查插件 + 元数据)。它坏掉的形态
 * 全是"装上才知道":
 *  - 组装里混进一行本不该由 preset 拥有的东西(注册表 / 沙箱审批 / 持久化 / 模型路由);
 *  - 组装文件本身语法坏了(YAML 里一个缩进就能让它整份加载不了);
 *  - 前置检查那一行被 `disabled` 掉(于是回到"静默少几个工具");
 *  - `guard.mjs` 里点名要的工具与插件真实注册的名字对不上(改名之后这个 preset 会误报)。
 *
 * 所以这里做四件事:**解析**组装(真 YAML 解析,不是文本扫描)、**查策略**(该有的有、不该有的没有)、
 * **调前置检查**(两条路都走一遍)、**把工具名钉在插件上**(`registerGalfreeTools` 的真产物)。
 *
 * 这一条属于测试纪律台账里记过的那类"适配层/产物断言"(与 `tools-flow.test.ts` 同族)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { createProjectService, type ProjectService } from './service/project-service.ts'
import { registerGalfreeTools } from './service/tools.ts'
import { cleanupTempDirs, makeTempDir } from './testing/tmp.ts'

const PRESET_DIR = join(process.cwd(), 'presets', 'galgame')

/**
 * 组装用的 YAML 方言里带 `!!js <expr>`(宿主 loader 自己求值的表达式)。
 * js-yaml 不认识这个标签,所以给它一个"原样收下"的类型 —— 我们要验的是结构与行,
 * 不是那些表达式的值(那是宿主的事)。
 */
const CORDIS_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (data: unknown) => ({ js: data }),
  }),
])

interface PresetRow {
  id?: string
  name?: string
  disabled?: unknown
  group?: boolean
  config?: unknown
}

/** 读一份组装文件(顶层必须是插件行列表)。 */
async function readComposition(file = 'agent.cordis.yml'): Promise<PresetRow[]> {
  const text = await readFile(join(PRESET_DIR, file), 'utf8')
  const rows = load(text, { schema: CORDIS_SCHEMA })
  expect(Array.isArray(rows), '组装文件的顶层必须是插件行列表').toBe(true)
  return rows as PresetRow[]
}

/** 组里的行也要看得见(嵌套的 config 列表)。 */
function flatten(rows: PresetRow[]): PresetRow[] {
  const all: PresetRow[] = []
  for (const row of rows) {
    all.push(row)
    if (row.group === true && Array.isArray(row.config)) all.push(...flatten(row.config as PresetRow[]))
  }
  return all
}

function names(rows: PresetRow[]): string[] {
  return flatten(rows).map((row) => String(row.name ?? ''))
}

/**
 * 载入前置检查插件(它是交付物的一部分:`presets/galgame/guard.mjs`)。
 *
 * 用**变量说明符**而不是字面量:`.mjs` 在 `presets/` 下没有类型声明,字面量导入会被 TS
 * 当成本地模块要求类型;这里要的是"运行时真的能载入那个文件",类型由调用方声明。
 */
async function loadGuard(): Promise<{ REQUIRED_TOOLS: string[]; apply: (ctx: unknown) => void }> {
  const specifier = '../presets/galgame/guard.mjs'
  return await import(specifier) as { REQUIRED_TOOLS: string[]; apply: (ctx: unknown) => void }
}

describe('「Galgame 制作」preset(T22)', () => {
  it('组装文件能解析,而且每一行都是带 name 的插件行(宿主自己的形状规则)', async () => {
    const rows = await readComposition()
    expect(rows.length).toBeGreaterThanOrEqual(15)
    // 组里的行也要解析出来(planning / compaction / delegation 三个组)。
    expect(flatten(rows).length).toBeGreaterThan(rows.length)
    for (const [index, row] of rows.entries()) {
      expect(typeof row, `第 ${index + 1} 行不是插件行`).toBe('object')
      expect(typeof row.name, `第 ${index + 1} 行没有 name`).toBe('string')
      expect(row.name).not.toBe('')
    }
  })

  it('preset.yml 有展示元数据,且 id(目录名)= galgame', async () => {
    const meta = load(await readFile(join(PRESET_DIR, 'preset.yml'), 'utf8')) as { name?: string; description?: string; order?: number }
    expect(meta.name).toBeTruthy()
    expect(meta.description).toBeTruthy()
    expect(typeof meta.order).toBe('number')
    // id 就是目录名,而它必须匹配宿主的 id 规则。
    expect('galgame').toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  // ── 该有的:立场 + 前置检查 + skills ────────────────────────────────

  it('带 galgame 的立场:指向指引与板,而且**不复述**指引里的规则', async () => {
    const rows = await readComposition()
    const persona = rows.find((row) => row.id === 'persona')
    expect(persona, '没有 persona 行').toBeDefined()
    const prefix = String((persona!.config as { prefix?: unknown }).prefix ?? '')
    // 指向那份指引与那块板(而不是自己另写一套)。
    expect(prefix).toContain('galfree-workflow')
    expect(prefix).toContain('galfree_project_status')
    expect(prefix).toContain('nextActions')
    // **不复述**:闸门码与判据字段是 `galfree-workflow` 段的活儿;写在这里就会分叉。
    for (const borrowed of ['bible-not-final', 'no-image-channel', 'summary.missingSlots', 'publish.stale']) {
      expect(prefix, `persona 里复述了指引的内容(${borrowed})`).not.toContain(borrowed)
    }
    // stance:哪些必须请人、只报事实、一次一环 —— 这三条是立场,该在。
    expect(prefix).toMatch(/请人|人来做/)
    expect(prefix).toMatch(/事实|如实|不过/)
  })

  it('前置检查那一行是**相对路径**、而且没有 disabled(否则健康检查会跳过它)', async () => {
    const rows = await readComposition()
    const guard = rows.find((row) => row.id === 'galfree-guard')
    expect(guard, '没有 galfree-guard 行').toBeDefined()
    expect(guard!.name).toBe('./guard.mjs')
    // 相对行的解析判定是"这个文件在不在"(与谁装在哪无关),所以它在任何部署里都稳定;
    // 裸包名会被"从宿主安装位置向上找"的规则误判(profile 装的插件找不到)。
    expect(guard!.disabled, 'guard 被 disabled 了:那样就没人在意插件在不在').toBeUndefined()
    // 而被 disable 的那两行(生产不装的 subagent provider)照旧 —— 顺带确认我们没把 disabled 一锅端。
    expect(names(rows)).toContain('@deepseek-ai/dsh-tool-subagent')
  })

  it('skills 两行都在(这个模式要能用仓库与用户自己的 skill)', async () => {
    const rows = await readComposition()
    const list = names(rows)
    expect(list).toContain('@deepseek-ai/dsh-skill-filesystem')
    expect(list).toContain('@deepseek-ai/dsh-tool-skill')
  })

  // ── 不该有的:注册表 / 沙箱审批 / 持久化 / 模型路由 / preset 机制本身 ──

  it('没有注册表 / 沙箱审批 / 持久化 / 模型路由 / preset 机制那些行(它们归宿主)', async () => {
    const list = names(await readComposition())
    // 每一条都写明"为什么不该在 preset 里" —— 这些是集合的成员,不是随手列的名字。
    const forbidden: Array<[RegExp, string]> = [
      [/^@deepseek-ai\/dsh-tools$/, '工具注册表本身(进程单例,归宿主)'],
      [/^@deepseek-ai\/dsh-settings$/, '设置注册表(命名空间重复即抛)'],
      [/^@deepseek-ai\/dsh-agent-presets$/, 'preset 机制自己'],
      [/^@deepseek-ai\/dsh-session/, '会话/持久化'],
      [/^@deepseek-ai\/dsh-scope$/, '作用域机制'],
      [/sandbox|approval|user-approval/, '沙箱与审批栈'],
      [/^@deepseek-ai\/dsh-llm$|model-route|dsh-llm-/, '模型路由'],
      [/^@deepseek-ai\/dsh-fs/, 'fs 服务与策略(工具行可以用,服务本身不给)'],
    ]
    for (const name of list) {
      for (const [pattern, why] of forbidden) {
        expect(pattern.test(name), `${name} 不该出现在 preset 里:${why}`).toBe(false)
      }
    }
  })

  it('没有任何审读戳相关的**行或配置键**(preset 不是给 agent 开戳的入口)', async () => {
    const rows = await readComposition()
    // 注意口径:persona 的**正文**里提到"盖审读戳是人做的"是对的(那是立场);
    // 不许的是**组装层**给出盖戳的能力 —— 行名或配置键里出现盖章类动作才算。
    for (const row of flatten(rows)) {
      expect(String(row.name ?? ''), '组装里出现了盖章类的插件行').not.toMatch(/stamp|approve/i)
      const configKeys = Object.keys((row.config ?? {}) as Record<string, unknown>)
      expect(configKeys.filter((key) => /stamp|approve|review/i.test(key)), `行 ${String(row.id ?? '')} 的配置里出现了盖章类键`).toEqual([])
    }
  })

  // ── "照抄 standard + 两处改动"这句话本身要被机器检查 ──────────────────

  it('组装 = 随包 standard 的逐行副本 + 两处声明的改动(漂了就红)', async () => {
    const mine = await readComposition('agent.cordis.yml')
    const reference = await readComposition('standard.reference.cordis.yml')

    // 顶层行的 id 序列:除末尾多出来的 guard 行、以及 persona 行本身,必须**逐个相同**(顺序也同)。
    const ids = mine.map((row) => String(row.id ?? ''))
    const referenceIds = reference.map((row) => String(row.id ?? ''))
    expect(ids.filter((id) => id !== 'galfree-guard')).toEqual(referenceIds)

    // 除 persona(改了 config)之外,standard 里的每一行都要**深度相等**(抄错一个字符都会红)。
    for (const [index, row] of reference.entries()) {
      if (row.id === 'persona') continue
      expect(mine[index], `第 ${index + 1} 行与 standard 不一致(${String(row.id ?? '')})`).toEqual(row)
    }
    // 多出来的行:有且只有那一行 guard(不许有第二处未声明的改动)。
    expect(mine.slice(reference.length).map((row) => String(row.id ?? ''))).toEqual(['galfree-guard'])
    // persona 只动 config(行名与位置照旧)。
    const minePersona = mine.find((row) => row.id === 'persona')!
    const referencePersona = reference.find((row) => row.id === 'persona')!
    expect(minePersona.name).toBe(referencePersona.name)
    expect(minePersona.config).not.toEqual(referencePersona.config)
  })

  // ── 前置检查插件本身:两条路都走一遍 ────────────────────────────────

  it('前置检查:插件不在场时**带原因地拒绝**(指名少了哪些工具 + 怎么装)', async () => {
    const guard = await loadGuard()
    const empty = { tools: { get: () => undefined } }
    expect(() => guard.apply(empty)).toThrowError(/GALFree 插件/)
    // 错误信息要能照着做:点名缺了谁、去哪儿装。
    expect(() => guard.apply(empty)).toThrowError(/galfree_project_status/)
    expect(() => guard.apply(empty)).toThrowError(/README|重启宿主/)
    // 连工具注册表都没有:也是**带原因**地拒绝,而不是静默跳过。
    expect(() => guard.apply({})).toThrowError(/ctx\.tools|工具注册表/)
  })

  it('前置检查:插件在场就放行(不抛)', async () => {
    const guard = await loadGuard()
    const present = { tools: { get: (name: string) => ({ name }) } }
    expect(() => guard.apply(present)).not.toThrow()
  })

  it('前置检查点名的工具,与插件**真实注册**的名字对得上(改名就红)', async () => {
    const guard = await loadGuard()
    expect(guard.REQUIRED_TOOLS.length).toBeGreaterThan(3)

    const dataDir = await makeTempDir('galfree-t22-data-')
    let service: ProjectService | null = null
    try {
      service = createProjectService({ dataDir })
      const registered: string[] = []
      registerGalfreeTools(
        { tools: { register: (tool: unknown) => { registered.push((tool as { name: string }).name); return () => {} } } } as never,
        service,
      )
      for (const tool of guard.REQUIRED_TOOLS) {
        expect(registered, `guard 点名了 ${tool},但插件没注册这个名字`).toContain(tool)
      }
      // 反向:每个环节的入口都在名单上(别只查一个)。
      expect(guard.REQUIRED_TOOLS).toContain('galfree_publish')
      expect(guard.REQUIRED_TOOLS).toContain('galfree_playtest')
    } finally {
      if (service !== null) await service.dispose()
      await cleanupTempDirs()
    }
  })
})

afterEach(async () => {
  await cleanupTempDirs()
})
