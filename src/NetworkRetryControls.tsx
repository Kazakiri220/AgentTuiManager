import type { AgentKind } from './shared/manager-api'
import type { NetworkRetrySettings } from './shared/network-retry'

export default function NetworkRetryControls({ agentKind, value, onChange }: {
  agentKind: AgentKind
  value: NetworkRetrySettings
  onChange: (value: NetworkRetrySettings) => void
}): JSX.Element | null {
  if (agentKind !== 'codex' && agentKind !== 'claude') return null
  const count = (key: 'codexStreamRetries' | 'codexRequestRetries' | 'claudeRequestRetries', label: string, max: number) => <label>{label}<input
    className='launcher-field' type='number' min={0} max={max} step={1}
    value={value[key] ?? ''} placeholder='留空继承 CLI'
    onChange={(event) => onChange({ ...value, [key]: event.target.value === '' ? undefined : Number(event.target.value) })}
  /></label>
  return <div className='launcher-proxy-section'>
    <div className='launcher-section-title'><h2>网络断线重试</h2><span>仅当前 Agent · 下次启动生效</span></div>
    <div className='launcher-config-form'>
      {agentKind === 'codex' ? <>
        {count('codexStreamRetries', '流式断线重连次数（0–100）', 100)}
        {count('codexRequestRetries', 'HTTP 请求重试次数（0–100）', 100)}
      </> : <>
        <label>长重试模式<select className='launcher-field' value={value.claudeRetryWatchdog === undefined ? 'inherit' : String(value.claudeRetryWatchdog)} onChange={(event) => {
          const watchdog = event.target.value === 'inherit' ? undefined : event.target.value === 'true'
          onChange({ ...value, claudeRetryWatchdog: watchdog, ...(watchdog !== true && (value.claudeRequestRetries ?? 0) > 15 ? { claudeRequestRetries: 15 } : {}) })
        }}><option value='inherit'>继承 CLI</option><option value='false'>关闭</option><option value='true'>开启（Retry Watchdog）</option></select></label>
        {count('claudeRequestRetries', `请求重试次数（0–${value.claudeRetryWatchdog ? 1000 : 15}）`, value.claudeRetryWatchdog ? 1000 : 15)}
      </>}
    </div>
    <div className='launcher-config-security'><strong>与无监管恢复分开</strong><span>留空不覆盖原生设置；不修改全局配置，也不更改独立配置的地址、密钥或模型。0 表示不重试。
      {agentKind === 'codex' ? ' Codex 默认流式 5 次、请求 4 次；独立 Base URL 会使用当前窗口的命名 Provider。直接继承内置 openai 等 Provider 时无法覆盖，将继续使用 CLI 默认值。' : ' Claude Code 默认通常为 10 次；新版普通模式上限 15。长重试需 CLI 支持，开启后容量错误可能无限重试，次数并非总上限。'}
    </span></div>
  </div>
}
