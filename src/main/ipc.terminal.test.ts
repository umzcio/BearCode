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
  listArtifactComments: vi.fn(() => [])
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

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
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
})
