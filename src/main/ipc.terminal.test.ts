import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-terminal-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, statSync: vi.fn(() => ({ isDirectory: () => true })) }
})
vi.mock('./terminal/manager', () => ({
  terminalManager: {
    create: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    list: vi.fn(() => []),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn())
  }
}))
vi.mock('./keys', () => ({
  keyStatus: vi.fn(),
  setKey: vi.fn(),
  setHermesToken: vi.fn(),
  getHermesToken: vi.fn()
}))
vi.mock('./hermes/gatewayClient', () => ({ checkHermesHealth: vi.fn() }))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
vi.mock('./settings', () => ({ setSettings: vi.fn(), settingsInfo: vi.fn() }))
vi.mock('./providers/registry', () => ({ listAllModels: vi.fn(), listManageableModels: vi.fn() }))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('./db', () => ({
  createConversation: vi.fn(),
  setModelRef: vi.fn(),
  setHermesSessionId: vi.fn(),
  getConversationMeta: vi.fn(),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  setEffort: vi.fn(),
  setUrsaMode: vi.fn(),
  setThinking: vi.fn(),
  clearAll: vi.fn(),
  insertArtifactComment: vi.fn(),
  listArtifactComments: vi.fn(() => []),
  getProjectSettings: vi.fn(() => null),
  hasConversationForProject: vi.fn(() => false)
}))
vi.mock('./agentsDir', () => ({ loadAgentsContent: vi.fn() }))
vi.mock('./orchestrator/commands', () => ({ listCommands: vi.fn() }))
vi.mock('./orchestrator/mentionSuggest', () => ({
  suggestFiles: vi.fn(),
  manualRuleInfos: vi.fn()
}))
vi.mock('./orchestrator', () => ({
  assertValidAttachments: vi.fn(),
  assertValidCommand: vi.fn(),
  assertValidMentions: vi.fn(),
  assertValidPlanReviewResolution: vi.fn(),
  cancelRunOrchestrator: vi.fn(),
  clearRunsOrchestrator: vi.fn(),
  forgetRunOrchestrator: vi.fn(),
  pruneCheckpoints: vi.fn(),
  resolveApprovalOrchestrator: vi.fn(),
  resolvePlanReviewOrchestrator: vi.fn(),
  resumeInterruptedRuns: vi.fn(),
  startRunOrchestrator: vi.fn()
}))

import { registerIpc } from './ipc'
import { terminalManager } from './terminal/manager'
import * as db from './db'
import { statSync } from 'fs'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  // Default: every path is "known" (has an existing conversation) so the 6
  // pre-existing delegation tests below don't need to care about the new
  // known-project check -- rejection tests override this per-case.
  vi.mocked(db.hasConversationForProject).mockReturnValue(true)
  registerIpc()
})

describe('bearcode:terminal:* IPC surface', () => {
  it('registers the full terminal:* channel set', () => {
    for (const channel of [
      'bearcode:terminal:create',
      'bearcode:terminal:write',
      'bearcode:terminal:resize',
      'bearcode:terminal:close',
      'bearcode:terminal:list'
    ]) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('create() delegates to terminalManager.create with the project path', () => {
    const view = { id: 'x', projectPath: '/proj', title: 'zsh', createdAt: 0, exited: false }
    vi.mocked(terminalManager.create).mockReturnValue(view)
    const handler = handlers.get('bearcode:terminal:create')!
    expect(handler(null, '/proj')).toEqual(view)
    expect(terminalManager.create).toHaveBeenCalledWith('/proj')
  })

  it('write() delegates to terminalManager.write with id and data', () => {
    const handler = handlers.get('bearcode:terminal:write')!
    handler(null, 'x', 'ls\n')
    expect(terminalManager.write).toHaveBeenCalledWith('x', 'ls\n')
  })

  it('resize() delegates to terminalManager.resize with id, cols, rows', () => {
    const handler = handlers.get('bearcode:terminal:resize')!
    handler(null, 'x', 120, 40)
    expect(terminalManager.resize).toHaveBeenCalledWith('x', 120, 40)
  })

  it('close() delegates to terminalManager.close with id', () => {
    const handler = handlers.get('bearcode:terminal:close')!
    handler(null, 'x')
    expect(terminalManager.close).toHaveBeenCalledWith('x')
  })

  it('list() delegates to terminalManager.list with the project path', () => {
    vi.mocked(terminalManager.list).mockReturnValue([])
    const handler = handlers.get('bearcode:terminal:list')!
    expect(handler(null, '/proj')).toEqual([])
    expect(terminalManager.list).toHaveBeenCalledWith('/proj')
  })

  it('wires terminalManager.onData/onExit exactly once per registerIpc() call', () => {
    expect(terminalManager.onData).toHaveBeenCalledTimes(1)
    expect(terminalManager.onExit).toHaveBeenCalledTimes(1)
  })

  it('create() rejects a path that is not absolute', () => {
    const handler = handlers.get('bearcode:terminal:create')!
    expect(() => handler(null, 'relative/path')).toThrow(/Unknown or invalid project path/)
    expect(terminalManager.create).not.toHaveBeenCalled()
  })

  it('create() rejects a path this app has never seen', () => {
    vi.mocked(db.getProjectSettings).mockReturnValue(null)
    vi.mocked(db.hasConversationForProject).mockReturnValue(false)
    const handler = handlers.get('bearcode:terminal:create')!
    expect(() => handler(null, '/proj/unknown')).toThrow(/Unknown or invalid project path/)
    expect(terminalManager.create).not.toHaveBeenCalled()
  })

  it('create() rejects a path that does not exist / is not a directory', () => {
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    vi.mocked(db.hasConversationForProject).mockReturnValue(true)
    const handler = handlers.get('bearcode:terminal:create')!
    expect(() => handler(null, '/proj/gone')).toThrow(/Unknown or invalid project path/)
  })

  it('create() accepts a path known via an existing conversation, even with no project_settings row', () => {
    vi.mocked(db.getProjectSettings).mockReturnValue(null)
    vi.mocked(db.hasConversationForProject).mockReturnValue(true)
    const view = { id: 'x', projectPath: '/proj/a', title: 'zsh', createdAt: 0, exited: false }
    vi.mocked(terminalManager.create).mockReturnValue(view)
    const handler = handlers.get('bearcode:terminal:create')!
    expect(handler(null, '/proj/a')).toEqual(view)
  })

  it('write() rejects non-string data', () => {
    const handler = handlers.get('bearcode:terminal:write')!
    expect(() => handler(null, 'x', 12345)).toThrow(/Invalid terminal data/)
    expect(terminalManager.write).not.toHaveBeenCalled()
  })

  it('write() rejects a non-string id', () => {
    const handler = handlers.get('bearcode:terminal:write')!
    expect(() => handler(null, 12345, 'ls\n')).toThrow(/Invalid terminal id/)
  })

  it('resize() rejects non-finite cols/rows', () => {
    const handler = handlers.get('bearcode:terminal:resize')!
    expect(() => handler(null, 'x', NaN, 40)).toThrow(/Invalid terminal size/)
    expect(() => handler(null, 'x', 120, 'forty')).toThrow(/Invalid terminal size/)
    expect(terminalManager.resize).not.toHaveBeenCalled()
  })

  it('close() rejects a non-string id', () => {
    const handler = handlers.get('bearcode:terminal:close')!
    expect(() => handler(null, { id: 'x' })).toThrow(/Invalid terminal id/)
  })
})
