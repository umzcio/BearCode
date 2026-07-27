// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { Hint, resetHintWarmStateForTests } from './Hint'

function expectHintEntry(label: string, animated: boolean): void {
  const labelElement = screen.queryByText(label)
  expect(labelElement).not.toBeNull()
  const surface = labelElement?.closest('.hint-surface')
  expect(surface).not.toBeNull()
  if (!surface) return
  if (animated) expect(surface).toHaveClass('hint-enter')
  else expect(surface).not.toHaveClass('hint-enter')
}

describe('Hint keyboard focus', () => {
  let fineHoverPointer = true

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    resetHintWarmStateForTests()
    fineHoverPointer = true
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(hover: hover) and (pointer: fine)' && fineHoverPointer,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
  })

  afterEach(() => {
    cleanup()
    resetHintWarmStateForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows the bubble immediately without entry motion on focus, then hides on blur', () => {
    render(
      <Hint label="Toggle Sidebar" keys="⌘B">
        <button>btn</button>
      </Hint>
    )
    const button = screen.getByRole('button', { name: 'btn' })
    act(() => {
      fireEvent.focus(button)
    })
    expectHintEntry('Toggle Sidebar', false)
    act(() => {
      fireEvent.blur(button)
    })
    expect(screen.queryByText('Toggle Sidebar')).toBeNull()
  })

  it('delays and animates the first pointer Hint, then reveals a warm sibling immediately without replaying entry motion', () => {
    render(
      <>
        <Hint label="First Hint">
          <button>first</button>
        </Hint>
        <Hint label="Second Hint">
          <button>second</button>
        </Hint>
      </>
    )
    const first = screen.getByText('first').parentElement as HTMLElement
    const second = screen.getByText('second').parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(first)
      vi.advanceTimersByTime(449)
    })
    expect(screen.queryByText('First Hint')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expectHintEntry('First Hint', true)

    act(() => {
      fireEvent.mouseLeave(first)
      fireEvent.mouseEnter(second)
    })
    expectHintEntry('Second Hint', false)
  })

  it('ignores pointer hover without hover/fine capability while keeping focus hints available', () => {
    fineHoverPointer = false
    render(
      <Hint label="Adaptive Hint">
        <button>adaptive</button>
      </Hint>
    )
    const button = screen.getByRole('button', { name: 'adaptive' })
    const wrap = button.parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(wrap)
      vi.advanceTimersByTime(450)
    })
    expect(screen.queryByText('Adaptive Hint')).toBeNull()

    act(() => {
      fireEvent.focus(button)
    })
    expectHintEntry('Adaptive Hint', false)
  })

  it('does not let keyboard focus warm the first eligible pointer Hint', () => {
    render(
      <>
        <Hint label="Focus Hint">
          <button>focus first</button>
        </Hint>
        <Hint label="Pointer Hint">
          <button>pointer second</button>
        </Hint>
      </>
    )
    const focusButton = screen.getByRole('button', { name: 'focus first' })
    const pointerWrap = screen.getByRole('button', { name: 'pointer second' })
      .parentElement as HTMLElement

    act(() => {
      fireEvent.focus(focusButton)
      fireEvent.blur(focusButton)
      fireEvent.mouseEnter(pointerWrap)
      vi.advanceTimersByTime(449)
    })
    expect(screen.queryByText('Pointer Hint')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expectHintEntry('Pointer Hint', true)
  })

  it('returns to the initial delay after the shared warm window expires', () => {
    render(
      <>
        <Hint label="First Hint">
          <button>first</button>
        </Hint>
        <Hint label="Second Hint">
          <button>second</button>
        </Hint>
      </>
    )
    const first = screen.getByText('first').parentElement as HTMLElement
    const second = screen.getByText('second').parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(first)
      vi.advanceTimersByTime(450)
      fireEvent.mouseLeave(first)
      vi.advanceTimersByTime(801)
      fireEvent.mouseEnter(second)
      vi.advanceTimersByTime(449)
    })
    expect(screen.queryByText('Second Hint')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('Second Hint')).not.toBeNull()
  })

  it('does not reveal or warm siblings when leaving before the initial delay', () => {
    render(
      <>
        <Hint label="First Hint">
          <button>first</button>
        </Hint>
        <Hint label="Second Hint">
          <button>second</button>
        </Hint>
      </>
    )
    const first = screen.getByText('first').parentElement as HTMLElement
    const second = screen.getByText('second').parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(first)
      vi.advanceTimersByTime(200)
      fireEvent.mouseLeave(first)
      fireEvent.mouseEnter(second)
      vi.advanceTimersByTime(449)
    })
    expect(screen.queryByText('First Hint')).toBeNull()
    expect(screen.queryByText('Second Hint')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('Second Hint')).not.toBeNull()
  })

  it('refreshes the warm window when a visible Hint becomes disabled', () => {
    const { rerender } = render(
      <>
        <Hint label="First Hint">
          <button>first</button>
        </Hint>
        <Hint label="Second Hint">
          <button>second</button>
        </Hint>
      </>
    )
    const first = screen.getByText('first').parentElement as HTMLElement
    const second = screen.getByText('second').parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(first)
      vi.advanceTimersByTime(450)
      vi.advanceTimersByTime(801)
    })
    rerender(
      <>
        <Hint label="First Hint" disabled>
          <button>first</button>
        </Hint>
        <Hint label="Second Hint">
          <button>second</button>
        </Hint>
      </>
    )

    act(() => {
      fireEvent.mouseEnter(second)
    })
    expect(screen.getByText('Second Hint')).not.toBeNull()
  })

  it('refreshes the warm window when a visible Hint unmounts', () => {
    const { unmount } = render(
      <Hint label="First Hint">
        <button>first</button>
      </Hint>
    )
    const first = screen.getByText('first').parentElement as HTMLElement

    act(() => {
      fireEvent.mouseEnter(first)
      vi.advanceTimersByTime(450)
      vi.advanceTimersByTime(801)
    })
    unmount()

    render(
      <Hint label="Second Hint">
        <button>second</button>
      </Hint>
    )
    const second = screen.getByText('second').parentElement as HTMLElement
    act(() => {
      fireEvent.mouseEnter(second)
    })
    expect(screen.getByText('Second Hint')).not.toBeNull()
  })
})
