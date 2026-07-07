import { useEffect, useRef, useState } from 'react'
import { IconChevronDown } from './icons'
import './Select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

// The app's shared dropdown: a pill trigger + the standard .menu popover, so
// every dropdown looks and behaves the same. NEVER use a native <select> --
// they render OS chrome that clashes with the app (project rule).
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className="app-select" ref={rootRef}>
      <button
        type="button"
        className="app-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="app-select-value">{current?.label ?? value}</span>
        <span className="chev">
          <IconChevronDown />
        </span>
      </button>
      {open ? (
        <div className="menu app-select-menu" role="listbox">
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={'menu-item' + (o.value === value ? ' selected' : '')}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span>{o.label}</span>
              <span className="check">✓</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
