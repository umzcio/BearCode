import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same mocking idiom as ipc.test.ts (registerIpc() pulls in nearly the whole
// main-process graph) -- kept in its own file per the plan so the mcp:* mocks
// don't have to be threaded through the large existing ipc.test.ts suite.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-mcp-test') },
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
  setVaultSecret: vi.fn()
}))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
vi.mock('./settings', () => ({ setSettings: vi.fn(), settingsInfo: vi.fn() }))
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

const testConfig = {
  name: 'gh',
  transport: 'http' as const,
  url: 'https://example.test/mcp',
  source: 'global' as const
}

vi.mock('./mcp/store', () => ({
  loadServers: vi.fn(() => [testConfig]),
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

describe('bearcode:mcp:* IPC surface (Task 8)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc()
  })

  it('registers the full mcp:* channel set', () => {
    for (const channel of [
      'bearcode:mcp:list',
      'bearcode:mcp:add',
      'bearcode:mcp:remove',
      'bearcode:mcp:set-enabled',
      'bearcode:mcp:trust',
      'bearcode:mcp:spawn-consent',
      'bearcode:mcp:reconnect',
      'bearcode:mcp:status',
      'bearcode:mcp:set-secret',
      'bearcode:mcp:smithery-search',
      'bearcode:mcp:smithery-install'
    ]) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('list() merges store config + enabled + trust into McpServerView[]', () => {
    const handler = handlers.get('bearcode:mcp:list')!
    const result = handler(null, '/proj')
    expect(result).toEqual([
      { config: testConfig, enabled: true, status: { state: 'disabled' }, spawnConsented: false }
    ])
  })

  it('rejects a malformed remove() source before touching the store', async () => {
    const handler = handlers.get('bearcode:mcp:remove')!
    const { removeServer } = await import('./mcp/store')
    expect(() => handler(null, 'gh', 'bogus', null)).toThrow(/source/i)
    expect(removeServer).not.toHaveBeenCalled()
  })

  it('add() moves a plaintext header secret into the vault before persisting', async () => {
    const handler = handlers.get('bearcode:mcp:add')!
    const { setVaultSecret } = await import('./keys')
    const { upsertServer } = await import('./mcp/store')
    handler(
      null,
      {
        name: 'gh',
        transport: 'http',
        url: 'https://x',
        source: 'global',
        headers: { Authorization: 'Bearer ghp_secret' }
      },
      null
    )
    expect(setVaultSecret).toHaveBeenCalledWith('mcp:gh:headers:Authorization', 'Bearer ghp_secret')
    const persisted = vi.mocked(upsertServer).mock.calls[0][0]
    expect(persisted.headers).toEqual({
      Authorization: '${VAULT:mcp:gh:headers:Authorization}'
    })
  })

  it('add() leaves an existing ${VAULT:} reference untouched', async () => {
    const handler = handlers.get('bearcode:mcp:add')!
    const { setVaultSecret } = await import('./keys')
    handler(
      null,
      {
        name: 'gh',
        transport: 'http',
        url: 'https://x',
        source: 'global',
        headers: { Authorization: '${VAULT:mykey}' }
      },
      null
    )
    expect(setVaultSecret).not.toHaveBeenCalled()
  })

  it('add() rejects a config with no name (no servers[undefined] key)', async () => {
    const handler = handlers.get('bearcode:mcp:add')!
    const { upsertServer } = await import('./mcp/store')
    expect(() => handler(null, { transport: 'http', url: 'x', source: 'global' }, null)).toThrow(
      /name/i
    )
    expect(upsertServer).not.toHaveBeenCalled()
  })

  it('setSecret writes through keys.setVaultSecret (never a getter)', async () => {
    const handler = handlers.get('bearcode:mcp:set-secret')!
    const { setVaultSecret } = await import('./keys')
    handler(null, 'mcp:gh:token', 'sekret')
    expect(setVaultSecret).toHaveBeenCalledWith('mcp:gh:token', 'sekret')
  })
})
