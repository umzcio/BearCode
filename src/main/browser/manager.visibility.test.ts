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

  const page = {
    url: vi.fn(() => loadedUrl),
    emulateMedia: vi.fn(async () => {})
  }
  const browserHandlers = new Map<string, Handler>()
  const browser = {
    contexts: vi.fn(() => [{ pages: () => [page] }]),
    close: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: Handler) => {
      browserHandlers.set(event, handler)
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
    page,
    browser,
    browserHandlers,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function managerWithView(): {
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
  return { manager, setBounds }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.views.splice(0)
  mocks.browserHandlers.clear()
  mocks.getMainWindow.mockReturnValue({ contentView: mocks.contentView })
  mocks.browserDebuggingEnabled.mockReturnValue(true)
  mocks.chromiumInstalled.mockReturnValue(true)
  mocks.ensureChromium.mockResolvedValue(undefined)
  mocks.connectOverCDP.mockResolvedValue(mocks.browser)
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
    const { manager, setBounds } = managerWithView()
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
    const { manager, setBounds } = managerWithView()
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
})
