import { useEffect, useRef, useState } from 'react'
import type { ExecutionMode } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import './ExecutionModePicker.css'

const MODES: { id: ExecutionMode; label: string; key: string }[] = [
  { id: 'planning', label: 'Planning', key: '1' },
  { id: 'fast', label: 'Fast', key: '2' }
]

// The per-conversation Planning/Fast control (design 3.2). Chosen when the
// conversation starts; locked once the first turn has run. The lock here is
// honest UI only -- the store mirror refuses the action and main enforces it
// authoritatively (ipc.ts set-execution-mode throws once events exist).
// NOT a permission control: the ModePicker beside it owns permissions.
export function ExecutionModePicker(): React.JSX.Element {
  const mode = useAppStore((s) => s.executionMode)
  const setMode = useAppStore((s) => s.setExecutionMode)
  const isConversation = useAppStore((s) => s.view.kind === 'conversation')
  const convo = useAppStore((s) =>
    s.view.kind === 'conversation' ? s.conversations[s.view.id] : undefined
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  // Fail closed, matching the store mirror: an unloaded conversation counts
  // as locked. On Home there is no conversation yet, so never locked.
  const locked = isConversation && (!convo || !convo.loaded || convo.events.length > 0)

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (['1', '2'].includes(e.key)) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        const picked = MODES.find((m) => m.key === e.key)
        if (picked) {
          setMode(picked.id)
          setOpen(false)
        }
      }
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setMode])

  return (
    <div className="exec-mode-picker" ref={rootRef}>
      <Hint
        label={locked ? 'Execution mode locks once the first turn runs' : 'Execution mode'}
        side="top"
        disabled={open}
      >
        <button
          className={'pill-btn' + (locked ? ' locked' : '')}
          aria-disabled={locked}
          onClick={() => {
            if (locked) return
            setOpen((o) => !o)
          }}
        >
          <span>{current.label}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      {open ? (
        <div className="menu exec-mode-menu">
          <div className="menu-group-label">Execution</div>
          {MODES.map((m) => (
            <div
              key={m.id}
              className={'menu-item' + (m.id === mode ? ' selected' : '')}
              onClick={() => {
                setMode(m.id)
                setOpen(false)
              }}
            >
              <span className="mode-label">{m.label}</span>
              <span className="mode-key">{m.key}</span>
              <span className="check">✓</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
