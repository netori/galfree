/**
 * dsh-galfree — Client 半(工作台面板入口)。
 *
 * 注册三件席位(零 DOM 注入):
 *  - `sidebar.panellist`(list,id='galfree'):侧边栏图标入口
 *  - `main`(root keyed,key='galfree'):面板本体(当前项目 + 文件树)
 *  - `plugins.bundle.config`(keyed,key='dsh-galfree'):**渠道设置页** ——
 *    T37 迁移:设置面在 DSH 0.1.7 里重构过,旧的 `settings.plugin.item` /
 *    `settings.section` 已经不存在,插件的配置面现在长在 **Plugins 页**上。
 *
 * SlotMap 增补由 ui-layout / ui-sidebar / ui-plugin-manager 在运行时提供;此处按同名约定
 * 注册(与 dsh-skill-hub 同款 build-time augmentation,避免依赖内部类型包)。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GalfreeIcon } from './icon.tsx'
import { WorkbenchPanel } from './panel.tsx'
import { apply as applySettingsCard } from './settings-card.tsx'

export const name = 'galfree'

/**
 * 客户端半要求的服务。
 *
 * **`slots` 是硬依赖**(三处注册都要它);`configForms` **不在这里** ——
 * 它是"有这个席位才多一页设置"的可选能力,走 `ctx.inject` 懒装配。
 *
 * 为什么把 `configForms` 从硬依赖里拿出来(实测过的代价):
 * 硬 inject 缺一个服务 ⇒ **整个客户端半不激活** ⇒ 侧边栏入口与面板一起消失。
 * 而"设置页画不出来"和"工作台打不开"是两件严重程度差很远的事,不该绑在一起。
 *
 * 旧模型要的 `settingsScope` / `remote.settings` 都不再需要了:读写设置走
 * `ctx.configForms`,而它**通过服务提供者的 fiber 发请求**(`ui-settings` 的注释:
 * "letting a shared form write through the caller's context would make every caller
 * declare `remote.settings` in its own `inject`")。
 */
export const inject = ['slots']

interface SlotsLike {
  register: (options: Record<string, unknown>, component: unknown) => () => void
  inject: (key: string, build: () => (() => void)) => unknown
}

function slotsOf(ctx: Context): SlotsLike {
  return (ctx as unknown as { slots: SlotsLike }).slots
}

export function apply(ctx: Context): void {
  ctx.effect(
    () => slotsOf(ctx).inject('sidebar.panellist', () => slotsOf(ctx).register({
      name: 'sidebar.panellist',
      id: 'galfree',
      order: 30,
      label: 'GALFree 工作台',
    }, GalfreeIcon)) as () => void,
    'dsh-galfree: sidebar entry',
  )
  ctx.effect(
    () => slotsOf(ctx).inject('main', () => slotsOf(ctx).register({
      name: 'main',
      key: 'galfree',
    }, WorkbenchPanel)) as () => void,
    'dsh-galfree: main panel',
  )
  // 渠道设置页(T14 / T37):长在 Plugins 页上,不在工作台面板里再开一处配置面。
  // **懒注入**:宿主没给 `configForms` 席位(或没装载设置面)时少一页,面板照常。
  ctx.inject(['configForms'], (settingsCtx) => {
    settingsCtx.effect(() => applySettingsCard(settingsCtx), 'dsh-galfree: settings page')
  })
}
