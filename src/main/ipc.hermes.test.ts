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
  getHermesToken: vi.fn(),
  setHermesPlatformKey: vi.fn(),
  getHermesPlatformKey: vi.fn(),
  getOrCreateHermesInstallationId: vi.fn()
}))
vi.mock('./hermes/gatewayClient', () => ({
  checkHermesHealth: vi.fn()
}))
vi.mock('./hermes/nativeClient', () => ({
  checkHermesNativeHealth: vi.fn()
}))
vi.mock('./hermes/nativeRunner', () => ({
  resolveHermesApproval: vi.fn(),
  resolveHermesClarification: vi.fn()
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
  setHermesMode: vi.fn(),
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
import {
  getHermesPlatformKey,
  getHermesToken,
  getOrCreateHermesInstallationId,
  setHermesPlatformKey,
  setHermesToken
} from './keys'
import { checkHermesHealth } from './hermes/gatewayClient'
import { checkHermesNativeHealth } from './hermes/nativeClient'
import { resolveHermesApproval, resolveHermesClarification } from './hermes/nativeRunner'
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
  it('creates native without a local session id and returns refreshed native metadata', async () => {
    const refreshed = {
      id: 'new-convo-id',
      hermesSessionId: null,
      hermesMode: 'native'
    }
    vi.mocked(db.getConversationMeta).mockReturnValue(refreshed as never)

    const meta = await handlers.get('bearcode:conversations:create-hermes')!({}, 'native')

    expect(db.createConversation).toHaveBeenCalledWith(null)
    expect(db.setModelRef).toHaveBeenCalledWith('new-convo-id', HERMES_MODEL_REF)
    expect(db.setHermesSessionId).not.toHaveBeenCalled()
    expect(db.setHermesMode).toHaveBeenCalledWith('new-convo-id', 'native')
    expect(meta).toBe(refreshed)
    expect(vi.mocked(db.setModelRef).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.setHermesMode).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(db.setHermesMode).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.getConversationMeta).mock.invocationCallOrder[0]
    )
  })

  it('creates legacy with a local session id before returning refreshed legacy metadata', async () => {
    const refreshed = {
      id: 'new-convo-id',
      hermesSessionId: 'legacy-session',
      hermesMode: 'legacy'
    }
    vi.mocked(db.getConversationMeta).mockReturnValue(refreshed as never)

    const meta = await handlers.get('bearcode:conversations:create-hermes')!({}, 'legacy')

    expect(db.createConversation).toHaveBeenCalledWith(null)
    expect(db.setModelRef).toHaveBeenCalledWith('new-convo-id', HERMES_MODEL_REF)
    expect(db.setHermesSessionId).toHaveBeenCalledWith('new-convo-id', expect.any(String))
    expect(db.setHermesMode).toHaveBeenCalledWith('new-convo-id', 'legacy')
    expect(meta).toBe(refreshed)
    expect(vi.mocked(db.setModelRef).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.setHermesSessionId).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(db.setHermesSessionId).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.setHermesMode).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(db.setHermesMode).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.getConversationMeta).mock.invocationCallOrder[0]
    )
  })

  it('rejects an unknown connection mode', () => {
    expect(() => handlers.get('bearcode:conversations:create-hermes')!({}, 'unknown')).toThrow(
      'Invalid Hermes connection mode'
    )
  })
})

describe('bearcode:hermes:test-connection', () => {
  it('routes legacy mode to /v1/models health with the supplied draft token', async () => {
    vi.mocked(checkHermesHealth).mockResolvedValue({ ok: true, message: 'Connected' })
    const result = await handlers.get('bearcode:hermes:test-connection')!(
      {},
      'legacy',
      'http://x:8642',
      'tok'
    )
    expect(checkHermesHealth).toHaveBeenCalledWith('http://x:8642', 'tok')
    expect(result).toEqual({ ok: true, message: 'Connected' })
  })

  it('uses the vaulted legacy token when the draft secret is blank or omitted', async () => {
    vi.mocked(getHermesToken).mockReturnValue('stored-legacy')
    vi.mocked(checkHermesHealth).mockResolvedValue({ ok: true, message: 'Connected' })

    await handlers.get('bearcode:hermes:test-connection')!({}, 'legacy', 'http://x:8642', '')
    await handlers.get('bearcode:hermes:test-connection')!({}, 'legacy', 'http://x:8642')

    expect(checkHermesHealth).toHaveBeenNthCalledWith(1, 'http://x:8642', 'stored-legacy')
    expect(checkHermesHealth).toHaveBeenNthCalledWith(2, 'http://x:8642', 'stored-legacy')
  })

  it('routes native mode with the main-only installation id and supplied platform key', async () => {
    vi.mocked(getOrCreateHermesInstallationId).mockReturnValue('installation-main-only')
    vi.mocked(checkHermesNativeHealth).mockResolvedValue({ ok: true, message: 'Connected' })

    const result = await handlers.get('bearcode:hermes:test-connection')!(
      {},
      'native',
      'ws://x:8643',
      'platform-draft'
    )

    expect(checkHermesNativeHealth).toHaveBeenCalledWith(
      'ws://x:8643',
      'platform-draft',
      'installation-main-only'
    )
    expect(result).toEqual({ ok: true, message: 'Connected' })
  })

  it('uses the vaulted native platform key when the draft secret is blank', async () => {
    vi.mocked(getHermesPlatformKey).mockReturnValue('stored-native')
    vi.mocked(getOrCreateHermesInstallationId).mockReturnValue('installation-main-only')
    vi.mocked(checkHermesNativeHealth).mockResolvedValue({ ok: true, message: 'Connected' })

    await handlers.get('bearcode:hermes:test-connection')!({}, 'native', 'ws://x:8643', '')

    expect(checkHermesNativeHealth).toHaveBeenCalledWith(
      'ws://x:8643',
      'stored-native',
      'installation-main-only'
    )
  })

  it('reports a missing native plugin separately from key, protocol, and network failures', async () => {
    vi.mocked(getOrCreateHermesInstallationId).mockReturnValue('installation-main-only')
    vi.mocked(checkHermesNativeHealth)
      .mockResolvedValueOnce({ ok: false, message: 'Unexpected server response: 404' })
      .mockResolvedValueOnce({
        ok: false,
        message: 'Rejected — check the platform key in Settings'
      })
      .mockResolvedValueOnce({ ok: false, message: 'Incompatible native Hermes protocol' })
      .mockResolvedValueOnce({ ok: false, message: 'ECONNREFUSED' })

    const invoke = () =>
      handlers.get('bearcode:hermes:test-connection')!(
        {},
        'native',
        'ws://x:8643',
        'platform-key'
      )

    await expect(invoke()).resolves.toEqual({
      ok: false,
      message: 'Native platform unavailable — install and enable the BearCode plugin on Hermes'
    })
    await expect(invoke()).resolves.toEqual({
      ok: false,
      message: 'Rejected — check the platform key in Settings'
    })
    await expect(invoke()).resolves.toEqual({
      ok: false,
      message: 'Incompatible native Hermes protocol'
    })
    await expect(invoke()).resolves.toEqual({ ok: false, message: 'ECONNREFUSED' })
  })

  it.each([
    ['bad mode', 'unknown', 'http://x', undefined],
    ['non-string url', 'legacy', 42, undefined],
    ['non-string secret', 'native', 'ws://x', 42]
  ])('rejects %s before any health call', async (_label, mode, url, secret) => {
    await expect(
      handlers.get('bearcode:hermes:test-connection')!({}, mode, url, secret)
    ).rejects.toThrow()
    expect(checkHermesHealth).not.toHaveBeenCalled()
    expect(checkHermesNativeHealth).not.toHaveBeenCalled()
  })
})

describe('Hermes credential setters', () => {
  it('stores the legacy token in its dedicated vault entry', () => {
    handlers.get('bearcode:hermes:set-legacy-token')!({}, 'new-token')
    expect(setHermesToken).toHaveBeenCalledWith('new-token')
  })

  it('stores the native platform key in its dedicated vault entry', () => {
    handlers.get('bearcode:hermes:set-platform-key')!({}, 'new-platform-key')
    expect(setHermesPlatformKey).toHaveBeenCalledWith('new-platform-key')
  })

  it.each([
    ['bearcode:hermes:set-legacy-token', 42],
    ['bearcode:hermes:set-platform-key', null]
  ])('rejects a non-string credential on %s', (channel, value) => {
    expect(() => handlers.get(channel)!({}, value)).toThrow()
    expect(setHermesToken).not.toHaveBeenCalled()
    expect(setHermesPlatformKey).not.toHaveBeenCalled()
  })
})

describe('native Hermes interactions', () => {
  const conversationId = '11111111-1111-4111-8111-111111111111'
  const requestId = '22222222-2222-4222-8222-222222222222'

  it('validates and routes an approval decision to the active native turn', async () => {
    vi.mocked(resolveHermesApproval).mockReturnValue(true)

    await handlers.get('bearcode:hermes:resolve-approval')!(
      {},
      conversationId,
      requestId,
      'session'
    )

    expect(resolveHermesApproval).toHaveBeenCalledWith(conversationId, requestId, 'session')
  })

  it.each([
    ['bad conversation id', '../escape', requestId, 'once'],
    ['bad request id', conversationId, 'not-a-uuid', 'once'],
    ['bad decision', conversationId, requestId, 'sometimes']
  ])('rejects %s before routing', async (_label, conversation, request, decision) => {
    expect(() =>
      handlers.get('bearcode:hermes:resolve-approval')!({}, conversation, request, decision)
    ).toThrow()
    expect(resolveHermesApproval).not.toHaveBeenCalled()
  })

  it('validates and routes a clarification response to the active native turn', async () => {
    vi.mocked(resolveHermesClarification).mockReturnValue(true)

    await handlers.get('bearcode:hermes:resolve-clarification')!(
      {},
      conversationId,
      requestId,
      'Use desktop'
    )

    expect(resolveHermesClarification).toHaveBeenCalledWith(
      conversationId,
      requestId,
      'Use desktop'
    )
  })

  it.each([
    ['bad conversation id', '../escape', requestId, 'answer'],
    ['bad request id', conversationId, 'not-a-uuid', 'answer'],
    ['non-string response', conversationId, requestId, 42]
  ])('rejects clarification with %s before routing', (_label, conversation, request, response) => {
    expect(() =>
      handlers.get('bearcode:hermes:resolve-clarification')!(
        {},
        conversation,
        request,
        response
      )
    ).toThrow()
    expect(resolveHermesClarification).not.toHaveBeenCalled()
  })
})
