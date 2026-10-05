import { type ReactNode, useEffect, useRef, useState } from 'react'
import { usePreference } from './ui-preferences'

type PanelMode = 'rail' | 'pinned' | 'hidden'
const isMode = (value: unknown): value is PanelMode => value === 'rail' || value === 'pinned' || value === 'hidden'

/** Hover is purely visual: it never activates an Agent or remounts panel children. */
export default function CollapsiblePanel({ name, storageId, children, keepOpen = false, badge = 0 }: {
  name: string; storageId: string; children: ReactNode; keepOpen?: boolean; badge?: number
}): JSX.Element {
  const [mode, setMode] = usePreference<PanelMode>(`agent-tui-manager:panel:${storageId}:v1`, 'rail', isMode)
  const [revealed, setRevealed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const hovering = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const clearTimer = (): void => { if (timer.current) clearTimeout(timer.current); timer.current = undefined }
  useEffect(() => () => clearTimer(), [])
  const hideLater = (): void => {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!hovering.current && !root.current?.contains(document.activeElement)) setRevealed(false)
    }, 220)
  }
  const expanded = mode === 'pinned' || revealed || keepOpen
  return <div ref={root} className={`collapsible-panel panel-${storageId} panel-${mode}${expanded ? ' panel-expanded' : ''}`}
    data-panel={storageId} data-mode={mode}
    onMouseEnter={() => { hovering.current = true; clearTimer(); timer.current = setTimeout(() => setRevealed(true), 100) }}
    onMouseLeave={() => { hovering.current = false; hideLater() }}
    onFocusCapture={() => { clearTimer(); setRevealed(true) }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideLater() }}
    onKeyDown={(event) => { if (event.key === 'Escape' && mode !== 'pinned') { clearTimer(); setRevealed(false); (document.activeElement as HTMLElement | null)?.blur() } }}>
    <button type='button' className='panel-reveal-handle' aria-label={`展开${name}`} aria-expanded={expanded}
      onClick={() => setRevealed(true)} title={`展开${name}`}>›{badge > 0 && <i>{badge}</i>}</button>
    <div className='panel-surface'>
      <header className='panel-toolbar'><span className='panel-label'>{name}</span>
        <button type='button' title={mode === 'pinned' ? `收起${name}` : `固定${name}`} aria-label={mode === 'pinned' ? `收起${name}` : `固定${name}`} aria-pressed={mode === 'pinned'} onClick={() => setMode(mode === 'pinned' ? 'rail' : 'pinned')}>{mode === 'pinned' ? '«' : '⌖'}</button>
        <button type='button' className='panel-label' title={`隐藏${name}`} aria-label={`隐藏${name}`} onClick={() => { setMode('hidden'); setRevealed(false); (document.activeElement as HTMLElement | null)?.blur() }}>‹</button>
        {mode === 'hidden' && <button type='button' aria-label={`显示${name}图标栏`} title='显示图标栏' onClick={() => setMode('rail')}>▥</button>}
      </header>
      {children}
    </div>
  </div>
}
