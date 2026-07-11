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

  const [activeIndex, setActiveIndex] = useState(0)

  // When the menu opens, start the active option on the current value and focus
  // the listbox so it receives arrow keys.
  useEffect(() => {
    if (!open) return
    const i = options.findIndex((o) => o.value === value)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
  }, [open, options, value])

  const commit = (i: number): void => {
    const o = options[i]
    if (o) {
      onChange(o.value)
      setOpen(false)
    }
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(options.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIndex)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const current = options.find((o) => o.value === value)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) {
      // The app sets CSS `zoom` on <html> for font size (appearance.ts). A
      // position:fixed menu is re-scaled by that zoom, while getBoundingClientRect
      // already returns zoom-scaled coords -- so a raw rect lands the menu at
      // position*zoom^2. Divide by the zoom factor so it sits exactly under the
      // trigger at every font size (small/medium/large).
      const zoom = Number(document.documentElement.style.zoom) || 1
      setPos({ top: r.bottom / zoom + 4, left: r.left / zoom, width: r.width / zoom })
    }
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
              tabIndex={-1}
              aria-activedescendant={`opt-${options[activeIndex]?.value}`}
              onKeyDown={onMenuKey}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                minWidth: pos.width,
                maxWidth: 320,
                zIndex: 1000
              }}
            >
              {options.map((o, i) => (
                <div
                  key={o.value}
                  id={`opt-${o.value}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={
                    'menu-item' +
                    (o.value === value ? ' selected' : '') +
                    (i === activeIndex ? ' active' : '') +
                    (o.description ? ' has-desc' : '')
                  }
                  onClick={() => commit(i)}
                  onMouseEnter={() => setActiveIndex(i)}
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
