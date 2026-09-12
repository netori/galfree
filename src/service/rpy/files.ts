/**
 * `game/` 下的 `.rpy` 读取(唯一出处)。
 *
 * **递归**:Ren'Py 自己会加载 `game/` 下任意深度的 `.rpy`,真 SDK 的 lint 也是递归看的。
 * 所以方言子集解析、分支图、假验证器都必须看到同一批文件 —— 早先它们只读 `game/` 顶层,
 * 于是"生成到 `game/scenes/` 的剧本"对板与假验证器都是隐形的(真 lint 却看得见),
 * 两边判断会分叉。这里收成一处,谁要文件都从这里拿。
 *
 * 文件名用 **`game/` 下的相对 POSIX 路径**(如 `scenes/start.rpy`):定位信息要能指回文件,
 * 而 lint 报告里的 file 也是这个口径。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import type { RpyFile } from './parse.ts'

/** 场景生成的目标目录(`game/` 下):生成的场景一文件一场景。 */
export const SCENES_DIR = 'scenes'

/**
 * **叙述文件的边界**(契约:叙述只住这两个地方)。
 *
 * - `game/script.rpy` —— 手写/模板的入口(人自己的文件,生成器不碰);
 * - `game/scenes/**` —— 生成物的家。
 *
 * 别的 `.rpy` 不按方言子集解析:`screens.rpy` / `gui.rpy` / `options.rpy` 是
 * **Ren'Py 自己的界面与配置**(几百个 `style` / `screen` / `init` 块),它们不是叙述,
 * 也不是 agent 该去改的东西。真实测过:把界面文件算进来会一次产出 **265 条 warning**,
 * 把板上真正有用的判断(缺对白、缺素材、悬空跳转)整个淹掉。
 */
export function isNarrativeFile(name: string): boolean {
  const normalized = name.split(sep).join(posix.sep)
  return normalized === 'script.rpy' || normalized.startsWith(`${SCENES_DIR}/`)
}

export async function readRpyFiles(gameDir: string): Promise<RpyFile[]> {
  const files: RpyFile[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), prefix === '' ? entry.name : `${prefix}/${entry.name}`)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.rpy')) continue
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      // 只收叙述文件:界面/配置/插件模板不参与方言子集解析(见 isNarrativeFile)。
      if (!isNarrativeFile(name)) continue
      files.push({ name, text: await readFile(join(dir, entry.name), 'utf8') })
    }
  }
  await walk(gameDir, '')
  // 顺序稳定:按相对路径排序,保证纯函数可重入。
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

/** 相对路径 → 项目内的 POSIX 路径(板上的定位口径)。 */
export function rpyPathOf(name: string): string {
  return `game/${name.split(sep).join(posix.sep)}`
}
