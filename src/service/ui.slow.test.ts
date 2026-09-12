/**
 * 慢带:**项目的界面层齐备,且真能启动**(真钉版 SDK)。
 *
 * 为什么单列这一条:2026-09-12 那天连续栽在同一类问题上 —— **"文件写对了"不等于"能跑"**。
 * 三个坑都是真启动才暴露的:
 *
 *  1. 模板缺 `screens.rpy` → **点窗口关闭按钮直接 `AttributeError` 崩**(试玩永远失败);
 *  2. SDK 默认字体不含中文字形 → **中文全是方块**(写绝对路径字体还会被静默回退);
 *  3. `gui.language` 写成 `"chinese"` → 渲染时抛 `Unknown language`,**把对话屏打崩**。
 *
 * 这条守卫能可靠断言的部分(不假装更多):
 *  - 界面文件与中文字体**真的进了项目**,且字体补丁指**项目内相对路径**;
 *  - 真 SDK 的 lint 判定干净(validator 升级为 `sdk`);
 *  - 真启动:进程活着、**没有 traceback**(坑 1/2/3 任何一个复发都会在这里红)。
 *
 * 它**不**断言"玩通到某一幕" —— 那需要在无头环境里点主菜单的"开始",不可靠;
 * "从某场试玩真的落在那一场"由 `sdk.slow.test.ts` 自己的用例覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createProjectService } from './project-service.ts'
import { createCompositeValidator } from './validation/composite-validator.ts'
import { findLauncher } from './hash.ts'
import { TEMPLATE_UI_PATCH } from './template.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

/** 拿钉版 SDK 目录(与别的慢带用例同一口径)。 */
async function sdkDirFor(): Promise<string> {
  const fromEnv = process.env.GALFREE_SDK_DIR
  const dir = fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-galfree', 'sdk')
  const launcher = await findLauncher(dir)
  if (launcher === null) throw new Error(`慢带需要真 SDK,但在 ${dir} 找不到启动器(设 GALFREE_SDK_DIR 或先完成 SDK 供给)`)
  return dir
}

describe('项目的界面层(慢带,真 SDK)', () => {
  afterEach(async () => { await cleanupTempDirs() })

  it('建项目 → 界面文件与中文字体齐备 → 真 SDK lint 干净 → 真启动无 traceback', async () => {
    const sdkDir = await sdkDirFor()
    const launcher = (await findLauncher(sdkDir))!
    const base = await makeTempDir('galfree-slow-ui-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const service = createProjectService({
      dataDir: join(base, 'data'),
      // 生产装配口径:合成验证器 —— 假 lint 恒跑,SDK 就绪时叠加**真** lint 并升级 validator。
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
    })
    let root = ''
    try {
      const project = await service.createProject({ projectsRoot, name: 'uiflow', title: '界面链路', sdkDir })
      root = project.root

      // 1) 界面文件与中文字体真的进了项目(少一个 screens.rpy,关窗就崩)。
      for (const name of ['screens.rpy', 'gui.rpy', 'guisupport.rpy', 'testcases.rpy']) {
        expect(existsSync(join(root, 'game', name)), `缺 ${name}`).toBe(true)
      }
      expect(existsSync(join(root, 'game', 'fonts', 'SourceHanSansLite.ttf')), '缺中文字体').toBe(true)

      // 2) 字体补丁必须指**项目内相对路径**:绝对路径会被 Ren'Py 静默回退 → 中文方块。
      const patch = await readFile(join(root, 'game', TEMPLATE_UI_PATCH), 'utf8')
      expect(patch).toContain('gui.text_font = "fonts/SourceHanSansLite.ttf"')
      expect(patch, '字体不能用绝对路径(会被静默回退)').not.toMatch(/gui\.text_font = "[A-Za-z]:/)
      // 断行的合法值(写 "chinese" 会在渲染时抛 Unknown language 把对话屏打崩)。
      expect(patch).toContain('gui.language = "eastasian"')
      // 只查**赋值语句**:注释里那句"没有 chinese"是给人看的警告,不算。
      expect(patch, 'gui.language 不能赋成 chinese(会抛 Unknown language)')
        .not.toMatch(/^\s*define\s+gui\.language\s*=\s*"chinese"/m)

      // 3) 一场引用图片与角色台词的戏:把"图片名 → 文件"按素材槽的约定路径接起来。
      const snap = await service.readProjectFile('uiflow', 'game/script.rpy')
      await service.writeProjectFiles('uiflow', [
        {
          path: 'game/images/bg-rooftop.png',
          content: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
            'base64',
          ),
          expectVersion: 'absent',
        },
        {
          path: 'game/script.rpy',
          content: [
            '# 角色定义(缺了 say 就 NameError)。',
            'define hero = Character("小棠")',
            '',
            "# 图片定义(缺了 scene 就显示灰底占位 —— Ren'Py 已不自动定义图片名)。",
            'image bg rooftop = "images/bg-rooftop.png"',
            '',
            'label start:',
            '    scene bg rooftop',
            '    hero "雨还在下。"',
            '    return',
            '',
          ].join('\n'),
          expectVersion: snap.version,
        },
      ], { reason: 'scenario', origin: 'agent' })

      // 4) 真 SDK 的 lint:validator 升级为 sdk,且没有 error。
      const validation = await service.validateActiveProject()
      expect(validation.validator).toBe('sdk')
      expect(validation.problems.filter((problem) => problem.severity === 'error')).toEqual([])

      // 5) 真启动:不带 windowsHide(否则窗口被藏),25 秒内活着 = 引擎把项目加载起来了。
      //    坑 1/2/3 任何一个复发,都会在启动或首帧渲染时崩出 traceback。
      const child = spawn(launcher, [root], {
        cwd: root,
        env: { ...process.env, RENPY_DISABLE_SOUND: '1', RENPY_LESS_UPDATES: '1' },
        stdio: 'ignore',
      })
      const alive = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 25_000)
        child.once('exit', () => { clearTimeout(timer); resolve(false) })
      })
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const tracebackPath = join(root, 'traceback.txt')
      if (existsSync(tracebackPath)) {
        const traceback = await readFile(tracebackPath, 'utf8')
        expect.fail(`真启动崩了(界面层/叙述链路的坑复发):\n${traceback.split('\n').slice(0, 14).join('\n')}`)
      }
      expect(alive, '引擎没能把项目启动起来(进程提前退出)').toBe(true)
    } finally {
      await service.dispose()
    }
  }, 300_000)

  /**
   * **分支选项是方块字**(2026-09-12 用户实测)。
   *
   * 根因:`SDK` 的 `gui.rpy` 里有两条**拷贝赋值** ——
   *   `define gui.button_text_font = gui.interface_text_font`(162 行)
   *   `define gui.choice_button_text_font = gui.text_font`(212 行)
   * 值在那一行就被抄走了。我们的补丁(在 `gui.rpy` 之后)把 `gui.text_font` 指到中文字体,
   * 但**这两条不会跟着变** → 选项与按钮仍读 DejaVuSans(不含中文字形)→ 方块。
   * 对白正常、只有选项是方块,正是这个形状。
   *
   * 这条守卫问两处:
   *  1. **变量**(init 探针 + 真 lint):`gui.*_font` 是否都指到项目里的中文字体 —— 这是修复点;
   *  2. **样式**(运行时探针 + 真启动):`style.choice_button_text.font` 等**渲染真正用的**值 ——
   *     因为样式属性在 init 之后才应用完(init 999 读到的还是引擎默认值,这点也是实测的),
   *     只在 init 里读样式会得出错误结论。
   */
  it('引擎最终用的字体是项目里那份中文字体(对话 / 角色名 / 界面 / **选项** / 按钮)', async () => {
    const sdkDir = await sdkDirFor()
    const launcher = (await findLauncher(sdkDir))!
    const base = await makeTempDir('galfree-slow-font-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const service = createProjectService({
      dataDir: join(base, 'data'),
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
    })
    let child: ReturnType<typeof spawn> | null = null
    try {
      const project = await service.createProject({ projectsRoot, name: 'fontflow', title: '字体链路', sdkDir })
      const styles = [
        'style.default.font', 'style.say_dialogue.font', 'style.name_text.font',
        'style.button_text.font', 'style.choice_button_text.font', 'style.interface_text.font',
      ]
      const vars = [
        'gui.text_font', 'gui.name_text_font', 'gui.interface_text_font',
        'gui.button_text_font', 'gui.choice_button_text_font',
      ]

      // 探针:init 999 记变量(修复点在变量上);periodic 回调记样式(渲染真正用的值)。
      await writeFile(join(project.root, 'game', 'zz_galfree_font_probe.rpy'), [
        'init 999 python:',
        '    import json',
        '    with open(config.basedir + "/galfree-font-vars.json", "w") as handle:',
        `        json.dump({${vars.map((key) => `"${key}": ${key.replace('gui.', 'gui.')}`).join(', ')}}, handle, ensure_ascii=False, indent=2)`,
        '',
        'init python:',
        '    _gf_style_probe_done = False',
        '',
        '    def _gf_style_probe():',
        '        global _gf_style_probe_done',
        '        if _gf_style_probe_done:',
        '            return',
        '        _gf_style_probe_done = True',
        '        import json',
        `        probe = {${styles.map((key) => `"${key}": ${key}`).join(', ')}}`,
        '        with open(config.basedir + "/galfree-font-styles.json", "w") as handle:',
        '            json.dump(probe, handle, ensure_ascii=False, indent=2)',
        '',
        '    config.periodic_callbacks.append(_gf_style_probe)',
        '',
      ].join('\n'), 'utf8')

      // ① 真 lint(会跑完 init)→ 变量那一份。
      const validation = await service.validateActiveProject()
      expect(validation.validator).toBe('sdk')
      expect(validation.problems.filter((problem) => problem.severity === 'error')).toEqual([])
      const varProbe = JSON.parse(await readFile(join(project.root, 'galfree-font-vars.json'), 'utf8')) as Record<string, string>
      const wrongVars = vars.filter((key) => !(varProbe[key] ?? '').includes('SourceHanSansLite.ttf'))
      expect(
        wrongVars.map((key) => `${key} = ${String(varProbe[key])}`),
        '这些**变量**没指到项目里的中文字体(选项/按钮读的就是它们)',
      ).toEqual([])

      // ② 真启动(与上面那条同一个路数:进程活着就够,不必玩到某处)→ 样式那一份。
      child = spawn(launcher, [project.root], {
        cwd: project.root,
        env: { ...process.env, RENPY_DISABLE_SOUND: '1', RENPY_LESS_UPDATES: '1' },
        stdio: 'ignore',
      })
      const styleProbePath = join(project.root, 'galfree-font-styles.json')
      const deadline = Date.now() + 40_000
      while (Date.now() < deadline && !existsSync(styleProbePath)) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(existsSync(styleProbePath), '真启动后运行时探针没写出来(游戏没跑到主菜单?)').toBe(true)

      const styleProbe = JSON.parse(await readFile(styleProbePath, 'utf8')) as Record<string, string>
      const wrongStyles = styles.filter((key) => !(styleProbe[key] ?? '').includes('SourceHanSansLite.ttf'))
      expect(
        wrongStyles.map((key) => `${key} = ${String(styleProbe[key])}`),
        '这些**样式**(渲染真正用的值)没指到项目里的中文字体 —— 中文会显示成方块字',
      ).toEqual([])

      // 启动期没崩(与第一条用例同一口径)。
      expect(existsSync(join(project.root, 'traceback.txt')), '真启动崩了').toBe(false)
    } finally {
      child?.kill()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await service.dispose()
    }
  }, 300_000)
})
