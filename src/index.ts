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
import { SdkProvisioner } from './service/sdk-provision.ts'
import { extractZip, httpsDownloader, platformLauncherName } from './service/sdk-real.ts'
import { defaultLauncher, realSpawn } from './service/playtest.ts'

/** 稳定的 cordis 插件名(与 cordis.patch.yml 的 insert id 对齐)。 */
export const name = 'galfree'

/** 挂载工作台路由与设置所需的服务。 */
export const inject = ['webServer', 'settings']

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
  const sdkDir = () => current().sdkPath !== '' ? current().sdkPath : join(dataDir, 'sdk')

  // 钉版 SDK 供给(首次需要时下载;进度经 /sdk/status 可见)。
  const provisioner = new SdkProvisioner(join(dataDir, 'sdk'), {
    download: httpsDownloader,
    extract: extractZip,
    launcherName: platformLauncherName(),
  })

  const service = createProjectService({
    dataDir,
    playtest: {
      resolveLauncher: async () => {
        const dir = sdkDir()
        // 覆盖路径直接用;钉版目录若未就绪则先供给(首次下载)。
        if (current().sdkPath === '' && (await defaultLauncher(dir)) === null) {
          const status = await provisioner.ensure().catch(() => null)
          if (status === null || status.state !== 'ready') return null
        }
        return defaultLauncher(dir)
      },
      spawn: realSpawn,
    },
  })

  ctx.effect(
    () => {
      const disposers = makeRoutes({
        service,
        config: current,
        sdk: {
          status: () => ({ requested: current().sdkPath !== '' ? 'override' : 'pinned', dir: sdkDir(), provision: provisioner.status }),
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
}
