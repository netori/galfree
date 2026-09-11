/**
 * /api/galfree 路由族 —— 项目服务的**薄适配器**(spec:适配器不承载独占逻辑)。
 * 工作台 Client 与未来的独立前端都经这里消费同一接缝状态。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { GalfreeError } from './service/error.ts'
import { createSubdirectory, describePath, listDirectories } from './service/directory-listing.ts'
import type { ProjectService } from './service/project-service.ts'
import type { ProvisionStatus } from './service/sdk-provision.ts'

export interface RouteDeps {
  service: ProjectService
  /** 解析后的插件设置(enabled/defaultProjectsRoot/sdkPath…)。 */
  config: () => { enabled: boolean; defaultProjectsRoot: string }
  /**
   * 目录选择端口(宿主 `ctx.directoryPicker` 的转接)。
   *
   * 能力式接缝:后端可能是 `native`(宿主屏幕上的 OS 选择器)或 `browse`(应用内
   * 目录浏览),也可能**根本没有** —— `dsh-host-directory-picker-auto` 是用运行时
   * Loader 动态装配后端的,那一步失败是静默的。
   *
   * 所以本插件自带 `directory-listing.ts` 作**降级底座**:端口缺席时,/picker/list 与
   * /picker/create-directory 照样工作,面板里的目录浏览器不受宿主启动时序影响。
   */
  picker?: {
    capability: () => Promise<{ kind: string; note?: string }>
    pick: (signal?: AbortSignal) => Promise<string | null>
    list: (path?: string, signal?: AbortSignal) => Promise<unknown>
    createDirectory: (path: string, name: string) => Promise<unknown>
  }
  /** SDK 供给(T5;未装配时路由如实报告不可用)。 */
  sdk?: {
    status: () => Promise<{
      requested: 'override' | 'pinned'
      dir: string
      launcherReady: boolean
      version?: string
      mismatch?: { pinned: string; actual: string }
      provision: ProvisionStatus
    }>
    ensure: () => Promise<ProvisionStatus>
  }
}

export interface GalfreeRoute {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

const MAX_JSON_BODY_BYTES = 64 * 1024

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  return host === undefined ? false : /^127\.0\.0\.1(:\d+)?$|^\[::1\](:\d+)?$|^localhost(:\d+)?$/.test(host)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_JSON_BODY_BYTES) throw new GalfreeError('body-too-large', '请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    // 语法错误是请求方的错(400),不是服务端故障 —— 不能落成 500。
    throw new GalfreeError('bad-json', `请求体不是合法 JSON:${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new GalfreeError('bad-json', '请求体需为 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 路由 → 允许的方法。用于把"路径存在但方法不对"如实报成 405(带 Allow 头),
 * 而不是伪装成 404 未知路由。**新增路由必须同步登记在这里。**
 */
const ROUTE_METHODS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['/state', ['GET']],
  ['/projects/create', ['POST']],
  ['/projects/activate', ['POST']],
  ['/validate', ['GET']],
  ['/progress', ['GET']],
  ['/stamps/scene', ['POST']],
  ['/stamps/slot', ['POST']],
  ['/snapshots', ['GET']],
  ['/snapshots/diff', ['GET']],
  ['/snapshots/rollback', ['POST']],
  ['/files/content', ['GET']],
  ['/cast', ['GET']],
  ['/cast/characters/upsert', ['POST']],
  ['/cast/characters/remove', ['POST']],
  ['/cast/slots/upsert', ['POST']],
  ['/cast/slots/remove', ['POST']],
  ['/bible', ['GET']],
  ['/bible/patch', ['POST']],
  ['/bible/import-outline', ['POST']],
  ['/bible/stamp', ['POST']],
  ['/bible/context', ['GET']],
  ['/picker', ['GET']],
  ['/picker/pick', ['POST']],
  ['/picker/list', ['GET']],
  ['/picker/create-directory', ['POST']],
  ['/picker/inspect', ['GET']],
  ['/playtest', ['POST']],
  ['/sdk', ['GET']],
  ['/sdk/ensure', ['POST']],
  ['/events', ['GET']],
]

/** 原生选择器给人的时间:开窗、翻目录、确认。超时即中止(宿主会关掉对话框)。 */
const PICK_TIMEOUT_MS = 120_000

/**
 * 宿主目录选择接缝的**类型化失败**(`DirectoryPickerError`)。
 *
 * 它在宿主包里被声明,我们不 import 它(插件不该依赖宿主内部包),改用文档承诺的
 * 结构约定识别:带封闭业务码 + 出错路径的 Error。识别到了就 1:1 映射成协议错误码,
 * 而不是笼统的 500。
 */
const PICKER_ERROR_CODES = new Set(['directory-unreadable', 'directory-exists', 'directory-create-failed'])

function pickerFailure(error: unknown): { code: string; path?: string; message: string } | null {
  if (!(error instanceof Error)) return null
  const candidate = error as Error & { code?: unknown; path?: unknown }
  if (typeof candidate.code !== 'string' || !PICKER_ERROR_CODES.has(candidate.code)) return null
  return {
    code: candidate.code,
    message: error.message,
    ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
  }
}

/** 项目文件树(受限深度/数量;快照噪声与缓存排除在外)。 */
const TREE_IGNORE = new Set(['.git', '.rpyc'])
const TREE_MAX_ENTRIES = 2000

interface TreeNode {
  name: string
  path: string
  dir: boolean
  children?: TreeNode[]
}

async function buildTree(root: string, dir: string, depth: number, budget: { left: number }): Promise<TreeNode[]> {
  if (depth > 6 || budget.left <= 0) return []
  const entries = await readdir(join(root, dir), { withFileTypes: true })
  const nodes: TreeNode[] = []
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (budget.left <= 0) break
    if (TREE_IGNORE.has(entry.name) || entry.name.endsWith('.rpyc')) continue
    const rel = dir.length === 0 ? entry.name : `${dir}/${entry.name}`
    budget.left -= 1
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, dir: true, children: await buildTree(root, rel, depth + 1, budget) })
    } else {
      nodes.push({ name: entry.name, path: rel, dir: false })
    }
  }
  return nodes
}

async function dispatch(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://galfree')
  const path = url.pathname.replace(/^\/api\/galfree/, '') || '/'
  const method = req.method ?? 'GET'
  const { service } = deps

  if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: '仅回环可访问' })
  if (!deps.config().enabled && path !== '/state') return writeJson(res, 503, { error: 'GALFree 已停用(见设置)' })

  const allowed = ROUTE_METHODS.find(([routePath]) => routePath === path)?.[1]
  if (allowed !== undefined && !allowed.includes(method)) {
    res.setHeader('allow', allowed.join(', '))
    return writeJson(res, 405, { error: `${path} 只接受 ${allowed.join('/')}`, code: 'method-not-allowed' })
  }

  if (method === 'GET' && path === '/state') {
    const projects = await service.listProjects()
    const active = projects.find((project) => project.active) ?? null
    let tree: TreeNode[] = []
    if (active !== null && !active.missing) {
      tree = await buildTree(active.root, '', 0, { left: TREE_MAX_ENTRIES })
    }
    // 网关非致命故障(快照/回滚/监听)如实上板 —— "不静默"是硬规矩。
    const errors = active !== null && !active.missing ? await service.gatewayErrors(active.id) : []
    writeJson(res, 200, {
      projects,
      activeId: active?.id ?? null,
      tree,
      activeRoot: active?.root ?? null,
      activeMissing: active?.missing ?? false,
      gatewayErrors: errors,
      // 新建项目的默认父目录(空 = 尚未配置,面板要显式提醒人先选一个)
      defaultProjectsRoot: deps.config().defaultProjectsRoot,
    })
    return
  }

  if (method === 'POST' && path === '/projects/create') {
    const body = await readJsonBody(req)
    const projectsRoot = typeof body.projectsRoot === 'string' && body.projectsRoot !== '' ? body.projectsRoot : deps.config().defaultProjectsRoot
    if (projectsRoot === '') throw new GalfreeError('no-projects-root', '未指定项目父目录(设置 defaultProjectsRoot 或显式传入)')
    const project = await service.createProject({
      projectsRoot,
      name: String(body.name ?? ''),
      title: typeof body.title === 'string' && body.title !== '' ? body.title : undefined,
    })
    writeJson(res, 201, { project })
    return
  }

  // 切换激活项目。spec 原本把"切换 UI"划在 v1 之外(US29「切换 UI 后补」);
  // 这个路由与面板切换器是**经发起人明确批准**解除该延迟的产物(见接缝契约)。
  // 仍然只动注册表的激活位:项目内容一律走网关,这里不写任何项目文件。
  if (method === 'POST' && path === '/projects/activate') {
    const body = await readJsonBody(req)
    const id = String(body.project ?? '')
    if (id === '') throw new GalfreeError('unknown-project', '需要 project(id 或唯一 name)')
    await service.setActive(id)
    const project = await service.getActiveProject()
    writeJson(res, 200, { project })
    return
  }

  if (method === 'GET' && path === '/validate') {
    const report = await service.validateActiveProject()
    writeJson(res, 200, report)
    return
  }

  // 推导进度(阶段板数据源,T6)。
  if (method === 'GET' && path === '/progress') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const progress = await service.progress(active.id)
    writeJson(res, 200, progress)
    return
  }

  if (method === 'POST' && path === '/stamps/scene') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.stampScene(typeof body.project === 'string' && body.project !== '' ? body.project : active.id, String(body.label ?? ''), { via: 'human' })
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/stamps/slot') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.stampSlot(typeof body.project === 'string' && body.project !== '' ? body.project : active.id, String(body.slot ?? ''), { via: 'human' })
    writeJson(res, 200, { ok: true })
    return
  }

  // 快照历史(最小历史浏览器的数据源,T3)。
  if (method === 'GET' && path === '/snapshots') {
    const rel = url.searchParams.get('path')
    if (rel === null || rel === '') return writeJson(res, 400, { error: '需要 path 查询参数' })
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const history = await service.snapshotHistory(active.id, rel)
    writeJson(res, 200, { history })
    return
  }

  if (method === 'GET' && path === '/snapshots/diff') {
    const rel = url.searchParams.get('path')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (rel === null || from === null || to === null) return writeJson(res, 400, { error: '需要 path/from/to' })
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const diff = await service.snapshotDiff(active.id, rel, from, to)
    writeJson(res, 200, { diff })
    return
  }

  // 回滚一个文件到历史版本。**回滚本身是一次写**,必须走网关 → 自动产生一条
  // 回滚快照(接缝的 snapshotRollback 就是这么做的,路由只做参数搬运)。
  if (method === 'POST' && path === '/snapshots/rollback') {
    const body = await readJsonBody(req)
    const rel = String(body.path ?? '')
    const to = String(body.to ?? '')
    if (rel === '' || to === '') throw new GalfreeError('bad-json', '需要 path 与 to(commit)')
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const result = await service.snapshotRollback(active.id, rel, to)
    writeJson(res, 200, { result })
    return
  }

  // 文件内容(只读预览)。读走网关口径(磁盘为真 + 当前版本戳),不经网关写。
  if (method === 'GET' && path === '/files/content') {
    const rel = url.searchParams.get('path')
    if (rel === null || rel === '') return writeJson(res, 400, { error: '需要 path 查询参数' })
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const snapshot = await service.readProjectFile(active.id, rel)
    writeJson(res, 200, {
      path: rel,
      content: snapshot.content,
      version: snapshot.version,
      bytes: Buffer.byteLength(snapshot.content, 'utf8'),
    })
    return
  }

  // 目录选择:把**可用**的选择方式如实交给面板。
  //
  // 关键取舍:"能不能选文件夹"不押在宿主 Loader 有没有把后端挂上 —— 宿主选择器
  // 在就用它(OS 对话框 / 宿主列举),不在就用插件自带的目录列举兜底,因此
  // `browse` 恒为可用,`native` 才是那个"有则更好"的增强。
  if (method === 'GET' && path === '/picker') {
    const capability = deps.picker === undefined ? { kind: 'none' } : await deps.picker.capability()
    writeJson(res, 200, {
      ...capability,
      browse: true,
      native: capability.kind === 'native',
      defaultProjectsRoot: deps.config().defaultProjectsRoot,
    })
    return
  }

  if (method === 'POST' && path === '/picker/pick') {
    if (deps.picker === undefined) throw new GalfreeError('picker-unsupported', '宿主未提供目录选择接缝')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS)
    timer.unref?.()
    try {
      const picked = await deps.picker.pick(controller.signal)
      // 取消是正常结果(人改了主意),不是错误:如实回报 cancelled,面板什么都不改。
      writeJson(res, 200, { path: picked, cancelled: picked === null })
    } catch (error) {
      if (controller.signal.aborted) throw new GalfreeError('picker-timeout', `目录选择超时(${PICK_TIMEOUT_MS / 1000} 秒),已中止`)
      throw error
    } finally {
      clearTimeout(timer)
    }
    return
  }

  // 列举/新建目录:宿主 browse 后端优先;缺席或报错则回落到插件自带底座。
  if (method === 'GET' && path === '/picker/list') {
    const target = url.searchParams.get('path')
    const wanted = target === null || target === '' ? undefined : target
    if (deps.picker !== undefined) {
      try {
        const listing = await deps.picker.list(wanted)
        return writeJson(res, 200, { ...(listing as Record<string, unknown>), source: 'host' })
      } catch (error) {
        const failure = pickerFailure(error)
        // 宿主的类型化失败说明"这个目录本身读不了" → 如实报,不要假装兜底成功。
        if (failure !== null && failure.code === 'directory-unreadable') throw error
        // 其他情况(没挂上后端、未知错)才回落到自带底座。
      }
    }
    writeJson(res, 200, { ...(await listDirectories(wanted)), source: 'plugin' })
    return
  }

  if (method === 'POST' && path === '/picker/create-directory') {
    const body = await readJsonBody(req)
    const parent = String(body.path ?? '')
    const name = String(body.name ?? '')
    if (parent === '' || name === '') throw new GalfreeError('bad-json', '需要 path(父目录)与 name(单段目录名)')
    if (deps.picker !== undefined) {
      try {
        const created = await deps.picker.createDirectory(parent, name)
        return writeJson(res, 201, created)
      } catch (error) {
        if (pickerFailure(error) !== null) throw error
      }
    }
    writeJson(res, 201, await createSubdirectory(parent, name))
    return
  }

  // 手输路径的即时校验:这个位置现在能不能放项目(面板据此提醒,不假装成功)。
  if (method === 'GET' && path === '/picker/inspect') {
    const target = url.searchParams.get('path')
    if (target === null || target === '') return writeJson(res, 400, { error: '需要 path 查询参数' })
    writeJson(res, 200, { path: target, ...(await describePath(target)) })
    return
  }

  // 素材板账本(读):角色登记簿 + 槽账本。**只读制作信息**;槽清单本身从 /progress 派生。
  if (method === 'GET' && path === '/cast') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const [characters, slots] = await Promise.all([
      service.characters(active.id),
      service.slotLedger(active.id),
    ])
    writeJson(res, 200, { characters, slots })
    return
  }

  if (method === 'POST' && path === '/cast/characters/upsert') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.upsertCharacter(active.id, {
      id: String(body.id ?? ''),
      name: String(body.name ?? ''),
      ...(typeof body.voice === 'string' && body.voice !== '' ? { voice: body.voice } : {}),
      appearance: (typeof body.appearance === 'object' && body.appearance !== null ? body.appearance : {}) as Record<string, string>,
      ...(typeof body.styleAnchor === 'string' && body.styleAnchor !== '' ? { styleAnchor: body.styleAnchor } : {}),
      references: Array.isArray(body.references) ? body.references as Array<{ path: string }> : [],
      ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : {}),
    })
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/cast/characters/remove') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.removeCharacter(active.id, String(body.id ?? ''))
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/cast/slots/upsert') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.upsertSlot(active.id, {
      slot: String(body.slot ?? ''),
      requiresCharacters: Array.isArray(body.requiresCharacters) ? body.requiresCharacters.map(String) : [],
      ...(typeof body.prompt === 'string' && body.prompt !== '' ? { prompt: body.prompt } : {}),
      ...(typeof body.artStyleAnchor === 'string' && body.artStyleAnchor !== '' ? { artStyleAnchor: body.artStyleAnchor } : {}),
      ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : {}),
    })
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/cast/slots/remove') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.removeSlot(active.id, String(body.slot ?? ''))
    writeJson(res, 200, { ok: true })
    return
  }

  // 设定集(T9):读账本 / 局部更新 / 导入人写原文 / 盖定稿戳 / 取下游上下文。
  if (method === 'GET' && path === '/bible') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const [doc, outline] = await Promise.all([service.bible(active.id), service.bibleOutline(active.id)])
    writeJson(res, 200, { bible: doc, outline })
    return
  }

  if (method === 'POST' && path === '/bible/patch') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.writeBible(active.id, {
      ...(typeof body.theme === 'string' ? { theme: body.theme } : {}),
      ...(typeof body.world === 'string' ? { world: body.world } : {}),
      ...(Array.isArray(body.chapters) ? { chapters: body.chapters as never } : {}),
    }, { via: 'human' })
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/bible/import-outline') {
    const body = await readJsonBody(req)
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const text = String(body.text ?? '')
    if (text.trim() === '') throw new GalfreeError('bible-invalid', '大纲原文不能为空')
    await service.importOutline(active.id, text)
    writeJson(res, 200, { ok: true, chars: text.length })
    return
  }

  // 「设定定稿」戳:只能由人盖(与场景/槽戳同一条守卫)。
  if (method === 'POST' && path === '/bible/stamp') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    await service.stampBible(active.id, { via: 'human' })
    writeJson(res, 200, { ok: true })
    return
  }

  // 下游上下文(只给定稿版):没定稿 → 409,面板/agent 据此提示去定稿。
  if (method === 'GET' && path === '/bible/context') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    writeJson(res, 200, await service.generationContext(active.id))
    return
  }

  // 一键试玩(T7):接缝同一控制器,无第二管线。
  if (method === 'POST' && path === '/playtest') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    const run = await service.playtestStart(active.id)
    writeJson(res, 200, { run })
    return
  }

  // SDK 供给状态 / 触发下载(T5:首次使用自动下载、进度可见)。
  if (method === 'GET' && path === '/sdk') {
    if (deps.sdk === undefined) return writeJson(res, 503, { error: 'SDK 供给未装配' })
    writeJson(res, 200, await deps.sdk.status())
    return
  }
  if (method === 'POST' && path === '/sdk/ensure') {
    if (deps.sdk === undefined) return writeJson(res, 503, { error: 'SDK 供给未装配' })
    const status = await deps.sdk.ensure()
    writeJson(res, 200, { state: status.state, error: status.error ?? null, progress: status.progress })
    return
  }

  // 变更推送(SSE):外部修改 → 网关观察 → 工作台无刷新即更新(T2;协议在 T7 定稿)。
  if (method === 'GET' && path === '/events') {
    const active = await service.getActiveProject()
    if (active === null) return writeJson(res, 404, { error: '没有激活项目' })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': galfree events\n\n')
    let debounce: ReturnType<typeof setTimeout> | undefined
    const stop = service.observeChanges(active.id, (change) => {
      if (change.kind !== 'external') return
      // 合并抖动:100ms 内的多次外部改动推一帧(客户端收到即重拉状态)。
      if (debounce !== undefined) return
      debounce = setTimeout(() => {
        debounce = undefined
        try {
          res.write(`data: ${JSON.stringify({ type: 'external-change' })}\n\n`)
        } catch { /* 客户端已断开 */ }
      }, 100)
      debounce.unref?.()
    })
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* closed */ }
    }, 25_000)
    heartbeat.unref?.()
    req.on('close', () => {
      clearInterval(heartbeat)
      if (debounce !== undefined) clearTimeout(debounce)
      stop()
    })
    return
  }

  writeJson(res, 404, { error: `未知路由 ${method} ${path}` })
}

export function makeRoutes(deps: RouteDeps): GalfreeRoute[] {
  return [{
    kind: 'prefix',
    path: '/api/galfree',
    async handler(req, res) {
      try {
        await dispatch(deps, req, res)
      } catch (error) {
        const failure = pickerFailure(error)
        if (failure !== null) {
          // 浏览后端的类型化失败:业务码原样透出,409 表示"你的操作与磁盘现状冲突"
          // (目录不可读 / 已存在 / 建不出来),面板按 code 说人话。
          writeJson(res, 409, { error: failure.message, code: failure.code, path: failure.path })
        } else if (error instanceof GalfreeError) {
          // 404 = 目标不存在(含"项目目录已被挪走"),与 5xx 的"服务端故障"严格区分。
          const status = error.code === 'no-active-project' || error.code === 'unknown-project' || error.code === 'unknown-scene' || error.code === 'project-missing' ? 404
            : error.code === 'project-exists' || error.code === 'invalid-name' || error.code === 'no-projects-root' || error.code === 'bad-json' || error.code === 'character-invalid' || error.code === 'slot-invalid' || error.code === 'bible-invalid' ? 400
            : error.code === 'body-too-large' ? 413
            : error.code === 'picker-unsupported' ? 501
            : error.code === 'picker-timeout' ? 504
            : error.code === 'bible-not-final' ? 409
            : error.code === 'version-drift' || error.code === 'expect-required' || error.code === 'path-escape' || error.code === 'stamp-forbidden' || error.code === 'slot-not-filled' || error.code === 'sdk-not-ready' ? 409
            : 500
          writeJson(res, status, { error: error.message, code: error.code })
        } else {
          writeJson(res, 500, { error: String(error) })
        }
        if (!res.headersSent) res.end()
      }
    },
  }]
}
