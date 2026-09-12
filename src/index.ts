/**
 * dsh-galfree — Host 半(插件入口)。
 *
 * 把项目服务(seam)挂到 DSH:`/api/galfree` 路由族 + 设置命名空间。
 * 工作台 Client(./client)与 agent 工具是两个薄适配器,消费同一接缝状态。
 * 独占逻辑全部住在 src/service/ 之下,这里只做装配(ADR-0002)。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProjectService } from './service/project-service.ts'
import { makeRoutes } from './routes.ts'
import { GalfreeError } from './service/error.ts'
import { SdkProvisioner, probeOverrideSdk } from './service/sdk-provision.ts'
import { extractZip, httpsDownloader } from './service/sdk-real.ts'
import { findLauncher, platformLauncherName } from './service/hash.ts'
import { realSpawn } from './service/playtest.ts'
import { createCompositeValidator } from './service/validation/composite-validator.ts'
import { registerGalfreeTools } from './service/tools.ts'

/** 稳定的 cordis 插件名(与 cordis.patch.yml 的 insert id 对齐)。 */
export const name = 'galfree'

/** 挂载工作台路由与设置所需的服务。 */
export const inject = ['webServer', 'settings']

/**
 * agent 工具席位(可选):`dsh-tools` 在基础组合里总在,但工具是**可选席位** ——
 * 没有它的宿主照样该能跑面板,所以用 cordis 的懒注入按需注册,而不是把它塞进 `inject`
 * 让插件整体依赖它。与目录选择接缝同一种态度:缺能力就少一个入口,不是插件起不来。
 */
const TOOL_INJECT = { tools: false } as const

/**
 * 目录选择接缝(`ctx.directoryPicker`,由 dsh-web-app 的 adapter 装配 backend)。
 *
 * 它刻意**不进 `inject`**:接缝是能力式的(原生 OS 选择器 `native` / 应用内
 * 浏览器 `browse`),缺 backend 时正确行为是"隐藏选择入口"而不是插件加载失败,
 * 所以这里按名取用、容忍缺席。结构按宿主文档的能力约定声明,不引入对宿主包的依赖。
 */
interface DirectoryPickerSeam {
  capability: () => {
    kind: string
    /** `native`:打开宿主屏幕上的 OS 选择器,取消返回 null。 */
    pick?: (signal?: AbortSignal) => Promise<string | null>
    /** `browse`:列举一层目录。 */
    list?: (path?: string, signal?: AbortSignal) => Promise<unknown>
    /** `browse`:在指定父目录下建一个子目录(单段名)。 */
    createDirectory?: (path: string, name: string) => Promise<unknown>
  }
}

function directoryPickerSeam(ctx: Context): DirectoryPickerSeam | undefined {
  return (ctx as unknown as { directoryPicker?: DirectoryPickerSeam }).directoryPicker
}

export interface Config {
  /** 主开关(路由;关闭后仅 /state 可读)。 */
  enabled?: boolean
  /** 新建项目的默认父目录(空 = 每次显式传入)。 */
  defaultProjectsRoot?: string
  /** 既有 Ren'Py SDK 路径覆盖(空 = 用钉版自动供给)。 */
  sdkPath?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  defaultProjectsRoot: z.string().default(''),
  sdkPath: z.string().default(''),
})

/** 设置命名空间(与 SDK 路径/渠道覆盖同一真相;spec User Story 25)。 */
export const CONFIG_NAMESPACE = 'dsh-galfree'

export const GalfreeSettingsSchema: z<Required<Config>> = z.object({
  enabled: z.boolean().default(true),
  defaultProjectsRoot: z.string().default(''),
  sdkPath: z.string().default(''),
})

/** 宿主侧插件数据目录(注册表、钉版 SDK 等)。 */
export function galfreeDataDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-galfree')
}

export function apply(ctx: Context, config?: Config): void {
  const base: Partial<Required<Config>> = {
    enabled: config?.enabled ?? true,
    defaultProjectsRoot: config?.defaultProjectsRoot ?? '',
    sdkPath: config?.sdkPath ?? '',
  }
  const settingsScope = ctx.settings.register(CONFIG_NAMESPACE, GalfreeSettingsSchema, { base })
  const current = () => settingsScope.get()

  const dataDir = galfreeDataDir()
  const pinnedSdkDir = join(dataDir, 'sdk')
  const sdkDir = () => current().sdkPath !== '' ? current().sdkPath : pinnedSdkDir

  /** 解析可用启动器:覆盖路径直接用;钉版目录若未就绪,不自动下载(试玩时如实报缺)。 */
  const resolveLauncher = async (): Promise<string | null> => {
    if (current().sdkPath !== '') return findLauncher(current().sdkPath)
    // 钉版:仅在已就绪时返回(下载由 /sdk/ensure 或首次试玩前显式触发,避免隐性大下载)。
    return findLauncher(pinnedSdkDir)
  }

  // 钉版 SDK 供给(首次需要时下载;进度经 /sdk/status 可见)。
  const provisioner = new SdkProvisioner(pinnedSdkDir, {
    download: httpsDownloader,
    extract: extractZip,
    launcherName: platformLauncherName(),
  })

  const service = createProjectService({
    dataDir,
    // 合成验证器:假 lint 恒跑,SDK 就绪时叠加真 lint;覆盖路径版本差异警告入状态。
    validator: createCompositeValidator({
      pinnedSdkDir,
      overrideSdkPath: () => current().sdkPath,
    }),
    playtest: {
      resolveLauncher: async () => {
        const dir = sdkDir()
        // 钉版且未就绪 → 先供给(首次下载,进度可见),再取启动器。
        if (current().sdkPath === '' && (await findLauncher(dir)) === null) {
          const status = await provisioner.ensure().catch(() => null)
          if (status === null || status.state !== 'ready') return null
        }
        return findLauncher(dir)
      },
      spawn: realSpawn,
    },
  })

  ctx.effect(
    () => {
      const disposers = makeRoutes({
        service,
        config: current,
        // 目录选择:每次请求现取接缝(backend 可能晚些激活,能力对象在服务生命周期内稳定)。
        picker: {
          capability: async () => {
            const seam = directoryPickerSeam(ctx)
            if (seam === undefined) return { kind: 'none' as const }
            try {
              return { kind: seam.capability().kind }
            } catch (error) {
              return { kind: 'none' as const, note: String(error) }
            }
          },
          pick: async (signal) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.pick === undefined) throw new GalfreeError('picker-unsupported', '宿主没有原生目录选择器(当前后端为应用内浏览)')
            return await capability.pick(signal)
          },
          list: async (path, signal) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.list === undefined) throw new GalfreeError('picker-unsupported', '宿主没有应用内目录浏览后端')
            return await capability.list(path, signal)
          },
          createDirectory: async (path, name) => {
            const seam = directoryPickerSeam(ctx)
            const capability = seam?.capability()
            if (capability?.createDirectory === undefined) throw new GalfreeError('picker-unsupported', '宿主没有应用内目录浏览后端')
            return await capability.createDirectory(path, name)
          },
        },
        sdk: {
          status: async () => {
            const override = current().sdkPath
            const dir = sdkDir()
            const launcher = await findLauncher(dir)
            const probe = launcher === null ? { ready: false } : override !== '' ? await probeOverrideSdk(dir, platformLauncherName()) : { ready: true }
            return {
              requested: override !== '' ? ('override' as const) : ('pinned' as const),
              dir,
              launcherReady: launcher !== null,
              version: probe.version,
              mismatch: probe.mismatch,
              provision: provisioner.status,
            }
          },
          ensure: async () => {
            try {
              await provisioner.ensure()
            } catch { /* 状态对象里如实呈现 failed + error */ }
            return provisioner.status
          },
        },
      }).map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-galfree: routes',
  )

  // agent 工具(T10):接缝能力的薄适配器。懒注入 —— 宿主没有工具席位就少两个入口,
  // 面板与路由照常工作。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () => registerGalfreeTools(
        toolCtx as unknown as Parameters<typeof registerGalfreeTools>[0],
        service,
      ),
      'dsh-galfree: agent tools',
    )
  })
}
