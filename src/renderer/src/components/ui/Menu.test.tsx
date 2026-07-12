// @vitest-environment jsdom
import { useRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Menu, type MenuGroup } from './Menu'

afterEach(cleanup)

const groups: MenuGroup[] = [
  {
    items: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
      { value: 'c', label: 'Gamma' }
    ]
  }
]

function Harness({
  value = 'a',
  onSelect,
  onClose
}: {
  value?: string
  onSelect: (v: string) => void
  onClose: () => void
}): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={anchorRef}>Anchor</button>
      <Menu
        anchorRef={anchorRef}
        open={true}
        onClose={onClose}
        groups={groups}
        value={value}
        onSelect={onSelect}
        ariaLabel="Test menu"
      />
    </div>
  )
}

describe('Menu keyboard nav', () => {
  // Regression guard for the first-open dead-keyboard-nav bug: Menu focuses
  // its listbox in a useLayoutEffect on open, and Popover must not be
  // `visibility: hidden` at that point (Chromium refuses `.focus()` on a
  // hidden element, so ArrowDown/Enter would silently do nothing). jsdom
  // doesn't enforce the visibility-blocks-focus rule the way Chromium does,
  // so this test can't reproduce the bug itself -- but it does pin down the
  // expected outcome (activeElement is the listbox right after open) so a
  // future change to the focus effect's timing/deps doesn't regress it
  // unnoticed. See Popover.tsx + Menu.tsx comments for the real fix.
  it('focuses the listbox on open (first open, no prior mount)', () => {
    render(<Harness onSelect={vi.fn()} onClose={vi.fn()} />)
    const listbox = screen.getByRole('listbox')
    expect(document.activeElement).toBe(listbox)
  })

  it('ArrowDown moves the active item, skipping disabled ones', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<Harness onSelect={onSelect} onClose={onClose} />)
    const listbox = screen.getByRole('listbox')
    // active starts on 'a' (value); ArrowDown should skip disabled 'b' -> 'c'
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('c')
  })

  it('Enter selects the active item and closes the menu', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<Harness onSelect={onSelect} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape closes without selecting', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<Harness onSelect={onSelect} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('clicking a disabled item does not select it', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<Harness onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByText('Beta'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
