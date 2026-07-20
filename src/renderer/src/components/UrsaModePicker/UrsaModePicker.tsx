import { useLayoutEffect, useRef, useState } from 'react'
import type { UrsaMode } from '@shared/types'
import { URSA_MODES } from '@shared/ursaMode'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconChevronDown } from '../icons'
import { Popover } from '../ui/Popover'
import { useCloseOnSettingsOpen } from '../../lib/useCloseOnSettingsOpen'
import './UrsaModePicker.css'

// Presentational copy for the three Ursa modes. Keyed by UrsaMode so TypeScript
// enforces one entry per mode; the render order comes from URSA_MODES (the
// canonical union in shared/ursaMode.ts) so the dropdown can never drift from
// the type. `pillLabel` is the compact composer-button text.
const MODE_COPY: Record<UrsaMode, { label: string; pillLabel: string; desc: string }> = {
  code: { label: 'Code', pillLabel: 'Code', desc: 'Ursa routes each turn' },
  council: {
    label: 'Council',
    pillLabel: 'Council',
    desc: 'Three models deliberate, Fable 5 synthesizes'
  },
  'deep-research': {
    label: 'Deep Research',
    pillLabel: 'Deep Research',
    desc: 'Multi-step web research with citations'
  }
}

// Ursa-only replacement for the EffortPicker: effort is meaningless for a
// router, so when the conversation's model is Ursa the composer swaps in this
// per-conversation Mode picker (same slot, same Menu/Popover primitive, same
// visual weight). Mounted by Composer.tsx behind the URSA_MODEL_REF check.
export function UrsaModePicker(): React.JSX.Element {
  const mode = useAppStore((s) => s.ursaMode)
  const setUrsaMode = useAppStore((s) => s.setUrsaMode)
  const [open, setOpen] = useState(false)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  useCloseOnSettingsOpen(open, settingsOpen, () => setOpen(false))
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const pick = (m: UrsaMode): void => {
    setUrsaMode(m)
    setOpen(false)
  }

  // Popover owns click-outside/Esc/scroll dismissal + positioning. This effect
  // only seeds the roving highlight on the current mode and focuses the listbox
  // so it receives arrow keys. Stays a useLayoutEffect (not useEffect) because
  // Popover measures + positions itself in its own useLayoutEffect on the same
  // open transition, and layout effects fire bottom-up (Popover, nested inside
  // this component, before this one), so the listbox is never
  // `visibility: hidden` when `.focus()` is called here. See EffortPicker.tsx.
  useLayoutEffect(() => {
    if (!open) return
    const i = URSA_MODES.indexOf(mode)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(URSA_MODES.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(URSA_MODES.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const m = URSA_MODES[activeIndex]
      if (m) pick(m)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="ursa-mode-picker">
      <Hint label="Ursa mode" side="top" disabled={open}>
        <button ref={triggerRef} className="pill-btn" onClick={() => setOpen((o) => !o)}>
          <span>{MODE_COPY[mode].pillLabel}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} placement="top-end">
        <div
          className="menu menu--in-popover ursa-mode-menu"
          role="listbox"
          ref={menuRef}
          tabIndex={-1}
          aria-activedescendant={`opt-ursa-${URSA_MODES[activeIndex]}`}
          onKeyDown={onMenuKey}
        >
          <div className="menu-group-label">Mode</div>
          {URSA_MODES.map((m, i) => {
            const copy = MODE_COPY[m]
            return (
              <div
                key={m}
                id={`opt-ursa-${m}`}
                role="option"
                aria-selected={m === mode}
                className={
                  'menu-item ursa-mode-item' +
                  (m === mode ? ' selected' : '') +
                  (i === activeIndex ? ' active' : '')
                }
                onClick={() => pick(m)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="ursa-mode-text">
                  <span className="ursa-mode-title">
                    {copy.label}
                    {m === 'code' ? <span className="ursa-mode-default"> · Default</span> : null}
                  </span>
                  <span className="ursa-mode-sub">{copy.desc}</span>
                </span>
                {m === mode ? <span className="check">✓</span> : null}
              </div>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}
