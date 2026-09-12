/**
 * 假 `systemPrompt` 席位(快带夹具)—— T19 的两处守卫共用。
 *
 * 为什么要有它:提示词段是"注册了才算数"的东西,而真宿主那台机器只在几条守卫里挂得起。
 * 这里造一个**形状对**的席位(收下注册进来的 section、返回 disposer),让
 * `playbook.test.ts`(内容守卫)与 `index.test.ts`(入口装配守卫)看的是同一种东西 ——
 * 两边各写一份的话,哪天宿主的 `section` 形状变了,两份假夹具会各自漂移。
 */
import type { SystemPromptSeat } from '../service/playbook.ts'

/** 一段被注册进来的 section(形状照宿主的 `PromptSection`)。 */
export interface CollectedSection {
  name: string
  order: number
  text: string | (() => string)
}

export interface SectionCollector {
  seat: SystemPromptSeat
  sections: CollectedSection[]
  /** 把收下来的 section 渲染成文本(注册时给的是"每次组装现算"的 provider)。 */
  render: (index?: number) => string
}

/** 造一个收 section 的假席位。 */
export function collectPromptSections(): SectionCollector {
  const sections: CollectedSection[] = []
  return {
    sections,
    seat: {
      section(section) {
        sections.push(section)
        return () => { /* disposer */ }
      },
    },
    render(index = 0) {
      const section = sections[index]
      if (section === undefined) throw new Error(`没有第 ${index} 段已注册的 section`)
      return typeof section.text === 'function' ? section.text() : section.text
    },
  }
}
