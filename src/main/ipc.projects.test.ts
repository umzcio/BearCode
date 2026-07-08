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
const { upsertProjectSettings, getProjectSettings, listProjectSettings } = vi.hoisted(() => ({
  upsertProjectSettings: vi.fn(),
  getProjectSettings: vi.fn((path: string) => ({
    path,
    name: null,
    color: '#123',
    icon: null,
    defaultModelRef: null,
    defaultEffort: null,
    defaultPermissionMode: null
  })),
  listProjectSettings: vi.fn(() => [])
}))
vi.mock('./db', () => ({
  upsertProjectSettings,
  getProjectSettings,
  listProjectSettings
}))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('projects IPC (folder = project)', () => {
  it('list returns the stored folder settings rows', () => {
    handlers.get('bearcode:projects:list')!({})
    expect(listProjectSettings).toHaveBeenCalled()
  })
  it('update upserts by path and returns the resulting row', () => {
    const out = handlers.get('bearcode:projects:update')!({}, '/Users/zach/repo', { color: '#123' })
    expect(upsertProjectSettings).toHaveBeenCalledWith('/Users/zach/repo', { color: '#123' })
    expect(getProjectSettings).toHaveBeenCalledWith('/Users/zach/repo')
    expect(out).toMatchObject({ path: '/Users/zach/repo', color: '#123' })
  })
  it('update rejects a non-string / empty path', () => {
    expect(() => handlers.get('bearcode:projects:update')!({}, '', { color: '#1' })).toThrow(
      /path/i
    )
    expect(() => handlers.get('bearcode:projects:update')!({}, 42, { color: '#1' })).toThrow(
      /path/i
    )
  })
  it('update rejects a non-object patch', () => {
    expect(() => handlers.get('bearcode:projects:update')!({}, '/p', 'nope')).toThrow(/patch/i)
  })
})
