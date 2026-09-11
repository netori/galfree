/** 领域错误:code 是接缝契约的一部分(调用方按 code 分支,不解析 message)。 */
export class GalfreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'GalfreeError'
  }
}
