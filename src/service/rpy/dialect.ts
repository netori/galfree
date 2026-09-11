/**
 * 方言子集(galfree-subset-1)—— 环节零接缝契约第一块。
 * 语法清单成文于 docs/contracts/dialect-subset.md;这里是其类型与常量。
 *
 * 结构解析器**只承诺子集内**可靠;子集外语法 → 如实报告 + 该场景降级只读,
 * 可解析部分仍产出(ADR-0009:不静默、不覆盖)。
 */

/** 场景(label)内可识别的语句。 */
export type Statement =
  | { kind: 'dialogue'; speaker: string | null; text: string; line: number }
  | { kind: 'image'; role: 'show' | 'scene' | 'hide'; tag: string; attributes: string[]; line: number }
  | { kind: 'jump'; target: string; line: number }
  | { kind: 'return'; line: number }
  | { kind: 'call'; target: string; line: number }
  | { kind: 'menu'; choices: MenuChoice[]; line: number }
  | { kind: 'with'; transition: string; line: number }
  | { kind: 'pause'; seconds: number | null; line: number }
  | { kind: 'audio'; action: 'play' | 'stop'; channel: 'music' | 'sound' | 'voice'; file: string | null; loop: boolean; line: number }
  | { kind: 'comment'; line: number }

export interface MenuChoice {
  /** 选项文案(菜单项的字符串字面量)。 */
  prompt: string
  /** 该选项体解析出的语句(通常含 jump / dialogue)。 */
  body: Statement[]
  line: number
}

/** 分支图节点:一个 label 场景。 */
export interface SceneNode {
  label: string
  /** .rpy 文件名(不含目录),供定位。 */
  file: string
  /** label 声明所在行(1 基)。 */
  line: number
  statements: Statement[]
  /** 子集外语法 → 降级只读并记录原因(不为空时 readOnly=true)。 */
  readOnly: boolean
  problems: DialectProblem[]
}

/** 分支边:从某源场景到目标场景的跳转(显式 jump 或菜单选项)。 */
export interface BranchEdge {
  from: string
  to: string
  /** 边来源:直接 jump、菜单选项、call。 */
  via: 'jump' | 'menu' | 'call'
  /** 菜单选项文案(via=menu 时)。 */
  prompt?: string
  file: string
  line: number
}

/** 子集外语法的问题记录(severity=warning 触发只读降级;error 为结构缺陷)。 */
export interface DialectProblem {
  severity: 'error' | 'warning'
  file: string
  line?: number
  code: string
  message: string
  /** 触发降级的原始语句(便于如实呈现"这里看不懂")。 */
  snippet?: string
}

export interface ParsedScript {
  scenes: SceneNode[]
  edges: BranchEdge[]
  /** 顶层 `define <var> = Character("显示名")` —— 对白说话人的显示名来源。 */
  characters: Array<{ var: string; displayName: string; file: string; line: number }>
  /** 顶层 `image <名> = …` —— 静态图像定义(存在性登记;表达式不透明)。 */
  images: Array<{ name: string; file: string; line: number }>
  /** 全文件级问题(label 之外的顶层语法等)。 */
  problems: DialectProblem[]
}

/** 派生分支骨架 = scenes + edges,可全量重算、可缓存(ADR-0009)。 */
export interface BranchGraph {
  dialect: 'galfree-subset-1'
  scenes: SceneNode[]
  edges: BranchEdge[]
  problems: DialectProblem[]
  /** 是否存在任何只读降级场景(供板上徽标)。 */
  degraded: boolean
}
