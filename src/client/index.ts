/**
 * dsh-galfree — Client 半(工作台面板入口)。
 *
 * 注册三件官方席位(零 DOM 注入):
 *  - `sidebar.panellist`(list,id='galfree'):侧边栏图标入口
 *  - `main`(root keyed,key='galfree'):面板本体(当前项目 + 文件树)
 *  - `settings.plugin.item`(keyed,key='dsh-galfree'):**图像渠道设置卡** ——
 *    设置页的「插件配置」标签页按 key 分发卡片,"插件自己提供那张卡";
 *    光在 Host 半注册设置命名空间不会长出界面(T14 踩到的正是这个)。
 *
 * SlotMap 增补由 ui-layout / ui-sidebar / ui-settings 在运行时提供;此处按同名约定注册
 * (与 dsh-skill-hub 同款 build-time augmentation,避免依赖内部类型包)。
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
 * `slots` 是三个席位都需要的;`settingsScope` 是渠道设置分区**读**设置要用的;
 * `remote` + **`remote.settings`** 是**写**设置要用的 —— 子服务必须**单独声明**
 * (宿主自己的「模型」设置页就是这么写的:`["slots","locale","remote",
 * "remote.credentials","remote.llm","remote.settings","settingsScope","settingsSchema"]`)。
 *
 * 两个坑都踩过,记在这里:
 *  - 不声明 `settingsScope` → 组件一读就抛错,界面**一片空白**;
 *  - 不声明 `remote.settings` → 抛 `cannot get property "remote.settings" without inject`。
 * 所以这个 inject 列表是**功能的一部分**,别当样板删。
 */
export const inject = ['slots', 'settingsScope', 'remote', 'remote.settings']

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
  // 图像渠道设置卡(T14):长在宿主的设置页里,不在工作台面板里再开一处配置面。
  ctx.effect(() => { applySettingsCard(ctx); return () => { /* effect 由 cordis 收口 */ } }, 'dsh-galfree: settings card')
}
