// @vitest-environment jsdom
// @ts-expect-error -- Vitest executes this stylesheet harness in Node; the web tsconfig omits Node types.
import { readFileSync } from 'node:fs'
import { useRef, useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Popover } from './Popover'

const popoverStyles = readFileSync('src/renderer/src/components/ui/Popover.css', 'utf8')

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduce : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  stubMatchMedia(false)
  const style = document.createElement('style')
  style.dataset.testStyles = 'popover'
  style.textContent = popoverStyles
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-motion')
  document.querySelector('style[data-test-styles="popover"]')?.remove()
})

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

function ControlledHarness({ initialOpen = true }: { initialOpen?: boolean }): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(initialOpen)
  return (
    <div>
      <button ref={anchorRef} onClick={() => setOpen((value) => !value)}>
        Anchor
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)}>
        <button>Popover action</button>
      </Popover>
    </div>
  )
}

function InstantHarness({ open }: { open: boolean }): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={anchorRef}>Anchor</button>
      <Popover anchorRef={anchorRef} open={open} onClose={vi.fn()} instant>
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

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['resize', () => fireEvent(window, new Event('resize'))],
    ['external scroll', () => fireEvent.scroll(document.body)]
  ])('removes the popover immediately when %s invalidates its geometry', (_reason, close) => {
    render(<ControlledHarness />)
    const action = screen.getByRole('button', { name: 'Popover action' })
    action.focus()

    close()

    expect(screen.queryByText('Popover action')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Anchor' }))
  })

  it('retains the 150ms exit after a pointer outside-close', () => {
    render(<ControlledHarness />)

    fireEvent.pointerDown(document.body)

    const closing = screen.getByText('Popover action').closest('.popover')
    expect(closing?.getAttribute('data-state')).toBe('closing')
    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(screen.queryByText('Popover action')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('Popover action')).toBeNull()
  })

  it('does not close on pointerdown inside the popover', () => {
    const onClose = vi.fn()
    render(<Harness open={true} onClose={onClose} />)
    fireEvent.pointerDown(screen.getByText('Popover content'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('retains an open popover as closing, then unmounts it after 150ms', () => {
    const { rerender } = render(<Harness open={true} onClose={vi.fn()} />)

    rerender(<Harness open={false} onClose={vi.fn()} />)
    expect(
      screen.getByText('Popover content').closest('.popover')?.getAttribute('data-state')
    ).toBe('closing')

    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(screen.queryByText('Popover content')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('Popover content')).toBeNull()
  })

  it('makes the retained closing wrapper aria-hidden, pointer-inert, and keyboard-inert', () => {
    const { rerender } = render(<Harness open={true} onClose={vi.fn()} />)

    rerender(<Harness open={false} onClose={vi.fn()} />)
    const wrapper = screen.getByText('Popover content').closest('.popover')

    expect(wrapper?.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(wrapper as Element).pointerEvents).toBe('none')
    expect(wrapper).toHaveAttribute('inert')
  })

  it('reopens the same closing DOM node and cancels its pending unmount', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Harness open={true} onClose={onClose} />)
    const originalWrapper = screen.getByText('Popover content').closest('.popover')

    rerender(<Harness open={false} onClose={onClose} />)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender(<Harness open={true} onClose={onClose} />)

    const reopenedWrapper = screen.getByText('Popover content').closest('.popover')
    expect(reopenedWrapper).toBe(originalWrapper)
    expect(reopenedWrapper?.getAttribute('data-state')).toBe('open')
    expect(reopenedWrapper?.hasAttribute('aria-hidden')).toBe(false)

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByText('Popover content')).toBeTruthy()
  })

  it('unmounts an instant popover synchronously, with no closing phase', () => {
    const { rerender } = render(<InstantHarness open={true} />)
    const wrapper = screen.getByText('Popover content').closest('.popover')
    expect(wrapper?.getAttribute('data-state')).toBe('open')
    expect(wrapper).toHaveAttribute('data-instant')
    expect(getComputedStyle(wrapper as Element).transition).toBe('none')

    rerender(<InstantHarness open={false} />)

    expect(screen.queryByText('Popover content')).toBeNull()
    expect(document.querySelector(".popover[data-state='closing']")).toBeNull()
  })

  it('uses the open lifecycle state, then unmounts immediately under OS reduced motion', () => {
    stubMatchMedia(true)
    const { rerender } = render(<Harness open={true} onClose={vi.fn()} />)
    expect(
      screen.getByText('Popover content').closest('.popover')?.getAttribute('data-state')
    ).toBe('open')

    rerender(<Harness open={false} onClose={vi.fn()} />)

    expect(screen.queryByText('Popover content')).toBeNull()
  })

  it('uses the open lifecycle state, then unmounts immediately under in-app reduced motion', () => {
    document.documentElement.setAttribute('data-motion', 'reduced')
    const { rerender } = render(<Harness open={true} onClose={vi.fn()} />)
    expect(
      screen.getByText('Popover content').closest('.popover')?.getAttribute('data-state')
    ).toBe('open')

    rerender(<Harness open={false} onClose={vi.fn()} />)

    expect(screen.queryByText('Popover content')).toBeNull()
  })
})
