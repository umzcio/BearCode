import { useLayoutEffect, useRef, useState } from 'react'
import { Popover } from './Popover'
import type { Placement } from '../../lib/usePopoverPosition'

export interface MenuItem {
  value: string
  label: string
  description?: string
  disabled?: boolean
  danger?: boolean
}

export interface MenuGroup {
  label?: string
  items: MenuItem[]
}

export interface MenuProps {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  groups: MenuGroup[]
  value?: string
  onSelect: (value: string) => void
  placement?: Placement
  ariaLabel?: string
}

// The app's shared dropdown list: a `Popover` (positioning/dismissal) holding
// a `role="listbox"` with roving-tabindex arrow-key nav. Every menu-shaped
// dropdown (Select, model pickers, row context menus, ...) should render
// this rather than re-deriving the nav/markup per-component.
export function Menu({
  anchorRef,
  open,
  onClose,
  groups,
  value,
  onSelect,
  placement = 'bottom-start',
  ariaLabel
}: MenuProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)
  const flat = groups.flatMap((g) => g.items)
  const [activeIndex, setActiveIndex] = useState(0)

  // When the menu opens, start the active item on the current value (falling
  // back to the first enabled item) and focus the listbox so it receives
  // arrow keys.
  useLayoutEffect(() => {
    if (!open) return
    const selected = flat.findIndex((it) => it.value === value && !it.disabled)
    const firstEnabled = flat.findIndex((it) => !it.disabled)
    setActiveIndex(selected >= 0 ? selected : firstEnabled >= 0 ? firstEnabled : 0)
    listRef.current?.focus()
    // Only re-run when the menu opens -- not on every value/groups change
    // while it's already open (that would fight the user's arrow-key nav).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Step `from` by `dir`, wrapping around and skipping disabled items. Falls
  // back to `from` if every item is disabled.
  const step = (from: number, dir: 1 | -1): number => {
    if (flat.length === 0) return from
    let i = from
    for (let n = 0; n < flat.length; n++) {
      i = (i + dir + flat.length) % flat.length
      if (!flat[i]?.disabled) return i
    }
    return from
  }

  const commit = (i: number): void => {
    const item = flat[i]
    if (!item || item.disabled) return
    onSelect(item.value)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => step(i, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => step(i, -1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(flat[0] && !flat[0].disabled ? 0 : step(0, 1))
    } else if (e.key === 'End') {
      e.preventDefault()
      const last = flat.length - 1
      setActiveIndex(flat[last] && !flat[last].disabled ? last : step(last, -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const active = flat[activeIndex]

  return (
    <Popover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      placement={placement}
      matchAnchorWidth
    >
      <div
        ref={listRef}
        className="menu menu--in-popover"
        role="listbox"
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-activedescendant={active ? `menu-opt-${active.value}` : undefined}
        onKeyDown={onKeyDown}
      >
        {groups.map((group, gi) => (
          <div key={group.label ?? gi}>
            {gi > 0 ? <div className="menu-divider" role="separator" /> : null}
            {group.label ? <div className="menu-group-label">{group.label}</div> : null}
            {group.items.map((item) => {
              // `flat` is built from the same item references (groups.flatMap
              // above), so a referential lookup gives the flat index without
              // mutating a counter during render.
              const idx = flat.indexOf(item)
              return (
                <div
                  key={item.value}
                  id={`menu-opt-${item.value}`}
                  role="option"
                  aria-selected={item.value === value}
                  aria-disabled={item.disabled || undefined}
                  className={
                    'menu-item' +
                    (item.value === value ? ' selected' : '') +
                    (idx === activeIndex ? ' active' : '') +
                    (item.description ? ' has-desc' : '') +
                    (item.disabled ? ' disabled' : '') +
                    (item.danger ? ' danger' : '')
                  }
                  onClick={() => commit(idx)}
                  onMouseEnter={() => {
                    if (!item.disabled) setActiveIndex(idx)
                  }}
                >
                  {item.description ? (
                    <span className="mi-text">
                      <span className="mi-title">{item.label}</span>
                      <span className="mi-desc">{item.description}</span>
                    </span>
                  ) : (
                    <span>{item.label}</span>
                  )}
                  <span className="check">✓</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </Popover>
  )
}
