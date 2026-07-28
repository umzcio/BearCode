// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi } from '@shared/types'
import { BrowserPane } from './BrowserPane'

const setBounds = vi.fn().mockResolvedValue(undefined)
const show = vi.fn().mockResolvedValue(undefined)
const hide = vi.fn().mockResolvedValue(undefined)

class ResizeObserverStub {
  observe = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  setBounds.mockClear()
  show.mockClear()
  hide.mockClear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    browser: { setBounds, show, hide }
  } as unknown as BearcodeApi
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BrowserPane native-view staging', () => {
  it('reports the measured pane bounds as exact rounded integers', () => {
    const { container } = render(<BrowserPane visible={false} />)
    const pane = container.querySelector<HTMLDivElement>('.browser-pane')!
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0.49, 48.5, 799.5, 599.49))
    setBounds.mockClear()

    window.dispatchEvent(new Event('resize'))

    expect(setBounds).toHaveBeenCalledExactlyOnceWith({
      x: 0,
      y: 49,
      width: 800,
      height: 599
    })
  })

  it('reports placeholder bounds but stays hidden until visible', async () => {
    const { rerender } = render(<BrowserPane visible={false} />)

    expect(setBounds).toHaveBeenCalledTimes(1)
    expect(show).not.toHaveBeenCalled()
    expect(hide).toHaveBeenCalledTimes(1)

    rerender(<BrowserPane visible />)

    await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(setBounds.mock.invocationCallOrder.at(-1)).toBeLessThan(show.mock.invocationCallOrder[0])
  })

  it('hides immediately when visibility is revoked and again on unmount', () => {
    const { rerender, unmount } = render(<BrowserPane visible />)
    expect(show).toHaveBeenCalledTimes(1)

    rerender(<BrowserPane visible={false} />)
    expect(hide).toHaveBeenCalledTimes(1)

    unmount()
    expect(hide).toHaveBeenCalledTimes(2)
  })
})
