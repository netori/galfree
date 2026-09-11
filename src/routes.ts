/**
 * /api/galfree 路由族 —— 项目服务的**薄适配器**(spec:适配器不承载独占逻辑)。
 * 工作台 Client 与未来的独立前端都经这里消费同一接缝状态。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { GalfreeError } from './service/error.ts'
import type { ProjectService } from './service/project-service.ts'

export interface RouteDeps {
  service: ProjectService
  /** 解析后的插件设置(enabled/defaultProjectsRoot/sdkPath…)。 */
  config: () => { enabled: boolean; defaultProjectsRoot: string }
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
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new GalfreeError('bad-json', '请求体需为 JSON 对象')
  return parsed as Record<string, unknown>
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

  if (method === 'GET' && path === '/state') {
    const projects = await service.listProjects()
    const active = projects.find((project) => project.active) ?? null
    let tree: TreeNode[] = []
    if (active !== null && !active.missing) {
      tree = await buildTree(active.root, '', 0, { left: TREE_MAX_ENTRIES })
    }
    writeJson(res, 200, { projects, activeId: active?.id ?? null, tree, activeRoot: active?.root ?? null, activeMissing: active?.missing ?? false })
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

  if (method === 'POST' && path === '/projects/activate') {
    const body = await readJsonBody(req)
    await service.setActive(String(body.id ?? ''))
    writeJson(res, 200, { ok: true })
    return
  }

  if (method === 'GET' && path === '/validate') {
    const report = await service.validateActiveProject()
    writeJson(res, 200, report)
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
        if (error instanceof GalfreeError) {
          const status = error.code === 'no-active-project' || error.code === 'unknown-project' ? 404
            : error.code === 'project-exists' || error.code === 'invalid-name' || error.code === 'no-projects-root' || error.code === 'bad-json' ? 400
            : error.code === 'body-too-large' ? 413
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
