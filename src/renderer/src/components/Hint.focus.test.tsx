// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { Hint, resetHintWarmStateForTests } from './Hint'

describe('Hint keyboard focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    resetHintWarmStateForTests()
  })

  afterEach(() => {
    cleanup()
    resetHintWarmStateForTests()
    vi.useRealTimers()
  })

  it('shows the bubble on focus and hides on blur', () => {
    render(
      <Hint label="Toggle Sidebar" keys="⌘B">
        <button>btn</button>
      </Hint>
    )
    const wrap = screen.getByText('btn').parentElement as HTMLElement
    act(() => {
      fireEvent.focus(wrap)
    })
    // show() has a 450ms timer; advance it
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getByText('Toggle Sidebar')).not.toBeNull()
    act(() => {
      fireEvent.blur(wrap)
    })
    expect(screen.queryByText('Toggle Sidebar')).toBeNull()
  })

  it('delays the first Hint, then reveals a sibling immediately after it hides', () => {
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
    expect(screen.getByText('First Hint')).not.toBeNull()

    act(() => {
      fireEvent.mouseLeave(first)
      fireEvent.mouseEnter(second)
    })
    expect(screen.getByText('Second Hint')).not.toBeNull()
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
