import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-updater-test'), getVersion: vi.fn(() => '1.0.0') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))

const checkNow = vi.fn(async () => ({ state: 'up-to-date' as const, checkedAt: 123 }))
const installNow = vi.fn()
vi.mock('./updater', () => ({ checkNow, installNow, initUpdater: vi.fn() }))

beforeEach(async () => {
  vi.clearAllMocks()
  handlers.clear()
  const { registerIpc } = await import('./ipc')
  registerIpc()
})

describe('updater IPC', () => {
  it('bearcode:app:getVersion returns app.getVersion()', async () => {
    const handler = handlers.get('bearcode:app:getVersion')
    expect(handler).toBeDefined()
    expect(await handler!({})).toBe('1.0.0')
  })

  it('bearcode:updater:checkNow delegates to checkNow()', async () => {
    const handler = handlers.get('bearcode:updater:checkNow')
    expect(handler).toBeDefined()
    expect(await handler!({})).toEqual({ state: 'up-to-date', checkedAt: 123 })
    expect(checkNow).toHaveBeenCalled()
  })

  it('bearcode:updater:installNow delegates to installNow()', async () => {
    const handler = handlers.get('bearcode:updater:installNow')
    expect(handler).toBeDefined()
    await handler!({})
    expect(installNow).toHaveBeenCalled()
  })
})
