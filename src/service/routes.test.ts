/**
 * 路由适配层的契约测试(/api/galfree)。
 *
 * 这不是第二个接缝:项目逻辑仍只经 ProjectService 断言(见各 *-service / * 测试)。
 * 这里只钉住**薄适配器**自己的行为 —— 状态码映射、方法守卫、鉴权墙、SSE 帧,
 * 以及"工作台实际调用的每个端点都真的存在"。存在的理由:这一层曾经长期没人
 * 走过,于是"坏 JSON → 500""项目目录消失 → 500"两个错误映射静默存活了下来。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRoutes } from '../routes.ts'
import { createProjectService, type ProjectService } from './project-service.ts'

const SCRIPT = [
  'label start:',
  '    scene bg school',
  '    "从这里开始你的故事。"',
  '    jump prologue',
  '',
  'label prologue:',
  '    show alice smile',
  '    alice "序章。"',
  '    return',
  '',
].join('\n')

let server: Server
let base: string
let service: ProjectService
let dataDir: string
let projectsRoot: string
let seq = 0

async function req(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

function postJson(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  return req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

/** 带伪造 Host 的裸请求(fetch 不允许改 Host)。 */
function rawWithHost(path: string, host: string): Promise<number> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, path, headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/** 每个用例自带项目:单跑与全跑结果一致。 */
async function freshProject(): Promise<{ id: string; root: string; name: string }> {
  seq += 1
  const name = `rt${seq}`
  const created = await postJson('/api/galfree/projects/create', { name, title: `路由项目${seq}`, projectsRoot })
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`)
  const project = created.body.project as { id: string; root: string }
  const snap = await service.readProjectFile(project.id, 'game/script.rpy')
  await service.writeProjectFiles(project.id, [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'workbench', reason: 'scenario' })
  return { id: project.id, root: project.root, name }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'galfree-route-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'galfree-route-proj-'))
  service = createProjectService({ dataDir })
  const routes = makeRoutes({
    service,
    config: () => ({ enabled: true, defaultProjectsRoot: '' }),
    sdk: {
      status: async () => ({
        requested: 'pinned' as const,
        dir: join(dataDir, 'sdk'),
        launcherReady: false,
        provision: { sdkDir: join(dataDir, 'sdk'), state: 'idle' as const, progress: { phase: 'idle' as const, fraction: 0 } },
      }),
      ensure: async () => ({ sdkDir: join(dataDir, 'sdk'), state: 'idle' as const, progress: { phase: 'idle' as const, fraction: 0 } }),
    },
  })
  server = createServer((request, response) => { void routes[0]!.handler(request, response) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await service.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
  await rm(projectsRoot, { recursive: true, force: true, maxRetries: 5 })
})

describe('路由适配层(/api/galfree)', () => {
  it('空状态如实返回,不是错误', async () => {
    const state = await req('/api/galfree/state')
    expect(state.status).toBe(200)
    expect(state.body).toMatchObject({ projects: [], activeId: null, tree: [], activeRoot: null, gatewayErrors: [] })
  })

  it('坏 JSON 请求体是 400(不是 500 服务端故障)', async () => {
    const bad = await req('/api/galfree/projects/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('bad-json')
  })

  it('超大请求体是 413', async () => {
    const r = await postJson('/api/galfree/projects/create', { name: 'x'.repeat(70 * 1024), projectsRoot })
    expect(r.status).toBe(413)
  })

  it('未知路由 404;路径存在但方法不对 405 且带 Allow', async () => {
    expect((await req('/api/galfree/nope')).status).toBe(404)
    const wrongMethod = await req('/api/galfree/projects/create')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.body.code).toBe('method-not-allowed')
  })

  it('非回环 Host 一律 403', async () => {
    expect(await rawWithHost('/api/galfree/state', 'evil.example.com')).toBe(403)
    expect(await rawWithHost('/api/galfree/state', '127.0.0.1')).toBe(200)
  })

  it('工作台调用的端点全部存在:state / progress / validate / sdk / snapshots', async () => {
    await freshProject()
    const state = await req('/api/galfree/state')
    expect(state.body.activeId).toBeTruthy()
    expect(JSON.stringify(state.body.tree)).toContain('script.rpy')

    const progress = await req('/api/galfree/progress')
    expect(progress.status).toBe(200)
    expect(progress.body.scenes.map((scene: { label: string }) => scene.label).sort()).toEqual(['prologue', 'start'])
    expect(progress.body.summary.scenes).toBe(2)
    expect(progress.body.lint.ok).toBe(true)
    expect(Array.isArray(progress.body.problems)).toBe(true)

    expect((await req('/api/galfree/validate')).status).toBe(200)
    expect((await req('/api/galfree/sdk')).status).toBe(200)
    expect((await req('/api/galfree/snapshots?path=game%2Fscript.rpy')).status).toBe(200)
  })

  it('人盖场景戳生效;重生成同一幕 → 待复审(指纹=场景原始文本)', async () => {
    const project = await freshProject()
    expect((await postJson('/api/galfree/stamps/scene', { label: 'prologue' })).status).toBe(200)
    const approved = await req('/api/galfree/progress')
    expect(approved.body.scenes.find((scene: any) => scene.label === 'prologue').stamp).toBe('approved')

    const snap = await service.readProjectFile(project.id, 'game/script.rpy')
    await service.writeProjectFiles(project.id, [{
      path: 'game/script.rpy',
      content: snap.content.replace('alice "序章。"', 'alice "序章(重生成)。"'),
      expectVersion: snap.version,
    }], { origin: 'workbench', reason: 'scenario' })

    const stale = await req('/api/galfree/progress')
    expect(stale.body.scenes.find((scene: any) => scene.label === 'prologue').stamp).toBe('stale')
    expect(stale.body.summary.awaitingReview).toBe(1)
  })

  it('只改别的场景不会让已经盖过的戳失效', async () => {
    const project = await freshProject()
    await postJson('/api/galfree/stamps/scene', { label: 'start' })
    const snap = await service.readProjectFile(project.id, 'game/script.rpy')
    await service.writeProjectFiles(project.id, [{
      path: 'game/script.rpy',
      content: snap.content.replace('alice "序章。"', 'alice "另一幕改了。"'),
      expectVersion: snap.version,
    }], { origin: 'workbench', reason: 'scenario' })
    const progress = await req('/api/galfree/progress')
    expect(progress.body.scenes.find((scene: any) => scene.label === 'start').stamp).toBe('approved')
  })

  it('未知场景 404;未填素材槽 409', async () => {
    await freshProject()
    const unknown = await postJson('/api/galfree/stamps/scene', { label: 'nope' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('unknown-scene')

    const unfilled = await postJson('/api/galfree/stamps/slot', { slot: 'bg school' })
    expect(unfilled.status).toBe(409)
    expect(unfilled.body.code).toBe('slot-not-filled')
  })

  it('素材补齐后槽可盖戳,板上转成已认可', async () => {
    const project = await freshProject()
    await mkdir(join(project.root, 'game/images'), { recursive: true })
    await writeFile(join(project.root, 'game/images/bg-school.png'), Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex',
    ))

    const before = await req('/api/galfree/progress')
    const start = before.body.scenes.find((scene: any) => scene.label === 'start')
    expect(start.missingSlots).toEqual([])
    expect(start.slots.find((slot: any) => slot.slot === 'bg school').filled).toBe(true)

    expect((await postJson('/api/galfree/stamps/slot', { slot: 'bg school' })).status).toBe(200)
    const after = await req('/api/galfree/progress')
    expect(after.body.scenes.find((scene: any) => scene.label === 'start')
      .slots.find((slot: any) => slot.slot === 'bg school').stamp).toBe('approved')
  })

  it('项目目录被挪走:状态如实标 missing,下游读进度是 404 不是 500', async () => {
    const project = await freshProject()
    await rm(project.root, { recursive: true, force: true })
    const state = await req('/api/galfree/state')
    expect(state.body.activeMissing).toBe(true)
    expect(state.body.tree).toEqual([])
    expect((await req('/api/galfree/progress')).status).toBe(404)
    expect((await req('/api/galfree/validate')).status).toBe(404)
    expect((await req('/api/galfree/snapshots?path=game%2Fscript.rpy')).status).toBe(404)
  })

  it('SSE:外部改动经网关观察后推一帧给工作台', async () => {
    const project = await freshProject()
    const controller = new AbortController()
    const res = await fetch(`${base}/api/galfree/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toContain('galfree events')

    await writeFile(join(project.root, 'game/script.rpy'), `${SCRIPT}\n# external\n`, 'utf8')

    const deadline = Date.now() + 10_000
    let sawEvent = false
    while (Date.now() < deadline && !sawEvent) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), 1000)),
      ])
      if (chunk.value !== undefined && decoder.decode(chunk.value).includes('external-change')) sawEvent = true
    }
    controller.abort()
    expect(sawEvent).toBe(true)
  })

  it('停用开关:仅 /state 可读,其余 503', async () => {
    const offline = createProjectService({ dataDir: join(dataDir, 'disabled') })
    const routes = makeRoutes({ service: offline, config: () => ({ enabled: false, defaultProjectsRoot: '' }) })
    const s = createServer((request, response) => { void routes[0]!.handler(request, response) })
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const port = (s.address() as { port: number }).port
    expect((await fetch(`http://127.0.0.1:${port}/api/galfree/state`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/api/galfree/progress`)).status).toBe(503)
    await offline.dispose()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  })
})
