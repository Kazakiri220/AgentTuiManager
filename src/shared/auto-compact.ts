import type { AgentKind } from './manager-api'

export function parseAutoCompactTokens(value: unknown, kind?: AgentKind): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000 || value > 1_000_000) {
    throw new Error('自动压缩阈值必须为 1,000–1,000,000 的整数 Token 数')
  }
  if (kind === 'claude' && value < 100_000) throw new Error('Claude Code 自动压缩窗口最小为 100,000 Tokens')
  if (kind && kind !== 'claude' && kind !== 'codex') throw new Error('该 Agent 暂不支持自定义自动压缩阈值')
  return value
}

/** 放在其他覆盖参数之后，但不能越过 CLI 提示词分隔符。 */
export function autoCompactArgs(kind: AgentKind, args: string[], value?: number): string[] {
  const tokens = parseAutoCompactTokens(value, kind)
  if (tokens === undefined) return [...args]
  const overrides = kind === 'claude' ? ['--autocompact', String(tokens)] : ['-c', `model_auto_compact_token_limit=${tokens}`]
  const separator = args.indexOf('--')
  // Codex 配置保留在根命令作用域，与独立 Provider 和 Hook 接入保持一致。
  // 新会话将配置追加到全部选项之后。
  const resume = kind === 'codex' ? args.indexOf('resume') : -1
  const insertion = Math.min(separator < 0 ? args.length : separator, resume < 0 ? args.length : resume)
  return [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
}
