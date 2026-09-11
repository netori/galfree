/**
 * 假验证器(T4):方言子集解析 + 结构检查(悬空跳转/重复 label/缺 start)。
 * 实现 ValidationReport 契约;T5 真 SDK 适配器产出同型结果。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRpy, type RpyFile } from '../rpy/parse.ts'
import type { ValidationProblem, ValidationReport } from './contract.ts'

export class FakeValidator {
  readonly kind = 'fake' as const

  /** @param gameDir 项目 game/ 目录的绝对路径。 */
  async validate(gameDir: string): Promise<ValidationReport> {
    const files: RpyFile[] = []
    for (const entry of await readdir(gameDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.rpy')) {
        files.push({ name: entry.name, text: await readFile(join(gameDir, entry.name), 'utf8') })
      }
    }
    const parsed = parseRpy(files)
    const problems: ValidationProblem[] = [
      ...parsed.problems.map((p) => ({ severity: p.severity, file: `game/${p.file}`, line: p.line, code: p.code, message: p.message })),
      ...parsed.scenes.flatMap((scene) => scene.problems.map((p) => ({ severity: p.severity, file: `game/${p.file}`, line: p.line, code: p.code, message: p.message }))),
    ]
    const errors = problems.filter((problem) => problem.severity === 'error')
    return { ok: errors.length === 0, problems, validator: 'fake', at: new Date().toISOString() }
  }
}
