// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { prefersReducedMotion, usePrefersReducedMotion } from './prefersReducedMotion'

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

function stubMutableMatchMedia(initialReduced = false): {
  setReduced: (reduced: boolean) => void
  listenerCount: () => number
} {
  let reduced = initialReduced
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = '(prefers-reduced-motion: reduce)'
  const media = {
    get matches() {
      return reduced
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener)
    }),
    dispatchEvent: vi.fn()
  } as unknown as MediaQueryList

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media)
  )

  return {
    setReduced: (nextReduced) => {
      reduced = nextReduced
      const event = { matches: reduced, media: query } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    },
    listenerCount: () => listeners.size
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-motion')
})

describe('prefersReducedMotion', () => {
  it('returns false when neither signal is set', () => {
    stubMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('returns false when data-motion is "system" and OS is false', () => {
    stubMatchMedia(false)
    document.documentElement.setAttribute('data-motion', 'system')
    expect(prefersReducedMotion()).toBe(false)
  })

  it('returns true when only the OS matchMedia signal is true', () => {
    stubMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('returns true when only data-motion="reduced" is set (OS matchMedia false)', () => {
    stubMatchMedia(false)
    document.documentElement.setAttribute('data-motion', 'reduced')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('returns true when both signals are true', () => {
    stubMatchMedia(true)
    document.documentElement.setAttribute('data-motion', 'reduced')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('updates the hook when either live signal changes and cleans up its subscriptions', async () => {
    const media = stubMutableMatchMedia()
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())

    expect(result.current).toBe(false)
    expect(media.listenerCount()).toBe(1)

    act(() => media.setReduced(true))
    expect(result.current).toBe(true)

    act(() => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      media.setReduced(false)
    })
    expect(result.current).toBe(true)

    document.documentElement.removeAttribute('data-motion')
    await waitFor(() => expect(result.current).toBe(false))

    unmount()
    expect(media.listenerCount()).toBe(0)
    expect(disconnect).toHaveBeenCalled()
  })

  it('supports the legacy MediaQueryList listener API', () => {
    let reduced = false
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    const removeListener = vi.fn()
    const media = {
      get matches() {
        return reduced
      },
      media: '(prefers-reduced-motion: reduce)',
      addListener: vi.fn((nextListener: (event: MediaQueryListEvent) => void) => {
        listener = nextListener
      }),
      removeListener
    } as unknown as MediaQueryList
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media)
    )
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())

    act(() => {
      reduced = true
      listener?.({ matches: true, media: media.media } as MediaQueryListEvent)
    })

    expect(result.current).toBe(true)
    unmount()
    expect(removeListener).toHaveBeenCalledWith(listener)
  })
})
