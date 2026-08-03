// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, BrowserStatus } from '@shared/types'
import { BrowserPane } from './BrowserPane'

const idleStatus: BrowserStatus = {
  phase: 'idle',
  message: null,
  installed: true,
  connected: false,
  conversationId: null,
  debuggingEnabled: true
}
const readyStatus: BrowserStatus = {
  ...idleStatus,
  phase: 'ready',
  connected: true,
  conversationId: 'conversation-1'
}

const status = vi.fn<() => Promise<BrowserStatus>>()
const setBounds = vi.fn().mockResolvedValue(undefined)
const show = vi.fn().mockResolvedValue(undefined)
const hide = vi.fn().mockResolvedValue(undefined)
const unsubscribe = vi.fn()
let statusListener: ((next: BrowserStatus) => void) | null = null
const onStatus = vi.fn((listener: (next: BrowserStatus) => void) => {
  statusListener = listener
  return unsubscribe
})

class ResizeObserverStub {
  observe = vi.fn()
  disconnect = vi.fn()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  status.mockReset()
  status.mockResolvedValue(idleStatus)
  setBounds.mockReset()
  setBounds.mockResolvedValue(undefined)
  show.mockReset()
  show.mockResolvedValue(undefined)
  hide.mockReset()
  hide.mockResolvedValue(undefined)
  onStatus.mockClear()
  unsubscribe.mockClear()
  statusListener = null
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // jsdom rects are all-zero, which the pane now correctly skips as a
  // degenerate measurement. Give every element a realistic in-window rect;
  // geometry tests override the pane instance directly.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    browser: { status, onStatus, setBounds, show, hide }
  } as unknown as BearcodeApi
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BrowserPane lifecycle feedback', () => {
  it('subscribes before fetching initial status and unsubscribes on unmount', async () => {
    const { unmount } = render(<BrowserPane visible={false} />)

    expect(onStatus).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(onStatus.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0])
    await screen.findByText('Browser is not active')

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('announces Preparing browser… only after the current hide resolves', async () => {
    const initial = deferred<BrowserStatus>()
    const initialHide = deferred<void>()
    status.mockReturnValueOnce(initial.promise)
    hide.mockReturnValueOnce(initialHide.promise)
    render(<BrowserPane visible={false} />)

    expect(screen.queryByText('Preparing browser…')).not.toBeInTheDocument()
    initialHide.resolve()
    expect(await screen.findByRole('status')).toHaveTextContent('Preparing browser…')

    act(() => statusListener!({ ...idleStatus, phase: 'starting' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Preparing browser…')
    expect(hide).toHaveBeenCalled()
  })

  it('does not paint a pushed error until its current hide resolves', async () => {
    const initial = deferred<BrowserStatus>()
    status.mockReturnValueOnce(initial.promise)
    render(<BrowserPane visible={false} />)
    await screen.findByRole('status')
    const errorHide = deferred<void>()
    hide.mockReturnValueOnce(errorHide.promise)

    act(() =>
      statusListener!({
        ...idleStatus,
        phase: 'error',
        message: 'Could not attach to the browser.'
      })
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    errorHide.resolve()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not attach to the browser.')
  })

  it('shows native pixels only for ready + connected + visible', async () => {
    status.mockResolvedValueOnce(readyStatus)
    const { rerender } = render(<BrowserPane visible={false} />)

    await waitFor(() => expect(hide).toHaveBeenCalled())
    expect(show).not.toHaveBeenCalled()

    rerender(<BrowserPane visible />)

    await waitFor(() => expect(show).toHaveBeenCalledOnce())
    expect(setBounds.mock.invocationCallOrder.at(-1)).toBeLessThan(show.mock.invocationCallOrder[0])

    const hidesBeforeDisconnect = hide.mock.calls.length
    act(() => statusListener!({ ...readyStatus, connected: false }))
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(hidesBeforeDisconnect + 1))
  })

  it('ignores a late initial status after a newer push', async () => {
    const initial = deferred<BrowserStatus>()
    status.mockReturnValueOnce(initial.promise)
    render(<BrowserPane visible />)

    act(() => statusListener!(readyStatus))
    await waitFor(() => expect(show).toHaveBeenCalledOnce())

    await act(async () => initial.resolve(idleStatus))

    expect(screen.queryByText('Browser is not active')).not.toBeInTheDocument()
    expect(show).toHaveBeenCalledOnce()
  })

  it('ignores a stale initial-status rejection after a newer push', async () => {
    const initial = deferred<BrowserStatus>()
    status.mockReturnValueOnce(initial.promise)
    render(<BrowserPane visible />)

    act(() => statusListener!(readyStatus))
    await waitFor(() => expect(show).toHaveBeenCalledOnce())
    await act(async () => initial.reject(new Error('stale status failure')))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces a current initial-status rejection and requests hide', async () => {
    status.mockRejectedValueOnce(new Error('Status unavailable'))
    render(<BrowserPane visible />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Status unavailable')
    expect(hide).toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })
})

describe('BrowserPane native-view command failures', () => {
  it('surfaces a setBounds failure, hides, and does not show', async () => {
    status.mockResolvedValueOnce(readyStatus)
    setBounds.mockRejectedValue(new Error('Bounds unavailable'))

    render(<BrowserPane visible />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Bounds unavailable')
    expect(show).not.toHaveBeenCalled()
    expect(hide).toHaveBeenCalled()
  })

  it('surfaces a show failure only after requesting hide', async () => {
    status.mockResolvedValueOnce(readyStatus)
    const failureHide = deferred<void>()
    hide.mockResolvedValueOnce(undefined).mockReturnValueOnce(failureHide.promise)
    show.mockRejectedValueOnce(new Error('Show unavailable'))

    render(<BrowserPane visible />)

    await waitFor(() => expect(show).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    failureHide.resolve()
    expect(await screen.findByRole('alert')).toHaveTextContent('Show unavailable')
  })

  it('surfaces a current authoritative hide rejection as an ErrorCard', async () => {
    const initial = deferred<BrowserStatus>()
    status.mockReturnValueOnce(initial.promise)
    hide.mockRejectedValue(
      new Error('Could not safely hide the browser view. The browser session was closed.')
    )

    render(<BrowserPane visible={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not safely hide the browser view. The browser session was closed.'
    )
  })

  it('does not let a stale show rejection overwrite a newer starting push', async () => {
    const pendingShow = deferred<void>()
    status.mockResolvedValueOnce(readyStatus)
    show.mockReturnValueOnce(pendingShow.promise)
    render(<BrowserPane visible />)
    await waitFor(() => expect(show).toHaveBeenCalledOnce())

    act(() => statusListener!({ ...idleStatus, phase: 'starting' }))
    await act(async () => pendingShow.reject(new Error('stale show failure')))

    expect(screen.getByText('Preparing browser…')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('hides a visible native view before a bounds error and blocks re-show until new status', async () => {
    status.mockResolvedValueOnce(readyStatus)
    const { rerender } = render(<BrowserPane visible />)
    await waitFor(() => expect(show).toHaveBeenCalledOnce())

    const failureHide = deferred<void>()
    setBounds.mockRejectedValueOnce(new Error('Resize unavailable'))
    hide.mockReturnValueOnce(failureHide.promise)
    window.dispatchEvent(new Event('resize'))
    await act(async () => Promise.resolve())

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    failureHide.resolve()
    expect(await screen.findByRole('alert')).toHaveTextContent('Resize unavailable')

    rerender(<BrowserPane visible={false} />)
    rerender(<BrowserPane visible />)
    await act(async () => Promise.resolve())
    expect(show).toHaveBeenCalledOnce()

    act(() => statusListener!(readyStatus))
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2))
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale non-ready hide %s after a newer ready push',
    async (outcome) => {
      status.mockResolvedValueOnce(readyStatus)
      render(<BrowserPane visible />)
      await waitFor(() => expect(show).toHaveBeenCalledOnce())
      const staleHide = deferred<void>()
      hide.mockReturnValueOnce(staleHide.promise)

      act(() => statusListener!({ ...idleStatus, phase: 'starting' }))
      expect(screen.queryByText('Preparing browser…')).not.toBeInTheDocument()
      act(() => statusListener!(readyStatus))
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2))

      if (outcome === 'resolve') staleHide.resolve()
      else staleHide.reject(new Error('stale hide failure'))
      await act(async () => Promise.resolve())

      expect(screen.queryByText('Preparing browser…')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
  )
})

describe('BrowserPane geometry', () => {
  it('reports the measured pane bounds as exact rounded integers', () => {
    render(<BrowserPane visible={false} />)
    const pane = document.querySelector<HTMLDivElement>('.browser-pane')!
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

  it('clamps a mid-animation rect that overhangs the window edge instead of pushing it raw', () => {
    render(<BrowserPane visible={false} />)
    const pane = document.querySelector<HTMLDivElement>('.browser-pane')!
    // The pane's entrance slides in via translateX(100%): the rect hangs past
    // the window's right edge, which the main-process guard hard-rejects.
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(900, 48, 800, 600))
    setBounds.mockClear()

    window.dispatchEvent(new Event('resize'))

    expect(setBounds).toHaveBeenCalledExactlyOnceWith({
      x: 900,
      y: 48,
      width: 124,
      height: 600
    })
  })

  it('skips the push entirely for a zero-size rect', () => {
    render(<BrowserPane visible={false} />)
    const pane = document.querySelector<HTMLDivElement>('.browser-pane')!
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0))
    setBounds.mockClear()

    window.dispatchEvent(new Event('resize'))

    expect(setBounds).not.toHaveBeenCalled()
  })

  it('skips the push for a rect fully outside the window', () => {
    render(<BrowserPane visible={false} />)
    const pane = document.querySelector<HTMLDivElement>('.browser-pane')!
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(1030, 48, 800, 600))
    setBounds.mockClear()

    window.dispatchEvent(new Event('resize'))

    expect(setBounds).not.toHaveBeenCalled()
  })

  it('hides again on unmount', async () => {
    const { unmount } = render(<BrowserPane visible={false} />)
    await screen.findByText('Browser is not active')
    const beforeUnmount = hide.mock.calls.length

    unmount()

    expect(hide).toHaveBeenCalledTimes(beforeUnmount + 1)
  })
})
