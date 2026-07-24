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

const { shellOpenPath, deleteConversationAttachments, openAttachment } = vi.hoisted(() => ({
  shellOpenPath: vi.fn(),
  deleteConversationAttachments: vi.fn(),
  openAttachment: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: shellOpenPath },
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
  getConversationMeta: vi.fn(() => ({ worktrees: [] })),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  clearAll: vi.fn(),
  insertArtifactComment: vi.fn(),
  listArtifactComments: vi.fn(() => [])
}))
vi.mock('./hermes/nativeFiles', () => ({ deleteConversationAttachments, openAttachment }))
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

describe('native attachment IPC and cleanup', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    vi.mocked(db.getConversationMeta).mockReturnValue({ worktrees: [] } as never)
    vi.mocked(db.listConversations).mockReturnValue([])
    registerIpc()
  })

  it('opens only through the native attachment storage helper', async () => {
    const handler = handlers.get('bearcode:attachments:open')
    expect(handler).toBeTypeOf('function')

    await handler!(null, 'c1', 'a1')

    expect(openAttachment).toHaveBeenCalledWith(
      '/tmp/bearcode-ipc-test',
      'c1',
      'a1',
      shellOpenPath
    )
  })

  it('deletes a conversation row before reclaiming only that conversation attachment directory', async () => {
    const handler = handlers.get('bearcode:conversations:delete')
    expect(handler).toBeTypeOf('function')

    await handler!(null, 'c1')

    expect(db.deleteConversation).toHaveBeenCalledWith('c1')
    expect(deleteConversationAttachments).toHaveBeenCalledWith('/tmp/bearcode-ipc-test', 'c1')
    expect(vi.mocked(db.deleteConversation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteConversationAttachments).mock.invocationCallOrder[0]
    )
  })

  it('captures all conversation IDs before clear and reclaims each attachment directory', async () => {
    vi.mocked(db.listConversations).mockReturnValue([{ id: 'c1' }, { id: 'c2' }] as never)
    const handler = handlers.get('bearcode:conversations:clear')
    expect(handler).toBeTypeOf('function')

    await handler!(null)

    expect(db.clearAll).toHaveBeenCalledOnce()
    expect(deleteConversationAttachments).toHaveBeenCalledWith('/tmp/bearcode-ipc-test', 'c1')
    expect(deleteConversationAttachments).toHaveBeenCalledWith('/tmp/bearcode-ipc-test', 'c2')
  })
})
