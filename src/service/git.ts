/**
 * git 子进程薄封装:固定 GALFree 身份,显式 -c 屏蔽用户全局配置差异。
 * 快照(ADR-0011)与模板初始化共用。**永不 push。**
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const SNAPSHOT_IDENTITY = { name: 'GALFree', email: 'galfree@dsh.local' } as const

/** 以 GALFree 身份执行 git 命令;返回 stdout(trim)。stderr 抛进异常信息。 */
export async function runGit(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await runGitRaw(repoDir, args, env)).trim()
}

/** 同上,但保留原始字节(用于 git show 取文件内容等不能丢行尾的场景)。 */
export async function runGitRaw(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const prefixed = ['-C', repoDir,
    '-c', `user.name=${SNAPSHOT_IDENTITY.name}`,
    '-c', `user.email=${SNAPSHOT_IDENTITY.email}`,
    '-c', 'commit.gpgSign=false',
    '-c', 'core.autocrlf=false',
    ...args]
  const { stdout } = await exec('git', prefixed, { env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}
