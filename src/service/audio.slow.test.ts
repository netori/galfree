/**
 * 慢带:**音频接线的语法与效果,在真钉版 SDK 面前对一次**(T17)。
 *
 * 为什么单列一条:方言子集契约写着"扩语法需先改文档 + 解析器 + 模板,并过**慢集成带**
 * (真 SDK lint)验证"。音频语句(`play music|sound|voice "文件" [loop]` / `stop …`)
 * 是 T4 进子集的,但直到 T17 才有真正的接线动作 —— 这一票把"写出来的那一行**真引擎认不认**"
 * 补上,顺带把两件容易自欺的事钉住:
 *
 *  1. 真 SDK lint 对一段接了 BGM/SE 的剧本判**干净**(我们自己解析得对 ≠ 引擎认);
 *  2. 池与真磁盘一致:文件放进去 → 引用不悬空(板上的 `missing-audio` 由**同一份池**推出)。
 *
 * 它不试听、不生成音频(票面明确不做音乐生成与 TTS):试听由试玩承担,主观认可由人盖审读戳。
 */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SdkValidator } from './validation/sdk-validator.ts'
import { createCompositeValidator } from './validation/composite-validator.ts'
import { createProjectService } from './project-service.ts'
import { findLauncher } from './hash.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

/** 钉版 SDK(与别的慢带同一口径;GALFREE_SDK_DIR 可跳过 155MB 下载)。 */
async function sdkDirFor(): Promise<string> {
  const dir = process.env.GALFREE_SDK_DIR !== undefined && process.env.GALFREE_SDK_DIR !== ''
    ? process.env.GALFREE_SDK_DIR
    : join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-galfree', 'sdk')
  if ((await findLauncher(dir)) === null) throw new Error(`慢带需要真 SDK,但在 ${dir} 找不到启动器(设 GALFREE_SDK_DIR 或先完成 SDK 供给)`)
  return dir
}

describe('音频接线(慢带,真 SDK)', () => {
  it('接了 BGM/SE 的剧本:真 SDK lint 判干净,池与真磁盘一致', async () => {
    const sdkDir = await sdkDirFor()
    const base = await makeTempDir('galfree-slow-audio-')
    const projectsRoot = join(base, 'projects')
    await mkdir(projectsRoot, { recursive: true })

    const service = createProjectService({
      dataDir: join(base, 'data'),
      // 生产装配口径:假 lint 恒跑,SDK 就绪时叠加**真** lint(validator 升级为 sdk)。
      validator: createCompositeValidator({ pinnedSdkDir: sdkDir, overrideSdkPath: () => '' }),
    })
    try {
      const project = await service.createProject({ projectsRoot, name: 'audioslow', title: '音频慢带', sdkDir })
      const root = project.root

      // 丢两个音频文件进项目(假字节:lint 不解析音频内容,它只看语法)。
      await service.writeProjectFiles('audioslow', [
        { path: 'game/audio/rain.ogg', content: Buffer.from('OggS-fake-rain'), expectVersion: 'absent' },
        { path: 'game/audio/click.ogg', content: Buffer.from('OggS-fake-click'), expectVersion: 'absent' },
      ], { origin: 'workbench', reason: 'asset' })

      // 在**生成目录**的场景里接线(表单编辑只对它开放)。
      await service.writeProjectFiles('audioslow', [{
        path: 'game/scenes/scene_one.rpy',
        content: [
          'label scene_one:',
          '    play music "audio/rain.ogg" loop',
          '    "（雨声）"',
          '    play sound "audio/click.ogg"',
          '    stop music',
          '    return',
          '',
        ].join('\n'),
        expectVersion: 'absent',
      }], { origin: 'agent', reason: 'scenario' })
      const snap = await service.readProjectFile('audioslow', 'game/script.rpy')
      await service.writeProjectFiles('audioslow', [{
        path: 'game/script.rpy',
        content: snap.content.replace(/^label start:\n/m, 'label start:\n    jump scene_one\n'),
        expectVersion: snap.version,
      }], { origin: 'agent', reason: 'scenario' })

      // 1) 真 SDK lint:语法与结构都干净(我们自己解析得对 ≠ 引擎认)。
      const report = await service.validateActiveProject()
      expect(report.validator).toBe('sdk')
      expect(report.problems.filter((problem) => problem.severity === 'error')).toEqual([])

      // 2) 池与真磁盘一致:两张都在池里、都被引用 → 没有悬空引用、也没有 unused。
      const pool = await service.audioPool('audioslow')
      expect(pool.files.map((file) => file.path)).toEqual(['audio/click.ogg', 'audio/rain.ogg'])
      expect(pool.references.map((reference) => reference.ref)).toEqual(['audio/rain.ogg', 'audio/click.ogg'])
      expect(pool.missing).toEqual([])
      expect(pool.unused).toEqual([])
      const progress = await service.progress('audioslow')
      expect(progress.problems.some((problem) => problem.code === 'missing-audio')).toBe(false)
      expect(progress.lint.ok).toBe(true)

      // 3) 悬空引用仍然是 error(池是唯一判据) —— 删掉文件,板上立刻报。
      const current = await service.readProjectFile('audioslow', 'game/audio/click.ogg')
      await service.writeProjectFiles('audioslow', [{ path: 'game/audio/click.ogg', content: null, expectVersion: current.version }], { origin: 'workbench', reason: 'asset' })
      const after = await service.progress('audioslow')
      expect(after.problems.some((problem) => problem.code === 'missing-audio')).toBe(true)

      // 真 SDK 也认这条剧本(落盘的是标准 Ren'Py 项目,不是我们的内部格式)。
      const onDisk = await readFile(join(root, 'game', 'scenes', 'scene_one.rpy'), 'utf8')
      expect(onDisk).toContain('play music "audio/rain.ogg" loop')
    } finally {
      await service.dispose()
      await cleanupTempDirs()
    }
  })
})
