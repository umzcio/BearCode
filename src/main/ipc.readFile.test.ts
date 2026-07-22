import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: vi.fn(() => '/nonexistent') },
  BrowserWindow: {},
  dialog: {},
  shell: { openPath: vi.fn(() => Promise.resolve('')) }
}))

// vi.mock factories are hoisted above regular top-level const/let declarations,
// so any vi.fn() referenced directly in a factory's returned object must be
// created via vi.hoisted() (which hoists together, in source order) rather
// than a plain const — otherwise it's a TDZ ReferenceError at import time.
const { getConversationMeta, jailPath, readFileSync } = vi.hoisted(() => ({
  getConversationMeta: vi.fn(),
  jailPath: vi.fn(),
  readFileSync: vi.fn()
}))
vi.mock('./db', () => ({
  getConversationMeta
}))
vi.mock('./orchestrator/fsBackend', () => ({
  jailPath
}))
vi.mock('fs', () => ({
  readFileSync,
  statSync: vi.fn()
}))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('shell:read-file IPC', () => {
  it('returns the text of a jail-validated path inside the conversation workspace', () => {
    getConversationMeta.mockReturnValue({ projectPath: '/ws' })
    jailPath.mockImplementation((root: string, p: string) => `${root}/${p}`)
    readFileSync.mockReturnValue('const answer = 42\n')

    const out = handlers.get('bearcode:shell:read-file')!({}, 'c1', 'src/app.ts')

    expect(jailPath).toHaveBeenCalledWith('/ws', 'src/app.ts')
    expect(readFileSync).toHaveBeenCalledWith('/ws/src/app.ts', 'utf8')
    expect(out).toBe('const answer = 42\n')
  })

  it('rejects when the conversation has no workspace, without reading anything', () => {
    getConversationMeta.mockReturnValue({ projectPath: null })

    expect(() => handlers.get('bearcode:shell:read-file')!({}, 'c1', 'src/app.ts')).toThrow(
      /workspace/i
    )
    expect(jailPath).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it('propagates a jailPath escape throw without reading anything', () => {
    getConversationMeta.mockReturnValue({ projectPath: '/ws' })
    jailPath.mockImplementation(() => {
      throw new Error('escapes workspace root')
    })

    expect(() =>
      handlers.get('bearcode:shell:read-file')!({}, 'c1', '../../etc/passwd')
    ).toThrow(/escapes workspace root/)
    expect(readFileSync).not.toHaveBeenCalled()
  })
})
