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
