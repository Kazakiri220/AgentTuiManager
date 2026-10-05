import { useEffect, useState } from 'react'
import type { NativeSessionSummary, SessionSummary } from './shared/manager-api'

export default function SessionBindingDialog({ session, mode, onClose, onChanged }: {
  session: SessionSummary; mode: 'history' | 'fresh'; onClose: () => void; onChanged: () => void
}): JSX.Element {
  const [items, setItems] = useState<NativeSessionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(mode === 'history')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (mode !== 'history') return
    let active = true
    setLoading(true); setError(''); setSelected('')
    void (async () => {
      try {
        if (!window.agentManager.listBindingSessions) throw new Error('请重启 Manager 后使用')
        const result = await window.agentManager.listBindingSessions(session.sessionId)
        if (active) setItems(result)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [session.sessionId, mode, revision])
  const submit = async () => {
    setBusy(true); setError('')
    try {
      if (!window.agentManager.replaceSessionBinding) throw new Error('请重启 Manager 后使用')
      await window.agentManager.replaceSessionBinding(session.sessionId, mode === 'fresh' ? null : selected)
      onChanged(); onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const filtered = items.filter(item => `${item.managerDisplayName ?? ''} ${item.title} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className='launcher-scrim' role='presentation' onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
    <section className='agent-launcher session-continuation-dialog' role='dialog' aria-modal='true' aria-labelledby='binding-heading'>
      <header className='launcher-head'><h1 id='binding-heading'>{mode === 'fresh' ? '按原配置开启新会话' : '选择历史会话'}</h1><button type='button' className='icon-button' disabled={busy} onClick={onClose} aria-label='关闭会话切换'>×</button></header>
      <div className='launcher-content'><section className='launcher-panel'>
        <div className='launcher-config-intro'><strong>{session.displayName}</strong><span>{session.workspace}</span></div>
        <p>保留窗口名称、独立配置、模型、代理、重试和压缩设置。不删除任何原生对话文件。</p>
        {session.status === 'needs_attention' && <p>确认后先停止当前异常进程，再启动所选会话。</p>}
        <p>切换后关闭全自动和无监管，关键词续跑暂停到你首次提交输入。请确认会话正确后再开启自动模式。</p>
        {mode === 'fresh' ? <p>确认后清除旧会话绑定并启动空会话，不携带旧对话上下文。也可在新终端中手动使用 /resume 查找历史。</p> : <>
          <div className='launcher-section-title'><h2>当前目录的会话</h2><button type='button' className='button-secondary' disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>刷新</button></div>
          <input className='launcher-field' aria-label='搜索历史会话' placeholder='搜索名称或会话 ID' value={search} onChange={event => setSearch(event.target.value)} />
          {loading ? <p>正在检查对话文件…</p> : <div className='launcher-session-list'>{filtered.map(item => <button type='button' disabled={busy} className={`launcher-session-item${selected === item.id ? ' active' : ''}`} aria-pressed={selected === item.id} key={item.id} onClick={() => setSelected(item.id)}><span><strong>{item.managerDisplayName ?? item.title}</strong><small>{item.id}</small></span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}{!filtered.length && <p>该目录没有匹配的有效对话。可取消后按原配置开启新会话。</p>}</div>}
        </>}
        {error && <p className='launcher-error' role='alert'>{error}</p>}
      </section></div>
      <footer className='launcher-foot'><span>仅替换 Manager 绑定</span><button type='button' className='button-secondary' disabled={busy} onClick={onClose}>取消</button>{mode === 'history' && <button type='button' className='button-secondary' disabled={busy} onClick={() => { if (!window.agentManager.restartSession) return; setBusy(true); void window.agentManager.restartSession(session.sessionId).then(() => { onChanged(); onClose() }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)) }}>继续重试</button>}{mode === 'history' && <button type='button' className='button-secondary' disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await window.agentManager.replaceSessionBinding?.(session.sessionId, null); onChanged(); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }}>按原配置开启新会话</button>}<button type='button' className='button-primary' disabled={busy || (mode === 'history' && (loading || !selected))} onClick={() => void submit()}>{busy ? '正在切换…' : mode === 'fresh' ? '确认开启新会话' : '关联并启动'}</button></footer>
    </section>
  </div>
}
