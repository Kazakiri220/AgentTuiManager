import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { trapDialogTab } from './dialog-focus'
import { DEFAULT_TERMINAL_SETTINGS, type CodexTerminalMode, type TerminalSettings } from './shared/terminal-settings'

export default function TerminalSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<TerminalSettings>({ ...DEFAULT_TERMINAL_SETTINGS })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLFormElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    dialog.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let mounted = true
    void window.agentManager.getTerminalSettings().then(value => {
      if (mounted) { setSettings(value); setLoaded(true) }
    }).catch(reason => { if (mounted) setError(String(reason instanceof Error ? reason.message : reason)) })
    return () => { mounted = false }
  }, [])
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!loaded || busy) return
    setBusy(true); setError('')
    try { await window.agentManager.updateTerminalSettings(settings); onClose() }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setBusy(false) }
  }
  return <div className='modal-backdrop' role='presentation'>
    <form ref={dialog} tabIndex={-1} className='rules-dialog terminal-settings-dialog' role='dialog' aria-modal='true' aria-labelledby='terminal-settings-title'
      onSubmit={event => { void save(event) }} onKeyDown={event => {
        trapDialogTab(event, dialog.current)
        if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
      }}>
      <header><div><span className='eyebrow'>TERMINAL</span><h2 id='terminal-settings-title'>终端显示模式</h2></div><button type='button' className='icon-button' onClick={onClose} disabled={busy} aria-label='关闭终端设置'>×</button></header>
      <div className='terminal-settings-body'>
        <p className='rules-help'>保存后用于新建、重启和恢复的 Codex 会话。正在运行的会话保持当前模式；Claude Code 等其他 Agent 不受影响。</p>
        <fieldset disabled={!loaded || busy}>
          <label htmlFor='codex-terminal-mode'>Codex 显示方式</label>
          <select id='codex-terminal-mode' value={settings.codexMode} onChange={event => setSettings({ codexMode: event.target.value as CodexTerminalMode })}>
            <option value='scrollback'>滚动历史模式（默认）</option>
            <option value='native-fullscreen'>Codex 原生全屏模式</option>
          </select>
        </fieldset>
        {settings.codexMode === 'scrollback'
          ? <p className='field-note'>沿用当前显示方式，通过终端滚动条浏览输出历史。鼠标选中的是终端显示文字，不能直接修改底部输入。</p>
          : <><p className='field-note'>Codex 填满当前 Agent 面板，并管理历史滚动。新版 Codex 支持在底部未发送的输入中点击定位、拖选、复制、删除和粘贴。</p><p className='field-note'>Ctrl+C 复制输入选区，Ctrl+V 粘贴，Delete 删除选区。没有输入选区时 Ctrl+C 仍会中断。按住 Shift 拖选可复制终端显示文字。已验证 Codex 0.159.2；该版本不支持 Ctrl+X 剪切鼠标选区。此模式不改变 Agent 面板大小。</p></>}
        {!loaded && !error && <p role='status'>正在读取设置…</p>}
        {error && <p className='form-error' role='alert'>{error}</p>}
      </div>
      <footer><button type='button' className='button-secondary' disabled={busy} onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={!loaded || busy}>{busy ? '保存中…' : '保存设置'}</button></footer>
    </form>
  </div>
}
