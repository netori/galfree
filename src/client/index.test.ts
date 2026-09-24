/**
 * 客户端半的**注册契约**(T37 · DSH 0.1.7)。
 *
 * 这一条守的是"插件在 0.1.7 的浏览器端到底注册了什么"。它值得单独一组,因为
 * **客户端半坏起来是静默的**:浏览器只把模块装进表里,注册到不存在的槽位不会抛、
 * 也不会有人告诉你 —— 界面表现就是"少一个入口"或者"那一页打不开"。升级事故里
 * 客户端半断的正是这一层(旧槽位 `settings.plugin.item` / `settings.section`
 * 在 0.1.7 的 asar 里一次都搜不到)。
 *
 * 用**假 ctx** 而不是真浏览器:注册这件事是纯调用序列,给一个记录调用的壳就能看清;
 * 而"宿主没有设置面时面板照常"这条(可选席位纪律,与 Host 半的 T35 同一态度)只有
 * 在假壳里才构造得出来。
 */
import { describe, expect, it } from 'vitest'
import { apply, inject } from './index.ts'

interface Registration {
  name: string
  [key: string]: unknown
}

/** 一个记录调用的 ctx 壳;`withConfigForms` 决定"宿主有没有设置面"。 */
function fakeCtx(options: { withConfigForms: boolean }) {
  const registered: Registration[] = []
  const slotInjects: string[] = []
  const childInjections: string[][] = []

  const shell = {
    // cordis 的 `ctx.effect` 立刻跑一次回调并返回 disposer;这里照做。
    // 子 ctx(`ctx.inject` 的回调参数)**同样**是完整 ctx —— 它有 effect/get,所以放进 shell。
    effect: (fn: () => unknown) => { fn(); return () => { /* 卸载 */ } },
    get: () => undefined,
    slots: {
      inject: (key: string, build: () => () => void) => { slotInjects.push(key); return build() },
      register: (opts: Record<string, unknown>) => {
        registered.push(opts as Registration)
        return () => { /* disposer */ }
      },
    },
  }

  const ctx = {
    ...shell,
    inject: (names: string[], callback: (child: unknown) => void) => {
      childInjections.push(names)
      // **可选席位的语义**:服务不在 → 回调根本不跑(而不是抛)。
      if (!options.withConfigForms) return
      callback({
        ...shell,
        configForms: {
          get: () => { throw new Error('这一组只验注册,不读表单值') },
          whileServed: (namespaces: string[], register: (served: Set<string>) => () => void) =>
            register(new Set(namespaces)),
        },
      })
    },
  }

  return { ctx, registered, slotInjects, childInjections }
}

describe('客户端半的注册契约(T37)', () => {
  it('`configForms` 必须是**懒注入**的:硬 inject 会让整个客户端半不激活(面板一起消失)', () => {
    expect(inject).toContain('slots')
    expect(inject, '设置面是可选席位 —— 它缺席只该少一页设置,不该让工作台打不开').not.toContain('configForms')
  })

  it('有设置面时:三处注册都到位(侧边栏 / 主面板 / Plugins 页的配置页)', () => {
    const fake = fakeCtx({ withConfigForms: true })
    apply(fake.ctx as never)

    expect(fake.registered.some((r) => r.name === 'sidebar.panellist' && r.id === 'galfree')).toBe(true)
    expect(fake.registered.some((r) => r.name === 'main' && r.key === 'galfree')).toBe(true)
    expect(
      fake.registered.some((r) => r.name === 'plugins.bundle.config' && r.key === 'dsh-galfree'),
      `设置页要注册到 Plugins 页的 plugins.bundle.config(key = bundle 包名);实际注册:${fake.registered.map((r) => String(r.name)).join(' / ')}`,
    ).toBe(true)
    // 0.1.7 里这两个槽位已经不存在 —— 注册回去等于那一页没人渲染。
    expect(fake.registered.some((r) => String(r.name).startsWith('settings.'))).toBe(false)
  })

  it('宿主**没有**设置面时:面板照常,设置页不注册(可选席位真的可选)', () => {
    const fake = fakeCtx({ withConfigForms: false })
    expect(() => apply(fake.ctx as never)).not.toThrow()
    expect(fake.registered.some((r) => r.name === 'main')).toBe(true)
    expect(fake.registered.some((r) => r.name === 'plugins.bundle.config')).toBe(false)
  })
})
