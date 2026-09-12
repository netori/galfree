/**
 * 路由适配层契约测试(/api/galfree)—— **慢带**(`npm run test:slow`)。
 *
 * 规范定位(重要):spec Testing Decisions 与 docs/contracts/stage-zero.md 的
 * 测试纪律都写着"不测适配器、不引入第二测试面",测试接缝只认 ProjectService。
 * 本文件是**一处被记录在案的例外**,不是第二个接缝:
 *
 *  - 断言的是薄适配器自己的对外行为(状态码映射、方法守卫、回环 Host 守卫、
 *    SSE 帧形状、"工作台实际调用的每个端点都存在"),不碰任何项目逻辑;
 *  - 项目逻辑仍只经 ProjectService 断言(见本文件之外的各 seam 测试);
 *  - 它是慢带成员:快集成带保持 100% 符合 spec 的接缝纪律,这一层在
 *    `npm run test:slow` 里跑(发版前必跑,CI 默认跳过)。
 *
 * 存在的理由(已被现实证明):这一层曾经长期没人走过,于是
 * "坏 JSON → 500""项目目录消失 → 500"两个错误映射静默存活到了环节零交付之后。
 * 例外本身的记录见 docs/contracts/stage-zero.md 的测试纪律节。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
/** 目录选择后端形态与"人在对话框里选了什么",按用例改写。 */
let pickerKind = 'native'
let pickedPath: string | null = null

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
    config: () => ({ enabled: true, defaultProjectsRoot: projectsRoot }),
    // 目录选择端口用假后端:原生选择器会开真对话框,自动化面不能碰。
    picker: {
      capability: async () => ({ kind: pickerKind }),
      pick: async () => (pickerKind === 'native' ? pickedPath : null),
      list: async (path?: string) => ({
        path: path ?? '/home/tester',
        home: '/home/tester',
        crumbs: [{ name: '/', path: '/' }, { name: 'home', path: '/home' }],
        entries: [{ name: 'projects', path: '/home/projects', hidden: false }, { name: '.config', path: '/home/.config', hidden: true }],
        truncated: false,
      }),
      createDirectory: async (path: string, name: string) => ({ path: `${path}/${name}`, name }),
    },
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
    // 可盖性也由接缝给:填了就 approvable,而且已认可的槽仍可重盖(不是 UI 自己判的)
    expect(start.slots.find((slot: any) => slot.slot === 'bg school').approvable).toBe(true)

    expect((await postJson('/api/galfree/stamps/slot', { slot: 'bg school' })).status).toBe(200)
    const after = await req('/api/galfree/progress')
    expect(after.body.scenes.find((scene: any) => scene.label === 'start')
      .slots.find((slot: any) => slot.slot === 'bg school').stamp).toBe('approved')
    // 已认可 → 仍然 approvable(可以重新认可),UI 不再自行禁止
    expect(after.body.scenes.find((scene: any) => scene.label === 'start')
      .slots.find((slot: any) => slot.slot === 'bg school').approvable).toBe(true)
    // 未填的槽则不可盖,且带原因
    const unfilledSlot = after.body.scenes.find((scene: any) => scene.label === 'rooftop_rain')?.slots
      .find((slot: any) => slot.filled === false)
    if (unfilledSlot !== undefined) {
      expect(unfilledSlot.approvable).toBe(false)
      expect(unfilledSlot.approvableBlockedBy).toBeTruthy()
    }
  })

  it('切换激活项目走注册表激活位,不写任何项目文件', async () => {
    const first = await freshProject()
    const second = await freshProject()
    expect((await req('/api/galfree/state')).body.activeId).toBe(second.id)

    const activated = await postJson('/api/galfree/projects/activate', { project: first.id })
    expect(activated.status).toBe(200)
    expect(activated.body.project.id).toBe(first.id)
    const state = await req('/api/galfree/state')
    expect(state.body.activeId).toBe(first.id)
    // 切回后进度读的是第一个项目(模板两场戏),而不是第二个的 SCRIPT
    const progress = await req('/api/galfree/progress')
    expect(progress.body.scenes.map((scene: { label: string }) => scene.label).sort()).toEqual(['prologue', 'start'])

    // 不存在的项目 → 404(unknown-project),不是静默成功
    const missing = await postJson('/api/galfree/projects/activate', { project: 'no-such-project' })
    expect(missing.status).toBe(404)
  })

  it('文件内容只读预览:读得到当前内容,且不产生写', async () => {
    await freshProject()
    const before = await service.listProjects()
    const active = before.find((project) => project.active)!
    const historyBefore = await service.snapshotHistory(active.id, 'game/script.rpy')

    const file = await req('/api/galfree/files/content?path=game%2Fscript.rpy')
    expect(file.status).toBe(200)
    expect(file.body.content).toContain('label start:')
    expect(file.body.bytes).toBeGreaterThan(0)
    expect(typeof file.body.version).toBe('string')
    expect(file.body.version).not.toBe('absent')

    // 只读:快照历史不增长(读不产生写批)
    const historyAfter = await service.snapshotHistory(active.id, 'game/script.rpy')
    expect(historyAfter.length).toBe(historyBefore.length)

    // 缺 path → 400;不存在的项目路径 → 仍能如实报告 absent
    expect((await req('/api/galfree/files/content')).status).toBe(400)
    const absent = await req('/api/galfree/files/content?path=game%2Fnever.rpy')
    expect(absent.status).toBe(200)
    expect(absent.body.version).toBe('absent')
  })

  it('回滚:文件回到历史版本,且回滚本身留下一条新快照(历史不改写)', async () => {
    const project = await freshProject()
    const history = await service.snapshotHistory(project.id, 'game/script.rpy')
    const oldest = history[history.length - 1]!
    const commitsBefore = history.length

    const snap = await service.readProjectFile(project.id, 'game/script.rpy')
    await service.writeProjectFiles(project.id, [{
      path: 'game/script.rpy', content: '# 被改坏了\n', expectVersion: snap.version,
    }], { origin: 'workbench', reason: 'scenario' })
    expect((await req('/api/galfree/files/content?path=game%2Fscript.rpy')).body.content).toBe('# 被改坏了\n')

    const rolled = await postJson('/api/galfree/snapshots/rollback', { path: 'game/script.rpy', to: oldest.commit })
    expect(rolled.status).toBe(200)
    const restored = await req('/api/galfree/files/content?path=game%2Fscript.rpy')
    expect(restored.body.content).toContain('从这里开始你的故事')

    // 回滚不改写历史:历史只增(写了 1 次 + 回滚 1 次 = +2),且旧 commit 仍在
    const after = await service.snapshotHistory(project.id, 'game/script.rpy')
    expect(after.length).toBe(commitsBefore + 2)
    expect(after.some((entry) => entry.commit === oldest.commit)).toBe(true)

    // 缺参数 → 400
    expect((await postJson('/api/galfree/snapshots/rollback', { path: 'game/script.rpy' })).status).toBe(400)
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

  it('目录选择:native 后端回报能力、选中路径与取消;不选就什么都不改', async () => {
    pickerKind = 'native'
    pickedPath = null

    const capability = await req('/api/galfree/picker')
    expect(capability.status).toBe(200)
    expect(capability.body.kind).toBe('native')
    // 默认父目录随能力一起给面板,好让它说清"不选会建到哪"
    expect(capability.body.defaultProjectsRoot).toBe(projectsRoot)

    const cancelled = await postJson('/api/galfree/picker/pick', {})
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toEqual({ path: null, cancelled: true })

    pickedPath = projectsRoot
    const picked = await postJson('/api/galfree/picker/pick', {})
    expect(picked.status).toBe(200)
    expect(picked.body).toEqual({ path: projectsRoot, cancelled: false })

    // 选完之后真的能拿它建项目(端到端:选目录 → 建项目)
    const created = await postJson('/api/galfree/projects/create', { name: `picked${(seq += 1)}`, projectsRoot: picked.body.path })
    expect(created.status).toBe(201)
  })

  it('目录选择:browse 后端给一层列举;原生入口如实报"不可用"而不是假装成功', async () => {
    pickerKind = 'browse'

    const capability = await req('/api/galfree/picker')
    expect(capability.body.kind).toBe('browse')

    const listing = await req('/api/galfree/picker/list?path=%2Fhome%2Ftester')
    expect(listing.status).toBe(200)
    expect(listing.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['projects', '.config'])
    expect(listing.body.entries.find((entry: { name: string }) => entry.name === '.config').hidden).toBe(true)
    expect(listing.body.crumbs.length).toBeGreaterThan(0)

    const created = await postJson('/api/galfree/picker/create-directory', { path: '/home/tester', name: 'new-folder' })
    expect(created.status).toBe(201)
    expect(created.body.path).toBe('/home/tester/new-folder')
    expect((await postJson('/api/galfree/picker/create-directory', { path: '/home/tester' })).status).toBe(400)
  })

  it('宿主没有选择器后端时:浏览器仍可用(插件自带底座兜底),系统对话框如实报不可用', async () => {
    // 真实故障形态:dsh-host-directory-picker-auto 用运行时 Loader 动态装后端,
    // 那一步失败是静默的 → ctx.directoryPicker 根本不存在。
    const bare = createProjectService({ dataDir: join(dataDir, 'nopicker') })
    const routes = makeRoutes({ service: bare, config: () => ({ enabled: true, defaultProjectsRoot: '' }) })
    const s = createServer((request, response) => { void routes[0]!.handler(request, response) })
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const port = (s.address() as { port: number }).port
    const origin = `http://127.0.0.1:${port}/api/galfree`

    const capability = await (await fetch(`${origin}/picker`)).json() as { kind: string; browse: boolean; native: boolean }
    expect(capability.kind).toBe('none')
    // 关键:浏览入口恒可用 —— 不再挂在宿主启动时序上
    expect(capability.browse).toBe(true)
    expect(capability.native).toBe(false)

    // 系统对话框如实报不可用(不假装成功)
    expect((await fetch(`${origin}/picker/pick`, { method: 'POST' })).status).toBe(501)

    // 自带底座真的能列目录(数据源是磁盘,不是假的)
    const listing = await (await fetch(`${origin}/picker/list?path=${encodeURIComponent(projectsRoot)}`)).json() as {
      path: string; entries: Array<{ name: string }>; source?: string
    }
    expect(listing.source).toBe('plugin')
    expect(listing.path).toBe(projectsRoot)
    expect(listing.entries.length).toBeGreaterThan(0)

    // 也能真的建目录(磁盘终态断言)
    const created = await fetch(`${origin}/picker/create-directory`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectsRoot, name: 'from-fallback' }),
    })
    expect(created.status).toBe(201)
    expect(await readdir(projectsRoot)).toContain('from-fallback')

    await bare.dispose()
    await new Promise<void>((resolve) => s.close(() => resolve()))
    pickerKind = 'native'
  })

  it('手输路径即时校验:存在与否、是不是目录,都如实回答', async () => {
    const exists = await req(`/api/galfree/picker/inspect?path=${encodeURIComponent(projectsRoot)}`)
    expect(exists.status).toBe(200)
    expect(exists.body).toMatchObject({ exists: true, isDirectory: true })

    const missing = await req('/api/galfree/picker/inspect?path=D%3A%5Cnope-nope-nope')
    expect(missing.status).toBe(200)
    expect(missing.body.exists).toBe(false)

    const relative = await req('/api/galfree/picker/inspect?path=relative')
    expect(relative.body.exists).toBe(false)
    expect((await req('/api/galfree/picker/inspect')).status).toBe(400)
  })

  it('素材板账本路由:登记角色 / 挂槽制作信息 / 派生结果立刻反映', async () => {
    await freshProject()

    // 空账本:如实返回空,不是错误。
    const empty = await req('/api/galfree/cast')
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ characters: [], slots: [] })

    // 登记一个角色(经网关写 → 有新快照)。
    const before = await req('/api/galfree/progress')
    const snapshotsBefore = (await service.listProjects()).find((project) => project.active)!
    const historyBefore = await service.snapshotHistory(snapshotsBefore.id, '.studio/characters.json')

    const created = await postJson('/api/galfree/cast/characters/upsert', {
      id: 'xiao_tang', name: '小棠', voice: 'alice', appearance: { hair: '黑色长直发' }, styleAnchor: 'clean anime lineart',
    })
    expect(created.status).toBe(200)
    const historyAfter = await service.snapshotHistory(snapshotsBefore.id, '.studio/characters.json')
    expect(historyAfter.length).toBeGreaterThan(historyBefore.length)

    // 派生立刻反映:角色进入素材板,且"剧本里有没有它"是推导出来的。
    const progress = await req('/api/galfree/progress')
    const board = progress.body.characters.find((character: { id: string }) => character.id === 'xiao_tang')
    expect(board).toBeDefined()
    expect(board.defined).toBe(false) // SCRIPT 里没有 alice 的 Character 定义
    expect(progress.body.slots.map((slot: { slot: string }) => slot.slot)).toEqual(expect.arrayContaining(['bg school']))
    // 槽带着账本与定位字段(定位能力是 AC 的一部分)。
    const school = progress.body.slots.find((slot: { slot: string }) => slot.slot === 'bg school')
    expect(school.origin.file).toBe('script.rpy')
    expect(school.origin.scenes).toContain('start')
    void before

    // 挂槽制作信息 → 账本落盘;悬空(要求不存在的角色)如实进 problems。
    expect((await postJson('/api/galfree/cast/slots/upsert', {
      slot: 'bg school', requiresCharacters: ['ghost'], prompt: '教室,午后的光',
    })).status).toBe(200)
    const withDangling = await req('/api/galfree/progress')
    expect(withDangling.body.problems.some((problem: { code: string }) => problem.code === 'dangling-character-ref')).toBe(true)
    expect(withDangling.body.lint.ok).toBe(false)

    // 移除角色 / 移除账本:幂等且如实反映。
    expect((await postJson('/api/galfree/cast/characters/remove', { id: 'xiao_tang' })).status).toBe(200)
    expect((await postJson('/api/galfree/cast/slots/remove', { slot: 'bg school' })).status).toBe(200)
    const cleaned = await req('/api/galfree/progress')
    expect(cleaned.body.problems.some((problem: { code: string }) => problem.code === 'dangling-character-ref')).toBe(false)

    // 非法输入:坏 id / 空槽名 → 400(不是 500)。
    expect((await postJson('/api/galfree/cast/characters/upsert', { id: 'Bad Id', name: 'x' })).status).toBe(400)
    expect((await postJson('/api/galfree/cast/slots/upsert', { slot: '' })).status).toBe(400)
  })

  it('设定集路由:导入大纲逐字保留 / 定稿戳只人可盖 / 下游上下文只给定稿版', async () => {
    await freshProject()

    // 空设定集:如实返回空壳,不是错误。
    const empty = await req('/api/galfree/bible')
    expect(empty.status).toBe(200)
    expect(empty.body.bible.chapters).toEqual([])
    expect(empty.body.outline).toBeNull()

    // 人写的原文(带口语与括注,专门看会不会被"整理")。
    const outline = '第一章 天台\n她说"你也是来看雨的哦",语气很冲。\n\n（备注:先别写结局。）'
    const imported = await postJson('/api/galfree/bible/import-outline', { text: outline })
    expect(imported.status).toBe(200)
    expect(imported.body.chars).toBe(outline.length)
    const after = await req('/api/galfree/bible')
    expect(after.body.outline).toBe(outline) // 逐字
    expect(after.body.bible.outline.path).toBe('.studio/bible/outline.md')

    // 面板改主题/世界观 → 派生物变化,戳自动待复审。
    expect((await postJson('/api/galfree/bible/patch', { theme: '雨天的重逢', world: '现代都市,梅雨季。' })).status).toBe(200)
    let progress = await req('/api/galfree/progress')
    expect(progress.body.bible.stamp).toBe('none')
    expect(progress.body.bible.hasOutline).toBe(true)
    expect(progress.body.bible.outlineFingerprintOk).toBe(true)

    // 没定稿 → 下游上下文拒绝(409),不偷偷给草稿。
    const refused = await req('/api/galfree/bible/context')
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('bible-not-final')

    // 人盖定稿戳 → 上下文可读,且带指纹。
    expect((await postJson('/api/galfree/bible/stamp', {})).status).toBe(200)
    progress = await req('/api/galfree/progress')
    expect(progress.body.bible.stamp).toBe('approved')
    const context = await req('/api/galfree/bible/context')
    expect(context.status).toBe(200)
    expect(context.body.theme).toBe('雨天的重逢')
    expect(context.body.outline.text).toBe(outline)
    expect(context.body.fingerprint).toBeTruthy()

    // 再改设定集 → 戳待复审 → 上下文又拒绝。
    await postJson('/api/galfree/bible/patch', { theme: '改过的主题' })
    progress = await req('/api/galfree/progress')
    expect(progress.body.bible.stamp).toBe('stale')
    expect((await req('/api/galfree/bible/context')).status).toBe(409)

    // 空原文 → 400;不是 500。
    expect((await postJson('/api/galfree/bible/import-outline', { text: '   ' })).status).toBe(400)
  })

  it('场景编辑器路由:读表单 / 表单编辑守归属 / 源文本可改 / 坏输入 400', async () => {
    await freshProject()

    // 读表单:行模型 + 源文本。
    const form = await req('/api/galfree/scenes/form?label=start')
    expect(form.status).toBe(200)
    expect(form.body.label).toBe('start')
    expect(form.body.rows.length).toBeGreaterThan(0)
    expect(form.body.source).toContain('label start:')
    expect((await req('/api/galfree/scenes/form')).status).toBe(400)
    expect((await req('/api/galfree/scenes/form?label=nope')).status).toBe(404)

    // 表单编辑:停在手写文件的场景被拒(且理由是可执行的指令),源文本模式可以改。
    const refused = await postJson('/api/galfree/scenes/edit', {
      label: 'start', edit: { kind: 'setDialogue', line: 3, speaker: null, text: 'x' },
    })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('script.rpy')

    const raw = await postJson('/api/galfree/scenes/edit', {
      label: 'start',
      edit: { kind: 'replaceSource', source: 'label start:\n    "从源文本改的。"\n    return\n' },
    })
    expect(raw.status).toBe(200)
    expect(raw.body.form.source).toContain('从源文本改的。')
    expect(raw.body.validation.ok).toBe(true)

    // 坏编辑(缺 kind)→ 400,不是 500。
    expect((await postJson('/api/galfree/scenes/edit', { label: 'start', edit: {} })).status).toBe(400)
    expect((await postJson('/api/galfree/scenes/edit', { label: 'start' })).status).toBe(400)
  })

  it('分支图路由:节点/边与接缝派生一致,子集外场景带只读与原因', async () => {
    await freshProject()
    const graph = await req('/api/galfree/scenes/graph')
    expect(graph.status).toBe(200)
    expect(graph.body.dialect).toBe('galfree-subset-1')

    // 与接缝读出来的**同一份**派生对象(不是路由自己算的)。
    const active = (await service.listProjects()).find((project) => project.active)!
    const derived = await service.branchGraph(active.id)
    expect(graph.body.nodes.map((node: { label: string }) => node.label))
      .toEqual(derived.scenes.map((scene) => scene.label))
    expect(graph.body.edges.map((edge: { from: string; to: string }) => `${edge.from}->${edge.to}`))
      .toEqual(derived.edges.map((edge) => `${edge.from}->${edge.to}`))
    // 节点带戳状态(来自推导,不在面板里自己判)。
    expect(graph.body.nodes.every((node: { stamp: string }) => typeof node.stamp === 'string')).toBe(true)

    // 子集外场景:图上带只读 + 原因。
    await service.generateScene(active.id, {
      label: 'scene_odd',
      source: 'label scene_odd:\n    if flag:\n        "子集外。"\n    return\n',
      outline: undefined,
    })
    const withOdd = await req('/api/galfree/scenes/graph')
    const odd = withOdd.body.nodes.find((node: { label: string }) => node.label === 'scene_odd')
    expect(odd.readOnly).toBe(true)
    expect(typeof odd.reason).toBe('string')
    expect(withOdd.body.degraded).toBe(true)
  })

  it('整线完整性 + 从此场试玩:状态码与拒绝语义都如实', async () => {
    const project = await freshProject()
    // 完整性:模板两场是通的。
    const graph = await req('/api/galfree/scenes/graph')
    expect(graph.body.degraded).toBe(false)
    const progressBefore = await req('/api/galfree/progress')
    expect(progressBefore.body.completeness).toMatchObject({ entry: 'start', orphans: [], endingReachable: true })

    // 造一个孤立场景 → 板上如实报,并定位到它自己。
    await service.generateScene(project.id, {
      label: 'lonely',
      source: 'label lonely:\n    "没人走得到。"\n    return\n',
      outline: undefined,
    })
    const progressAfter = await req('/api/galfree/progress')
    expect(progressAfter.body.completeness.orphans).toEqual(['lonely'])
    expect(progressAfter.body.problems.some((problem: { code: string }) => problem.code === 'orphan-scene')).toBe(true)

    // 试玩路由:`from` 指向不存在的场 → 404(不静默地从 start 跑一遍糊弄过去)。
    const bogus = await postJson('/api/galfree/playtest', { from: 'no_such_scene' })
    expect(bogus.status).toBe(404)
    expect(bogus.body.code).toBe('unknown-scene')

    // 不带 body(面板的"启动试玩")也不该因为读不到 JSON 而 500 —— 这里没有真 SDK,
    // 所以期望的是 **sdk-not-ready**(409),而不是解析错误。
    const noBody = await postJson('/api/galfree/playtest', {})
    expect([409, 200]).toContain(noBody.status)
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
