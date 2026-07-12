import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServerConfig } from '../../shared/types'

// A remote (http) server — the only transport that can do OAuth. store.ts is
// mocked so this test exercises only the manager's OAuth lifecycle.
const httpConfig: McpServerConfig = {
  name: 'oauth-server',
  transport: 'http',
  url: 'https://example.test/mcp',
  source: 'global'
}

const isEnabledMock = vi.fn(() => true)
const isTrustedMock = vi.fn(() => true)
const hasSpawnConsentMock = vi.fn(() => true)
vi.mock('./store', () => ({
  loadServers: vi.fn(() => [httpConfig]),
  resolveConfig: vi.fn((cfg: McpServerConfig) => cfg),
  isEnabled: (...a: unknown[]) => isEnabledMock(...(a as [])),
  isTrusted: (...a: unknown[]) => isTrustedMock(...(a as [])),
  hasSpawnConsent: (...a: unknown[]) => hasSpawnConsentMock(...(a as []))
}))
// manager.ts threads workspace trust into every loadServers call via
// isProjectTrusted (../db) -- mock it so this test never touches the real
// sqlite-backed db module.
vi.mock('../db', () => ({
  isProjectTrusted: vi.fn(() => true)
}))

// Capture the connection config the manager builds so we can assert the
// authProvider is (or is not) attached.
const getToolsMock = vi.fn()
const closeMock = vi.fn().mockResolvedValue(undefined)
let lastClientConfig: Record<string, unknown> | undefined
const MultiServerMCPClientMock = vi.fn(function MultiServerMCPClient(cfg: unknown) {
  lastClientConfig = cfg as Record<string, unknown>
  return { getTools: getToolsMock, close: closeMock }
})
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: MultiServerMCPClientMock
}))

// The SDK auth() orchestrator is mocked — NO real OAuth network round-trip.
// It returns 'REDIRECT' then 'AUTHORIZED' to simulate the two-step flow.
const authMock = vi.fn()
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: (...a: unknown[]) => authMock(...(a as []))
}))

// A single fake vault-backed provider, so tests can assert the manager
// prepares it, reads the captured code, and disposes it — without touching the
// real vault, loopback, or system browser.
const tokensMock = vi.fn()
const prepareMock = vi.fn().mockResolvedValue(undefined)
const takeAuthorizationCodeMock = vi.fn()
const disposeMock = vi.fn()
const fakeProvider = {
  tokens: (...a: unknown[]) => tokensMock(...(a as [])),
  prepare: (...a: unknown[]) => prepareMock(...(a as [])),
  takeAuthorizationCode: (...a: unknown[]) => takeAuthorizationCodeMock(...(a as [])),
  dispose: (...a: unknown[]) => disposeMock(...(a as []))
}
const makeMcpOAuthProviderMock = vi.fn(() => fakeProvider)
vi.mock('./oauthProvider', () => ({
  makeMcpOAuthProvider: (...a: unknown[]) => makeMcpOAuthProviderMock(...(a as []))
}))

const { mcpManager } = await import('./manager')

const AUTH_ERROR = new Error(
  'Authentication failed for HTTP server "oauth-server" at https://example.test/mcp (HTTP 401)'
)
const TOOLS = [{ name: 'send_email', description: 'send', invoke: vi.fn() }]

describe('mcpManager OAuth wiring', () => {
  beforeEach(async () => {
    getToolsMock.mockReset()
    closeMock.mockReset().mockResolvedValue(undefined)
    MultiServerMCPClientMock.mockClear()
    lastClientConfig = undefined
    isEnabledMock.mockReset().mockReturnValue(true)
    isTrustedMock.mockReset().mockReturnValue(true)
    hasSpawnConsentMock.mockReset().mockReturnValue(true)
    authMock.mockReset()
    tokensMock.mockReset().mockResolvedValue(undefined)
    prepareMock.mockClear().mockResolvedValue(undefined)
    takeAuthorizationCodeMock.mockReset()
    disposeMock.mockClear()
    makeMcpOAuthProviderMock.mockClear()
    await mcpManager.teardown()
  })

  it('enable(): a 401-then-authorized sequence ends connected', async () => {
    // First connect (no tokens) → 401; reconnect after sign-in → tools.
    getToolsMock.mockRejectedValueOnce(AUTH_ERROR).mockResolvedValueOnce(TOOLS)
    authMock.mockResolvedValueOnce('REDIRECT').mockResolvedValueOnce('AUTHORIZED')
    takeAuthorizationCodeMock.mockReturnValue('auth-code-123')

    const status = await mcpManager.enable('oauth-server', null)

    expect(status.state).toBe('connected')
    // Interactive flow was driven: loopback prepared, auth() ran the two-step
    // continuation with the captured code, provider disposed.
    expect(prepareMock).toHaveBeenCalled()
    expect(authMock).toHaveBeenCalledTimes(2)
    expect(authMock).toHaveBeenNthCalledWith(1, fakeProvider, {
      serverUrl: 'https://example.test/mcp'
    })
    expect(authMock).toHaveBeenNthCalledWith(2, fakeProvider, {
      serverUrl: 'https://example.test/mcp',
      authorizationCode: 'auth-code-123'
    })
    expect(disposeMock).toHaveBeenCalled()
    // The authorized reconnect attached the provider to the connection.
    const servers = lastClientConfig?.mcpServers as Record<string, Record<string, unknown>>
    expect(servers['oauth-server'].authProvider).toBe(fakeProvider)
  })

  it('enable(): passes through the authorizing state before settling', async () => {
    getToolsMock.mockRejectedValueOnce(AUTH_ERROR).mockResolvedValueOnce(TOOLS)
    takeAuthorizationCodeMock.mockReturnValue('code')
    // While auth() is in flight, the manager must report 'authorizing'.
    let statusMidFlight = ''
    authMock
      .mockImplementationOnce(async () => {
        statusMidFlight = mcpManager.statusOf('oauth-server').state
        return 'REDIRECT'
      })
      .mockResolvedValueOnce('AUTHORIZED')

    await mcpManager.enable('oauth-server', null)
    expect(statusMidFlight).toBe('authorizing')
  })

  it('enable(): reuses a saved token without launching the browser flow', async () => {
    tokensMock.mockResolvedValue({ access_token: 'saved', token_type: 'bearer' })
    getToolsMock.mockResolvedValueOnce(TOOLS)

    const status = await mcpManager.enable('oauth-server', null)

    expect(status.state).toBe('connected')
    expect(authMock).not.toHaveBeenCalled()
    expect(prepareMock).not.toHaveBeenCalled()
    // Provider attached on the token-backed connect.
    const servers = lastClientConfig?.mcpServers as Record<string, Record<string, unknown>>
    expect(servers['oauth-server'].authProvider).toBe(fakeProvider)
  })

  it('enable(): a non-auth failure surfaces as error, no sign-in', async () => {
    getToolsMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const status = await mcpManager.enable('oauth-server', null)

    expect(status.state).toBe('error')
    expect(authMock).not.toHaveBeenCalled()
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('authorize(): triggers the provider and reconnects', async () => {
    authMock.mockResolvedValueOnce('REDIRECT').mockResolvedValueOnce('AUTHORIZED')
    takeAuthorizationCodeMock.mockReturnValue('code-xyz')
    getToolsMock.mockResolvedValueOnce(TOOLS)

    const status = await mcpManager.authorize('oauth-server', null)

    expect(status.state).toBe('connected')
    expect(prepareMock).toHaveBeenCalled()
    expect(authMock).toHaveBeenCalled()
    expect(makeMcpOAuthProviderMock).toHaveBeenCalledWith('oauth-server')
  })

  it('signIn: a cancelled/timed-out redirect clears to error (no token saved)', async () => {
    getToolsMock.mockRejectedValueOnce(AUTH_ERROR)
    authMock.mockResolvedValueOnce('REDIRECT')
    takeAuthorizationCodeMock.mockReturnValue(undefined) // user closed the tab

    const status = await mcpManager.enable('oauth-server', null)

    expect(status.state).toBe('error')
    if (status.state === 'error') {
      expect(status.message.toLowerCase()).toContain('cancel')
    }
    expect(disposeMock).toHaveBeenCalled()
  })

  it('authorize(): non-remote server is rejected', async () => {
    const { loadServers } = await import('./store')
    ;(loadServers as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { name: 'local', transport: 'stdio', command: 'x', source: 'global' } as McpServerConfig
    ])

    const status = await mcpManager.authorize('local', null)

    expect(status.state).toBe('error')
    expect(authMock).not.toHaveBeenCalled()
  })
})
