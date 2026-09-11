/**
 * 假验证器(T1 最小形态):对 game/*.rpy 做结构健全检查,实现 ValidationReport 契约。
 * T4 的方言子集解析器落地后,本文件的检查并入真契约的假适配器;此处先保证
 * "模板可被接缝判定干净"这一端到端行为成立。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ValidationProblem, ValidationReport } from './contract.ts'

const LABEL_RE = /^label ([A-Za-z0-9_]+):\s*$/
const JUMP_RE = /^\s+jump ([A-Za-z0-9_]+)\s*$/

export class TemplateValidator {
  readonly kind = 'fake' as const

  /** @param gameDir 项目 game/ 目录的绝对路径。 */
  async validate(gameDir: string): Promise<ValidationReport> {
    const problems: ValidationProblem[] = []
    const labels = new Map<string, string>() // label → 相对文件名
    const jumps: Array<{ target: string; file: string; line: number }> = []

    const entries = await readdir(gameDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.rpy')) continue
      const file = join(gameDir, entry.name)
      const text = await readFile(file, 'utf8')
      text.split('\n').forEach((raw, index) => {
        const line = index + 1
        const label = LABEL_RE.exec(raw)?.[1]
        if (label !== undefined) {
          if (labels.has(label)) {
            problems.push({ severity: 'error', file: entry.name, line, code: 'duplicate-label', message: `label ${label} 重复定义` })
          }
          labels.set(label, entry.name)
          return
        }
        const jump = JUMP_RE.exec(raw)?.[1]
        if (jump !== undefined) jumps.push({ target: jump, file: entry.name, line })
      })
    }

    if (!labels.has('start')) {
      problems.push({ severity: 'error', file: 'game', code: 'no-start-label', message: '缺少 label start:(主菜单入口)' })
    }
    for (const jump of jumps) {
      if (!labels.has(jump.target)) {
        problems.push({ severity: 'error', file: jump.file, line: jump.line, code: 'dangling-jump', message: `jump 指向不存在的 label:${jump.target}` })
      }
    }

    const errors = problems.filter((problem) => problem.severity === 'error')
    return { ok: errors.length === 0, problems, validator: 'fake', at: new Date().toISOString() }
  }
}
