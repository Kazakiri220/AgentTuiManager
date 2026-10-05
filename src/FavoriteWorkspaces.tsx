import { useState } from 'react'
import { readPreference } from './ui-preferences'

export interface FavoriteWorkspace { id: string; name: string; path: string }
export const FAVORITE_WORKSPACES_KEY = 'agent-tui-manager:favorite-workspaces:v1'
export function isAbsoluteWorkspace(path: string, platform: string): boolean {
  return platform === 'win32' ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(path) : path.startsWith('/')
}
function isFavorites(value: unknown): value is FavoriteWorkspace[] {
  return Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string')
}

export default function FavoriteWorkspaces({ workspace, disabled, onSelect }: { workspace: string; disabled: boolean; onSelect: (path: string) => void }): JSX.Element {
  const [items, setItems] = useState(() => readPreference<FavoriteWorkspace[]>(FAVORITE_WORKSPACES_KEY, [], isFavorites))
  const [managing, setManaging] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [choosing, setChoosing] = useState(false)
  const persist = (next: FavoriteWorkspace[]): boolean => {
    try { window.localStorage.setItem(FAVORITE_WORKSPACES_KEY, JSON.stringify(next)); setItems(next); setError(''); return true }
    catch { setError('常用工作区保存失败，请检查本地存储是否可用'); return false }
  }
  const reset = (): void => { setEditingId(undefined); setName(''); setPath('') }
  const save = (): void => {
    const normalized = path.trim()
    if (!name.trim() || name.trim().length > 80 || normalized.length > 4096 || !isAbsoluteWorkspace(normalized, window.agentManager.platform)) {
      setError('请填写名称（最多 80 字）和完整工作区路径'); return
    }
    if (!editingId && items.length >= 100) { setError('最多保存 100 个常用工作区'); return }
    const item = { id: editingId ?? crypto.randomUUID(), name: name.trim(), path: normalized }
    if (persist(editingId ? items.map(old => old.id === editingId ? item : old) : [...items, item])) reset()
  }
  const choose = async (): Promise<void> => {
    setChoosing(true); setError('')
    try { const selected = await window.agentManager.chooseWorkspace(); if (selected) { setPath(selected); if (!name.trim()) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? selected) } }
    catch { setError('无法打开文件夹选择器，请直接填写完整路径') }
    finally { setChoosing(false) }
  }
  return <section className='favorite-workspaces' aria-label='常用工作区'>
    <div className='favorite-workspaces-heading'><strong>常用工作区</strong><button type='button' className='button-secondary mini-button' disabled={disabled} aria-expanded={managing} onClick={() => { setManaging(!managing); setError(''); if (!managing && !editingId) setPath(workspace) }}>{managing ? '收起管理' : '管理列表'}</button></div>
    <div className='favorite-workspace-chips'>{items.map(item => <button type='button' key={item.id} disabled={disabled} title={item.path} aria-pressed={workspace === item.path} onClick={() => onSelect(item.path)}>{item.name}</button>)}{items.length === 0 && <span>保存常用项目，下次一键填入</span>}</div>
    {managing && <div className='favorite-workspace-manager' onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); if (!disabled) save() } }}>
      {items.map(item => <div className='favorite-workspace-row' key={item.id}><span title={item.path}><strong>{item.name}</strong><small>{item.path}</small></span><button type='button' disabled={disabled} aria-label={`编辑工作区 ${item.name}`} onClick={() => { setEditingId(item.id); setName(item.name); setPath(item.path); setError('') }}>编辑</button><button type='button' disabled={disabled} aria-label={`移除工作区 ${item.name}`} onClick={() => { if (persist(items.filter(old => old.id !== item.id)) && editingId === item.id) reset() }}>移除</button></div>)}
      <label>工作区名称<input className='launcher-field' maxLength={80} value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder='例如：趋势分析' /></label>
      <label>工作区路径<div className='workspace-picker'><input className='launcher-field' value={path} disabled={disabled} onChange={event => setPath(event.target.value)} placeholder='完整目录路径' /><button type='button' disabled={disabled || choosing} onClick={() => { void choose() }}>浏览</button></div></label>
      <div className='favorite-workspace-actions'><small>移除仅删除快捷记录；启动时检查目录。</small>{editingId && <button type='button' onClick={reset}>取消编辑</button>}<button type='button' disabled={disabled || !name.trim() || !path.trim()} onClick={save}>{editingId ? '保存工作区' : '添加工作区'}</button></div>
    </div>}
    {error && <p role='alert' className='launcher-state error'>{error}</p>}
  </section>
}
