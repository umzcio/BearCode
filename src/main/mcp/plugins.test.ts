import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => ({
    pluginsEnabled: (store.pluginsEnabled as string[]) ?? [],
    mcpUntrustedGlobalServers: [],
    mcpTrustedProjectServers: {}
  }),
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

describe('plugin MCP servers', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
  })
  it('loads a plugin server tagged with plugin, untrusted by default', async () => {
    const { pluginsDir } = await import('../plugins')
    const p = join(pluginsDir('global', null), 'srvpack')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(
      join(p, 'mcp.json'),
      JSON.stringify({ mcpServers: { api: { type: 'http', url: 'https://x' } } })
    )
    store.pluginsEnabled = ['global:srvpack']
    const { loadServers, isTrusted } = await import('./store')
    const srv = loadServers(null).find((s) => s.name === 'api' && s.plugin === 'srvpack')
    expect(srv).toBeTruthy()
    expect(isTrusted(srv!.name, srv!.source, null, srv!.plugin)).toBe(false)
  })
})
