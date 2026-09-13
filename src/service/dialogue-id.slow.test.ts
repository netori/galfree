/**
 * T26(#34)慢带守卫 —— 对话 id 必须**过得了真引擎**,而且引擎导出的是我们盖的那个。
 *
 * 为什么这条只能住慢带:"我们解析得对 ≠ 引擎认"(方言子集契约的老话)。
 * 两条断言各挡一类错:
 *  1. `lint` 干净 —— 文字子句的语法引擎认(子句顺序、`id` 摆哪儿);
 *  2. `dialogue` 导出的标识符**等于我们盖的** —— 这条才是 ADR-0013 的地基:
 *     引擎在不给 id 时用的是**内容哈希**,所以"导出的是 start_0000 而不是 start_e49b1e45"
 *     正是"我们的 id 真的成了文件名锚"的证据。
 *
 * 复用 2026-09-12 那次一次性探针的形态(launcher 的「Extract Dialogue」命令行形态,
 * **不需要显示**);探针见本票的交接记录。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findLauncher, platformLauncherName } from './hash.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { stampDialogueIds } from './dialogue-id.ts'

const overrideSdk = process.env.GALFREE_SDK_DIR

const SCENE_SOURCE = [
  'label start:',
  '    scene bg school',
  '    e "第一句。"',
  '    "旁白也算一句。"',
  '    e "第三句。" with dissolve',
  '    return',
  '',
].join('\n')

describe('对话 id 与真引擎(T26,慢带)', () => {
  it('盖了 id 的剧本:真 lint 干净,且 dialogue 导出的标识符**就是我们盖的**', async () => {
    const sdkDir = overrideSdk ?? ''
    const launcher = sdkDir === '' ? null : await findLauncher(sdkDir)
    // 没有真 SDK 就跳过(慢带本来就要 GALFREE_SDK_DIR;缺了不是失败,是没跑)。
    if (launcher === null) {
      console.warn(`⚠ 跳过:没找到钉版 SDK(GALFREE_SDK_DIR=${sdkDir || '(未设)'},启动器 ${platformLauncherName()})`)
      return
    }

    const project = await makeTempDir('galfree-t26-')
    const game = join(project, 'game')
    await mkdir(game, { recursive: true })
    await writeFile(join(game, 'options.rpy'), 'define config.name = "t26"\ndefine config.version = "0.1.0"\n', 'utf8')
    const stamped = stampDialogueIds(SCENE_SOURCE, 'start')
    await writeFile(join(game, 'script.rpy'), `define e = Character("Eileen")\n\n${stamped}`, 'utf8')

    const run = promisify(execFile)
    const lint = await run(launcher, [project, 'lint'], { maxBuffer: 16 * 1024 * 1024 })
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
    expect('code' in lint ? lint.code : 0).toBe(0)
    // lint 干净:没有 error 行(它会把问题打在 stdout/stderr 里)。
    expect(`${lint.stdout ?? ''}${lint.stderr ?? ''}`).not.toMatch(/\d+ errors?/i)

    await run(launcher, [project, 'dialogue', 'None'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '', stderr: '' }))
    const tab = await readFile(join(project, 'dialogue.tab'), 'utf8')
    const rows = tab.trim().split('\n').slice(1).map((line) => line.split('\t'))
    // 第一列 = 标识符。**它必须是我们的 id,不是引擎的内容哈希**(那会长成 start_<8位hex>)。
    expect(rows.map((row) => row[0])).toEqual(['start_0000', 'start_0001', 'start_0002'])
    // 附带:引擎把 `id` 子句原样写进了它的 "Ren'Py Script" 列 —— 说明它确实解析了这个子句。
    expect(rows[2]![5]).toContain('id start_0002')

    await rm(project, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 300_000)
})
