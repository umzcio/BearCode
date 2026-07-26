// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { prefersReducedMotion } from './prefersReducedMotion'

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

afterEach(() => {
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
})
