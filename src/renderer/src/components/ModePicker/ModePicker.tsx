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
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(permMenuTick)
  // Fall back to Accept edits (MODES[1]) — the product default — for an
  // unrecognized mode, never to MODES[0] (Ask).
  const current = MODES.find((m) => m.id === mode) ?? MODES[1]
  const isBypass = mode === 'bypass'

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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setConfirmingBypass(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        setConfirmingBypass(false)
        return
      }
      if (NUMERIC_KEYS.includes(e.key)) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        const picked = MODES.find((m) => m.numeric && m.key === e.key)
        if (picked) {
          setMode(picked.id)
          setOpen(false)
          setConfirmingBypass(false)
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

  const pick = (m: ModeOption): void => {
    if (m.id === 'bypass') {
      setConfirmingBypass(true) // gate: never switch to bypass without confirm
      return
    }
    setMode(m.id)
    setOpen(false)
    setConfirmingBypass(false)
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <Hint label="Permission mode" keys="⌘." side="top" disabled={open}>
        <button
          className={'pill-btn' + (isBypass ? ' bypass-active' : '')}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{current.pillLabel}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      {open ? (
        <div className="menu mode-menu">
          {confirmingBypass ? (
            <div
              className="bypass-confirm"
              role="alertdialog"
              aria-label="Enable Bypass permissions"
            >
              <div className="bypass-confirm-text">
                Enable Bypass permissions? Disables ALL command and edit safety checks for this
                conversation, including built-in .git/.env protection.
              </div>
              <div className="bypass-confirm-actions">
                <button className="small-btn" onClick={() => setConfirmingBypass(false)}>
                  Cancel
                </button>
                <button
                  className="danger-btn"
                  onClick={() => {
                    setMode('bypass')
                    setOpen(false)
                    setConfirmingBypass(false)
                  }}
                >
                  Enable Bypass
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="menu-group-label">Mode</div>
              {MODES.map((m) => (
                <div
                  key={m.id}
                  className={
                    'menu-item' +
                    (m.id === mode ? ' selected' : '') +
                    (m.id === 'bypass' ? ' bypass-item' : '')
                  }
                  onClick={() => pick(m)}
                >
                  <span className="mode-label">{m.label}</span>
                  <span className="mode-key">{m.key}</span>
                  <span className="check">✓</span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
