import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServerConfig } from '../../shared/types'

// Fixed server config returned for every lookup -- store.ts (config
// read/merge/resolve) is Task 3's concern; this test only exercises
// manager.ts's lifecycle against a mocked adapter + a mocked store.
const testConfig: McpServerConfig = {
  name: 'test-server',
  transport: 'http',
  url: 'https://example.test/mcp',
  source: 'global'
}
// The manager gates every launch on these store-backed checks (enabled +
// trusted + spawn-consent). Default them permissive; individual tests flip one
// to assert the gate denies before any client is constructed.
const isEnabledMock = vi.fn(() => true)
const isTrustedMock = vi.fn(() => true)
const hasSpawnConsentMock = vi.fn(() => true)
vi.mock('./store', () => ({
  loadServers: vi.fn(() => [testConfig]),
  resolveConfig: vi.fn((cfg: McpServerConfig) => cfg),
  isEnabled: (...a: unknown[]) => isEnabledMock(...(a as [])),
  isTrusted: (...a: unknown[]) => isTrustedMock(...(a as [])),
  hasSpawnConsent: (...a: unknown[]) => hasSpawnConsentMock(...(a as []))
}))

// Mock surface: only what the manager actually calls on a client instance.
const getToolsMock = vi.fn()
const closeMock = vi.fn().mockResolvedValue(undefined)
// A plain function (not an arrow) so `new MultiServerMCPClient(...)` in the
// manager works -- arrow functions cannot be used as constructors.
const MultiServerMCPClientMock = vi.fn(function MultiServerMCPClient() {
  return { getTools: getToolsMock, close: closeMock }
})
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: MultiServerMCPClientMock
}))

// Mock the SDK OAuth driver + the vault-backed provider so the sign-in path is
// exercised without electron/vault/loopback/browser. `auth` is the two-step SDK
// continuation; the provider is a plain stub (tokens() → undefined so enable()
// keeps its unauthenticated-first-attempt behavior for the non-OAuth tests).
const authMock = vi.fn()
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: (...a: unknown[]) => authMock(...(a as []))
}))
const providerStub = {
  redirectUrl: undefined,
  clientMetadata: {},
  clientInformation: () => undefined,
  saveClientInformation: vi.fn(),
  tokens: vi.fn(() => undefined),
  saveTokens: vi.fn(),
  saveCodeVerifier: vi.fn(),
  codeVerifier: () => 'verifier',
  redirectToAuthorization: vi.fn(),
  takeAuthorizationCode: vi.fn(() => 'auth-code'),
  invalidateCredentials: vi.fn(),
  prepare: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn()
}
const makeProviderMock = vi.fn(() => providerStub)
vi.mock('./oauthProvider', () => ({
  makeMcpOAuthProvider: (...a: unknown[]) => makeProviderMock(...(a as []))
}))

// Import after the mocks so the manager module picks up the mocked deps.
const { mcpManager } = await import('./manager')
const { loadServers } = await import('./store')

describe('mcpManager', () => {
  beforeEach(async () => {
    getToolsMock.mockReset()
    closeMock.mockReset().mockResolvedValue(undefined)
    MultiServerMCPClientMock.mockClear()
    isEnabledMock.mockReset().mockReturnValue(true)
    isTrustedMock.mockReset().mockReturnValue(true)
    hasSpawnConsentMock.mockReset().mockReturnValue(true)
    // The manager is a module singleton (like browserManager) -- clear its
    // connection cache between tests so each test starts from a clean slate.
    await mcpManager.teardown()
  })

  it('enable() connects, caches tools, and yields connected status', async () => {
    getToolsMock.mockResolvedValue([
      { name: 'get_x', description: 'd', invoke: vi.fn().mockResolvedValue('x-out') },
      {
        name: 'get_y',
        description: 'e',
        metadata: { annotations: { readOnlyHint: true } },
        invoke: vi.fn().mockResolvedValue('y-out')
      }
    ])

    const status = await mcpManager.enable('test-server', null)

    expect(status.state).toBe('connected')
    if (status.state === 'connected') {
      expect(status.tools).toEqual([
        { name: 'get_x', description: 'd', readOnlyHint: false },
        { name: 'get_y', description: 'e', readOnlyHint: true }
      ])
    }
    expect(mcpManager.statusOf('test-server')).toEqual(status)
    expect(mcpManager.listTools('test-server')).toEqual([
      { name: 'get_x', description: 'd', readOnlyHint: false },
      { name: 'get_y', description: 'e', readOnlyHint: true }
    ])
  })

  it('enable() yields an error status when the client throws, and listTools is empty', async () => {
    getToolsMock.mockRejectedValue(new Error('boom\n[2mCall log:[22m'))

    const status = await mcpManager.enable('test-server', null)

    expect(status).toEqual({ state: 'error', message: 'boom' })
    expect(mcpManager.listTools('test-server')).toEqual([])
  })

  it('callTool() routes through the mocked client for a cached tool', async () => {
    const invoke = vi.fn().mockResolvedValue('called-out')
    getToolsMock.mockResolvedValue([{ name: 'get_x', description: 'd', invoke }])
    await mcpManager.enable('test-server', null)

    const out = await mcpManager.callTool('test-server', 'get_x', { q: 1 })

    expect(invoke).toHaveBeenCalledWith({ q: 1 })
    expect(out).toBe('called-out')
  })

  it('callTool() invokes the tool method bound to its tool (this preserved)', async () => {
    // Regression: langchain's StructuredTool.invoke() reads `this.defaultConfig`
    // (mergeConfigs). callTool must not detach the method from its tool, or
    // `this` is undefined and the call throws "Cannot read properties of
    // undefined (reading 'defaultConfig')". A real remote MCP tool call hit
    // this live. Model `invoke` as a real method depending on `this`.
    const toolObj = {
      name: 'get_x',
      description: 'd',
      defaultConfig: { timeout: 5 },
      invoke(this: { defaultConfig: unknown }, args: unknown): Promise<string> {
        // Touching `this.defaultConfig` mirrors StructuredTool.invoke exactly.
        if (!this || this.defaultConfig === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading 'defaultConfig')")
        }
        return Promise.resolve(`bound-out:${JSON.stringify(args)}`)
      }
    }
    getToolsMock.mockResolvedValue([toolObj])
    await mcpManager.enable('test-server', null)

    const out = await mcpManager.callTool('test-server', 'get_x', { q: 2 })
    expect(out).toBe('bound-out:{"q":2}')
  })

  it('ensureEnabledConnected() connects an enabled+trusted idle stdio server', async () => {
    const stdioCfg: McpServerConfig = {
      name: 'local-srv',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      source: 'global'
    }
    vi.mocked(loadServers).mockReturnValue([stdioCfg])
    getToolsMock.mockResolvedValue([{ name: 't1', description: 'd', invoke: vi.fn() }])

    await mcpManager.ensureEnabledConnected(null)

    expect(MultiServerMCPClientMock).toHaveBeenCalled()
    expect(mcpManager.statusOf('local-srv').state).toBe('connected')
    vi.mocked(loadServers).mockReturnValue([testConfig])
  })

  it('ensureEnabledConnected() skips a remote server with no vaulted token (no connect, no browser)', async () => {
    // testConfig is http; providerStub.tokens() → undefined by default. A
    // passive refresh must NOT attempt the connection (which would 401) and
    // must NOT open a sign-in.
    providerStub.tokens.mockReturnValue(undefined)

    await mcpManager.ensureEnabledConnected(null)

    expect(MultiServerMCPClientMock).not.toHaveBeenCalled()
    expect(authMock).not.toHaveBeenCalled()
    expect(mcpManager.statusOf('test-server').state).toBe('disabled')
  })

  it('enable({interactive:false}) does not launch sign-in on a 401', async () => {
    // Token present so the provider is attached and the 401 is a genuine auth
    // challenge; interactive:false must still refuse to open the browser.
    providerStub.tokens.mockReturnValue({ access_token: 'stale' } as unknown as undefined)
    getToolsMock.mockRejectedValue(new Error('Authentication failed (HTTP 401)'))

    const status = await mcpManager.enable('test-server', null, { interactive: false })

    expect(authMock).not.toHaveBeenCalled()
    expect(status.state).toBe('error')
    providerStub.tokens.mockReturnValue(undefined)
  })

  it('callTool() connects on demand when the server was never enabled', async () => {
    const invoke = vi.fn().mockResolvedValue('demand-out')
    getToolsMock.mockResolvedValue([{ name: 'get_x', description: 'd', invoke }])

    const out = await mcpManager.callTool('test-server', 'get_x', {})

    expect(out).toBe('demand-out')
    expect(MultiServerMCPClientMock).toHaveBeenCalled()
  })

  it('enable() refuses an UNTRUSTED server without constructing a client', async () => {
    isTrustedMock.mockReturnValue(false)
    const status = await mcpManager.enable('test-server', '/proj')
    expect(status.state).toBe('error')
    if (status.state === 'error') expect(status.message).toMatch(/not trusted/i)
    expect(MultiServerMCPClientMock).not.toHaveBeenCalled()
  })

  it('enable() refuses an UNCONSENTED stdio server (no process ever spawns)', async () => {
    vi.mocked(loadServers).mockReturnValueOnce([
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['x'], source: 'global' }
    ])
    hasSpawnConsentMock.mockReturnValue(false)
    const status = await mcpManager.enable('fs', null)
    expect(status.state).toBe('error')
    if (status.state === 'error') expect(status.message).toMatch(/spawn consent/i)
    expect(MultiServerMCPClientMock).not.toHaveBeenCalled()
  })

  it('enable() refuses a DISABLED server (connect-on-demand cannot resurrect it)', async () => {
    isEnabledMock.mockReturnValue(false)
    const status = await mcpManager.enable('test-server', null)
    expect(status.state).toBe('error')
    if (status.state === 'error') expect(status.message).toMatch(/not enabled/i)
    expect(MultiServerMCPClientMock).not.toHaveBeenCalled()
  })

  it('a consented stdio server connects normally once its gates pass', async () => {
    vi.mocked(loadServers).mockReturnValueOnce([
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['x'], source: 'global' }
    ])
    getToolsMock.mockResolvedValue([{ name: 'run', description: 'd', invoke: vi.fn() }])
    const status = await mcpManager.enable('fs', null)
    expect(status.state).toBe('connected')
    expect(MultiServerMCPClientMock).toHaveBeenCalled()
  })

  it('stashResult/peekStashedResult/takeStashedResult mirror a take-once cache', () => {
    mcpManager.stashResult('call-1', 'payload')
    expect(mcpManager.peekStashedResult('call-1')).toBe('payload')
    expect(mcpManager.takeStashedResult('call-1')).toBe('payload')
    expect(mcpManager.takeStashedResult('call-1')).toBeUndefined()
  })

  it('authorize() coalesces a concurrent double-click onto ONE OAuth flow', async () => {
    // The first auth() call blocks until we release it, so the flow stays
    // in-flight while a second authorize() arrives (the double-click the review
    // flagged). Without the inFlightAuth guard this second call would start a
    // second auth() on the shared provider, clobbering the PKCE verifier and
    // opening a second browser tab.
    let releaseAuth!: (v: string) => void
    const authGate = new Promise<string>((r) => {
      releaseAuth = r
    })
    authMock.mockReset()
    authMock.mockReturnValueOnce(authGate)
    providerStub.prepare.mockClear()
    providerStub.dispose.mockClear()
    getToolsMock.mockResolvedValue([{ name: 'g', description: 'd', invoke: vi.fn() }])

    const p1 = mcpManager.authorize('test-server', null)
    const p2 = mcpManager.authorize('test-server', null)

    // Let both calls run up to the auth() await.
    await new Promise((r) => setTimeout(r, 0))
    expect(authMock).toHaveBeenCalledTimes(1)
    expect(providerStub.prepare).toHaveBeenCalledTimes(1)

    // A still-valid saved token short-circuits: auth() → AUTHORIZED, no exchange.
    releaseAuth('AUTHORIZED')
    const [s1, s2] = await Promise.all([p1, p2])

    expect(s1.state).toBe('connected')
    // Both callers observed the SAME resolved status (same in-flight promise);
    // still only one flow ran.
    expect(s2).toBe(s1)
    expect(authMock).toHaveBeenCalledTimes(1)
  })

  it('teardown() closes clients and clears caches', async () => {
    getToolsMock.mockResolvedValue([{ name: 'get_x', description: 'd', invoke: vi.fn() }])
    await mcpManager.enable('test-server', null)

    await mcpManager.teardown()

    expect(closeMock).toHaveBeenCalled()
    expect(mcpManager.listTools('test-server')).toEqual([])
    expect(mcpManager.statusOf('test-server')).toEqual({ state: 'disabled' })
  })
})
