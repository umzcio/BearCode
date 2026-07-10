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

  it('teardown() closes clients and clears caches', async () => {
    getToolsMock.mockResolvedValue([{ name: 'get_x', description: 'd', invoke: vi.fn() }])
    await mcpManager.enable('test-server', null)

    await mcpManager.teardown()

    expect(closeMock).toHaveBeenCalled()
    expect(mcpManager.listTools('test-server')).toEqual([])
    expect(mcpManager.statusOf('test-server')).toEqual({ state: 'disabled' })
  })
})
