/**
 * 目录列举(插件自带底座)。
 *
 * 为什么不直接用宿主 `ctx.directoryPicker` 的 browse 能力就够了:那条链是
 * `dsh-host-directory-picker-auto` 在启动时用**运行时 Loader 动态 create** 装配的
 * (`ctx.loader.create({name})`),它自己的 effect 一旦失败是静默的 —— 后端没挂上,
 * `ctx.directoryPicker` 就不存在,插件这边只能看到"没有选择器"。把"能不能选文件夹"
 * 押在那条链上,等于把用户可见功能押在别人的启动时序上。
 *
 * 所以这里自带一个最小底座:列举一层子目录、建一个子目录。它是**降级底座**,不是
 * 第二真相 —— 宿主选择器在的时候插件优先用它(见 routes.ts 的 /picker/*),不在的
 * 时候面板里的浏览器照样能用。目录内容属于文件系统本身,不存在"第二份真相"。
 */
import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'

export interface DirectoryEntryRow {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryListingView {
  /** 被列举的目录绝对路径。 */
  path: string
  home: string
  /** 从根到目标目录的祖先链(每段可跳转;根以完整路径标注)。 */
  crumbs: Array<{ name: string; path: string }>
  entries: DirectoryEntryRow[]
  /** 单层条目过多被截断(层级不完整,如实标注)。 */
  truncated: boolean
}

export class DirectoryListingError extends Error {
  constructor(
    readonly code: 'directory-unreadable' | 'directory-create-failed',
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'DirectoryListingError'
  }
}

/** 单层最多列举这么多子目录(与宿主 browse 后端同量级)。 */
export const MAX_ENTRIES = 1000

const WINDOWS = sep === '\\'

/** 是否"完全限定路径":Windows 认 `D:\x` 与 UNC `\\server\share`,POSIX 认 `/x`。 */
export function isFullyQualified(path: string): boolean {
  if (path === '') return false
  return WINDOWS ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/')
}

/** 路径所在卷/根的字符串(Windows `D:\`、UNC `\\server\share\`、POSIX `/`)。 */
function rootOf(target: string): string {
  if (WINDOWS) {
    const drive = /^[A-Za-z]:[\\/]/.exec(target)
    if (drive !== null) return drive[0]
    const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(target)
    if (unc !== null) return unc[0]
  }
  return sep
}

/**
 * 祖先链:从根到目录,每段都带绝对路径(客户端拿它做面包屑跳转)。
 * Windows 上止于盘符根 —— 跨盘要靠手输路径,宿主 browse 后端同样如此。
 */
export function ancestryCrumbs(target: string): Array<{ name: string; path: string }> {
  const absolute = resolve(target)
  const root = rootOf(absolute)
  const crumbs: Array<{ name: string; path: string }> = []
  let cursor = absolute
  while (true) {
    crumbs.unshift({ name: basename(cursor) === '' ? cursor : basename(cursor), path: cursor })
    if (cursor === root || cursor === dirname(cursor)) break
    const parent = dirname(cursor)
    if (parent === root) {
      crumbs.unshift({ name: parent, path: parent })
      break
    }
    cursor = parent
  }
  return crumbs
}

/** 只保留"确实是目录"的条目(符号链接跟随判定,断链与指向文件的跳过)。 */
async function keepDirectory(fullPath: string, isDirectory: boolean, isSymbolicLink: boolean): Promise<boolean> {
  if (isDirectory) return true
  if (!isSymbolicLink) return false
  const followed = await stat(fullPath).catch(() => null)
  return followed?.isDirectory() ?? false
}

/** 列举一层子目录(只看目录;按名称排序)。不给 path 则列举当前用户家目录。 */
export async function listDirectories(path?: string): Promise<DirectoryListingView> {
  const home = homedir()
  if (path !== undefined && path !== '' && !isFullyQualified(path)) {
    throw new DirectoryListingError('directory-unreadable', path, `需要完整路径才能列举:${path}`)
  }
  const target = resolve(path === undefined || path === '' ? home : path)
  const candidates: Array<{ name: string; path: string; isDirectory: boolean; isSymbolicLink: boolean }> = []
  let truncated = false
  try {
    const level = await opendir(target)
    try {
      for await (const dirent of level) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
        if (candidates.length >= MAX_ENTRIES) { truncated = true; break }
        candidates.push({
          name: dirent.name,
          path: join(target, dirent.name),
          isDirectory: dirent.isDirectory(),
          isSymbolicLink: dirent.isSymbolicLink(),
        })
      }
    } finally {
      // 目录句柄不 gc:读完就关(close 失败也不会改变列举结果)。
      if (typeof level.close === 'function') await level.close().catch(() => { /* 已经关了 */ })
    }
  } catch (error) {
    throw new DirectoryListingError('directory-unreadable', target, `列不出这个目录的内容:${target}(${String(error)})`)
  }

  const kept = await Promise.all(candidates.map(async (candidate) => (
    await keepDirectory(candidate.path, candidate.isDirectory, candidate.isSymbolicLink) ? candidate : null
  )))
  const entries = kept
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .map((candidate): DirectoryEntryRow => ({
      name: candidate.name,
      path: candidate.path,
      hidden: candidate.name.startsWith('.'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
}

/** 在父目录下建一个子目录(单段名,不递归创建中间层)。 */
export async function createSubdirectory(parent: string, name: string): Promise<{ path: string; name: string }> {
  if (!isFullyQualified(parent)) {
    throw new DirectoryListingError('directory-create-failed', parent, `父目录需要完整路径:${parent}`)
  }
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    throw new DirectoryListingError('directory-create-failed', join(parent, name), `不是一个合法的文件夹名:${name}`)
  }
  const target = join(resolve(parent), trimmed)
  try {
    await mkdir(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new DirectoryListingError(
      'directory-create-failed',
      target,
      code === 'EEXIST' ? `同名文件夹已经存在:${target}` : `建不了这个文件夹:${target}(${String(error)})`,
    )
  }
  return { path: target, name: trimmed }
}

/** 手输路径的即时校验:这个位置现在是不是一个能放项目的目录。 */
export async function describePath(path: string): Promise<{ exists: boolean; isDirectory: boolean }> {
  if (!isFullyQualified(path)) return { exists: false, isDirectory: false }
  const found = await stat(normalize(path)).catch(() => null)
  return { exists: found !== null, isDirectory: found?.isDirectory() ?? false }
}
