/**
 * T1 seam tests — 项目服务(project service)公共接口上的端到端行为:
 * 从模板新建项目 → 合法 Ren'Py 骨架 + .studio 骨架 + git HEAD;进入注册表。
 *
 * 断言全部是外部可观察行为(磁盘终态、注册表状态对象),不触碰内部结构。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProjectService, type ProjectService } from '../service/project-service.ts'
import { FakeValidator } from './validation/template-validator.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'

const exec = promisify(execFile)

/** git with GALFree identity-independent invocation (reads no global config noise). */
async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args])
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('项目服务 · 模板新建项目(T1)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-data-')
    projectsRoot = await makeTempDir('galfree-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ─── 界面文件(实测缺口:少了 screens.rpy,连关窗确认都崩)─────────────

  it('建项目带上 SDK 的界面文件(少了 screens.rpy,关窗即 AttributeError 崩)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'ui-story', title: '界面' })

    // 四个界面文件都从 SDK 拷进来了,内容逐字一致(不是自己仿造的)。
    for (const name of ['screens.rpy', 'gui.rpy', 'guisupport.rpy', 'testcases.rpy']) {
      const onDisk = await readFile(join(project.root, 'game', name), 'utf8')
      const fromSdk = await readFile(join(sdkDir, 'gui', 'game', name), 'utf8')
      expect(onDisk).toBe(fromSdk)
    }
    // 中文字体**拷进了项目**,补丁指到项目内的相对路径。
    // (实测教训:写成 C:/Windows/Fonts/msyh.ttc 这种绝对路径会被 Ren'Py 静默回退,
    //  中文照样是方块 —— 所以必须是项目内路径,而且文件真在。)
    const fontOnDisk = await readFile(join(project.root, 'game', 'fonts', 'SourceHanSansLite.ttf'))
    const fontFromSdk = await readFile(join(sdkDir, 'sdk-fonts', 'SourceHanSansLite.ttf'))
    expect(fontOnDisk.equals(fontFromSdk)).toBe(true)

    const patch = await readFile(join(project.root, 'game', 'zz_galfree_ui.rpy'), 'utf8')
    expect(patch).toContain('gui.text_font = "fonts/SourceHanSansLite.ttf"')
    expect(patch).toContain('gui.interface_text_font')
    // options.rpy 补上了 screens.rpy 依赖的变量。
    const options = await readFile(join(project.root, 'game', 'options.rpy'), 'utf8')
    expect(options).toContain('gui.show_name')
    expect(options).toContain('gui.about')
  })

  it('界面文件进快照(它们也是项目的一部分,回滚要能回去)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'ui-snap', title: '界面' })
    const history = await service.snapshotHistory(project.id, 'game/screens.rpy')
    expect(history.length).toBeGreaterThan(0)
  })

  it('SDK 界面模板缺失 → 如实拒绝建项目(不造一个一玩就崩的空壳)', async () => {
    // 假 SDK 里少一个 screens.rpy。
    const brokenSdk = await makeTempDir('galfree-broken-sdk-')
    await mkdir(join(brokenSdk, 'gui', 'game'), { recursive: true })
    await writeFile(join(brokenSdk, 'gui', 'game', 'gui.rpy'), 'define gui.x = 1\n', 'utf8')

    await expect(service.createProject({ projectsRoot, name: 'broken', title: undefined, sdkDir: brokenSdk }))
      .rejects.toMatchObject({ code: 'sdk-ui-missing' })
    // 拒绝得干干净净:没有留下半个项目目录。
    expect(await exists(join(projectsRoot, 'broken'))).toBe(false)
  })

  it('解析范围只认叙述文件:界面/配置不按方言子集解析(否则一次 265 条 warning)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'scope', title: '范围' })
    // 往 game/ 塞一个满是子集外构造的界面文件(模拟真 screens.rpy / gui.rpy)。
    const v = (await service.readProjectFile(project.id, 'game/options.rpy')).version
    await service.writeProjectFiles(project.id, [{
      path: 'game/screens_like.rpy',
      content: 'init python:\n    x = 1\n\nscreen foo():\n    pass\n\nstyle bar:\n    size 12\n',
      expectVersion: 'absent',
    }], { reason: 'edit', origin: 'workbench' })
    void v

    const progress = await service.progress(project.id)
    // 界面文件不参与解析:narrative 的两场戏照常,问题里没有它的份。
    expect(progress.scenes.map((scene) => scene.label).sort()).toEqual(['prologue', 'start'])
    expect(progress.problems.filter((problem) => problem.file.includes('screens_like'))).toEqual([])
    expect(progress.lint.warnings).toBe(0)
  })

  it('生成到 game/scenes/ 的场次仍在解析范围内(划界没划过头)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'scope2', title: '范围' })
    await service.writeProjectFiles(project.id, [{
      path: 'game/scenes/extra.rpy',
      content: 'label extra:\n    "一句话。"\n    return\n',
      expectVersion: 'absent',
    }], { reason: 'scenario', origin: 'agent' })
    const progress = await service.progress(project.id)
    expect(progress.scenes.map((scene) => scene.label)).toContain('extra')
  })

  it('新建项目 → 注册表出现该条目,路径指向磁盘上的新目录,并激活', async () => {
    const project = await service.createProject({ projectsRoot, name: 'my-story', title: '我的故事' })

    expect(project.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(project.name).toBe('my-story')
    expect(project.title).toBe('我的故事')
    expect(project.root).toBe(join(projectsRoot, 'my-story'))

    const listed = await service.listProjects()
    expect(listed.map((p) => p.id)).toEqual([project.id])
    const active = await service.getActiveProject()
    expect(active?.id).toBe(project.id)
    // 单一真相核对:注册表条目与项目记录同 id(无第二处项目状态)。
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id, name: 'my-story' })
  })

  it("磁盘得到合法 Ren'Py 项目骨架(script.rpy / options.rpy / gui 约定)", async () => {
    const project = await service.createProject({ projectsRoot, name: 'story2', title: undefined })

    const script = await readFile(join(project.root, 'game', 'script.rpy'), 'utf8')
    expect(script).toContain('label start:')
    // options.rpy 声明 config.name / config.version / 保存目录 —— 标准项目三件套。
    const options = await readFile(join(project.root, 'game', 'options.rpy'), 'utf8')
    expect(options).toContain('define config.name = _("story2")')
    expect(options).toContain('define config.version = "0.1.0"')
    expect(options).toContain('define config.save_directory = "galfree-story2"')
    // 素材目录约定存在(Ren'Py 的 image/audio 搜索路径)。
    for (const dir of ['game/images', 'game/audio', 'game/tl']) {
      expect(await exists(join(project.root, dir))).toBe(true)
    }
    // 项目名可缺省 title(标题默认等于 name)。
    expect(project.title).toBe('story2')
  })

  it('.studio/ 契约骨架就位:项目元数据、审读戳账本、素材槽账本(空文件不复制叙述内容)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'story3', title: undefined })

    const meta = JSON.parse(await readFile(join(project.root, '.studio', 'project.json'), 'utf8'))
    expect(meta).toMatchObject({ schemaVersion: 1, id: project.id, name: 'story3' })

    // 账本骨架存在且为空结构 —— 只放引用与制作信息。
    const stamps = JSON.parse(await readFile(join(project.root, '.studio', 'stamps.json'), 'utf8'))
    expect(stamps).toEqual({ schemaVersion: 1, stamps: [] })
    const slots = JSON.parse(await readFile(join(project.root, '.studio', 'slots.json'), 'utf8'))
    expect(slots).toEqual({ schemaVersion: 1, slots: [] })
    const registry = JSON.parse(await readFile(join(project.root, '.studio', 'characters.json'), 'utf8'))
    expect(registry).toEqual({ schemaVersion: 1, characters: [] })

    // 铁律核对:.studio 下的任何账本文件都不包含剧本正文。
    const script = await readFile(join(project.root, 'game', 'script.rpy'), 'utf8')
    const probe = script.split('\n').find((line) => line.trim().startsWith('"'))?.trim()
    if (probe !== undefined) {
      const studioDir = join(project.root, '.studio')
      for (const file of ['project.json', 'stamps.json', 'slots.json', 'characters.json']) {
        const content = await readFile(join(studioDir, file), 'utf8')
        expect(content).not.toContain(probe.slice(1, probe.length - 1))
      }
    }
  })

  it('git 初始化:HEAD 存在,作者标识 GALFree,模板文件全部纳入首提交', async () => {
    const project = await service.createProject({ projectsRoot, name: 'story4', title: undefined })

    const head = await git(project.root, ['rev-parse', 'HEAD'])
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    const author = await git(project.root, ['log', '-1', '--format=%an <%ae>'])
    expect(author).toBe('GALFree <galfree@dsh.local>')
    const tracked = (await git(project.root, ['ls-files'])).split('\n')
    expect(tracked).toContain('game/script.rpy')
    expect(tracked).toContain('.studio/project.json')
    // 工作区干净:快照点无未提交残留。
    const status = await git(project.root, ['status', '--porcelain'])
    expect(status).toBe('')
  })

  it('重名项目不静默覆盖:磁盘已有目标目录时报错并保持原目录不变', async () => {
    const first = await service.createProject({ projectsRoot, name: 'dup', title: undefined })
    await readFile(join(first.root, 'game', 'script.rpy')) // 项目确实在

    await expect(service.createProject({ projectsRoot, name: 'dup', title: undefined })).rejects.toMatchObject({
      code: 'project-exists',
    })
    // 原项目仍在注册表且未被破坏。
    expect((await service.listProjects()).map((p) => p.id)).toEqual([first.id])
  })

  it('项目名必须是文件系统安全 slug,拒绝路径注入', async () => {
    await expect(service.createProject({ projectsRoot, name: '../escape', title: undefined })).rejects.toMatchObject({
      code: 'invalid-name',
    })
    await expect(service.createProject({ projectsRoot, name: '有中文', title: undefined })).rejects.toMatchObject({
      code: 'invalid-name',
    })
    await expect(service.createProject({ projectsRoot, name: 'a b', title: undefined })).rejects.toMatchObject({
      code: 'invalid-name',
    })
  })

  it('模板脚本通过解析契约(假验证器判定干净)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'story5', title: undefined })
    const validator = new FakeValidator()
    const report = await validator.validate(join(project.root, 'game'))
    expect(report).toMatchObject({ ok: true, problems: [] })
  })

  /**
   * 模板不能踩的 Ren'Py 坑(每条都是实测踩过的):
   *  1. `config.title` 不存在 —— 启动时抛 not a known configuration variable;
   *  2. 小写 `true`/`false` 不存在 —— 编译期 NameError。
   *
   * 为什么放在快带:这两条会让**每个新建项目一启动就崩**,而 lint 与 compile 对它们
   * 都返回退出码 0(实测),只有真启动或这种静态断言才抓得到。真启动的端到端断言在
   * 慢带(`sdk.slow.test.ts` 的"模板真能启动"),这里给的是秒级护栏。
   */
  it('模板不踩已知的 Ren\'Py 字面量坑(没有 config.title;布尔是 True/False)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'literalcheck', title: '标题检查' })
    const options = await readFile(join(project.root, 'game', 'options.rpy'), 'utf8')
    // 只看**代码行** —— 模板的注释里正好写明了这两个坑,不能把自己说明当违规。
    const code = options.split('\n').filter((line) => !line.trimStart().startsWith('#'))
    const codeText = code.join('\n')
    expect(codeText).not.toContain('config.title')
    // 小写 true/false 作为独立词出现在 define 里就是坑(Python 没有这两个名字)。
    for (const line of code) {
      if (!line.trimStart().startsWith('define')) continue
      expect(line).not.toMatch(/=\s*(true|false)\s*$/)
    }
    // 标题要真的写进 config.name(窗口标题的真相)。
    expect(codeText).toContain('config.name = _("标题检查")')
  })

  it('注册表是持久化单一真相:新 service 实例(模拟重启)看到同一列表与激活项目', async () => {
    const created = await service.createProject({ projectsRoot, name: 'persist', title: '持久' })
    const other = await service.createProject({ projectsRoot, name: 'other', title: undefined })
    await service.setActive(created.id)

    const reopened = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    const listed = await reopened.listProjects()
    expect(listed.map((p) => p.id).sort()).toEqual([created.id, other.id].sort())
    const active = await reopened.getActiveProject()
    expect(active?.id).toBe(created.id)
    // 无第二处项目状态:同 id 再注册不会双份;list 上的 active 标志由注册表派生。
    expect(listed.length).toBe(2)
    expect(listed.find((p) => p.id === created.id)?.active).toBe(true)
    expect(listed.find((p) => p.id === other.id)?.active).toBe(false)
  })

  it('项目根被挪走(磁盘上消失)→ 注册表条目如实报告 missing,不伪装可写', async () => {
    const project = await service.createProject({ projectsRoot, name: 'moved', title: undefined })
    await rmDir(join(projectsRoot, 'moved'))

    const listed = await service.listProjects()
    expect(listed.find((p) => p.id === project.id)?.missing).toBe(true)
    await expect(service.getProject(project.id)).resolves.toMatchObject({ missing: true })
  })

  async function rmDir(path: string): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
  }

  it('模板自带 .gitignore 保护(logs/cache/saves 不进快照)', async () => {
    const project = await service.createProject({ projectsRoot, name: 'ignore', title: undefined })
    await access(join(project.root, '.gitignore'))
    const gitignore = await readFile(join(project.root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('game/saves/')
    expect(gitignore).toContain('game/cache/')
    expect(gitignore).toContain('.studio/tmp/')
  })
})
