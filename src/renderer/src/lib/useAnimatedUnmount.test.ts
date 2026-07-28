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
  document.documentElement.removeAttribute('data-motion')
})

describe('useAnimatedUnmount', () => {
  it('is mounted+open while open is true', () => {
    const { result } = renderHook(() => useAnimatedUnmount(true))
    expect(result.current).toMatchObject({ mounted: true, state: 'open' })
    expect(result.current.completeExit).toEqual(expect.any(Function))
  })

  it('stays mounted and closing immediately after open flips false, then unmounts after the timeout', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current).toMatchObject({ mounted: true, state: 'closing' })

    act(() => {
      vi.advanceTimersByTime(219)
    })
    expect(result.current).toMatchObject({ mounted: true, state: 'closing' })

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toMatchObject({ mounted: false, state: 'closing' })
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
    expect(result.current).toMatchObject({ mounted: true, state: 'open' })

    // The cancelled timer must not fire and unmount us later.
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(result.current).toMatchObject({ mounted: true, state: 'open' })
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

  it('unmounts immediately for an explicitly non-animated close', () => {
    const { result, rerender } = renderHook(
      ({ open, immediate }) => useAnimatedUnmount(open, { immediate }),
      {
        initialProps: { open: true, immediate: false }
      }
    )

    rerender({ open: false, immediate: true })

    expect(result.current).toMatchObject({ mounted: false, state: 'closing' })
  })

  it('unmounts immediately under prefers-reduced-motion, skipping the closing delay', () => {
    stubMatchMedia(true)
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current).toMatchObject({ mounted: false, state: 'closing' })
  })

  it('unmounts immediately when only the in-app data-motion="reduced" toggle is set (OS matchMedia false)', () => {
    stubMatchMedia(false)
    document.documentElement.setAttribute('data-motion', 'reduced')
    const { result, rerender } = renderHook(({ open }) => useAnimatedUnmount(open), {
      initialProps: { open: true }
    })
    rerender({ open: false })
    expect(result.current).toMatchObject({ mounted: false, state: 'closing' })
  })

  it('starts unmounted when initial open is false', () => {
    const { result } = renderHook(() => useAnimatedUnmount(false))
    expect(result.current.mounted).toBe(false)
  })

  it('keeps signal-completed exits mounted until completeExit is called', () => {
    const { result, rerender } = renderHook(
      ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
      { initialProps: { open: true } }
    )

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(340)
    })
    expect(result.current.mounted).toBe(true)

    act(() => {
      result.current.completeExit()
    })
    expect(result.current.mounted).toBe(false)
  })

  it('ignores a stale signal completion after reopening', () => {
    const { result, rerender } = renderHook(
      ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
      { initialProps: { open: true } }
    )

    rerender({ open: false })
    const completeClosingExit = result.current.completeExit
    rerender({ open: true })
    act(() => {
      completeClosingExit()
    })

    expect(result.current).toMatchObject({ mounted: true, state: 'open' })
  })

  it('fails safe after two seconds when an exit signal never arrives', () => {
    const { result, rerender } = renderHook(
      ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
      { initialProps: { open: true } }
    )

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(result.current.mounted).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.mounted).toBe(false)
  })

  it('unmounts signal-completed exits immediately under reduced motion', () => {
    stubMatchMedia(true)
    const { result, rerender } = renderHook(
      ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
      { initialProps: { open: true } }
    )

    rerender({ open: false })

    expect(result.current).toMatchObject({ mounted: false, state: 'closing' })
  })
})
