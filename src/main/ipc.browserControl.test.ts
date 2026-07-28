import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeEvent = {
  preventDefault: ReturnType<typeof vi.fn>
  readonly defaultPrevented: boolean
  sender: object
  senderFrame: object | null
  frameId: number
  processId: number
  type: 'frame'
}
type Handler = (event: InvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const contentBounds = { x: 300, y: 200, width: 1200, height: 800 }

const { browserManager, getMainWindow, mainFrame, mainWindow, webContents } = vi.hoisted(() => {
  const mainFrame = {
    routingId: 1,
    isDestroyed: vi.fn(() => false),
    detached: false
  }
  const webContents: {
    id: number
    isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
    mainFrame: typeof mainFrame | null
  } = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    mainFrame
  }
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 300, y: 200, width: 1200, height: 800 })),
    webContents
  }
  const getMainWindow = vi.fn<() => typeof mainWindow | null>(() => mainWindow)
  return {
    browserManager: {
      status: vi.fn(() => ({ connected: false })),
      clearSession: vi.fn(async () => {}),
      setBounds: vi.fn(),
      show: vi.fn(),
      hide: vi.fn()
    },
    getMainWindow,
    mainFrame,
    mainWindow,
    webContents
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('./browser/manager', () => ({ browserManager }))
vi.mock('./mainWindow', () => ({
  REMOTE_DEBUG_PORT: 9333,
  browserDebuggingEnabled: () => true,
  getMainWindow
}))

import { registerIpc } from './ipc'

function eventFor(
  sender: object = webContents,
  senderFrame: object | null = mainFrame
): InvokeEvent {
  return {
    preventDefault: vi.fn(),
    defaultPrevented: false,
    sender,
    senderFrame,
    frameId: 1,
    processId: 1,
    type: 'frame'
  }
}

function invoke(channel: string, event: InvokeEvent, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => handlers.get(channel)!(event, ...args))
}

function expectNoManagerCalls(): void {
  expect(browserManager.status).not.toHaveBeenCalled()
  expect(browserManager.clearSession).not.toHaveBeenCalled()
  expect(browserManager.setBounds).not.toHaveBeenCalled()
  expect(browserManager.show).not.toHaveBeenCalled()
  expect(browserManager.hide).not.toHaveBeenCalled()
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  getMainWindow.mockReturnValue(mainWindow)
  mainWindow.isDestroyed.mockReturnValue(false)
  webContents.isDestroyed.mockReturnValue(false)
  webContents.mainFrame = mainFrame
  mainFrame.isDestroyed.mockReturnValue(false)
  mainFrame.detached = false
  registerIpc()
})

describe('browser-control IPC authorization', () => {
  it('allows the authoritative main frame to use every browser-control channel', async () => {
    const bounds = { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height }

    await expect(invoke('bearcode:browser:status', eventFor())).resolves.toEqual({
      connected: false
    })
    await expect(invoke('bearcode:browser:clear-session', eventFor())).resolves.toBeUndefined()
    await expect(invoke('bearcode:browser:set-bounds', eventFor(), bounds)).resolves.toBeUndefined()
    await expect(invoke('bearcode:browser:show', eventFor())).resolves.toBeUndefined()
    await expect(invoke('bearcode:browser:hide', eventFor())).resolves.toBeUndefined()

    expect(browserManager.status).toHaveBeenCalledOnce()
    expect(browserManager.clearSession).toHaveBeenCalledOnce()
    expect(browserManager.setBounds).toHaveBeenCalledWith(bounds)
    expect(browserManager.show).toHaveBeenCalledOnce()
    expect(browserManager.hide).toHaveBeenCalledOnce()
  })

  it('rejects a same-webContents subframe before any manager call', async () => {
    const subframe = { routingId: 2 }

    for (const [channel, args] of [
      ['bearcode:browser:status', []],
      ['bearcode:browser:clear-session', []],
      ['bearcode:browser:set-bounds', [{ x: 0, y: 0, width: 1, height: 1 }]],
      ['bearcode:browser:show', []],
      ['bearcode:browser:hide', []]
    ] as const) {
      await expect(invoke(channel, eventFor(webContents, subframe), ...args)).rejects.toThrow(
        'Unauthorized browser control.'
      )
    }

    expectNoManagerCalls()
  })

  it('rejects a foreign sender before any manager call', async () => {
    const foreignFrame = { routingId: 1 }
    const foreignWebContents = { id: 2, mainFrame: foreignFrame }

    for (const channel of [
      'bearcode:browser:status',
      'bearcode:browser:clear-session',
      'bearcode:browser:show',
      'bearcode:browser:hide'
    ]) {
      await expect(invoke(channel, eventFor(foreignWebContents, foreignFrame))).rejects.toThrow(
        'Unauthorized browser control.'
      )
    }
    await expect(
      invoke('bearcode:browser:set-bounds', eventFor(foreignWebContents, foreignFrame), {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      })
    ).rejects.toThrow('Unauthorized browser control.')

    expectNoManagerCalls()
  })

  it('rejects calls when the main window is missing', async () => {
    getMainWindow.mockReturnValueOnce(null)

    await expect(invoke('bearcode:browser:show', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects calls when the main window is destroyed', async () => {
    mainWindow.isDestroyed.mockReturnValueOnce(true)

    await expect(invoke('bearcode:browser:hide', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects calls when the authoritative webContents is destroyed', async () => {
    webContents.isDestroyed.mockReturnValueOnce(true)

    await expect(invoke('bearcode:browser:clear-session', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects calls when the authoritative main frame is destroyed', async () => {
    mainFrame.isDestroyed.mockReturnValueOnce(true)

    await expect(invoke('bearcode:browser:show', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects calls when the authoritative main frame is missing', async () => {
    webContents.mainFrame = null

    await expect(invoke('bearcode:browser:status', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects calls when the authoritative main frame is detached', async () => {
    mainFrame.detached = true

    await expect(invoke('bearcode:browser:hide', eventFor())).rejects.toThrow(
      'Browser control unavailable.'
    )

    expectNoManagerCalls()
  })

  it('rejects a null sender frame before any manager call', async () => {
    await expect(
      invoke('bearcode:browser:clear-session', eventFor(webContents, null))
    ).rejects.toThrow('Unauthorized browser control.')

    expectNoManagerCalls()
  })
})

describe('browser bounds IPC validation', () => {
  const valid = { x: 10, y: 20, width: 100, height: 200 }

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['array', [0, 0, 1, 1]],
    ['string', '0,0,1,1'],
    ['number', 1],
    ['empty object', {}],
    ['missing x', { y: 20, width: 100, height: 200 }],
    ['missing y', { x: 10, width: 100, height: 200 }],
    ['missing width', { x: 10, y: 20, height: 200 }],
    ['missing height', { x: 10, y: 20, width: 100 }],
    ['extra key', { ...valid, scale: 2 }],
    ['string x', { ...valid, x: '10' }],
    ['string y', { ...valid, y: '20' }],
    ['string width', { ...valid, width: '100' }],
    ['string height', { ...valid, height: '200' }],
    ['NaN x', { ...valid, x: Number.NaN }],
    ['NaN y', { ...valid, y: Number.NaN }],
    ['NaN width', { ...valid, width: Number.NaN }],
    ['NaN height', { ...valid, height: Number.NaN }],
    ['infinite x', { ...valid, x: Number.POSITIVE_INFINITY }],
    ['infinite y', { ...valid, y: Number.NEGATIVE_INFINITY }],
    ['infinite width', { ...valid, width: Number.POSITIVE_INFINITY }],
    ['infinite height', { ...valid, height: Number.NEGATIVE_INFINITY }],
    ['fractional x', { ...valid, x: 10.5 }],
    ['fractional y', { ...valid, y: 20.5 }],
    ['fractional width', { ...valid, width: 100.5 }],
    ['fractional height', { ...valid, height: 200.5 }],
    ['unsafe x', { ...valid, x: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe y', { ...valid, y: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe width', { ...valid, width: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe height', { ...valid, height: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative x', { ...valid, x: -1 }],
    ['negative y', { ...valid, y: -1 }],
    ['zero width', { ...valid, width: 0 }],
    ['negative width', { ...valid, width: -1 }],
    ['zero height', { ...valid, height: 0 }],
    ['negative height', { ...valid, height: -1 }],
    ['right overflow', { x: 1101, y: 0, width: 100, height: 1 }],
    ['bottom overflow', { x: 0, y: 601, width: 1, height: 200 }],
    ['arithmetic overflow', { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 }]
  ])('rejects %s without mutating manager state', async (_name, raw) => {
    await expect(invoke('bearcode:browser:set-bounds', eventFor(), raw)).rejects.toThrow(
      'Invalid browser bounds.'
    )

    expectNoManagerCalls()
  })

  it.each([
    ['full content bounds', { x: 0, y: 0, width: 1200, height: 800 }],
    ['bottom-right pixel', { x: 1199, y: 799, width: 1, height: 1 }],
    ['interior rectangle', valid]
  ])('accepts %s unchanged', async (_name, bounds) => {
    await expect(invoke('bearcode:browser:set-bounds', eventFor(), bounds)).resolves.toBeUndefined()

    expect(browserManager.setBounds).toHaveBeenCalledOnce()
    expect(browserManager.setBounds).toHaveBeenCalledWith(bounds)
  })
})
