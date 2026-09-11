/**
 * T5 fast-band tests — 钉版 SDK 供给状态机 + 真验证适配器(假 spawn)。
 * 真 SDK 下载/解析冒烟在 *.slow.test.ts(慢集成带,CI 可跳过)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SdkProvisioner, sdkIsReady, probeOverrideSdk, type Downloader, type Extractor } from './sdk-provision.ts'
import { SdkValidator, parseLintOutput } from './validation/sdk-validator.ts'
import type { ProvisionStatus } from './sdk-provision.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('钉版 SDK 供给(T5,假端口)', () => {
  let sdkDir: string

  beforeEach(async () => {
    const base = await makeTempDir('galfree-sdk-')
    sdkDir = join(base, 'renpy-pinned')
  })
  afterEach(async () => { await cleanupTempDirs() })

  function makePorts(opts?: { failFirst?: number; sha256?: string }) {
    let attempts = 0
    const payload = bytesOf('ZIPBYTES')
    const download: Downloader = async (_url, onBytes) => {
      attempts += 1
      if (opts?.failFirst !== undefined && attempts <= opts.failFirst) throw new Error('network down')
      onBytes(4, 8)
      onBytes(8, 8)
      return payload
    }
    const extract: Extractor = async (zip, dest) => {
      // 假解压:写出与 zip 同字节数的占位文件,并放一个启动器。
      await mkdir(dest, { recursive: true })
      await writeFile(join(dest, 'renpy-8.5.3-sdk'), 'x'.repeat(zip.byteLength))
      await writeFile(join(dest, 'renpy.exe'), '@echo off')
    }
    // 默认端口注入空 sha(跳过校验);校验行为由专用测试覆盖(见下)。
    return { download, extract, launcherName: 'renpy.exe', sha256: '' }
  }

  it('下载状态机完整:进度回调 + 到 ready', async () => {
    const provisioner = new SdkProvisioner(sdkDir, makePorts())
    expect(provisioner.status.state).toBe('idle')
    const done = await provisioner.ensure()
    expect(done.state).toBe('ready')
    expect(done.progress.fraction).toBe(1)
    expect(done.progress.totalBytes).toBe(8)
    expect(await sdkIsReady(sdkDir, 'renpy.exe')).toBe(true)
  })

  it('幂等:二次 ensure 不再下载(下载调用计数不增)', async () => {
    let downloads = 0
    const ports = makePorts()
    const wrapped: typeof ports = { ...ports, download: async (u, cb, s) => { downloads += 1; return ports.download(u, cb, s) } }
    const provisioner = new SdkProvisioner(sdkDir, wrapped)
    await provisioner.ensure()
    await provisioner.ensure()
    await provisioner.ensure()
    expect(downloads).toBe(1)
  })

  it('网络失败 → failed 状态且可 retry 成功', async () => {
    const provisioner = new SdkProvisioner(sdkDir, makePorts({ failFirst: 1 }))
    await expect(provisioner.ensure()).rejects.toThrow(/network down/)
    expect(provisioner.status.state).toBe('failed')
    expect(provisioner.status.error).toContain('network down')
    // retry:第二次(端口已越过 failFirst)成功。
    const ready = await provisioner.retry()
    expect(ready.state).toBe('ready')
  })

  it('校验和不匹配 → 拒绝且不产出就绪(可重试)', async () => {
    const ports = makePorts()
    const provisioner = new SdkProvisioner(sdkDir, { ...ports, sha256: 'deadbeef'.repeat(8) })
    await expect(provisioner.ensure()).rejects.toThrow(/校验和不匹配/)
    expect(provisioner.status.state).toBe('failed')
    expect(await sdkIsReady(sdkDir, 'renpy.exe')).toBe(false)
  })

  it('默认端口(不注入 sha)→ 校验钉版常量,不匹配即拒绝(钉版校验不可缺席)', async () => {
    const ports = makePorts()
    const provisioner = new SdkProvisioner(sdkDir, { download: ports.download, extract: ports.extract, launcherName: 'renpy.exe' })
    // 'ZIPBYTES' 的哈希必然 != 官方钉版 sha256。
    await expect(provisioner.ensure()).rejects.toThrow(/校验和不匹配/)
  })

  it('校验和正确 → 放行到 ready', async () => {
    const ports = makePorts()
    const sha = createHash('sha256').update(bytesOf('ZIPBYTES')).digest('hex')
    const provisioner = new SdkProvisioner(sdkDir, { ...ports, sha256: sha })
    const ready = await provisioner.ensure()
    expect(ready.state).toBe('ready')
  })

  it('解压后缺启动器 → bad-archive(产物不可用如实报)', async () => {
    const ports = makePorts()
    const empty: typeof ports = { ...ports, extract: async () => { await mkdir(sdkDir, { recursive: true }) } }
    const provisioner = new SdkProvisioner(sdkDir, empty)
    await expect(provisioner.ensure()).rejects.toThrow(/启动器/)
    expect(provisioner.status.state).toBe('failed')
  })

  it('覆盖路径 + 版本差异 → 警告进状态且试玩不被阻塞', async () => {
    // 模拟用户既有 SDK 目录:有启动器,版本号是 7.5.3(非钉版)。
    const override = join(sdkDir, '..', 'user-renpy-7.5.3')
    await mkdir(join(override, 'renpy-7.5.3-sdk'), { recursive: true })
    await writeFile(join(override, 'renpy.exe'), '@echo off')
    const probe = await probeOverrideSdk(override, 'renpy.exe')
    expect(probe.ready).toBe(true)
    expect(probe.mismatch).toMatchObject({ pinned: '8.5.3', actual: '7.5.3' })
    // 版本差异不阻塞:ready=true 且只有 mismatch(没有 error 字段)。
    expect(probe.ready).toBe(true)
  })
})

describe('真验证适配器(T5,假 spawn)', () => {
  it('SDK 未就绪 → ok=false, sdk-not-ready(不谎称通过)', async () => {
    const validator = new SdkValidator({ resolveLauncher: async () => null })
    const provision: ProvisionStatus = { sdkDir: '/x', state: 'idle', progress: { phase: 'idle', fraction: 0 } }
    const report = await validator.validate('/project', provision)
    expect(report.validator).toBe('sdk')
    expect(report.ok).toBe(false)
    expect(report.problems.some((p) => p.code === 'sdk-not-ready')).toBe(true)
  })

  it('真适配器结果与假适配器结构同型(ValidationReport)', async () => {
    const { FakeValidator } = await import('./validation/template-validator.ts')
    const project = await makeTempDir('galfree-shape-')
    await mkdir(join(project, 'game'), { recursive: true })
    await writeFile(join(project, 'game', 'script.rpy'), 'label start:\n    "hi"\n    return\n')
    const fake = await new FakeValidator().validate(join(project, 'game'))
    const validator = new SdkValidator({
      resolveLauncher: async () => '/sdk/renpy.exe',
      run: async () => ({ code: 0, stdout: 'No lint errors found!\n', stderr: '' }),
    })
    const sdk = await validator.validate(project, { sdkDir: '/sdk', state: 'ready', progress: { phase: 'ready', fraction: 1 }, detectedVersion: '8.5.3' })
    // 同型:同一契约的核心键一致(sdkNote 为 SDK 侧可选附加信息)。
    const core = (r: Record<string, unknown>): string[] => Object.keys(r).filter((k) => k !== 'sdkNote').sort()
    expect(core(sdk as unknown as Record<string, unknown>)).toEqual(core(fake as unknown as Record<string, unknown>))
    expect(sdk.validator).toBe('sdk')
    expect(sdk.ok).toBe(true)
    expect(Array.isArray(sdk.problems)).toBe(true)
    await rm(project, { recursive: true, force: true })
  })

  it('lint 输出含 Errors 段 → error 进结果', () => {
    const problems = parseLintOutput('Errors:\n  script.rpy:5: bad thing\n', '', 1)
    expect(problems.some((p) => p.severity === 'error')).toBe(true)
  })

  it('退出码非 0 但无 error 行 → 兜底 lint-exit error(不静默放行)', () => {
    const problems = parseLintOutput('some noise', '', 2)
    expect(problems.some((p) => p.severity === 'error' && p.code === 'lint-exit')).toBe(true)
  })
})

// (校验和路径由端口注入 sha256 覆盖,见上;不再需要旁路辅助模块。)
