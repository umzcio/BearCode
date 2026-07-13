// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAnimatedUnmount } from './useAnimatedUnmount'

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
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useAnimatedUnmount', () => {
  it('is mounted+open while open is true', () => {
    const { result } = renderHook(() => useAnimatedUnmount(true))
    expect(result.current).toEqual({ mounted: true, state: 'open' })
  })

  it('stays mounted and closing immediately after open flips false, then unmounts after the timeout', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: true, state: 'closing' })

    act(() => {
      vi.advanceTimersByTime(219)
    })
    expect(result.current).toEqual({ mounted: true, state: 'closing' })

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toEqual({ mounted: false, state: 'closing' })
  })

  it('re-opening during closing cancels the pending unmount and returns to open', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current.state).toBe('closing')

    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ open: true })
    expect(result.current).toEqual({ mounted: true, state: 'open' })

    // The cancelled timer must not fire and unmount us later.
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(result.current).toEqual({ mounted: true, state: 'open' })
  })

  it('respects a custom durationMs', () => {
    const { result, rerender } = renderHook(
      ({ open }) => useAnimatedUnmount(open, { durationMs: 50 }),
      {
        initialProps: { open: true }
      }
    )
    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(49)
    })
    expect(result.current.mounted).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.mounted).toBe(false)
  })

  it('unmounts immediately under prefers-reduced-motion, skipping the closing delay', () => {
    stubMatchMedia(true)
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: false, state: 'closing' })
  })

  it('starts unmounted when initial open is false', () => {
    const { result } = renderHook(() => useAnimatedUnmount(false))
    expect(result.current.mounted).toBe(false)
  })
})
