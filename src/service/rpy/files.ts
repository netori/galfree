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
      files.push({
        name: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        text: await readFile(join(dir, entry.name), 'utf8'),
      })
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
