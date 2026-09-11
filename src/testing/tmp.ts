/** Shared helpers for seam tests (temp dirs; real fs, real git). */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a temp working directory tracked for cleanup. */
export async function makeTempDir(prefix = 'galfree-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const tempDirs: string[] = []

/** Remove every temp dir created by makeTempDir in this process. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0, tempDirs.length)
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
}
