import { describe, it, expect, vi } from 'vitest'

// Count MultiServerMCPClient constructions; getTools resolves after a tick so
// two enable() calls overlap.
let constructed = 0
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    constructor() {
      constructed++
    }
    async getTools(): Promise<never[]> {
      await new Promise((r) => setTimeout(r, 10))
      return []
    }
    async close(): Promise<void> {
      // no-op mock
    }
  }
}))
// Minimal stubs so launchDenial permits the launch (enabled+trusted, http).
vi.mock('./store', () => ({
  loadServers: () => [{ name: 'srv', transport: 'http', url: 'https://x', source: 'user' }],
  isEnabled: () => true,
  isTrusted: () => true,
  hasSpawnConsent: () => true,
  resolveConfig: (c: unknown) => c,
  toConnection: () => ({}),
  toToolInfo: (t: unknown) => t
}))

describe('McpManager.enable dedup', () => {
  it('constructs one client for concurrent enables of the same server', async () => {
    constructed = 0
    const { McpManager } = await import('./manager')
    const m = new McpManager()
    const [a, b] = await Promise.all([m.enable('srv', null), m.enable('srv', null)])
    expect(constructed).toBe(1)
    expect(a).toBe(b) // same resolved status object -> coalesced
  })
})
