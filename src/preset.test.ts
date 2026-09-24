/**
 * 「Galgame 制作」preset(T22 / #30)的守卫 —— 断言的是**我们交付的那个产物**,不是运行时代码。
 *
 * 为什么要它:0.1.7 起 preset **不再是一个目录**(`$DSH_HOME/.agent-presets/<id>/` 那套被删掉了,
 * 没有任何东西再读它 —— `@deepseek-ai/dsh-agent-preset` 的
 * `skills/editing-cordis-compositions/SKILL.md` 明写 "Nothing reads that directory any more"),
 * 而是一行 Loader 声明:`cordis.patch.yml` 里 `preset-galgame` 那一行
 * (`name: '@deepseek-ai/dsh-agent-preset'` + `config.plugins`)。于是交付物变成了**一个 patch 文件
 * 里的一行**,它坏掉的形态全是"装上才知道":
 *  - `config.plugins` 里混进一行本不该由 preset 拥有的东西(注册表 / 沙箱审批 / 持久化 / 模型路由);
 *  - 这份 YAML 语法坏了(一个缩进就能让它整份加载不了 —— 而它还是**插进 profile 组装**的那一层,
 *    坏了整份 profile 都起不来);
 *  - `galfree-guard` 那一行被 `disabled` 掉,或者引用的形态**根本解析不到**(于是前置检查变成
 *    一个永远不启动的行,preset 在名单里挂成 broken,不可选);
 *  - `guard.mjs` 里点名要的工具与插件真实注册的名字对不上(改名之后这个 preset 会误报)。
 *
 * 所以这里做五件事:**解析** patch(真 YAML 解析,不是文本扫描)、**逐行比对**
 * (交付的 `plugins` ≡ 给人读的 `agent.cordis.yml` ≡ 0.1.7 的 standard + 两处声明的改动)、
 * **查解析形态**(guard 行的包名 + exports 子路径 + files 发布,三者缺一就红)、
 * **调前置检查**(在场 / 缺席 / 迟到三条路都走一遍)、**把工具名钉在插件上**
 * (`registerGalfreeTools` 的真产物)。
 *
 * 这一条属于测试纪律台账里记过的**第四类**"适配层/产物断言":与 `tools-flow.test.ts` 同族,
 * 但它断言的是**交付的那些文件**(patch + fixture + guard),而不是运行时行为 —— 台账里那一行
 * 写明了为什么它该住在快带(真解析 YAML 才能抓到"一个缩进让整份 preset 加载不了")。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { createProjectService, type ProjectService } from './service/project-service.ts'
import { registerGalfreeTools } from './service/tools.ts'
import { cleanupTempDirs, makeTempDir } from './testing/tmp.ts'

const REPO_ROOT = process.cwd()
const PRESET_DIR = join(REPO_ROOT, 'presets', 'galgame')
/** 交付物:插件 bundle 的 patch。preset-galgame 那一行就住在这里,随包一起走。 */
const PATCH_FILE = join(REPO_ROOT, 'cordis.patch.yml')
/** preset 的展示元数据来源(宿主**不读**它;它只喂 patch 那一行,并由本文件钉住)。 */
const METADATA_FILE = join(PRESET_DIR, 'preset.yml')

/**
 * 组装用的 YAML 方言里带 `!!js <expr>`(宿主 loader 自己求值的表达式)。
 * js-yaml 不认识这个标签,所以给它一个"原样收下"的类型 —— 我们要验的是结构与行,
 * 不是那些表达式的值(那是宿主的事)。
 * 两份文件都用同一个 schema 解析,`!!js` 节点才会得到同一个形状、能逐行深度比对。
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

/** patch 文件的一条:insert 列表,或按 id 定位的覆盖。 */
interface PatchEntry {
  id?: string
  name?: string
  disabled?: unknown
  insert?: PresetRow[]
}

interface PresetMetadata {
  name?: string
  description?: string
  order?: number
}

function parseYaml(text: string): unknown {
  return load(text, { schema: CORDIS_SCHEMA })
}

/** 读一份**组装文件**(顶层必须是插件行列表):agent.cordis.yml / standard.reference.cordis.yml。 */
async function readComposition(file: string): Promise<PresetRow[]> {
  const rows = parseYaml(await readFile(join(PRESET_DIR, file), 'utf8'))
  expect(Array.isArray(rows), `${file} 的顶层必须是插件行列表`).toBe(true)
  return rows as PresetRow[]
}

/** 读交付物 `cordis.patch.yml` 的顶层 patch 列表。 */
async function readPatch(): Promise<PatchEntry[]> {
  const entries = parseYaml(await readFile(PATCH_FILE, 'utf8'))
  expect(Array.isArray(entries), 'cordis.patch.yml 的顶层必须是 patch 列表').toBe(true)
  return entries as PatchEntry[]
}

/** 交付的那一行 preset 声明(`config.plugins` 就是它的组装)。 */
async function readPresetDeclaration(): Promise<{ row: PresetRow; config: Record<string, unknown>; plugins: PresetRow[] }> {
  const patch = await readPatch()
  const inserted = patch.flatMap((entry) => entry.insert ?? [])
  const row = inserted.find((candidate) => candidate.id === 'preset-galgame')
  expect(row, 'cordis.patch.yml 里没有 preset-galgame 这一行:preset 就不随包走了').toBeDefined()
  const config = (row!.config ?? {}) as Record<string, unknown>
  expect(Array.isArray(config.plugins), 'preset 声明缺 config.plugins:挂载时会被判成"不是插件行列表"').toBe(true)
  return { row: row!, config, plugins: config.plugins as PresetRow[] }
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

/** 让人读得懂的行标识:`planning:plan-mode` 这种嵌套 id 也要能点名。 */
function labelled(rows: PresetRow[], prefix = ''): Array<[string, PresetRow]> {
  const all: Array<[string, PresetRow]> = []
  for (const row of rows) {
    const label = `${prefix}${String(row.id ?? '(无 id)')}`
    all.push([label, row])
    if (row.group === true && Array.isArray(row.config)) all.push(...labelled(row.config as PresetRow[], `${label}:`))
  }
  return all
}

/**
 * 载入前置检查插件(它是交付物的一部分:`presets/galgame/guard.mjs`)。
 *
 * 用**变量说明符**而不是字面量:`.mjs` 在 `presets/` 下没有类型声明,字面量导入会被 TS
 * 当成本地模块要求类型;这里要的是"运行时真的能载入那个文件",类型由调用方声明。
 */
async function loadGuard(): Promise<{
  REQUIRED_TOOLS: string[]
  inject?: string[]
  apply: (ctx: unknown, config?: unknown) => Promise<void>
}> {
  const specifier = '../presets/galgame/guard.mjs'
  return await import(specifier) as {
    REQUIRED_TOOLS: string[]
    inject?: string[]
    apply: (ctx: unknown, config?: unknown) => Promise<void>
  }
}

/** 一个"工具齐全/缺席可控"的假席位。 */
function fakeTools(present: boolean): { tools: { get: (name: string) => unknown } } {
  return { tools: { get: (name: string) => (present ? { name } : undefined) } }
}

describe('「Galgame 制作」preset(T22 / #30)', () => {
  // ── 交付形态:它现在是一行 Loader 声明,住在插件的 bundle patch 里 ──────────

  it('交付物是 patch 里的一行声明:与插件同一次 insert,而且没有被 disabled', async () => {
    const patch = await readPatch()
    const inserted = patch.flatMap((entry) => entry.insert ?? []).map((row) => String(row.id ?? ''))
    // 两行必须**同一次 insert**:这就是"preset 不可能在插件缺席时存在"的结构性理由
    // (装的是同一个 bundle,两行一起进来)。测试钉住它,免得有人把 preset 挪到别处去。
    expect(inserted).toEqual(['galfree', 'preset-galgame'])
    const { row, config } = await readPresetDeclaration()
    expect(row.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(row.disabled, 'preset 行被 disabled 了:名单里就没有这个模式了').toBeUndefined()
    // row.id 是 Loader 用来定位这一行做编辑的地址;会话保存的 preset 身份是 config.id。
    expect(config.id).toBe('galgame')
    expect(String(config.id)).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    // id 就是这本目录的名字(人的心智模型:一个目录一个人读的组装)。
    expect(basename(PRESET_DIR)).toBe(String(config.id))
  })

  it('展示元数据(name / description / order)来自 presets/galgame/preset.yml,不是另抄一份', async () => {
    const { config } = await readPresetDeclaration()
    const meta = parseYaml(await readFile(METADATA_FILE, 'utf8')) as PresetMetadata
    expect(meta.name).toBeTruthy()
    expect(meta.description).toBeTruthy()
    expect(typeof meta.order).toBe('number')
    expect(config.name).toBe(meta.name)
    expect(config.description).toBe(meta.description)
    expect(config.order).toBe(meta.order)
  })

  it('config.plugins 能解析,而且每一行都是带 name 的插件行(宿主自己的形状规则)', async () => {
    const { plugins } = await readPresetDeclaration()
    expect(plugins.length).toBeGreaterThanOrEqual(15)
    // 组里的行也要解析出来(planning / compaction / delegation 三个组)。
    expect(flatten(plugins).length).toBeGreaterThan(plugins.length)
    for (const [index, row] of plugins.entries()) {
      expect(typeof row, `第 ${index + 1} 行不是插件行`).toBe('object')
      expect(typeof row.name, `第 ${index + 1} 行没有 name`).toBe('string')
      expect(row.name).not.toBe('')
    }
  })

  // ── 交付的 plugins ≡ 给人读的 fixture ≡ 0.1.7 standard + 两处改动 ──────────

  it('交付的 plugins 与 presets/galgame/agent.cordis.yml(给人读的那一份)**逐行深度相等**', async () => {
    const { plugins } = await readPresetDeclaration()
    const readable = await readComposition('agent.cordis.yml')
    // 两份文件解析出的值必须一模一样:这份长列表不是"另抄一遍",而是同一个真相的交付形态。
    expect(plugins).toEqual(readable)
  })

  it('agent.cordis.yml = 0.1.7 standard 参考副本 + 两处声明的改动(漂了就红)', async () => {
    const mine = await readComposition('agent.cordis.yml')
    const reference = await readComposition('standard.reference.cordis.yml')

    // 顶层行的 id 序列:除末尾多出来的 guard 行,必须**逐个相同**(顺序也同)。
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

    // persona:只换立场(prefix),别的键(含 suffix)照旧 —— "两处改动"里的第一处。
    const minePersona = mine.find((row) => row.id === 'persona')!
    const referencePersona = reference.find((row) => row.id === 'persona')!
    expect(minePersona.name).toBe(referencePersona.name)
    const mineConfig = minePersona.config as { prefix?: string; suffix?: string }
    const referenceConfig = referencePersona.config as { prefix?: string; suffix?: string }
    expect(mineConfig.suffix).toBe(referenceConfig.suffix)
    expect(mineConfig.prefix).not.toBe(referenceConfig.prefix)
    expect(Object.keys(mineConfig).sort()).toEqual(Object.keys(referenceConfig).sort())
  })

  // ── 该有的:立场 + 前置检查 + skills ────────────────────────────────

  it('带 galgame 的立场:指向指引与板,而且**不复述**指引里的规则', async () => {
    const { plugins } = await readPresetDeclaration()
    const persona = plugins.find((row) => row.id === 'persona')
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

  it('skills 两行都在(这个模式要能用仓库与用户自己的 skill)', async () => {
    const { plugins } = await readPresetDeclaration()
    const list = names(plugins)
    expect(list).toContain('@deepseek-ai/dsh-skill-filesystem')
    expect(list).toContain('@deepseek-ai/dsh-tool-skill')
  })

  // ── guard 行:引用的形态必须**真能解析**(这是本文件最容易骗过自己的地方)────

  /**
   * 「引用的形态能解析」为什么不能只看字符串:preset 的 `plugins` 行由 registry 挂载时,
   * 解析基准是**声明这一行的 Loader 树的 baseUrl**(profile 的根 include = `<profileDir>/cordis.yml`),
   * 而**不是**插件包目录 —— 本机 0.1.7-rc.2 实测:`./guard.mjs` 这一行在真宿主里
   * 只会得到 `probe-guard (./guard.mjs): never started`(导入失败),
   * `./node_modules/dsh-galfree/presets/galgame/guard.mjs` 与 `dsh-galfree/guard` 才正常。
   * 所以这里钉的不是"看起来对不对",而是**三者齐备**:行名 = `<包名>/<子路径>`、
   * `exports` 有这一条、目标文件真的在盘上且被 `files` 发布出去。
   */
  it('guard 行引用的形态真的能解析:`<包名>/guard` + exports 子路径 + 文件被发布', async () => {
    const { plugins } = await readPresetDeclaration()
    const guard = plugins.find((row) => row.id === 'galfree-guard')
    expect(guard, '没有 galfree-guard 行').toBeDefined()

    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      name?: string
      exports?: Record<string, string>
      files?: string[]
    }
    // ① 行名 = 本包的包名 + `/guard`(裸包名按 profile 的 node_modules 解析,那是插件被装上的地方)。
    expect(guard!.name).toBe(`${String(manifest.name)}/guard`)
    // ② exports 必须真有这一条,否则 ESM 解析会以 ERR_PACKAGE_PATH_NOT_EXPORTED 收场。
    const target = manifest.exports?.['./guard']
    expect(target, 'package.json 的 exports 里没有 "./guard":这一行在真宿主里解析不到').toBeTruthy()
    // ③ 目标文件要在仓库里(而且就在 preset 目录里,和别的交付物住一起)。
    const targetPath = join(REPO_ROOT, String(target).replace(/^\.\//, ''))
    const info = await stat(targetPath)
    expect(info.isFile()).toBe(true)
    expect(targetPath.startsWith(PRESET_DIR)).toBe(true)
    // ④ 它必须**随包发布**:files 里没有覆盖到它的条目,市场装出来的包里就没这个文件。
    const relative = targetPath.slice(REPO_ROOT.length + 1).split('\\').join('/')
    const shipped = (manifest.files ?? []).some((entry) => relative === entry || relative.startsWith(`${entry.replace(/\/$/, '')}/`))
    expect(shipped, `package.json 的 files 没有覆盖 ${relative}:装出来的包里没有它`).toBe(true)

    // 也**不能**加 `disabled`:registry 挂载时的 auditRows 会跳过 disabled 行,那就回到
    // "静默少几个工具"了。顺带确认我们没把 disabled 一锅端(生产不装的那两个 provider 照旧)。
    expect(guard!.disabled, 'guard 被 disabled 了:那样就没人在意插件在不在').toBeUndefined()
    expect(names(plugins)).toContain('@deepseek-ai/dsh-tool-subagent')
  })

  // ── 不该有的:注册表 / 沙箱审批 / 持久化 / 模型路由 / preset 机制本身 ──

  it('没有注册表 / 沙箱审批 / 持久化 / 模型路由 / preset 机制那些行(它们归宿主)', async () => {
    const { plugins } = await readPresetDeclaration()
    const list = names(plugins)
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
    const { plugins } = await readPresetDeclaration()
    // 注意口径:persona 的**正文**里提到"盖审读戳是人做的"是对的(那是立场);
    // 不许的是**组装层**给出盖戳的能力 —— 行名或配置键里出现盖章类动作才算。
    for (const row of flatten(plugins)) {
      expect(String(row.name ?? ''), '组装里出现了盖章类的插件行').not.toMatch(/stamp|approve/i)
      const configKeys = Object.keys((row.config ?? {}) as Record<string, unknown>)
      expect(configKeys.filter((key) => /stamp|approve|review/i.test(key)), `行 ${String(row.id ?? '')} 的配置里出现了盖章类键`).toEqual([])
    }
  })

  // ── 前置检查插件本身:在场 / 缺席 / 迟到,三条路都走一遍 ────────────────

  it('前置检查**声明了 inject**(不声明就读不到 ctx.tools:真机上就是这一步栽的)', async () => {
    const guard = await loadGuard()
    // cordis 的服务不能随手取:不声明 inject 读 `ctx.tools` 会当场抛
    // `cannot get property "tools" without inject`,会话压根切不过来。
    // 而"席位真缺席"不会因为声明 inject 变成静默 —— 宿主的规则是"等待从未提供的服务的行"
    // 会让挂载失败并指名那一行。
    expect(guard.inject).toEqual(['tools'])
  })

  it('前置检查:插件不在场时**带原因地拒绝**(指名少了哪些工具 + 怎么修)', async () => {
    const guard = await loadGuard()
    // waitMs: 0 —— 这条只验"判据与话术",不验等待(等待有下面单独一条);否则要等满默认上限。
    await expect(guard.apply(fakeTools(false), { waitMs: 0 })).rejects.toThrowError(/GALFree 插件/)
    // 错误信息要能照着做:点名缺了谁、去哪儿修。
    await expect(guard.apply(fakeTools(false), { waitMs: 0 })).rejects.toThrowError(/galfree_project_status/)
    await expect(guard.apply(fakeTools(false), { waitMs: 0 })).rejects.toThrowError(/同一个 bundle|插件管理器/)
    // 席位形状不对(生产上到不了,靠 inject 保证):也说人话,不抛 TypeError。
    await expect(guard.apply({}, { waitMs: 0 })).rejects.toThrowError(/ctx\.tools|工具注册表/)
  })

  it('前置检查:插件在场就放行(不抛)', async () => {
    const guard = await loadGuard()
    await expect(guard.apply(fakeTools(true))).resolves.toBeUndefined()
  })

  /**
   * 这条钉住**真机上栽过的那一次**:宿主的行是**并行激活**的
   * (`@deepseek-ai/cordis-plugin-loader` 的 `EntryGroup.update()` → `Promise.all`),
   * 而 GALFree 的工具是在**懒注入回调**里补上的(`src/index.ts` 的 `ctx.inject(['tools'], …)`)。
   * 于是 preset 挂载的那一刻目录可能还是空的 —— 本机 0.1.7-rc.2 实测:同一个 `inject: ['tools']`
   * 席位里,挂载时 8 个工具全看不到、3 秒后全在;而这一行一旦抛错就是**永久**失败
   * (名单里 galgame 一直挂 `broken`,不可选)。
   * 所以 guard 必须"等到看见为止,有上限":这条测试让工具**迟到**一点出现,它必须放行。
   */
  it('前置检查:工具**迟到**也算在场(并行激活的竞态,实测栽过一次)', async () => {
    const guard = await loadGuard()
    const registry = new Map<string, { name: string }>()
    const ctx = { tools: { get: (name: string) => registry.get(name) } }
    const timer = setTimeout(() => {
      for (const tool of guard.REQUIRED_TOOLS) registry.set(tool, { name: tool })
    }, 40)
    try {
      await expect(guard.apply(ctx, { waitMs: 2000 })).resolves.toBeUndefined()
    } finally {
      clearTimeout(timer)
    }
  })

  it('前置检查:等不到就有上限地收场(不是无限等,也不是静默放行)', async () => {
    const guard = await loadGuard()
    const started = Date.now()
    await expect(guard.apply(fakeTools(false), { waitMs: 60 })).rejects.toThrowError(/等了 60ms/)
    expect(Date.now() - started).toBeLessThan(2000)
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

  /**
   * 这条补一个**推理链上的洞**:guard 只查工具,而 persona 把"顺序"整个交给
   * `galfree-workflow` 那段指引 —— 如果插件可能只给工具不给指引,guard 就会放行一个
   * "有工具但没指引"的会话,而那正是这个 preset 想避免的静默降级。
   *
   * 所以这里验证的是那条**蕴含关系**:同一个插件的组装在同一台宿主上**既**注册工具
   * **也**把指引段装进系统提示(真挂 cordis + 真 `assemble()`,与入口同一条路)。
   * 有了它,"guard 查工具" 才等价于 "指引也在"。
   */
  it('同一个插件既给工具**也**给指引:guard 查工具 ⇒ 指引也在(真宿主验证)', async () => {
    const guard = await loadGuard()
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    const { registerGalfreePlaybook } = await import('./service/playbook.ts')

    const dataDir = await makeTempDir('galfree-t22-host-')
    const service = createProjectService({ dataDir })
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.inject(['tools'], (toolCtx) => {
        registerGalfreeTools(toolCtx as never, service)
      })
      await ctx.inject(['systemPrompt'], (promptCtx) => {
        registerGalfreePlaybook(promptCtx.systemPrompt)
      })

      // ① guard 看到的那一半:它点名的工具都真的注册了。
      for (const tool of guard.REQUIRED_TOOLS) {
        expect(ctx.tools.get(tool), `真宿主上看不到 ${tool}`).toBeDefined()
      }
      // ② 推断的另一半:指引段真的进得了组装(preset 的 persona 把顺序全权交给它)。
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map((section) => section.name)).toContain('galfree-workflow')
    } finally {
      await service.dispose()
      await cleanupTempDirs()
    }
  })

  /** 行标签表本身也要有用:下面几条断言靠它点名(顺带证明嵌套 id 能拼出来)。 */
  it('嵌套组的行能被点名(断言失败时看得出是哪一行)', async () => {
    const { plugins } = await readPresetDeclaration()
    const labels = labelled(plugins).map(([label]) => label)
    expect(labels).toContain('delegation:workflow-ptc')
    expect(labels).toContain('planning:plan-mode')
    expect(labels).toContain('galfree-guard')
  })
})

afterEach(async () => {
  await cleanupTempDirs()
})
