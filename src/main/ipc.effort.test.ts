import { describe, it, expect, vi, beforeEach } from 'vitest'

// registerIpc() pulls in nearly the whole main process graph (db, orchestrator,
// permissions, settings, providers, diffs...). Mock every direct dependency
// (mirrors ipc.test.ts's precedent) so importing this module never opens a
// real database or touches Electron. './attachments/ingest' is intentionally
// left UNMOCKED, matching ipc.test.ts.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-effort-test') },
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
vi.mock('./providers/registry', () => ({ listAllModels: vi.fn(), listManageableModels: vi.fn() }))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))

vi.mock('./db', () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  setEffort: vi.fn(),
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

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('set-effort / set-thinking IPC guards', () => {
  it('set-effort persists a valid level', () => {
    handlers.get('bearcode:conversations:set-effort')!({}, 'c1', 'high')
    expect(db.setEffort).toHaveBeenCalledWith('c1', 'high')
  })
  it('set-effort throws on garbage', () => {
    expect(() =>
      handlers.get('bearcode:conversations:set-effort')!({}, 'c1', 'ultra')
    ).toThrow(/Invalid effort/)
    expect(db.setEffort).not.toHaveBeenCalled()
  })
  it('set-thinking coerces to boolean', () => {
    handlers.get('bearcode:conversations:set-thinking')!({}, 'c1', true)
    expect(db.setThinking).toHaveBeenCalledWith('c1', true)
  })
  it('set-thinking throws on non-boolean', () => {
    expect(() =>
      handlers.get('bearcode:conversations:set-thinking')!({}, 'c1', 'yes')
    ).toThrow(/Invalid thinking/)
  })
})
