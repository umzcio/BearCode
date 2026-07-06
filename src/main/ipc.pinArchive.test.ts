import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: vi.fn(() => '/nonexistent') },
  BrowserWindow: {},
  dialog: {},
  shell: {}
}))

// vi.mock factories are hoisted above regular top-level const/let declarations,
// so any vi.fn() referenced directly in a factory's returned object must be
// created via vi.hoisted() (which hoists together, in source order) rather
// than a plain const — otherwise it's a TDZ ReferenceError at import time.
const { setPinned, setArchived } = vi.hoisted(() => ({
  setPinned: vi.fn(),
  setArchived: vi.fn()
}))
vi.mock('./db', () => ({
  setPinned,
  setArchived
}))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('pin/archive IPC', () => {
  it('set-pinned coerces a boolean and calls db.setPinned', () => {
    handlers.get('bearcode:conversations:set-pinned')!({}, 'c1', true)
    expect(setPinned).toHaveBeenCalledWith('c1', true)
    expect(() => handlers.get('bearcode:conversations:set-pinned')!({}, 'c1', 'nope')).toThrow(
      /pinned/i
    )
  })
  it('set-archived coerces a boolean and calls db.setArchived', () => {
    handlers.get('bearcode:conversations:set-archived')!({}, 'c1', false)
    expect(setArchived).toHaveBeenCalledWith('c1', false)
    expect(() => handlers.get('bearcode:conversations:set-archived')!({}, 'c1', 'nope')).toThrow(
      /archived/i
    )
  })
})
