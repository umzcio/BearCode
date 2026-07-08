import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown } from './icons'
import './Select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  // Optional secondary line (Antigravity-style rich dropdowns).
  description?: string
}

// The app's shared dropdown: a pill trigger + the standard .menu popover, so
// every dropdown looks and behaves the same. NEVER use a native <select> --
// they render OS chrome that clashes with the app (project rule).
//
// The menu is PORTALED to <body> and positioned `fixed` from the trigger's
// rect, so it escapes any `overflow: hidden`/`auto` ancestor (e.g. the settings
// cards + scroll body) that would otherwise clip it.
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  compact = false
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  // compact: drop the fixed min-width for inline form rows (size to content).
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (
        rootRef.current &&
        !rootRef.current.contains(t) &&
        menuRef.current &&
        !menuRef.current.contains(t)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // A fixed-positioned menu detaches from the trigger on scroll/resize, so
    // close it rather than let it float in the wrong place -- but ignore scrolls
    // WITHIN the menu itself (a long option list scrolling shouldn't close it).
    const onResize = (): void => setOpen(false)
    const onScroll = (e: Event): void => {
      const t = e.target as Node
      if (menuRef.current && menuRef.current.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('click', onDoc)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', onDoc)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setOpen(true)
  }

  return (
    <div className={'app-select' + (compact ? ' compact' : '')} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="app-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="app-select-value">{current?.label ?? value}</span>
        <span className="chev">
          <IconChevronDown />
        </span>
      </button>
      {open && pos
        ? createPortal(
            <div
              className="menu app-select-menu"
              role="listbox"
              ref={menuRef}
              style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}
            >
              {options.map((o) => (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={
                    'menu-item' +
                    (o.value === value ? ' selected' : '') +
                    (o.description ? ' has-desc' : '')
                  }
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                >
                  {o.description ? (
                    <span className="mi-text">
                      <span className="mi-title">{o.label}</span>
                      <span className="mi-desc">{o.description}</span>
                    </span>
                  ) : (
                    <span>{o.label}</span>
                  )}
                  <span className="check">✓</span>
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
