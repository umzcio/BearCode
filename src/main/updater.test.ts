import { describe, it, expect, vi, beforeEach } from 'vitest'

const listeners = new Map<string, (...args: unknown[]) => void>()
const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    listeners.set(event, cb)
  }),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn()
}

vi.mock('electron-updater', () => ({ autoUpdater }))

let packaged = true
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged
    }
  },
  BrowserWindow: {}
}))

function fire(event: string, ...args: unknown[]): void {
  const cb = listeners.get(event)
  if (!cb) throw new Error(`no listener registered for ${event}`)
  cb(...args)
}

function fakeWindow(): { webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed(): boolean } {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false }
}

beforeEach(() => {
  vi.resetModules()
  listeners.clear()
  autoUpdater.on.mockClear()
  autoUpdater.checkForUpdates.mockClear()
  autoUpdater.quitAndInstall.mockClear()
  packaged = true
})

describe('initUpdater', () => {
  it('registers all five autoUpdater listeners and sets autoDownload/autoInstallOnAppQuit', async () => {
    const { initUpdater } = await import('./updater')
    initUpdater(fakeWindow() as never)
    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    for (const event of [
      'checking-for-update',
      'update-available',
      'update-not-available',
      'update-downloaded',
      'error'
    ]) {
      expect(listeners.has(event)).toBe(true)
    }
  })

  it('forwards update-downloaded as a ready status with the version', async () => {
    const { initUpdater } = await import('./updater')
    const win = fakeWindow()
    initUpdater(win as never)
    fire('update-downloaded', { version: '1.2.3' })
    expect(win.webContents.send).toHaveBeenCalledWith('bearcode:updater:status', {
      state: 'ready',
      version: '1.2.3'
    })
  })

  it('forwards an error event as an error status', async () => {
    const { initUpdater } = await import('./updater')
    const win = fakeWindow()
    initUpdater(win as never)
    fire('error', new Error('network down'))
    expect(win.webContents.send).toHaveBeenCalledWith('bearcode:updater:status', {
      state: 'error',
      message: 'network down'
    })
  })

  it('is a no-op when the app is not packaged', async () => {
    packaged = false
    const { initUpdater } = await import('./updater')
    initUpdater(fakeWindow() as never)
    expect(autoUpdater.on).not.toHaveBeenCalled()
  })
})

describe('checkNow', () => {
  it('returns a dev-build status without calling autoUpdater when unpackaged', async () => {
    packaged = false
    const { checkNow } = await import('./updater')
    await expect(checkNow()).resolves.toEqual({ state: 'dev-build' })
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('calls autoUpdater.checkForUpdates and resolves up-to-date on update-not-available', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    autoUpdater.checkForUpdates.mockImplementation(() => {
      fire('update-not-available')
      return Promise.resolve()
    })
    const status = await checkNow()
    expect(status.state).toBe('up-to-date')
    expect(typeof status.checkedAt).toBe('number')
  })

  it('returns the in-flight status instead of starting a second check', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    let resolveCheck: () => void = () => {}
    autoUpdater.checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        })
    )
    const first = checkNow()
    const second = await checkNow()
    expect(second.state).toBe('checking')
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    resolveCheck()
    await first
  })

  it('resolves an error status if checkForUpdates rejects', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'))
    const status = await checkNow()
    expect(status).toEqual({ state: 'error', message: 'boom' })
  })
})

describe('installNow', () => {
  it('calls autoUpdater.quitAndInstall', async () => {
    const { initUpdater, installNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    installNow()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled()
  })
})
