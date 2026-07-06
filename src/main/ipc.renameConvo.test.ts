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
const { setTitle } = vi.hoisted(() => ({
  setTitle: vi.fn()
}))
vi.mock('./db', () => ({
  setTitle
}))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('rename conversation IPC', () => {
  it('rename calls db.setTitle with the trimmed title', () => {
    handlers.get('bearcode:conversations:rename')!({}, 'c1', '  New Title  ')
    expect(setTitle).toHaveBeenCalledWith('c1', 'New Title')
  })
  it('throws on an empty/whitespace title', () => {
    expect(() => handlers.get('bearcode:conversations:rename')!({}, 'c1', '   ')).toThrow(
      /title/i
    )
    expect(() => handlers.get('bearcode:conversations:rename')!({}, 'c1', '')).toThrow(/title/i)
  })
})
