// @vitest-environment jsdom
import { useRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Popover } from './Popover'

afterEach(cleanup)

function Harness({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={anchorRef}>Anchor</button>
      <Popover anchorRef={anchorRef} open={open} onClose={onClose}>
        <div>Popover content</div>
      </Popover>
    </div>
  )
}

describe('Popover', () => {
  it('renders nothing when closed', () => {
    render(<Harness open={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Popover content')).toBeNull()
  })

  it('portals its content to <body> when open', () => {
    render(<Harness open={true} onClose={vi.fn()} />)
    const content = screen.getByText('Popover content')
    expect(content).toBeTruthy()
    expect(content.closest('body')).toBe(document.body)
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose on pointerdown outside the anchor and popover', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close on pointerdown inside the popover', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    fireEvent.pointerDown(screen.getByText('Popover content'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
