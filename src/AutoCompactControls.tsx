import type { AgentKind } from './shared/manager-api'

export default function AutoCompactControls({ kind, value, onChange }: {
  kind: AgentKind; value?: number; onChange: (tokens: number | undefined) => void
}): JSX.Element | null {
  if (kind !== 'codex' && kind !== 'claude') return null
  return <div className='launcher-proxy-section'>
    <div className='launcher-section-title'><h2>自动压缩上下文</h2><span>仅当前窗口 · 下次启动生效</span></div>
    <div className='launcher-config-form'><label>自动压缩阈值（K Tokens）<input className='launcher-field'
      type='number' min={kind === 'claude' ? 100 : 1} max={1000} step={1}
      placeholder='留空继承全局设置' value={value === undefined ? '' : value / 1000}
      onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value) * 1000)}
    /></label></div>
    <div className='launcher-config-security'><strong>默认继承全局</strong><span>100 表示 100,000 Tokens。留空不追加参数，不修改本机配置或模型上下文长度。保存后重启生效。
      {kind === 'claude' ? ' Claude Code 使用 --autocompact，范围 100K–1M；最终受模型上限约束，全局环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW 的优先级更高，关闭自动压缩的全局设置不会被强制开启。需 CLI 支持该参数。' : ' Codex 使用 -c model_auto_compact_token_limit；超过模型可用窗口不会扩大上下文。'}
    </span></div>
  </div>
}
