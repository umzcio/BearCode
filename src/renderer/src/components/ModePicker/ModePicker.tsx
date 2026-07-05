import { useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import './ModePicker.css'

type ModeOption = {
  id: PermissionMode
  label: string
  pillLabel: string
  key: string
  numeric: boolean
}

const MODES: ModeOption[] = [
  { id: 'ask', label: 'Ask permissions', pillLabel: 'Ask', key: '1', numeric: true },
  { id: 'accept-edits', label: 'Accept edits', pillLabel: 'Accept edits', key: '2', numeric: true },
  { id: 'plan', label: 'Plan mode', pillLabel: 'Plan', key: '3', numeric: true },
  { id: 'auto', label: 'Auto mode', pillLabel: 'Auto', key: '4', numeric: true },
  { id: 'bypass', label: 'Bypass permissions', pillLabel: 'Bypass', key: 'Enable', numeric: false }
]

const NUMERIC_KEYS = MODES.filter((m) => m.numeric).map((m) => m.key)

export function ModePicker(): React.JSX.Element {
  const mode = useAppStore((s) => s.permissionMode)
  const setMode = useAppStore((s) => s.setPermissionMode)
  const permMenuTick = useAppStore((s) => s.permMenuTick)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(permMenuTick)
  // Fall back to Accept edits (MODES[1]) — the product default — for an
  // unrecognized mode, never to MODES[0] (Ask).
  const current = MODES.find((m) => m.id === mode) ?? MODES[1]

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
      if (NUMERIC_KEYS.includes(e.key)) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        const picked = MODES.find((m) => m.numeric && m.key === e.key)
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
    <div className="mode-picker" ref={rootRef}>
      <Hint label="Permission mode" keys="⌘." side="top" disabled={open}>
        <button className="pill-btn" onClick={() => setOpen((o) => !o)}>
          <span>{current.pillLabel}</span>
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
