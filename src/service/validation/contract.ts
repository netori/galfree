/**
 * 校验回路契约(T1 最小形态,T4 成文扩展)。
 * 结果对象是接缝状态的一部分:任何验证器(假/真 SDK)都产出同一形状。
 */
export interface ValidationProblem {
  severity: 'error' | 'warning'
  /** 相对项目根的路径。 */
  file: string
  line?: number
  code: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  problems: ValidationProblem[]
  /** 验证器标识:fake = 假验证器(快测), sdk = 真钉版 SDK(T5 起)。 */
  validator: 'fake' | 'sdk'
  /** ISO 时间戳。 */
  at: string
  /** 真 SDK 适配器附加信息(钉版号 / 覆盖路径版本差异警告);假验证器省略。 */
  sdkNote?: string
}
