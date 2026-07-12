import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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

// pluginsDir('global', null) resolves off os.homedir() (src/main/plugins/
// index.ts), so without this mock the test would write real fixture
// directories straight into the developer's/CI runner's actual home
// (~/.bearcode/agents/plugins/) with no teardown -- confirmed to leave a
// stray 'srvpack' folder behind. Point homedir() at a fresh mkdtempSync
// temp dir per test (mirrors the project-scope pattern in
// plugins/enumerate.test.ts) and remove it in afterEach.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

describe('plugin MCP servers', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-mcp-plugin-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
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

  // Regression for the collision hole: isEnabled/setEnabled/hasSpawnConsent/
  // grantSpawnConsent and McpManager's this.servers/findConfig are all keyed
  // on the bare server `name`, so a plugin server sharing a bare name with a
  // direct global server must never be enumerated -- otherwise toggling the
  // direct server's enabled/spawn-consent bit would silently also flip the
  // value read for the colliding plugin entry, and the plugin's own config
  // could never actually be launched.
  it('never enumerates a plugin server whose bare name collides with a direct global server', async () => {
    const { pluginsDir } = await import('../plugins')
    const p = join(pluginsDir('global', null), 'collidepack')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(
      join(p, 'mcp.json'),
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://plugin-supplied.example' } }
      })
    )
    store.pluginsEnabled = ['global:collidepack']

    // Write a DIRECT global server also named `github` under the same fake
    // home, exactly like the direct entry the plugin's server would collide
    // with (~/.bearcode/agents/mcp.json).
    const globalConfigDir = join(fakeHome, '.bearcode', 'agents')
    mkdirSync(globalConfigDir, { recursive: true })
    writeFileSync(
      join(globalConfigDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://direct.example' } }
      })
    )

    const { loadServers } = await import('./store')
    const servers = loadServers(null)
    const githubServers = servers.filter((s) => s.name === 'github')
    expect(githubServers).toHaveLength(1)
    expect(githubServers[0].plugin).toBeUndefined()
    expect(githubServers[0].url).toBe('https://direct.example')
  })

  // Important whole-branch finding: loadServers' `opts.trusted` gate for
  // project-scope plugin mcp.json servers had NO production caller threading
  // it (every ipc.ts / manager.ts / tools.ts call site passed loadServers
  // bare) -- so an enabled project plugin's MCP server could never be
  // enumerated even in a workspace the user had explicitly trusted.
  it('surfaces an enabled PROJECT plugin server only when { trusted: true } is passed', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'bc-mcp-proj-'))
    try {
      const p = join(projectPath, '.agents', 'plugins', 'projpack')
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'plugin.json'), '{}')
      writeFileSync(
        join(p, 'mcp.json'),
        JSON.stringify({ mcpServers: { 'proj-api': { type: 'http', url: 'https://proj' } } })
      )
      store.pluginsEnabled = ['project:projpack']

      const { loadServers } = await import('./store')
      const untrusted = loadServers(projectPath)
      expect(untrusted.find((s) => s.name === 'proj-api')).toBeUndefined()

      const trusted = loadServers(projectPath, { trusted: true })
      const srv = trusted.find((s) => s.name === 'proj-api')
      expect(srv).toBeTruthy()
      expect(srv?.plugin).toBe('projpack')
    } finally {
      rmSync(projectPath, { recursive: true, force: true })
    }
  })
})
