import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same mocking idiom as ipc.mcp.test.ts (registerIpc() pulls in nearly the
// whole main-process graph) -- kept in its own file so the compat mocks don't
// have to be threaded through the existing suites.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-compat-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./keys', () => ({
  keyStatus: vi.fn(),
  setKey: vi.fn(),
  setVaultSecret: vi.fn(),
  setCompatKey: vi.fn(),
  compatKeyStatus: vi.fn(() => ({}))
}))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
const COMPAT_ENDPOINTS = [
  { id: 'vllm', name: 'vLLM box', baseUrl: 'http://gpu.local:8000' },
  { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234' }
]
vi.mock('./settings', () => ({
  getSettings: vi.fn(() => ({ compatEndpoints: COMPAT_ENDPOINTS })),
  setSettings: vi.fn(),
  settingsInfo: vi.fn()
}))
vi.mock('./providers/registry', () => ({
  listAllModels: vi.fn(),
  listManageableModels: vi.fn(() => [])
}))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('./db', () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  clearAll: vi.fn(),
  insertArtifactComment: vi.fn(),
  listArtifactComments: vi.fn(() => []),
  isProjectTrusted: vi.fn(() => true)
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
vi.mock('./mcp/store', () => ({
  loadServers: vi.fn(() => []),
  upsertServer: vi.fn(),
  removeServer: vi.fn(),
  isEnabled: vi.fn(() => true),
  setEnabled: vi.fn(),
  isTrusted: vi.fn(() => true),
  trustProjectServer: vi.fn(),
  hasSpawnConsent: vi.fn(() => false),
  grantSpawnConsent: vi.fn()
}))
vi.mock('./mcp/manager', () => ({
  mcpManager: {
    statusOf: vi.fn(() => ({ state: 'disabled' })),
    enable: vi.fn(async () => ({ state: 'connected', tools: [] })),
    reconnect: vi.fn(async () => ({ state: 'connected', tools: [] })),
    teardown: vi.fn(async () => undefined)
  }
}))

import { registerIpc } from './ipc'

describe('bearcode:compat:* IPC surface', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc()
  })

  it('registers the compat channel set', () => {
    for (const channel of ['bearcode:compat:set-key', 'bearcode:compat:key-status']) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('set-key writes through keys.setCompatKey with the configured endpoint ids', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    handler(null, 'vllm', 'sekret')
    expect(setCompatKey).toHaveBeenCalledWith('vllm', 'sekret', ['vllm', 'lm-studio'])
  })

  it('set-key passes an empty value through unchanged (clearing is keys.ts convention)', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    handler(null, 'vllm', '')
    expect(setCompatKey).toHaveBeenCalledWith('vllm', '', ['vllm', 'lm-studio'])
  })

  it('set-key rejects a non-string endpoint id before touching keys', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    expect(() => handler(null, 42, 'sekret')).toThrow(/endpoint id/i)
    expect(() => handler(null, '', 'sekret')).toThrow(/endpoint id/i)
    expect(setCompatKey).not.toHaveBeenCalled()
  })

  it('set-key rejects a non-string value', async () => {
    const handler = handlers.get('bearcode:compat:set-key')!
    const { setCompatKey } = await import('./keys')
    expect(() => handler(null, 'vllm', null)).toThrow(/secret value/i)
    expect(setCompatKey).not.toHaveBeenCalled()
  })

  it('key-status derives from the configured endpoints and returns booleans only', async () => {
    const handler = handlers.get('bearcode:compat:key-status')!
    const { compatKeyStatus } = await import('./keys')
    vi.mocked(compatKeyStatus).mockReturnValue({ vllm: true, 'lm-studio': false })
    const result = handler(null)
    expect(compatKeyStatus).toHaveBeenCalledWith(['vllm', 'lm-studio'])
    expect(result).toEqual({ vllm: true, 'lm-studio': false })
  })
})
