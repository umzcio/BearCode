import { useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import './ModePicker.css'

const MODES: { id: PermissionMode; label: string; key: string; disabled?: boolean }[] = [
  { id: 'accept-edits', label: 'Accept edits', key: '1' },
  { id: 'auto', label: 'Auto', key: '2' },
  { id: 'plan', label: 'Plan', key: '3', disabled: true }
]

export function ModePicker(): React.JSX.Element {
  const mode = useAppStore((s) => s.permissionMode)
  const setMode = useAppStore((s) => s.setPermissionMode)
  const permMenuTick = useAppStore((s) => s.permMenuTick)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(permMenuTick)
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]

  // Cmd+. toggles the menu. Compare against the last seen tick so this only
  // fires on a real tick change, not on mount or StrictMode's double-run.
  useEffect(() => {
    if (lastTick.current === permMenuTick) return
    lastTick.current = permMenuTick
    setOpen((o) => !o)
  }, [permMenuTick])

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
      if (['1', '2', '3'].includes(e.key)) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        const picked = MODES.find((m) => m.key === e.key)
        if (picked && !picked.disabled) {
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
    <div className="mode-picker" ref={rootRef}>
      <Hint label="Permission mode" keys="⌘." side="top" disabled={open}>
        <button className="pill-btn" onClick={() => setOpen((o) => !o)}>
          <span>{current.label}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      {open ? (
        <div className="menu mode-menu">
          <div className="menu-group-label">Mode</div>
          {MODES.map((m) => (
            <div
              key={m.id}
              className={
                'menu-item' + (m.id === mode ? ' selected' : '') + (m.disabled ? ' disabled' : '')
              }
              onClick={() => {
                if (m.disabled) return
                setMode(m.id)
                setOpen(false)
              }}
            >
              <span className="mode-label">
                {m.label}
                {m.disabled ? <span className="badge">soon</span> : null}
              </span>
              <span className="mode-key">{m.key}</span>
              <span className="check">✓</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
