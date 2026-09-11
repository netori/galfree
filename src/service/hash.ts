/**
 * 内容指纹与启动器探测的共享实现(避免各处重复制哈希/探测逻辑)。
 * 指纹统一 16 hex sha256;**所有调用方用同一函数**,保证戳/试玩/版本戳口径一致。
 */
import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 短内容指纹(文本或字节):sha256 前 16 hex。 */
export function fingerprint(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** 缺失文件的统一哨兵(读/writeLog/事件三处一致,可回填 expectVersion)。 */
export const ABSENT = 'absent'

/** 平台启动器文件名。 */
export function platformLauncherName(): string {
  return process.platform === 'win32' ? 'renpy.exe' : 'renpy.sh'
}

/**
 * 在 SDK 目录里找启动器(允许一层嵌套,兼容解压出单一顶层目录的情形)。
 * 返回启动器绝对路径或 null。
 */
export async function findLauncher(sdkDir: string): Promise<string | null> {
  const name = platformLauncherName()
  const direct = join(sdkDir, name)
  if (await isFile(direct)) return direct
  try {
    for (const entry of await readdir(sdkDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(sdkDir, entry.name, name)
      if (await isFile(nested)) return nested
    }
  } catch {
    return null
  }
  return null
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 目录/文件是否存在(存在性哨兵)。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 文件指纹:rootDir/relPath 的内容哈希;不存在/目录 = ABSENT。 */
export async function fileFingerprint(rootDir: string, relPath: string): Promise<string> {
  try {
    const bytes = await readFile(join(rootDir, ...relPath.split('/')))
    return fingerprint(bytes)
  } catch {
    return ABSENT
  }
}

/**
 * 探测 SDK 目录版本:先看目录名本身(renpy-8.5.3 / …/renpy-8.5.3-sdk),
 * 再看一层子项名。探测不到返回 undefined(宁缺勿错)。
 */
export async function detectSdkVersion(sdkDir: string): Promise<string | undefined> {
  const fromSelf = /\d+\.\d+\.\d+/.exec(sdkDir.split(/[\\/]/).pop() ?? '')?.[0]
  if (fromSelf !== undefined) return fromSelf
  try {
    const entries = await readdir(sdkDir)
    const hint = entries.find((name) => /renpy-\d+\.\d+\.\d+/.test(name))
    return hint === undefined ? undefined : /\d+\.\d+\.\d+/.exec(hint)?.[0]
  } catch {
    return undefined
  }
}
