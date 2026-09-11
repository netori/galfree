/**
 * 真实现端口(Host 装配用):https 下载(带进度)+ extract-zip 解压。
 * 快测不加载这里(用假端口);慢集成带与生产运行时才走真网络。
 */
import { get } from 'node:https'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { GalfreeError } from './error.ts'
import type { Downloader, Extractor } from './sdk-provision.ts'

export const httpsDownloader: Downloader = (url, onBytes, signal) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const request = get(url, { headers: { 'user-agent': 'dsh-galfree' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume()
        httpsDownloader(response.headers.location, onBytes, signal).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new GalfreeError('download-http', `下载失败 HTTP ${status}:${url}`))
        return
      }
      const total = Number(response.headers['content-length'] ?? 0)
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        received += chunk.length
        onBytes(received, total)
      })
      response.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
      response.on('error', reject)
    })
    request.on('error', reject)
    signal?.addEventListener('abort', () => {
      request.destroy(new GalfreeError('aborted', '下载被取消'))
    })
  })

/**
 * 解压:extract-zip 到临时目录;若产物是单一顶层目录(如 renpy-8.5.3/),
 * 把该顶层目录的内容搬到 destDir,保证启动器就在 destDir 下。
 */
export const extractZip: Extractor = async (bytes, destDir) => {
  const { default: extract } = await import('extract-zip')
  const work = await mkdtemp(join(tmpdir(), 'galfree-sdk-'))
  const zipPath = join(work, 'sdk.zip')
  try {
    await writeFileBuffer(zipPath, bytes)
    const unpack = join(work, 'unpacked')
    await extract(zipPath, { dir: unpack })
    const entries = await readdir(unpack, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory())
    if (entries.length === 1 && dirs.length === 1) {
      // 单一顶层目录:提升到 destDir。
      await rename(join(unpack, dirs[0]!.name), destDir)
    } else {
      await rename(unpack, destDir)
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeFileBuffer(path: string, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path)
    stream.on('error', reject)
    stream.on('close', resolve)
    stream.end(Buffer.from(bytes))
  })
}

/** 平台启动器文件名。 */
export function platformLauncherName(): string {
  return process.platform === 'win32' ? 'renpy.exe' : 'renpy.sh'
}

/** 在 SDK 目录里找启动器(允许一层嵌套)。 */
export async function findLauncher(sdkDir: string): Promise<string | null> {
  const name = platformLauncherName()
  const direct = join(sdkDir, name)
  try {
    const info = await stat(direct)
    if (info.isFile()) return direct
  } catch { /* not here */ }
  try {
    for (const entry of await readdir(sdkDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(sdkDir, entry.name, name)
      try {
        const info = await stat(nested)
        if (info.isFile()) return nested
      } catch { /* keep looking */ }
    }
  } catch { /* missing dir */ }
  return null
}

export { basename }
