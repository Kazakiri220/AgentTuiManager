import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { AgentKind } from '../src/shared/manager-api'
import { parseNetworkRetry, type NetworkRetrySettings } from '../src/shared/network-retry'
import type { AgentLaunchOverrides } from './agent-launch-profile'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// 解析全局或 Profile 当前选中的 Provider，不改变路由、认证或原生会话的 Provider 身份。
export function retryProviderIds(configText: string, args: string[]): string[] {
  const config = object(parseToml(configText))
  let profile = typeof config.profile === 'string' ? config.profile : undefined
  let explicitProvider: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--profile' || arg === '-p') profile = args[++i]
    else if (arg.startsWith('--profile=')) profile = arg.slice(10)
    else {
      const override = arg === '-c' || arg === '--config' ? args[++i] : arg.startsWith('--config=') ? arg.slice(9) : arg.startsWith('-c=') ? arg.slice(3) : undefined
      if (!override) continue
      const match = /^model_provider\s*=\s*(.*)$/.exec(override)
      if (match) {
        try { explicitProvider = String(parseToml(`value=${match[1]}`).value) }
        catch { explicitProvider = match[1]!.trim() }
      }
    }
  }
  const selected = explicitProvider ?? object(object(config.profiles)[profile ?? '']).model_provider ?? config.model_provider ?? 'openai'
  if (typeof selected !== 'string' || !selected.trim()) throw new Error('无法确定 Codex Provider，未应用重试配置')
  const builtins = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime'])
  // Codex 拒绝覆盖保留的内置 Provider。独立地址会由 applyAgentLaunchProfile
  // 分配完整的命名 Provider，因此重试配置仍只作用于当前进程。
  if (builtins.has(selected)) return []
  return [selected]
}

export function applyNetworkRetry(agentKind: AgentKind, args: string[], value: NetworkRetrySettings | undefined, configText = ''): AgentLaunchOverrides {
  const settings = parseNetworkRetry(value)
  const environment: Record<string, string> = {}
  if (!settings) return { args: [...args], environment }
  if (agentKind === 'claude') {
    if (settings.claudeRequestRetries !== undefined) environment.CLAUDE_CODE_MAX_RETRIES = String(settings.claudeRequestRetries)
    if (settings.claudeRetryWatchdog !== undefined) environment.CLAUDE_CODE_RETRY_WATCHDOG = settings.claudeRetryWatchdog ? '1' : '0'
  }
  if (agentKind !== 'codex' || (settings.codexStreamRetries === undefined && settings.codexRequestRetries === undefined)) return { args: [...args], environment }
  const overrides: string[] = []
  for (const providerId of retryProviderIds(configText, args)) {
    // Codex 按点号拆分 -c 路径，此处不会把 TOML 引号解析为键名语法。
    // 给 custom 加引号会创建另一个无名称 Provider，而不是更新原 Provider。
    // 包含点号的 ID 无法通过这个 CLI 参数入口安全定位。
    if (providerId.includes('.')) throw new Error('当前 Codex Provider ID 包含点号，无法通过启动参数安全设置重试次数；请将重试次数留空，或在原生配置中设置。')
    const path = `model_providers.${providerId}`
    if (settings.codexStreamRetries !== undefined) overrides.push('-c', `${path}.stream_max_retries=${settings.codexStreamRetries}`)
    if (settings.codexRequestRetries !== undefined) overrides.push('-c', `${path}.request_max_retries=${settings.codexRequestRetries}`)
  }
  const resume = args.indexOf('resume')
  const insertion = resume < 0 ? args.length : resume
  return { args: [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)], environment }
}

export async function resolveNetworkRetry(agentKind: AgentKind, args: string[], settings?: NetworkRetrySettings): Promise<AgentLaunchOverrides> {
  let config = ''
  if (agentKind === 'codex' && (settings?.codexStreamRetries !== undefined || settings?.codexRequestRetries !== undefined)) {
    try { config = await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return applyNetworkRetry(agentKind, args, settings, config)
}
