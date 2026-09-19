/**
 * T5 生产接线测试:合成验证器端口(假恒跑;SDK 就绪升级;缺失如实标注;
 * 覆盖路径版本差异 → 警告进结果不静默)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCompositeValidator } from './composite-validator.ts'
import { createProjectService, type ProjectInfo, type ProjectService } from '../project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../../testing/sdk-fixture.ts'
import { platformLauncherName } from '../hash.ts'

describe('合成验证器(T5 接线)', () => {
  let base: string
  let sdkDir: string
  let service: ProjectService
  let project: ProjectInfo

  beforeEach(async () => {
    base = await makeTempDir('galfree-composite-')
    sdkDir = await makeFakeSdk()
    const validator = createCompositeValidator({
      pinnedSdkDir: join(base, 'no-sdk-here'),
      overrideSdkPath: () => '',
    })
    service = createProjectService({ dataDir: join(base, 'data'), validator, uiTemplate: fakeUiTemplate(sdkDir) })
    project = await service.createProject({ projectsRoot: join(base, 'projects'), name: 'comp', title: undefined })
  })
  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  it('SDK 未就绪 → 假验证器结果 + sdkNote 如实标注(不谎称真校验)', async () => {
    const report = await service.validateActiveProject()
    expect(report.validator).toBe('fake')
    expect(report.ok).toBe(true)
    expect(report.sdkNote).toContain('未就绪')
  })

  it('覆盖目录版本 ≠ 钉版 → 方言差异警告进结果且 ok 不被阻塞为假阳性', async () => {
    // 造一个假"覆盖 SDK"目录:启动器存在但版本是 9.9.9。
    // ⚠️ 启动器文件名**必须**走 `platformLauncherName()`:合成验证器是用它去探的
    // (`composite-validator.ts` 里 `probeOverrideSdk(dirname(launcher), platformLauncherName())`)。
    // 早先这里硬写 `renpy.exe`,于是这条用例在 Linux 上必红 —— CI 的 ubuntu 那条腿第一次跑就抓到
    // (`expected 'fake' to be 'sdk'`:探不到启动器 ⇒ 不升级 ⇒ 还留在假验证器)。
    const override = join(base, 'user-sdk')
    const launcher = platformLauncherName()
    await mkdir(join(override, 'renpy-9.9.9-sdk'), { recursive: true })
    await writeFile(join(override, 'renpy-9.9.9-sdk', launcher), '@echo off')
    const service2 = createProjectService({
      dataDir: join(base, 'data'),
      uiTemplate: fakeUiTemplate(sdkDir),
      validator: createCompositeValidator({ pinnedSdkDir: override, overrideSdkPath: () => override }),
    })
    try {
      const report = await service2.validateActiveProject()
      // 真 spawn 会失败(假 exe),但差异警告必须在结果里;validator 已升级为 sdk。
      expect(report.validator).toBe('sdk')
      expect(report.problems.some((p) => p.code === 'sdk-version-drift' && p.message.includes('9.9.9'))).toBe(true)
    } finally {
      await service2.dispose()
    }
  })
})
