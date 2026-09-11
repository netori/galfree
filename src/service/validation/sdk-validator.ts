/**
 * 真验证适配器(T5):对空模板执行 `renpy … lint`,把输出映射进 T4 的
 * ValidationReport 契约(结构同型于假验证器)。快测用假 spawn;真 SDK 冒烟在慢带。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ValidationProblem, ValidationReport } from './contract.ts'
import type { ProvisionStatus } from '../sdk-provision.ts'

const exec = promisify(execFile)

/** SDK 启动器调用形态(平台):返回 argv。 */
export function sdkLintArgs(sdkLauncher: string, projectDir: string): { command: string; args: string[] } {
  const isWin = process.platform === 'win32'
  if (isWin) return { command: sdkLauncher, args: [projectDir, 'lint'] }
  // renpy.sh 是 bash 脚本;非 Windows 直接执行需要它可执行位。
  return { command: sdkLauncher, args: [projectDir, 'lint'] }
}

export interface SdkValidatorOptions {
  /** 当前供给状态(含 sdkDir 与覆盖路径解析后的启动器)。 */
  resolveLauncher: () => Promise<string | null>
  /** 注入 spawn(快测假;默认真子进程)。返回 {code, stdout}。 */
  run?: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

export class SdkValidator {
  readonly kind = 'sdk' as const
  #opts: SdkValidatorOptions

  constructor(opts: SdkValidatorOptions) {
    this.#opts = opts
  }

  /** 对激活项目根目录跑 lint;SDK 未就绪 → 报 not-ready(不谎称通过)。 */
  async validate(projectRoot: string, provision: ProvisionStatus): Promise<ValidationReport> {
    const at = new Date().toISOString()
    const launcher = await this.#opts.resolveLauncher()
    if (launcher === null) {
      return {
        ok: false,
        problems: [{ severity: 'error', file: '(sdk)', code: 'sdk-not-ready', message: '钉版 SDK 尚未就绪,无法真校验' }],
        validator: 'sdk',
        at,
      }
    }
    const run = this.#opts.run ?? defaultRun
    let code = 0
    let stdout = ''
    let stderr = ''
    try {
      const result = await run(launcher, [projectRoot, 'lint'])
      code = result.code
      stdout = result.stdout
      stderr = result.stderr
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string; message: string }
      code = e.code ?? 1
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? e.message
    }
    const problems = parseLintOutput(stdout, stderr, code)
    const sdkNote = provision.versionMismatch === undefined
      ? `SDK ${provision.detectedVersion ?? '?'}`
      : `SDK ${provision.versionMismatch.actual}(方言差异:钉版 ${provision.versionMismatch.pinned})— 警告不阻塞`
    const noteProblem: ValidationProblem | undefined = provision.versionMismatch === undefined
      ? undefined
      : { severity: 'warning', file: '(sdk)', code: 'sdk-version-drift', message: sdkNote }
    const all = noteProblem === undefined ? problems : [...problems, noteProblem]
    const errors = all.filter((problem) => problem.severity === 'error')
    return { ok: errors.length === 0, problems: all, validator: 'sdk', at, sdkNote }
  }
}

async function defaultRun(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(command, args, { maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) }
  }
}

/**
 * Ren'Py lint 输出解析:`Errors:` 段与 `Warnings:`/`Messages:` 段。
 * 保守策略:命中 Errors 段行或退出码非 0 → error;其余归 warning/info。
 */
export function parseLintOutput(stdout: string, stderr: string, exitCode: number): ValidationProblem[] {
  const text = `${stdout}\n${stderr}`
  const problems: ValidationProblem[] = []
  let section: 'error' | 'warning' | 'info' = 'info'
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*errors:\s*$/i.test(line)) { section = 'error'; continue }
    if (/^\s*(warnings?|messages?):\s*$/i.test(line)) { section = 'warning'; continue }
    if (line.trim() === '') continue
    if (/(is not reachable|was not referenced|not referenced)/i.test(line)) {
      problems.push({ severity: 'warning', file: 'game', code: 'lint-unreachable', message: line.trim() })
      continue
    }
    const fileLine = /^\s*([^\s:]+\.rpy):(\d+)/.exec(line)
    if (fileLine !== null) {
      problems.push({ severity: section === 'error' ? 'error' : 'warning', file: `game/${fileLine[1]}`, line: Number(fileLine[2]), code: 'lint', message: line.trim() })
      continue
    }
    if (section === 'error') problems.push({ severity: 'error', file: 'game', code: 'lint', message: line.trim() })
  }
  if (exitCode !== 0 && !problems.some((problem) => problem.severity === 'error')) {
    problems.push({ severity: 'error', file: 'game', code: 'lint-exit', message: `renpy lint 退出码 ${exitCode}` })
  }
  return problems
}
