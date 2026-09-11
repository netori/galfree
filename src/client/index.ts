/**
 * dsh-galfree — Client 半(工作台面板入口)。
 *
 * 注册两件官方席位(零 DOM 注入):
 *  - `sidebar.panellist`(list,id='galfree'):侧边栏图标入口
 *  - `main`(root keyed,key='galfree'):面板本体(当前项目 + 文件树)
 *
 * SlotMap 增补由 ui-layout / ui-sidebar 在运行时提供;此处按同名约定注册
 * (与 dsh-skill-hub 同款 build-time augmentation,避免依赖内部类型包)。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GalfreeIcon } from './icon.tsx'
import { WorkbenchPanel } from './panel.tsx'

export const name = 'galfree'

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
}
