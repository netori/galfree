/**
 * 设定集(`.studio/bible/bible.json` + 可能的人写原文 `outline.md`)。
 *
 * 它是项目的**第一记忆源**:世界观、章节大纲、分支骨架。两条边界由 T9 钉死:
 *
 * 1. **角色设定以登记簿为家** —— 设定集只放 `{id}` 引用(T8 的登记簿是单一真相),
 *    不复制外观卡;否则同一张脸会有两处说法,迟早漂移。
 * 2. **大纲模式的原文即权威** —— 人导入的原文逐字躺在 `.studio/bible/outline.md`,
 *    设定集里只存**引用**(路径 + 指纹)。指纹对不上就如实报
 *    `outline-fingerprint-mismatch`:原文被外部改过这件事必须可见,而不是拿旧指纹
 *    假装它还是那份权威原文。
 *
 * 骨架是**派生**的(可全量重算),所以不落盘 —— 落盘的只有人的意图(主题/世界观/章节)、
 * 人的原文、以及对登记簿的引用。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GalfreeError } from './error.ts'
import { fingerprint } from './hash.ts'
import type { CharacterRecord } from './characters.ts'

/** 章节:标题 + 梗概 + 它覆盖的 label(引用,不是正文)。 */
export interface BibleChapter {
  id: string
  title: string
  /** 这一章的梗概(人的意图,不是叙述正文)。 */
  outline?: string
  /** 覆盖的 label(对 `.rpy` 的引用)。 */
  scenes: string[]
}

/** 大纲引用:原文的路径 + 指纹(原文本体在 outline.md,不在 json 里复制一份)。 */
export interface OutlineRef {
  path: string
  fingerprint: string
  chars: number
  importedAt: string
}

export interface BibleDocument {
  schemaVersion: 1
  /** 主题模式:一句话主题(人给或 agent 提炼)。 */
  theme?: string
  /** 世界观(人的意图;不是叙述正文)。 */
  world?: string
  chapters: BibleChapter[]
  /** 人导入的原文引用(缺省 = 没走大纲模式)。 */
  outline: OutlineRef | null
  /** 对登记簿的引用 —— 只放 id,不复制外观卡。 */
  characters: Array<{ id: string }>
  updatedAt: string
}

export const BIBLE_DIR = '.studio/bible'
export const BIBLE_FILE = `${BIBLE_DIR}/bible.json`
export const OUTLINE_FILE = `${BIBLE_DIR}/outline.md`

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** 单字段上限:设定集存意图,不存正文。 */
export const MAX_BIBLE_FIELD_CHARS = 4000

export function emptyBible(): BibleDocument {
  return { schemaVersion: 1, chapters: [], outline: null, characters: [], updatedAt: new Date(0).toISOString() }
}

export async function readBible(root: string): Promise<BibleDocument> {
  try {
    const doc = JSON.parse(await readFile(join(root, BIBLE_FILE), 'utf8')) as BibleDocument
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.chapters)) throw new Error('shape')
    return { ...emptyBible(), ...doc, characters: doc.characters ?? [], outline: doc.outline ?? null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBible()
    throw new GalfreeError('bible-corrupt', `设定集无法解析:${String(error)}`)
  }
}

/** 人写原文的当前内容(读);缺文件返回 null。 */
export async function readOutline(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, OUTLINE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GalfreeError('bible-corrupt', `大纲原文读不了:${String(error)}`)
  }
}

/**
 * 定稿指纹:只覆盖**派生物**(主题 / 世界观 / 章节 / 角色引用)。
 * 大纲原文有自己的指纹(在 `outline.fingerprint` 里),两者分开,才能分别判"谁被改了"。
 */
export function bibleFingerprint(doc: Pick<BibleDocument, 'theme' | 'world' | 'chapters' | 'characters'>): string {
  return fingerprint(JSON.stringify({
    theme: doc.theme ?? '',
    world: doc.world ?? '',
    chapters: doc.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      outline: chapter.outline ?? '',
      scenes: [...chapter.scenes].sort(),
    })),
    characters: doc.characters.map((reference) => reference.id).sort(),
  }))
}

export function bibleDocument(doc: BibleDocument): string {
  return `${JSON.stringify({ ...doc, schemaVersion: 1 }, null, 2)}\n`
}

/** 部分更新(agent 或人):只覆盖给出的字段;章节整段替换(列表不做逐字段合并)。 */
export interface BiblePatch {
  theme?: string
  world?: string
  chapters?: BibleChapter[]
  characters?: Array<{ id: string }>
}

export function applyBiblePatch(current: BibleDocument, patch: BiblePatch): BibleDocument {
  const next: BibleDocument = {
    ...current,
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.world === undefined ? {} : { world: patch.world }),
    ...(patch.chapters === undefined ? {} : { chapters: patch.chapters }),
    ...(patch.characters === undefined ? {} : { characters: patch.characters }),
    updatedAt: new Date().toISOString(),
  }
  assertBibleValid(next)
  return next
}

/** 写入前拦:字段长度上限 + 引用形状(id 必须是 slug),挡住"把正文抄进设定集"。 */
export function assertBibleValid(doc: BibleDocument): void {
  for (const [field, value] of [['theme', doc.theme], ['world', doc.world]] as Array<[string, string | undefined]>) {
    if (value !== undefined && value.length > MAX_BIBLE_FIELD_CHARS) {
      throw new GalfreeError('bible-invalid', `${field} 太长(${value.length} > ${MAX_BIBLE_FIELD_CHARS} 字):设定集存意图,不存正文`)
    }
  }
  const seen = new Set<string>()
  for (const chapter of doc.chapters) {
    if (!ID_RE.test(chapter.id)) throw new GalfreeError('bible-invalid', `章节 id 需匹配 ${ID_RE}:${chapter.id}`)
    if (seen.has(chapter.id)) throw new GalfreeError('bible-invalid', `章节 id 重复:${chapter.id}`)
    seen.add(chapter.id)
    // 形状也要拦:章节是可以从工具面/面板当自由 JSON 送进来的(`scenes` 缺了会让指纹计算抛
    // `chapter.scenes is not iterable` —— 那是**内部错误**,还会让整份文档写到盘上之后
    // 每次读板都炸)。所以"写之前拒绝"是这里唯一的正确时机。
    if (typeof chapter.title !== 'string' || chapter.title.trim() === '') {
      throw new GalfreeError('bible-invalid', `章节「${chapter.id}」需要一个标题`)
    }
    if (!Array.isArray(chapter.scenes) || chapter.scenes.some((scene) => typeof scene !== 'string')) {
      throw new GalfreeError('bible-invalid', `章节「${chapter.id}」的 scenes 必须是 label 字符串数组(要覆盖哪些场景)`)
    }
    if ((chapter.outline?.length ?? 0) > MAX_BIBLE_FIELD_CHARS) {
      throw new GalfreeError('bible-invalid', `章节「${chapter.id}」的梗概太长:设定集存意图,不存正文`)
    }
  }
  for (const reference of doc.characters) {
    if (!ID_RE.test(reference.id)) throw new GalfreeError('bible-invalid', `角色引用需要登记簿 id:${reference.id}`)
  }
}

/**
 * 下游生成用的上下文快照。**只给"定稿版"**:没盖定稿戳就不给(抛错),
 * 免得 agent 拿草稿当权威记忆源 —— 这正是"设定集是第一记忆源"的兑现方式。
 */
export interface GenerationContext {
  /** 定稿指纹;内容再变就对不上,下游据此知道要重取。 */
  fingerprint: string
  theme?: string
  world?: string
  chapters: BibleChapter[]
  /** 角色来自**登记簿**(单一真相),不是设定集里的复制品。 */
  characters: CharacterRecord[]
  /** 人写原文(有的话,逐字给出)。 */
  outline?: { text: string; fingerprint: string }
  /** 设定集引用但登记簿还没登记的角色 —— 如实列出,不假装完整。 */
  missingCharacters: string[]
}

export function buildGenerationContext(input: {
  bible: BibleDocument
  characters: CharacterRecord[]
  outlineText: string | null
}): GenerationContext {
  const registered = new Set(input.characters.map((character) => character.id))
  const missingCharacters = input.bible.characters.map((reference) => reference.id).filter((id) => !registered.has(id))
  return {
    fingerprint: bibleFingerprint(input.bible),
    ...(input.bible.theme === undefined ? {} : { theme: input.bible.theme }),
    ...(input.bible.world === undefined ? {} : { world: input.bible.world }),
    chapters: input.bible.chapters,
    characters: input.characters,
    ...(input.outlineText === null || input.bible.outline === null
      ? {}
      : { outline: { text: input.outlineText, fingerprint: input.bible.outline.fingerprint } }),
    missingCharacters,
  }
}

/** 大纲引用:导入时算一次(原文的指纹与长度)。 */
export function outlineRef(text: string): OutlineRef {
  return { path: OUTLINE_FILE, fingerprint: fingerprint(text), chars: text.length, importedAt: new Date().toISOString() }
}
