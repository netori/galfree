/**
 * 生产合成验证器(T5 接线):假验证器恒跑(子集 lint 是硬前置);
 * 钉版/覆盖 SDK 就绪时叠加真 `renpy lint`,报告升级为 validator:'sdk'
 * 同型形状。SDK 未就绪**不谎称真校验**,只在 sdkNote 里如实标注。
 * 覆盖目录版本 ≠ 钉版 → 方言差异警告进结果(不阻塞;ADR-0006)。
 */
import { basename, dirname, join } from 'node:path'
import { FakeValidator } from './template-validator.ts'
import { SdkValidator } from './sdk-validator.ts'
import { PINNED_SDK, probeOverrideSdk } from '../sdk-provision.ts'
import { findLauncher, platformLauncherName } from '../hash.ts'
import type { ProjectInfo, ValidatorPort } from '../project-service.ts'
import type { ValidationProblem, ValidationReport } from './contract.ts'

export interface CompositeValidatorOptions {
  /** 钉版 SDK 目录(未就绪时探测;不触发下载 —— 下载走 /sdk/ensure)。 */
  pinnedSdkDir: string
  /** 用户覆盖 SDK 路径(空 = 无)。 */
  overrideSdkPath: () => string
}

export function createCompositeValidator(options: CompositeValidatorOptions): ValidatorPort {
  const fake = new FakeValidator()
  return async (project: ProjectInfo): Promise<ValidationReport> => {
    const base = await fake.validate(join(project.root, 'game'))
    const override = options.overrideSdkPath()
    const sdkDir = override !== '' ? override : options.pinnedSdkDir
    const launcher = await findLauncher(sdkDir)
    if (launcher === null) {
      // 真 SDK 未就绪:交假验证器结果,但如实注明。
      return { ...base, sdkNote: `SDK 未就绪(用假验证器;钉版 ${PINNED_SDK.version})` }
    }
    let versionMismatch: { pinned: string; actual: string } | undefined
    let detectedVersion: string | undefined
    if (override !== '') {
      // 探测启动器**实际所在层**(覆盖目录可能再嵌套 renpy-X 顶层目录)。
      const probe = await probeOverrideSdk(dirname(launcher), platformLauncherName())
      versionMismatch = probe.mismatch
      detectedVersion = probe.version
    }
    const sdkValidator = new SdkValidator({ resolveLauncher: async () => launcher })
    const sdkReport = await sdkValidator.validate(project.root, {
      sdkDir,
      state: 'ready',
      progress: { phase: 'ready', fraction: 1 },
      detectedVersion,
      ...(versionMismatch === undefined ? {} : { versionMismatch }),
    })
    // 合并:假(子集结构) + 真(引擎 lint);去重同 code+file+line。
    const merged: ValidationProblem[] = [...base.problems]
    for (const problem of sdkReport.problems) {
      if (!merged.some((existing) => existing.code === problem.code && existing.file === problem.file && existing.line === problem.line)) {
        merged.push(problem)
      }
    }
    const errors = merged.filter((problem) => problem.severity === 'error')
    return {
      ok: errors.length === 0,
      problems: merged,
      validator: 'sdk',
      at: sdkReport.at,
      sdkNote: sdkReport.sdkNote ?? `SDK ${basename(sdkDir)}`,
    }
  }
}
