import { describe, it, expect, vi, beforeEach } from 'vitest'

// registerIpc() pulls in nearly the whole main process graph (db, orchestrator,
// permissions, settings, providers, diffs...). Mock every direct dependency
// (mirrors ipc.ursaMode.test.ts's precedent) so importing this module never
// opens a real database or touches Electron.
type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-hermes-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./keys', () => ({
  keyStatus: vi.fn(),
  setKey: vi.fn(),
  setHermesToken: vi.fn(),
  getHermesToken: vi.fn()
}))
vi.mock('./hermes/gatewayClient', () => ({
  checkHermesHealth: vi.fn()
}))
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
import * as db from './db'
import { setHermesToken } from './keys'
import { checkHermesHealth } from './hermes/gatewayClient'
import { HERMES_MODEL_REF } from '../shared/types'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  vi.mocked(db.createConversation).mockReturnValue({ id: 'new-convo-id' } as never)
  vi.mocked(db.getConversationMeta).mockReturnValue({
    id: 'new-convo-id',
    hermesSessionId: 'sess-x'
  } as never)
  registerIpc()
})

describe('bearcode:conversations:create-hermes', () => {
  it('creates a project-less conversation, sets the sentinel modelRef, and assigns a session id', async () => {
    const meta = await handlers.get('bearcode:conversations:create-hermes')!({})
    expect(db.createConversation).toHaveBeenCalledWith(null)
    expect(db.setModelRef).toHaveBeenCalledWith('new-convo-id', HERMES_MODEL_REF)
    expect(db.setHermesSessionId).toHaveBeenCalledWith('new-convo-id', expect.any(String))
    expect(meta).toMatchObject({ id: 'new-convo-id' })
  })
})

describe('bearcode:hermes:test-connection', () => {
  it('delegates to checkHermesHealth with the given url and token', async () => {
    vi.mocked(checkHermesHealth).mockResolvedValue({ ok: true, message: 'Connected' })
    const result = await handlers.get('bearcode:hermes:test-connection')!(
      {},
      'http://x:8642',
      'tok'
    )
    expect(checkHermesHealth).toHaveBeenCalledWith('http://x:8642', 'tok')
    expect(result).toEqual({ ok: true, message: 'Connected' })
  })
})

describe('bearcode:hermes:set-token', () => {
  it('delegates to setHermesToken', () => {
    handlers.get('bearcode:hermes:set-token')!({}, 'new-token')
    expect(setHermesToken).toHaveBeenCalledWith('new-token')
  })
})
