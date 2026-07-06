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
const { getConversationMeta, jailPath } = vi.hoisted(() => ({
  getConversationMeta: vi.fn(),
  jailPath: vi.fn()
}))
vi.mock('./db', () => ({
  getConversationMeta
}))
vi.mock('./orchestrator/fsBackend', () => ({
  jailPath
}))

import { shell } from 'electron'
import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('shell:open-file IPC', () => {
  it('opens a jail-validated path inside the conversation workspace', () => {
    getConversationMeta.mockReturnValue({ projectPath: '/ws' })
    jailPath.mockImplementation((root: string, p: string) => `${root}/${p}`)

    handlers.get('bearcode:shell:open-file')!({}, 'c1', 'file.docx')

    expect(jailPath).toHaveBeenCalledWith('/ws', 'file.docx')
    expect(shell.openPath).toHaveBeenCalledWith('/ws/file.docx')
  })

  it('rejects when the conversation has no workspace, without calling openPath', () => {
    getConversationMeta.mockReturnValue({ projectPath: null })

    expect(() => handlers.get('bearcode:shell:open-file')!({}, 'c1', 'file.docx')).toThrow(
      /workspace/i
    )
    expect(jailPath).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('propagates a jailPath escape throw without calling openPath', () => {
    getConversationMeta.mockReturnValue({ projectPath: '/ws' })
    jailPath.mockImplementation(() => {
      throw new Error('escapes workspace root')
    })

    expect(() =>
      handlers.get('bearcode:shell:open-file')!({}, 'c1', '../../etc/passwd')
    ).toThrow(/escapes workspace root/)
    expect(shell.openPath).not.toHaveBeenCalled()
  })
})
