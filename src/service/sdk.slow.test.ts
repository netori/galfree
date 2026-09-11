/**
 * 慢集成带(T5/T7):真钉版 Ren'Py SDK 的下载/解析/lint 冒烟。
 * 单一标记文件(*.slow.test.ts),默认由 vitest.config.ts 排除;
 * 显式 `npm run test:slow` 运行(需网络,发版前必跑)。
 *
 * 为免每次跑都拉 155MB,允许用 GALFREE_SDK_DIR 指向既有 SDK 跳过下载。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SdkProvisioner, sdkIsReady } from './sdk-provision.ts'
import { httpsDownloader, extractZip, platformLauncherName, findLauncher } from './sdk-real.ts'
import { SdkValidator } from './validation/sdk-validator.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { renderTemplateFiles, templateKeepFiles } from './template.ts'

const overrideSdk = process.env.GALFREE_SDK_DIR

describe('真钉版 SDK 慢带(T5)', () => {
  it('SDK 对模板 lint = clean,结果与假适配器结构同型', async () => {
    let sdkDir = overrideSdk ?? ''
    if (overrideSdk === undefined || !existsSync(join(overrideSdk, platformLauncherName()))) {
      const base = await makeTempDir('galfree-slow-sdk-')
      sdkDir = join(base, 'renpy-pinned')
      const provisioner = new SdkProvisioner(sdkDir, { download: httpsDownloader, extract: extractZip, launcherName: platformLauncherName() })
      const status = await provisioner.ensure()
      expect(status.state).toBe('ready')
    }
    expect(await sdkIsReady(sdkDir, platformLauncherName()) || (await findLauncher(sdkDir)) !== null).toBe(true)
    const launcher = await findLauncher(sdkDir)
    expect(launcher).not.toBeNull()

    // 造一个空模板项目。
    const projectRoot = await makeTempDir('galfree-slow-proj-')
    for (const file of [...renderTemplateFiles({ name: 'slowtest', title: 'slowtest', id: 'slowtest' }), ...templateKeepFiles()]) {
      const abs = join(projectRoot, file.path)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }
    // Ren'Py lint 需要 options.rpy 里的 config;模板已含。
    const validator = new SdkValidator({ resolveLauncher: async () => launcher })
    const report = await validator.validate(projectRoot, { sdkDir, state: 'ready', progress: { phase: 'ready', fraction: 1 }, detectedVersion: '8.5.3' })
    expect(report.validator).toBe('sdk')
    expect(typeof report.ok).toBe('boolean')
    // 空模板真 SDK 判定干净(无 error)。
    const errors = report.problems.filter((problem) => problem.severity === 'error')
    expect(errors).toEqual([])

    await rm(projectRoot, { recursive: true, force: true })
    await cleanupTempDirs()
  }, 600_000)
})
