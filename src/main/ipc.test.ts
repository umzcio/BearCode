import { describe, it, expect, vi, beforeEach } from 'vitest'

// registerIpc() pulls in nearly the whole main process graph (db, orchestrator,
// permissions, settings, providers, diffs...). Mock every direct dependency so
// importing this module never opens a real database or touches Electron.
// './attachments/ingest' is intentionally left UNMOCKED: it's the module under
// test's actual security boundary for conversations:create's optional id (the
// same grammar attachments:pick enforces), and it is otherwise pure aside from
// the 'electron' app.getPath call mocked below.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./keys', () => ({ keyStatus: vi.fn(), setKey: vi.fn() }))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
vi.mock('./settings', () => ({ setSettings: vi.fn(), settingsInfo: vi.fn() }))
vi.mock('./providers/registry', () => ({
  listAllModels: vi.fn(),
  listManageableModels: vi.fn(() => [
    { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', models: [] }
  ])
}))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('./db', () => ({
  createConversation: vi.fn((projectPath: string | null, id?: string) => ({
    id: id ?? 'minted',
    projectPath
  })),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
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
import * as db from './db'

describe('conversations:create optional draft id (D4)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc()
  })

  it('rejects a malformed supplied id before it ever reaches the db', () => {
    const handler = handlers.get('bearcode:conversations:create')
    expect(handler).toBeTypeOf('function')
    expect(() => handler!(null, null, '../etc')).toThrow(/conversationId/)
    expect(() => handler!(null, null, 'a/b')).toThrow(/conversationId/)
    expect(db.createConversation).not.toHaveBeenCalled()
  })

  it('accepts a well-formed supplied id and threads it through to db.createConversation', () => {
    const handler = handlers.get('bearcode:conversations:create')!
    const result = handler(null, '/tmp/proj', 'draft-abc_123')
    expect(db.createConversation).toHaveBeenCalledWith('/tmp/proj', 'draft-abc_123')
    expect(result).toEqual({ id: 'draft-abc_123', projectPath: '/tmp/proj' })
  })

  it('creates with no id (mint path) when none is supplied', () => {
    const handler = handlers.get('bearcode:conversations:create')!
    handler(null, '/tmp/proj')
    expect(db.createConversation).toHaveBeenCalledWith('/tmp/proj', undefined)
  })

  it('models:manageable returns the manageable provider list (F7)', () => {
    const handler = handlers.get('bearcode:models:manageable')!
    expect(handler).toBeTypeOf('function')
    const result = handler(null) as { id: string }[]
    expect(result).toEqual([
      { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', models: [] }
    ])
  })
})
