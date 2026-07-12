import { useRef, useState } from 'react'
import { IconChevronDown } from './icons'
import { Menu, type MenuGroup } from './ui/Menu'
import './Select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  // Optional secondary line (Antigravity-style rich dropdowns).
  description?: string
}

// The app's shared dropdown: a pill trigger + the shared `<Menu>` primitive,
// so every dropdown looks and behaves the same. NEVER use a native <select> --
// they render OS chrome that clashes with the app (project rule).
//
// Positioning, portaling, click-outside/Escape dismissal, and viewport-edge
// flipping all live in Menu/Popover -- Select just maps its flat `options`
// into a single Menu group.
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
  const triggerRef = useRef<HTMLButtonElement>(null)

  const current = options.find((o) => o.value === value)

  const groups: MenuGroup[] = [
    {
      items: options.map((o) => ({
        value: o.value,
        label: o.label,
        description: o.description
      }))
    }
  ]

  return (
    <div className={'app-select' + (compact ? ' compact' : '')}>
      <button
        type="button"
        ref={triggerRef}
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
      <Menu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        value={value}
        onSelect={(v) => onChange(v as T)}
        ariaLabel={ariaLabel}
      />
    </div>
  )
}
