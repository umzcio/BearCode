import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same mocking idiom as ipc.mcp.test.ts -- registerIpc() pulls in nearly the
// whole main-process graph, so only the channels this file exercises get
// meaningful mocks; everything else is stubbed just enough to import cleanly.
type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-integrations-test') },
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

const { getIntegration, setIntegration, saveIntegrationToken, disconnect } = vi.hoisted(() => ({
  getIntegration: vi.fn(),
  setIntegration: vi.fn(),
  saveIntegrationToken: vi.fn(),
  disconnect: vi.fn()
}))
vi.mock('./integrations/store', () => ({
  getIntegration,
  setIntegration,
  saveIntegrationToken,
  disconnect
}))

const { githubDeviceStart, githubDevicePoll, githubConnectPat } = vi.hoisted(() => ({
  githubDeviceStart: vi.fn(),
  githubDevicePoll: vi.fn(),
  githubConnectPat: vi.fn()
}))
vi.mock('./integrations/github', () => ({
  githubDeviceStart,
  githubDevicePoll,
  githubConnectPat
}))

const { bitbucketConnect } = vi.hoisted(() => ({ bitbucketConnect: vi.fn() }))
vi.mock('./integrations/bitbucket', () => ({ bitbucketConnect }))

import { registerIpc } from './ipc'

describe('bearcode:integrations:* IPC surface (Task 11)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    getIntegration.mockImplementation((p: 'github' | 'bitbucket') => ({
      provider: p,
      connected: false
    }))
    registerIpc()
  })

  it('registers the full integrations:* channel set', () => {
    for (const channel of [
      'bearcode:integrations:status',
      'bearcode:integrations:github-device-start',
      'bearcode:integrations:github-device-poll',
      'bearcode:integrations:github-connect-pat',
      'bearcode:integrations:connect-bitbucket',
      'bearcode:integrations:disconnect'
    ]) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('status() returns both providers via getIntegration, never a token', () => {
    getIntegration.mockImplementation((p: 'github' | 'bitbucket') =>
      p === 'github'
        ? { provider: 'github', connected: true, method: 'pat', login: 'zach' }
        : { provider: 'bitbucket', connected: false }
    )
    const handler = handlers.get('bearcode:integrations:status')!
    const result = handler(null) as unknown[]
    expect(result).toEqual([
      { provider: 'github', connected: true, method: 'pat', login: 'zach' },
      { provider: 'bitbucket', connected: false }
    ])
    // No field in the wire result ever carries anything token-shaped.
    expect(JSON.stringify(result)).not.toMatch(/token/i)
  })

  it('github-device-start() delegates to githubDeviceStart', async () => {
    githubDeviceStart.mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      deviceCode: 'dc',
      interval: 5
    })
    const handler = handlers.get('bearcode:integrations:github-device-start')!
    const result = await handler(null)
    expect(result).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      deviceCode: 'dc',
      interval: 5
    })
  })

  it('github-device-poll() vaults the token and never returns it', async () => {
    githubDevicePoll.mockResolvedValue({ token: 'ghp_secret', login: 'zach', scopes: ['repo'] })
    const handler = handlers.get('bearcode:integrations:github-device-poll')!
    const result = (await handler(null, 'dc', 5)) as Record<string, unknown>
    expect(githubDevicePoll).toHaveBeenCalledWith('dc', 5)
    expect(saveIntegrationToken).toHaveBeenCalledWith('github', { token: 'ghp_secret' })
    expect(setIntegration).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({
        provider: 'github',
        connected: true,
        method: 'device',
        login: 'zach'
      })
    )
    expect(result).toEqual(
      expect.objectContaining({ provider: 'github', connected: true, login: 'zach' })
    )
    expect(JSON.stringify(result)).not.toMatch(/ghp_secret/)
  })

  it('github-device-poll() rejects malformed arguments', async () => {
    const handler = handlers.get('bearcode:integrations:github-device-poll')!
    await expect(handler(null, 123, 5)).rejects.toThrow(/invalid/i)
    expect(githubDevicePoll).not.toHaveBeenCalled()
  })

  it('github-connect-pat() vaults the trimmed token and never returns it', async () => {
    githubConnectPat.mockResolvedValue({ login: 'zach', scopes: ['repo'] })
    const handler = handlers.get('bearcode:integrations:github-connect-pat')!
    const result = (await handler(null, '  ghp_abc  ')) as Record<string, unknown>
    expect(githubConnectPat).toHaveBeenCalledWith('ghp_abc')
    expect(saveIntegrationToken).toHaveBeenCalledWith('github', { token: 'ghp_abc' })
    expect(setIntegration).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ provider: 'github', connected: true, method: 'pat' })
    )
    expect(JSON.stringify(result)).not.toMatch(/ghp_abc/)
  })

  it('github-connect-pat() rejects an empty token', async () => {
    const handler = handlers.get('bearcode:integrations:github-connect-pat')!
    await expect(handler(null, '   ')).rejects.toThrow(/token/i)
    expect(githubConnectPat).not.toHaveBeenCalled()
  })

  it('connect-bitbucket() vaults the app password and never returns it', async () => {
    bitbucketConnect.mockResolvedValue({ username: 'zrossmiller' })
    const handler = handlers.get('bearcode:integrations:connect-bitbucket')!
    const result = (await handler(null, 'zrossmiller', 'app-pw-secret')) as Record<string, unknown>
    expect(bitbucketConnect).toHaveBeenCalledWith('zrossmiller', 'app-pw-secret')
    expect(saveIntegrationToken).toHaveBeenCalledWith('bitbucket', { token: 'app-pw-secret' })
    expect(setIntegration).toHaveBeenCalledWith(
      'bitbucket',
      expect.objectContaining({
        provider: 'bitbucket',
        connected: true,
        method: 'app-password',
        login: 'zrossmiller'
      })
    )
    expect(JSON.stringify(result)).not.toMatch(/app-pw-secret/)
  })

  it('connect-bitbucket() rejects missing credentials', async () => {
    const handler = handlers.get('bearcode:integrations:connect-bitbucket')!
    await expect(handler(null, '', 'pw')).rejects.toThrow(/required/i)
    expect(bitbucketConnect).not.toHaveBeenCalled()
  })

  it('disconnect() delegates to store.disconnect for a valid provider', () => {
    const handler = handlers.get('bearcode:integrations:disconnect')!
    handler(null, 'github')
    expect(disconnect).toHaveBeenCalledWith('github')
  })

  it('disconnect() rejects an invalid provider', () => {
    const handler = handlers.get('bearcode:integrations:disconnect')!
    expect(() => handler(null, 'gitlab')).toThrow(/invalid/i)
    expect(disconnect).not.toHaveBeenCalled()
  })
})
