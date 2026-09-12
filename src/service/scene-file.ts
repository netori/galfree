/**
 * 生成文件的组装(纯函数)—— T10 里最容易把项目搞坏的那一步,所以单独成文并单测。
 *
 * 约束:
 *  1. **生成物固定落在** `game/scenes/<label>.rpy`(一文件一场景);
 *  2. 一个 label 只归一个文件 —— 归属检查在服务层做(需要全项目解析),这里只负责
 *     "在同一文件内把这一段换掉,别的段原样保住";
 *  3. 模板/手写内容一律不动(生成器不越界)。
 */
import { SCENES_DIR } from './rpy/files.ts'

/**
 * 生成物的规范路径。
 *
 * 口径与 `SceneNode.file` 一致 = **`game/` 下的相对 POSIX 路径**(如 `scenes/start.rpy`):
 * 归属检查要拿它跟解析结果里的 `scene.file` 直接比,两边口径必须一样。
 * 落盘时由调用方拼上项目根的 `game/`。
 */
export function scenesPathOf(label: string): string {
  return `${SCENES_DIR}/${label}.rpy`
}

/** 规范路径 → 写批用的项目相对路径(`.studio/` 与 `game/` 同一口径)。 */
export function gatewayPathOf(scenePath: string): string {
  return `game/${scenePath}`
}

/** 场景文件头部(行数组):让人一眼看出这文件是生成物、归哪个场景、怎么重生成。 */
export function sceneHeaderLines(label: string): string[] {
  return [
    `# GALFree 生成场景:${label}`,
    '# 由工作台/agent 逐场生成,经写网关落盘(每次生成 = 一个快照)。',
    '# 手写改动请改 game/script.rpy;要重生成这一场,让 agent 再生成一次同名 label。',
    '',
  ]
}

/** 顶层 `label <name>:` 行(列 0,与方言子集一致)。 */
const LABEL_RE = /^label\s+([A-Za-z0-9_]+):\s*$/

interface Block {
  label: string
  body: string[]
}

/** 把一份 `.rpy` 拆成"顶层 label 段";段外的行归入其前面的段(或 preamble)。 */
function splitBlocks(text: string): { preamble: string[]; blocks: Block[] } {
  const preamble: string[] = []
  const blocks: Block[] = []
  for (const line of text.split('\n')) {
    const match = LABEL_RE.exec(line)
    if (match !== null) {
      blocks.push({ label: match[1]!, body: [line] })
      continue
    }
    if (blocks.length === 0) preamble.push(line)
    else blocks[blocks.length - 1]!.body.push(line)
  }
  return { preamble, blocks }
}

/** 去掉尾部空行(避免每次生成都往上堆空行)。 */
function trimTrailingBlank(lines: string[]): string[] {
  const trimmed = [...lines]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === '') trimmed.pop()
  return trimmed
}

/**
 * 组装目标文件内容。
 *
 * @param label 本次生成的场景 label。
 * @param source 生成的 `.rpy` 段落(必须含 `label <label>:` 起头)。
 * @param existing 目标文件当前内容(可为空)。
 * @param nextLabel 续接目标(label 存在时校验;`jump` 由生成内容自己写)。
 */
export function composeSceneFile(label: string, source: string, existing: string, nextLabel: string | null): string {
  void nextLabel
  const normalized = source.replace(/\r\n/g, '\n').trimEnd()
  if (!normalized.includes(`label ${label}:`)) {
    throw new Error(`生成内容里没有 label ${label}:,拒绝落盘`)
  }
  const generated = [...sceneHeaderLines(label), ...normalized.split('\n')]
  const { preamble, blocks } = splitBlocks(`${existing}\n`)
  const kept = blocks.filter((block) => block.label !== label).flatMap((block) => trimTrailingBlank(block.body))

  const sections: string[] = [trimTrailingBlank(generated).join('\n')]
  const keptText = trimTrailingBlank(kept).join('\n')
  if (keptText.trim() !== '') sections.push(keptText)

  const head = trimTrailingBlank(preamble).join('\n')
  const body = sections.join('\n\n')
  return `${head.trim() === '' ? '' : `${head}\n\n`}${body}\n`
}

/**
 * 从一个 `.rpy` 文件里**原样取出**一个 label 段(搬家用)。
 *
 * 语义严格限定为"搬":段内容逐字不变(含注释、缩进、空行),只是换个文件住。
 * 返回新的目标文件内容与去掉该段之后的源文件内容。
 */
export function extractSceneBlock(source: string, label: string): { moved: string; remainder: string } {
  const { preamble, blocks } = splitBlocks(source)
  const target = blocks.find((block) => block.label === label)
  if (target === undefined) throw new Error(`源文件里没有 label ${label}:`)
  const rest = blocks.filter((block) => block.label !== label)

  const movedBody = trimTrailingBlank(target.body).join('\n')
  const moved = `${[...sceneHeaderLines(label), ...movedBody.split('\n')].join('\n')}\n`

  const parts: string[] = []
  const head = trimTrailingBlank(preamble).join('\n')
  if (head.trim() !== '') parts.push(head)
  const restText = trimTrailingBlank(rest.flatMap((block) => trimTrailingBlank(block.body))).join('\n')
  if (restText.trim() !== '') parts.push(restText)
  return { moved, remainder: parts.length === 0 ? '' : `${parts.join('\n\n')}\n` }
}
