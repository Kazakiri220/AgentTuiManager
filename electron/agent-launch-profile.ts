import type { AgentKind } from '../src/shared/manager-api'
import type { StoredAgentConfig } from './agent-configuration-store'
import type { CodexGlobalProvider } from './codex-global-config'

export interface AgentLaunchOverrides {
  environment: Record<string, string>
  args: string[]
}

const CODEX_API_KEY_ENV = 'AGENT_TUI_MANAGER_CODEX_API_KEY'
const ISOLATED_CODEX_PROVIDER_ID = 'agent-tui-manager'

function providerPathSegment(providerId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(providerId) ? providerId : JSON.stringify(providerId)
}

function codexProviderArguments(profile: StoredAgentConfig, provider: CodexGlobalProvider): string[] {
  if (!profile.baseUrl && !profile.apiKey) return []
  if (provider.id === 'openai' && !provider.configurable) {
    if (profile.baseUrl) {
      const path = `model_providers.${ISOLATED_CODEX_PROVIDER_ID}`
      return [
        '-c', `model_provider=${ISOLATED_CODEX_PROVIDER_ID}`,
        '-c', `${path}.name=${JSON.stringify('Agent TUI Manager')}`,
        '-c', `${path}.base_url=${JSON.stringify(profile.baseUrl)}`,
        ...(profile.apiKey ? ['-c', `${path}.env_key=${CODEX_API_KEY_ENV}`] : []),
        '-c', `${path}.wire_api=responses`,
        '-c', `${path}.requires_openai_auth=false`,
      ]
    }
    return [
      '-c', 'model_provider=openai',
    ]
  }
  if (!provider.configurable) {
    throw new Error(`本机 Codex Provider “${provider.id}”是内置项，不能安全覆盖独立 Base URL 或 API Key。请先在 Codex 配置中选择一个命名的自定义 Provider。`)
  }
  const path = `model_providers.${providerPathSegment(provider.id)}`
  return [
    '-c', `model_provider=${provider.id}`,
    ...(profile.baseUrl ? ['-c', `${path}.base_url=${profile.baseUrl}`] : []),
    ...(profile.apiKey ? ['-c', `${path}.env_key=${CODEX_API_KEY_ENV}`] : []),
    '-c', `${path}.wire_api=responses`,
    '-c', `${path}.requires_openai_auth=false`,
  ]
}

function withoutModelArgument(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value === '--model' || value === '-m') {
      index += 1
      continue
    }
    if (value.startsWith('--model=')) continue
    result.push(value)
  }
  return result
}

function configuredArgs(agentKind: AgentKind, baseArgs: string[], profile: StoredAgentConfig, codexProvider: CodexGlobalProvider): string[] {
  const args = profile.model && (agentKind === 'codex' || agentKind === 'claude')
    ? withoutModelArgument(baseArgs)
    : [...baseArgs]
  const overrides = [
    ...profile.extraArgs,
    ...(agentKind === 'codex' ? codexProviderArguments(profile, codexProvider) : []),
    ...(profile.model && (agentKind === 'codex' || agentKind === 'claude') ? ['--model', profile.model] : []),
  ]
  if (overrides.length === 0) return args
  if (agentKind === 'codex') {
    const resumeIndex = args.indexOf('resume')
    // Provider 和模型覆盖必须留在根命令。放到 `resume <id>` 之后会改变
    // Codex 配置作用域，可能导致会话级 PermissionRequest Hook 无法处理审批。
    // 用户填写的恢复参数已包含在 baseArgs 中，仍保留在会话 ID 之后。
    const insertion = resumeIndex >= 0 ? resumeIndex : args.length
    return [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
  }
  if (agentKind === 'claude') {
    const resumeIndex = args.findIndex((value) => value === '--resume' || value.startsWith('--resume='))
    const insertion = resumeIndex >= 0 ? resumeIndex : args.length
    return [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
  }
  return [...args, ...overrides]
}

export function applyAgentLaunchProfile(
  agentKind: AgentKind,
  baseArgs: string[],
  profile: StoredAgentConfig,
  codexProvider: CodexGlobalProvider = { id: 'openai', configurable: false },
): AgentLaunchOverrides {
  const environment: Record<string, string> = {}
  if (agentKind === 'claude') {
    // Claude Code 启动后可能从 ~/.claude/settings.json 加载 Provider 路由变量。
    // Host 托管模式阻止这些设置替换当前 PTY 显式指定的 Provider，同时不修改原文件。
    if (profile.baseUrl || profile.apiKey) {
      environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      environment.CLAUDE_CODE_USE_BEDROCK = ''
      environment.CLAUDE_CODE_USE_VERTEX = ''
      environment.CLAUDE_CODE_USE_FOUNDRY = ''
      environment.CLAUDE_CODE_OAUTH_TOKEN = ''
    }
    if (profile.baseUrl) environment.ANTHROPIC_BASE_URL = profile.baseUrl
    if (profile.apiKey) {
      const officialAnthropic = !profile.baseUrl || (() => {
        try { return new URL(profile.baseUrl).hostname.toLowerCase() === 'api.anthropic.com' } catch { return false }
      })()
      // 自定义 Claude 网关（包括常见 CCSwitch 布局）使用 Authorization Token，
      // Anthropic 官方端点使用 x-api-key。
      environment.ANTHROPIC_AUTH_TOKEN = officialAnthropic ? '' : profile.apiKey
      environment.ANTHROPIC_API_KEY = officialAnthropic ? profile.apiKey : ''
    }
  } else if (agentKind === 'codex') {
    // config.toml 已指定自定义 Provider 时，Codex 根据 model_provider 选择端点，
    // 而不是读取 OPENAI_BASE_URL。上面的临时 -c 只为当前进程选择 Provider，
    // 密钥仅通过该 Provider 的 env_key 传入。
    if (profile.apiKey) {
      const isolatedProvider = codexProvider.id === 'openai' && !codexProvider.configurable && Boolean(profile.baseUrl)
      environment[isolatedProvider ? CODEX_API_KEY_ENV : codexProvider.id === 'openai' && !codexProvider.configurable ? 'OPENAI_API_KEY' : CODEX_API_KEY_ENV] = profile.apiKey
    }
  } else if (agentKind === 'deepseek') {
    // DeepSeek Harness 每次请求都会解析这些官方变量。dsh 没有模型 CLI 参数，
    // 因此模型仍在它自己的 Web 设置中选择。
    if (profile.baseUrl) environment.DEEPSEEK_BASE_URL = profile.baseUrl
    if (profile.apiKey) environment.DEEPSEEK_API_KEY = profile.apiKey
  } else {
    if (profile.baseUrl) environment.OPENAI_BASE_URL = profile.baseUrl
    if (profile.apiKey) environment.OPENAI_API_KEY = profile.apiKey
    if (profile.model) environment.OPENAI_MODEL = profile.model
  }
  return { environment, args: configuredArgs(agentKind, baseArgs, profile, codexProvider) }
}
