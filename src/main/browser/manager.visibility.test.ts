import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserStatus } from '../../shared/types'

const mocks = vi.hoisted(() => {
  type Bounds = { x: number; y: number; width: number; height: number }
  type Handler = (...args: unknown[]) => void

  const views: Array<{
    setBounds: ReturnType<typeof vi.fn<(bounds: Bounds) => void>>
    webContents: {
      loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
      on: ReturnType<typeof vi.fn<(event: string, handler: Handler) => void>>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      getURL: ReturnType<typeof vi.fn<() => string>>
      session: { clearStorageData: ReturnType<typeof vi.fn<() => Promise<void>>> }
      handlers: Map<string, Handler>
    }
  }> = []
  let loadedUrl = 'about:blank'

  class WebContentsView {
    setBounds = vi.fn<(bounds: Bounds) => void>()
    webContents = {
      loadURL: vi.fn(async (url: string) => {
        loadedUrl = url
      }),
      on: vi.fn((event: string, handler: Handler) => {
        this.webContents.handlers.set(event, handler)
      }),
      setWindowOpenHandler: vi.fn(),
      close: vi.fn(),
      getURL: vi.fn(() => loadedUrl),
      session: { clearStorageData: vi.fn(async () => {}) },
      handlers: new Map<string, Handler>()
    }

    constructor() {
      views.push(this)
    }
  }

  const cdpSession = {
    send: vi.fn(async () => {}),
    detach: vi.fn(async () => {})
  }
  const page = {
    url: vi.fn(() => loadedUrl),
    emulateMedia: vi.fn(async () => {}),
    setViewportSize: vi.fn(async () => {}),
    context: vi.fn(() => ({ newCDPSession: vi.fn(async () => cdpSession) }))
  }
  const otherPage = {
    url: vi.fn(() => 'app://bearcode'),
    emulateMedia: vi.fn(async () => {})
  }
  const browserDisconnectHandlers: Handler[] = []
  const browser = {
    contexts: vi.fn(() => [{ pages: () => [page, otherPage] }]),
    close: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: Handler) => {
      if (event === 'disconnected') browserDisconnectHandlers.push(handler)
    })
  }
  const contentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn()
  }
  const mainWindow = { contentView }

  return {
    WebContentsView,
    views,
    cdpSession,
    page,
    otherPage,
    browser,
    browserDisconnectHandlers,
    contentView,
    getMainWindow: vi.fn<() => typeof mainWindow | null>(() => mainWindow),
    browserDebuggingEnabled: vi.fn(() => true),
    ensureChromium: vi.fn<() => Promise<void>>(async () => {}),
    chromiumInstalled: vi.fn(() => true),
    connectOverCDP: vi.fn(async () => browser)
  }
})

vi.mock('electron', () => ({ WebContentsView: mocks.WebContentsView }))
vi.mock('playwright', () => ({
  chromium: { connectOverCDP: mocks.connectOverCDP }
}))
vi.mock('../mainWindow', () => ({
  getMainWindow: mocks.getMainWindow,
  REMOTE_DEBUG_PORT: 9333,
  browserDebuggingEnabled: mocks.browserDebuggingEnabled
}))
vi.mock('./install', () => ({
  ensureChromium: mocks.ensureChromium,
  chromiumInstalled: mocks.chromiumInstalled
}))

const { BrowserManager } = await import('./manager')

type Bounds = { x: number; y: number; width: number; height: number }

function deferred<T = void>(): {
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

function managerWithView(ready = false): {
  manager: InstanceType<typeof BrowserManager>
  setBounds: ReturnType<typeof vi.fn<(bounds: Bounds) => void>>
} {
  const manager = new BrowserManager()
  const setBounds = vi.fn<(bounds: Bounds) => void>()
  ;(
    manager as unknown as {
      view: { setBounds: (bounds: Bounds) => void } | null
    }
  ).view = { setBounds }
  if (ready) {
    ;(
      manager as unknown as {
        page: object | null
        phase: string
      }
    ).page = {}
    ;(manager as unknown as { phase: string }).phase = 'ready'
  }
  return { manager, setBounds }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.views.splice(0)
  mocks.browserDisconnectHandlers.splice(0)
  mocks.getMainWindow.mockReturnValue({ contentView: mocks.contentView })
  mocks.browserDebuggingEnabled.mockReturnValue(true)
  mocks.chromiumInstalled.mockReturnValue(true)
  mocks.ensureChromium.mockResolvedValue(undefined)
  mocks.connectOverCDP.mockResolvedValue(mocks.browser)
  mocks.otherPage.emulateMedia.mockResolvedValue(undefined)
})

describe('BrowserManager status lifecycle', () => {
  it('publishes idle → starting → ready around a successful start', async () => {
    const manager = new BrowserManager()
    const installing = deferred()
    mocks.ensureChromium.mockReturnValueOnce(installing.promise)
    const statuses: BrowserStatus[] = []
    manager.onStatus((status) => statuses.push(status))

    const start = manager.start('conversation-1')

    await vi.waitFor(() => expect(statuses.map(({ phase }) => phase)).toEqual(['starting']))
    expect(manager.status()).toMatchObject({
      phase: 'starting',
      message: null,
      connected: false,
      conversationId: null
    })

    installing.resolve()
    await start

    expect(statuses.map(({ phase }) => phase)).toEqual(['starting', 'ready'])
    expect(manager.status()).toMatchObject({
      phase: 'ready',
      message: null,
      connected: true,
      conversationId: 'conversation-1'
    })
  })

  it('publishes a sanitized error and keeps it after failed-start cleanup', async () => {
    const manager = new BrowserManager()
    mocks.connectOverCDP.mockRejectedValue(
      new Error('\u001b[31mCDP attach failed\u001b[0m\nsecret')
    )
    const statuses: BrowserStatus[] = []
    manager.onStatus((status) => statuses.push(status))

    await expect(manager.start('conversation-1')).rejects.toThrow('CDP attach failed')

    expect(statuses.map(({ phase }) => phase)).toEqual(['starting', 'error'])
    expect(statuses.at(-1)).toMatchObject({
      phase: 'error',
      message: 'CDP attach failed',
      connected: false,
      conversationId: null
    })
    expect(mocks.contentView.removeChildView).toHaveBeenCalledWith(mocks.views[0])
    expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce()
  })

  it('treats render-process-gone as an actionable error after cleaning up the session', async () => {
    const manager = new BrowserManager()
    const statuses: BrowserStatus[] = []
    manager.onStatus((status) => statuses.push(status))
    await manager.start('conversation-1')

    mocks.views[0].webContents.handlers.get('render-process-gone')!()

    await vi.waitFor(() =>
      expect(manager.status()).toMatchObject({
        phase: 'error',
        message: 'The browser view stopped unexpectedly. Start it again.',
        connected: false,
        conversationId: null
      })
    )
    expect(statuses.map(({ phase }) => phase)).toEqual(['starting', 'ready', 'error'])
    expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce()
  })

  it('publishes idle on normal teardown', async () => {
    const manager = new BrowserManager()
    const statuses: BrowserStatus[] = []
    manager.onStatus((status) => statuses.push(status))
    await manager.start('conversation-1')

    await manager.teardown()

    expect(statuses.map(({ phase }) => phase)).toEqual(['starting', 'ready', 'idle'])
    expect(manager.status()).toMatchObject({
      phase: 'idle',
      message: null,
      connected: false,
      conversationId: null
    })
  })

  it('delivers frozen snapshots and stops delivering after unsubscribe', async () => {
    const manager = new BrowserManager()
    const statuses: BrowserStatus[] = []
    const unsubscribe = manager.onStatus((status) => statuses.push(status))

    await manager.start('conversation-1')

    expect(statuses).toHaveLength(2)
    expect(statuses.every(Object.isFrozen)).toBe(true)
    expect(statuses[0]).not.toBe(statuses[1])

    unsubscribe()
    await manager.teardown()

    expect(statuses).toHaveLength(2)
  })

  it('isolates throwing listeners so later listeners receive every transition', async () => {
    const manager = new BrowserManager()
    const throwingListener = vi.fn(() => {
      throw new Error('listener failed')
    })
    const phases: string[] = []
    manager.onStatus(throwingListener)
    manager.onStatus((status) => phases.push(status.phase))

    await expect(manager.start('conversation-1')).resolves.toBeUndefined()

    expect(throwingListener).toHaveBeenCalledTimes(2)
    expect(phases).toEqual(['starting', 'ready'])
  })

  it.each(['render-process-gone', 'disconnected'] as const)(
    'does not publish stale ready when %s lands during theme reset',
    async (failure) => {
      const manager = new BrowserManager()
      const themeReset = deferred()
      mocks.otherPage.emulateMedia.mockReturnValueOnce(themeReset.promise)
      const phases: string[] = []
      manager.onStatus((status) => phases.push(status.phase))

      const start = manager.start('conversation-1')
      await vi.waitFor(() => expect(mocks.otherPage.emulateMedia).toHaveBeenCalledOnce())

      if (failure === 'render-process-gone') {
        mocks.views[0].webContents.handlers.get('render-process-gone')!()
      } else {
        mocks.browserDisconnectHandlers[0]()
      }
      themeReset.resolve()

      await expect(start).rejects.toThrow()
      await vi.waitFor(() => expect(manager.status().phase).toBe('error'))
      expect(phases).not.toContain('ready')
    }
  )

  it('waits for active teardown before starting a replacement session', async () => {
    const manager = new BrowserManager()
    await manager.start('conversation-1')
    mocks.ensureChromium.mockClear()
    const cleanup = deferred()
    mocks.browser.close.mockReturnValueOnce(cleanup.promise)

    const teardown = manager.teardown()
    await vi.waitFor(() => expect(mocks.browser.close).toHaveBeenCalled())
    const restart = manager.start('conversation-2')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(mocks.ensureChromium).not.toHaveBeenCalled()

    cleanup.resolve()
    await teardown
    await restart
    expect(manager.status()).toMatchObject({
      phase: 'ready',
      conversationId: 'conversation-2'
    })
  })

  it('supersedes an in-progress start even when the conversation id is unchanged', async () => {
    const manager = new BrowserManager()
    const firstThemeReset = deferred()
    mocks.otherPage.emulateMedia.mockReturnValueOnce(firstThemeReset.promise)
    const firstStart = manager.start('conversation-1')
    await vi.waitFor(() => expect(mocks.otherPage.emulateMedia).toHaveBeenCalledOnce())

    const replacementStart = manager.start('conversation-1')
    await replacementStart

    expect(mocks.ensureChromium).toHaveBeenCalledTimes(2)
    expect(manager.status()).toMatchObject({
      phase: 'ready',
      conversationId: 'conversation-1'
    })

    firstThemeReset.resolve()
    await expect(firstStart).rejects.toThrow('superseded')
  })

  it('does not retry or close the replacement when a superseded connect rejects', async () => {
    const manager = new BrowserManager()
    const staleConnect = deferred<Awaited<ReturnType<typeof mocks.connectOverCDP>>>()
    mocks.connectOverCDP
      .mockReturnValueOnce(staleConnect.promise)
      .mockResolvedValueOnce(mocks.browser)
    const firstStart = manager.start('conversation-1')
    await vi.waitFor(() => expect(mocks.connectOverCDP).toHaveBeenCalledOnce())

    await manager.start('conversation-2')
    staleConnect.reject(new Error('old connect rejected'))
    await expect(firstStart).rejects.toThrow('superseded')

    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(2)
    expect(mocks.browser.close).not.toHaveBeenCalled()
    expect(manager.status()).toMatchObject({
      phase: 'ready',
      connected: true,
      conversationId: 'conversation-2'
    })
  })

  it('closes a superseded successful connect locally without assigning or leaking it', async () => {
    const manager = new BrowserManager()
    const staleConnect = deferred<Awaited<ReturnType<typeof mocks.connectOverCDP>>>()
    const staleBrowser = {
      contexts: vi.fn(() => []),
      close: vi.fn(async () => {}),
      on: vi.fn()
    }
    mocks.connectOverCDP
      .mockReturnValueOnce(staleConnect.promise)
      .mockResolvedValueOnce(mocks.browser)
    const firstStart = manager.start('conversation-1')
    await vi.waitFor(() => expect(mocks.connectOverCDP).toHaveBeenCalledOnce())

    await manager.start('conversation-2')
    staleConnect.resolve(staleBrowser)
    await expect(firstStart).rejects.toThrow('superseded')

    expect(staleBrowser.close).toHaveBeenCalledOnce()
    expect(staleBrowser.contexts).not.toHaveBeenCalled()
    expect(mocks.browser.close).not.toHaveBeenCalled()
    expect(manager.status()).toMatchObject({
      phase: 'ready',
      connected: true,
      conversationId: 'conversation-2'
    })
  })

  it('ignores crash and disconnect callbacks captured by an older session', async () => {
    const manager = new BrowserManager()
    await manager.start('conversation-1')
    const oldCrash = mocks.views[0].webContents.handlers.get('render-process-gone')!
    const oldDisconnect = mocks.browserDisconnectHandlers[0]

    await manager.teardown()
    await manager.start('conversation-2')
    oldCrash()
    oldDisconnect()
    await Promise.resolve()
    await Promise.resolve()

    expect(manager.status()).toMatchObject({
      phase: 'ready',
      connected: true,
      conversationId: 'conversation-2'
    })
    expect(mocks.views[1].webContents.close).not.toHaveBeenCalled()
  })

  it('still cleans up and publishes an actionable crash error when hide throws', async () => {
    const manager = new BrowserManager()
    await manager.start('conversation-1')
    mocks.views[0].setBounds.mockImplementationOnce(() => {
      throw new Error('view already gone')
    })

    mocks.views[0].webContents.handlers.get('render-process-gone')!()

    await vi.waitFor(() =>
      expect(manager.status()).toMatchObject({
        phase: 'error',
        message: 'The browser view stopped unexpectedly. Start it again.',
        connected: false
      })
    )
    expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce()
  })

  it('detaches and closes the native view before an offscreen hide failure rejects', async () => {
    const manager = new BrowserManager()
    await manager.start('conversation-1')
    const cleanup = deferred()
    mocks.browser.close.mockReturnValueOnce(cleanup.promise)
    mocks.views[0].setBounds.mockImplementationOnce(() => {
      throw new Error('offscreen move failed')
    })

    const hide = manager.hide()
    let rejected = false
    void hide.catch(() => {
      rejected = true
    })

    expect(mocks.contentView.removeChildView).toHaveBeenCalledWith(mocks.views[0])
    expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce()
    expect(rejected).toBe(false)

    cleanup.resolve()
    await expect(hide).rejects.toThrow('safely hide')
    expect(manager.status()).toMatchObject({
      phase: 'error',
      message: 'Could not safely hide the browser view. The browser session was closed.',
      connected: false,
      conversationId: null
    })
  })
})

describe('BrowserManager native-view visibility', () => {
  it('stores reported bounds without revealing a hidden view', () => {
    const { manager, setBounds } = managerWithView()

    manager.setBounds({ x: 40, y: 20, width: 900, height: 700 })

    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 900,
      height: 700
    })
  })

  it('shows at the latest stored bounds and hides offscreen', () => {
    const { manager, setBounds } = managerWithView(true)
    const bounds = { x: 40, y: 20, width: 900, height: 700 }

    manager.setBounds(bounds)
    manager.show()
    expect(setBounds).toHaveBeenLastCalledWith(bounds)

    manager.hide()
    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 900,
      height: 700
    })
  })

  it('keeps resizing hidden views offscreen until the next show', () => {
    const { manager, setBounds } = managerWithView(true)
    manager.show()
    manager.hide()

    const latest = { x: 60, y: 30, width: 1024, height: 768 }
    manager.setBounds(latest)

    expect(setBounds).toHaveBeenLastCalledWith({
      x: -10000,
      y: 0,
      width: 1024,
      height: 768
    })

    manager.show()
    expect(setBounds).toHaveBeenLastCalledWith(latest)
  })

  it('emulates the pending bounds at start so a never-shown view can screenshot', async () => {
    const manager = new BrowserManager()
    manager.setBounds({ x: 12, y: 8, width: 901, height: 655 })

    await manager.start('conversation-1')

    expect(mocks.page.setViewportSize).toHaveBeenCalledExactlyOnceWith({
      width: 901,
      height: 655
    })
    expect(mocks.cdpSession.send).not.toHaveBeenCalled()
  })

  it('clears the hidden-viewport emulation once the view is shown', async () => {
    const manager = new BrowserManager()
    await manager.start('conversation-1')

    manager.show()

    await vi.waitFor(() => {
      expect(mocks.cdpSession.send).toHaveBeenCalledExactlyOnceWith(
        'Emulation.clearDeviceMetricsOverride'
      )
      expect(mocks.cdpSession.detach).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['idle', 'starting', 'error'] as const)(
    'refuses stale show requests while phase is %s',
    (phase) => {
      const { manager, setBounds } = managerWithView()
      ;(manager as unknown as { phase: string }).phase = phase
      ;(manager as unknown as { page: object | null }).page = {}

      manager.show()

      expect(setBounds).not.toHaveBeenCalled()
    }
  )
})
