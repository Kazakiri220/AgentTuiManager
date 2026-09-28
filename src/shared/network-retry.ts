export interface NetworkRetrySettings {
  codexStreamRetries?: number
  codexRequestRetries?: number
  claudeRequestRetries?: number
  claudeRetryWatchdog?: boolean
}

export function parseNetworkRetry(value: unknown): NetworkRetrySettings | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('网络重试配置格式无效')
  const input = value as Record<string, unknown>
  const result: NetworkRetrySettings = {}
  if (input.claudeRetryWatchdog !== undefined) {
    if (typeof input.claudeRetryWatchdog !== 'boolean') throw new Error('长重试开关格式无效')
    result.claudeRetryWatchdog = input.claudeRetryWatchdog
  }
  for (const key of ['codexStreamRetries', 'codexRequestRetries', 'claudeRequestRetries'] as const) {
    const number = input[key]
    if (number === undefined) continue
    const max = key === 'claudeRequestRetries' ? (result.claudeRetryWatchdog === true ? 1000 : 15) : 100
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > max) {
      throw new Error(`${key} 必须为 0–${max} 的整数`)
    }
    result[key] = number
  }
  return Object.keys(result).length ? result : undefined
}
