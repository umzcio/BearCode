// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { initWindowFocusTracking } from './windowFocus'

function stubHasFocus(focused: boolean): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}

const blurred = (): boolean => document.documentElement.hasAttribute('data-window-blurred')

afterEach(() => {
  document.documentElement.removeAttribute('data-window-blurred')
  vi.restoreAllMocks()
})

describe('initWindowFocusTracking', () => {
  it('leaves the attribute off when the window starts focused', () => {
    stubHasFocus(true)
    initWindowFocusTracking()
    expect(blurred()).toBe(false)
  })

  it('sets the attribute immediately when the window starts unfocused', () => {
    stubHasFocus(false)
    initWindowFocusTracking()
    expect(blurred()).toBe(true)
  })

  it('toggles the attribute on blur and focus events', () => {
    stubHasFocus(true)
    initWindowFocusTracking()
    expect(blurred()).toBe(false)

    stubHasFocus(false)
    window.dispatchEvent(new Event('blur'))
    expect(blurred()).toBe(true)

    stubHasFocus(true)
    window.dispatchEvent(new Event('focus'))
    expect(blurred()).toBe(false)
  })
})
