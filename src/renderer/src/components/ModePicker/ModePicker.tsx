import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PermissionMode } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import { Popover } from '../ui/Popover'
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
  const defaultMode = useAppStore((s) => s.settings?.defaultPermissionMode ?? 'accept-edits')
  const [open, setOpen] = useState(false)
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
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

  // Whenever the menu closes (via the pill toggle, a mode pick, Escape, or an
  // outside click), drop any pending Bypass confirmation so reopening the menu
  // always lands on the mode list, never a stale confirm dialog.
  useEffect(() => {
    if (!open) setConfirmingBypass(false)
  }, [open])

  // Popover owns click-outside/Esc/scroll dismissal + positioning now. This
  // effect only handles the numeric 1-4 shortcuts, which must keep working
  // while the menu is open regardless of what has focus.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setMode])

  // When the mode list opens (not the bypass-confirm dialog), start the
  // active option on the current mode and focus the listbox for arrow keys.
  // Stays a useLayoutEffect (not useEffect): Popover measures + positions
  // itself in its own useLayoutEffect on the same open transition, and
  // layout effects fire bottom-up (Popover, nested inside this component,
  // before this one), so the listbox is never `visibility: hidden` when
  // `.focus()` is called here. See Popover.tsx / ModelPicker.tsx.
  useLayoutEffect(() => {
    if (!open || confirmingBypass) return
    const i = MODES.findIndex((m) => m.id === mode)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
  }, [open, confirmingBypass, mode])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(MODES.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(MODES.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const m = MODES[activeIndex]
      if (m) pick(m)
    }
    // Escape is handled by Popover (click-outside/Esc/scroll dismissal).
  }

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
    <div className="mode-picker">
      <Hint label="Permission mode" keys="⌘." side="top" disabled={open}>
        <button
          ref={triggerRef}
          className={
            'pill-btn' +
            (isBypass ? ' bypass-active' : '') +
            (mode === 'auto' ? ' auto-active' : '')
          }
          onClick={() => setOpen((o) => !o)}
        >
          <span>{current.pillLabel}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-end"
      >
        <div
          className="menu menu--in-popover mode-menu"
          role={confirmingBypass ? undefined : 'listbox'}
          ref={menuRef}
          tabIndex={-1}
          aria-activedescendant={confirmingBypass ? undefined : `opt-${MODES[activeIndex]?.id}`}
          onKeyDown={confirmingBypass ? undefined : onMenuKey}
        >
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
              <div className="mode-current">
                <span className="mode-current-label">
                  {current.label}
                  {mode === defaultMode ? <span className="mode-default"> · Default</span> : null}
                </span>
                <span className="check">✓</span>
              </div>
              <div className="mode-sep" />
              {MODES.map((m, i) => (
                <div
                  key={m.id}
                  id={`opt-${m.id}`}
                  role="option"
                  aria-selected={m.id === mode}
                  className={
                    'menu-item' +
                    (m.id === mode ? ' selected' : '') +
                    (i === activeIndex ? ' active' : '') +
                    (m.id === 'bypass' ? ' bypass-item' : '')
                  }
                  onClick={() => pick(m)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className="mode-label">{m.label}</span>
                  <span className="mode-key">{m.key}</span>
                  <span className="check">✓</span>
                </div>
              ))}
            </>
          )}
        </div>
      </Popover>
    </div>
  )
}
