/**
 * 项目级完整性推导(T13)—— "全场景引用完整、开场到结局可达、无孤立场景,缺项定位到场景"。
 *
 * 全部是**纯推导**(ADR-0008):图可全量重算,板上的完整性判断没有第二处真相。
 * 三件事:
 *
 *  1. **定位**:把全局问题(如悬空跳转)映射到它所在的场景 —— 板要能说"是这一幕的问题",
 *     而不只是"项目里有个问题"。
 *  2. **可达**:从主菜单入口(`start`)沿 jump/call/菜单选项走,走不到的场是孤立场景
 *     (`orphan-scene`)。孤立场景是真实的坑:剧本写了、玩不到。
 *  3. **结局可达**:从 `start` 出发能否走到一个 `return`(回到主菜单/结束)。
 *     走不到就是死循环式结构(`no-ending-reachable`)。
 *
 * 注意与解析器既有问题的分工:悬空跳转/重复 label/缺 start 由解析器报(它看得更细,有
 * 行列号);这里只补"它没说的"——可达性与归属,并给它们加上场景名。
 */
import type { BranchGraph, DialectProblem, SceneNode } from './rpy/dialect.ts'

export interface CompletenessReport {
  /** 主菜单入口 label(方言子集约定 `start`);不存在 = null。 */
  entry: string | null
  /** 从入口可达的场景(含入口本身)。 */
  reachable: string[]
  /** 走不到的场景(孤立)。 */
  orphans: string[]
  /** 从入口能不能走到一个 return。 */
  endingReachable: boolean
  /** 完整性问题(已定位到场景;与解析器问题同形状,直接进板)。 */
  problems: DialectProblem[]
}

/** 每个场景的行区间上界(同文件内按起始行排序,下一个 label 起始行即上界)。 */
function sceneBounds(scenes: SceneNode[]): Map<string, number> {
  const bounds = new Map<string, number>()
  const byFile = new Map<string, SceneNode[]>()
  for (const scene of scenes) {
    const list = byFile.get(scene.file) ?? []
    list.push(scene)
    byFile.set(scene.file, list)
  }
  for (const list of byFile.values()) {
    const sorted = [...list].sort((a, b) => a.line - b.line)
    for (let i = 0; i < sorted.length; i += 1) {
      const next = sorted[i + 1]
      bounds.set(sorted[i]!.label, next?.line ?? Number.POSITIVE_INFINITY)
    }
  }
  return bounds
}

/**
 * 把一条"文件 + 行号"的问题落到它所在的场景上。
 * 行号缺失或落在所有场景之外 → 返回 null(如实:定位不到就不硬塞)。
 */
export function locateScene(graph: Pick<BranchGraph, 'scenes'>, problem: Pick<DialectProblem, 'file' | 'line'>): string | null {
  if (problem.line === undefined) return null
  const bounds = sceneBounds(graph.scenes)
  for (const scene of graph.scenes) {
    if (scene.file !== problem.file) continue
    const upper = bounds.get(scene.label) ?? Number.POSITIVE_INFINITY
    if (problem.line >= scene.line && problem.line < upper) return scene.label
  }
  return null
}

export function deriveCompleteness(graph: Pick<BranchGraph, 'scenes' | 'edges' | 'problems'>): CompletenessReport {
  const labels = new Set(graph.scenes.map((scene) => scene.label))
  const entry = labels.has('start') ? 'start' : null

  // 邻接表:jump / call / 菜单选项都算"走得到"。
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? []
    if (!list.includes(edge.to)) list.push(edge.to)
    outgoing.set(edge.from, list)
  }

  const reachable = new Set<string>()
  const queue: string[] = []
  if (entry !== null) { reachable.add(entry); queue.push(entry) }
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next) || !labels.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }

  const orphans = graph.scenes
    .map((scene) => scene.label)
    .filter((label) => entry !== null && !reachable.has(label))

  // 结局可达:从入口出发,能否走到一个含 return 的场景。
  // **return 可能藏在菜单选项体里**(模板的 start 就是这样:`menu:` 一个选项 return),
  // 只看顶层语句会把这种项目误判成"结局不可达" —— 那是假阳性,比漏报更糟。
  const sceneHasReturn = (scene: SceneNode): boolean => {
    const hasReturn = (statements: SceneNode['statements']): boolean => statements.some((statement) => (
      statement.kind === 'return'
      || (statement.kind === 'menu' && statement.choices.some((choice) => hasReturn(choice.body)))
    ))
    return hasReturn(scene.statements)
  }
  const hasReturn = new Set(graph.scenes.filter(sceneHasReturn).map((scene) => scene.label))
  const endingReachable = [...reachable].some((label) => hasReturn.has(label))

  const problems: DialectProblem[] = []

  // 1) 定位:把全局问题挂到场景上(只加场景名,不改原有问题的形状)。
  for (const problem of graph.problems) {
    const scene = locateScene(graph, problem)
    if (scene === null) continue
    problems.push({
      ...problem,
      message: `${problem.message}(在场景 ${scene} 内)`,
      snippet: problem.snippet ?? scene,
    })
  }

  // 2) 孤立场景:写了但玩不到。
  for (const label of orphans) {
    const scene = graph.scenes.find((candidate) => candidate.label === label)!
    problems.push({
      severity: 'error',
      file: scene.file,
      line: scene.line,
      code: 'orphan-scene',
      message: `场景 ${label} 从 ${entry ?? 'start'} 走不到(孤立场景):写了的戏玩不到,补一条 jump/call 或菜单选项进来`,
      snippet: label,
    })
  }

  // 3) 结局可达性:整条线走不到任何 return。
  if (entry !== null && reachable.size > 0 && !endingReachable) {
    problems.push({
      severity: 'error',
      file: graph.scenes.find((scene) => scene.label === entry)?.file ?? 'game',
      code: 'no-ending-reachable',
      message: `从 ${entry} 出发走不到任何 return(结局不可达):这条线永远不会结束`,
    })
  }

  return {
    entry,
    reachable: [...reachable],
    orphans,
    endingReachable,
    problems,
  }
}
