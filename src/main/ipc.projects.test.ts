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
const { createProject, renameProject, deleteProject, setConversationProject } = vi.hoisted(() => ({
  createProject: vi.fn(() => ({ id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 1 })),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
  setConversationProject: vi.fn()
}))
const listProjectsIds = new Set(['p1'])
vi.mock('./db', () => ({
  createProject,
  renameProject,
  deleteProject,
  listProjects: () => (listProjectsIds.size ? [{ id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 1 }] : []),
  setConversationProject
}))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('projects IPC', () => {
  it('create trims + rejects empty name', () => {
    handlers.get('bearcode:projects:create')!({}, '  Campus  ')
    expect(createProject).toHaveBeenCalledWith('Campus', null)
    expect(() => handlers.get('bearcode:projects:create')!({}, '   ')).toThrow(/name/i)
  })
  it('create rejects an over-long name', () => {
    expect(() => handlers.get('bearcode:projects:create')!({}, 'x'.repeat(81))).toThrow(/name/i)
  })
  it('set-project accepts an existing id and null, rejects unknown', () => {
    handlers.get('bearcode:conversations:set-project')!({}, 'c1', 'p1')
    expect(setConversationProject).toHaveBeenCalledWith('c1', 'p1')
    handlers.get('bearcode:conversations:set-project')!({}, 'c1', null)
    expect(setConversationProject).toHaveBeenCalledWith('c1', null)
    expect(() => handlers.get('bearcode:conversations:set-project')!({}, 'c1', 'nope')).toThrow(/project/i)
  })
})
