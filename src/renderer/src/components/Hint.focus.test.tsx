// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Hint } from './Hint'

describe('Hint keyboard focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
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
})
