import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSettings } from '../../shared/types'

// In-memory settings mock (mirrors the pattern used elsewhere for module
// mocks): store.ts reads/writes enable/trust/spawn-consent state through
// getSettings/setSettings, so we fake the whole settings module rather than
// the file behind it.
let fakeSettings: Partial<AppSettings> = {}
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({
    mcpEnabledServers: [],
    mcpTrustedProjectServers: {},
    mcpSpawnConsented: [],
    ...fakeSettings
  })),
  setSettings: vi.fn((patch: Partial<AppSettings>) => {
    fakeSettings = { ...fakeSettings, ...patch }
    return fakeSettings
  })
}))

// In-memory 'fs' + 'os' mock so mcp.json reads/writes never touch disk.
const fakeFiles = new Map<string, string>()
vi.mock('os', () => ({ homedir: vi.fn(() => '/fake-home') }))
vi.mock('fs', () => ({
  statSync: vi.fn((path: string) => {
    const contents = fakeFiles.get(path)
    if (contents === undefined) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { isFile: () => true, size: Buffer.byteLength(contents, 'utf8') }
  }),
  openSync: vi.fn((path: string) => path),
  readSync: vi.fn((fd: string, buf: Buffer, offset: number, length: number) => {
    const contents = fakeFiles.get(fd) ?? ''
    const src = Buffer.from(contents, 'utf8')
    const toCopy = Math.min(length, src.length - offset)
    if (toCopy <= 0) return 0
    src.copy(buf, offset, offset, offset + toCopy)
    return toCopy
  }),
  closeSync: vi.fn(),
  existsSync: vi.fn((path: string) => fakeFiles.has(path)),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((path: string, contents: string) => {
    fakeFiles.set(path, contents)
  })
}))

import { resolveVaultRefs } from '../keys'
vi.mock('../keys', () => ({
  resolveVaultRefs: vi.fn((input: string) =>
    input.replace(/\$\{VAULT:([^}]+)\}/g, (_m, k) => `resolved:${k}`)
  )
}))

import {
  mergeServerMaps,
  loadServers,
  upsertServer,
  removeServer,
  resolveConfig,
  isEnabled,
  setEnabled,
  isTrusted,
  trustProjectServer,
  markGlobalServerUntrusted,
  trustGlobalServer,
  hasSpawnConsent,
  grantSpawnConsent
} from './store'
import type { McpServerConfig } from '../../shared/types'

const GLOBAL_PATH = '/fake-home/.bearcode/agents/mcp.json'
const PROJECT_PATH = '/proj/.agents/mcp.json'

function setGlobalJson(obj: unknown): void {
  fakeFiles.set(GLOBAL_PATH, JSON.stringify(obj))
}
function setProjectJson(obj: unknown): void {
  fakeFiles.set(PROJECT_PATH, JSON.stringify(obj))
}

describe('mergeServerMaps (pure)', () => {
  it('project overrides global by name', () => {
    const g = { a: { name: 'a', transport: 'http', url: 'g', source: 'global' } } as const
    const p = { a: { name: 'a', transport: 'http', url: 'p', source: 'project' } } as const
    const merged = mergeServerMaps(
      g as unknown as Record<string, McpServerConfig>,
      p as unknown as Record<string, McpServerConfig>
    )
    expect(merged.find((s) => s.name === 'a')!.url).toBe('p')
    expect(merged.find((s) => s.name === 'a')!.source).toBe('project')
  })
})

describe('resolveConfig', () => {
  it('replaces ${VAULT:} refs in headers and env values', () => {
    const cfg: McpServerConfig = {
      name: 'x',
      transport: 'http',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer ${VAULT:mcp:x:token}' },
      env: { API_KEY: '${VAULT:mcp:x:key}' },
      source: 'global'
    }
    const resolved = resolveConfig(cfg)
    expect(resolved.headers!.Authorization).toBe('Bearer resolved:mcp:x:token')
    expect(resolved.env!.API_KEY).toBe('resolved:mcp:x:key')
    expect(resolveVaultRefs).toHaveBeenCalled()
  })
})

describe('loadServers', () => {
  beforeEach(() => {
    fakeFiles.clear()
    fakeSettings = {}
  })

  it('merges global + project, project wins on name collision', () => {
    setGlobalJson({
      mcpServers: {
        shared: { transport: 'http', url: 'g' },
        onlyGlobal: { transport: 'http', url: 'gg' }
      }
    })
    setProjectJson({ mcpServers: { shared: { transport: 'http', url: 'p' } } })
    const servers = loadServers('/proj')
    const shared = servers.find((s) => s.name === 'shared')!
    expect(shared.url).toBe('p')
    expect(shared.source).toBe('project')
    expect(servers.find((s) => s.name === 'onlyGlobal')!.source).toBe('global')
  })

  it('returns only global servers when projectPath is null', () => {
    setGlobalJson({ mcpServers: { onlyGlobal: { transport: 'http', url: 'gg' } } })
    const servers = loadServers(null)
    expect(servers).toHaveLength(1)
    expect(servers[0].source).toBe('global')
  })

  it('never throws on missing/malformed files', () => {
    expect(() => loadServers('/proj')).not.toThrow()
    fakeFiles.set(GLOBAL_PATH, '{ not json')
    expect(loadServers('/proj')).toEqual([])
  })

  it('classifies transport from the Claude Code `type` field', () => {
    setGlobalJson({
      mcpServers: {
        remote: { type: 'http', url: 'https://r' },
        sse: { type: 'sse', url: 'https://s' },
        local: { type: 'stdio', command: 'npx' }
      }
    })
    const byName = Object.fromEntries(loadServers(null).map((s) => [s.name, s.transport]))
    expect(byName).toEqual({ remote: 'http', sse: 'http', local: 'stdio' })
  })

  it('a `type: http` server is never misdriven as stdio, and a stdio command is honored', () => {
    setGlobalJson({
      mcpServers: {
        // type present but no command -> stays http (was: else-branch built a
        // bogus stdio connection)
        http: { type: 'http', url: 'https://h' },
        // no type, has command -> inferred stdio (still spawn-gated downstream)
        inferred: { command: 'curl', args: ['x'] }
      }
    })
    const byName = Object.fromEntries(loadServers(null).map((s) => [s.name, s.transport]))
    expect(byName.http).toBe('http')
    expect(byName.inferred).toBe('stdio')
  })

  it('an ambiguous/typeless entry with no command falls back to http (cannot spawn)', () => {
    setGlobalJson({ mcpServers: { weird: { url: 'https://w' }, empty: {} } })
    const byName = Object.fromEntries(loadServers(null).map((s) => [s.name, s.transport]))
    expect(byName.weird).toBe('http')
    expect(byName.empty).toBe('http')
  })

  it('drops non-object entries instead of spreading them into garbage config', () => {
    setGlobalJson({ mcpServers: { ok: { type: 'http', url: 'https://ok' }, bad: 'oops' } })
    const names = loadServers(null).map((s) => s.name)
    expect(names).toEqual(['ok'])
  })
})

describe('upsertServer / removeServer', () => {
  beforeEach(() => {
    fakeFiles.clear()
    fakeSettings = {}
  })

  it('writes a global server as the Claude Code `type` shape, no source field', () => {
    upsertServer({ name: 'gh', transport: 'http', url: 'https://gh', source: 'global' }, null)
    const written = JSON.parse(fakeFiles.get(GLOBAL_PATH)!)
    expect(written.mcpServers.gh).toEqual({ type: 'http', url: 'https://gh' })
  })

  it('round-trips through disk: upsert writes `type`, loadServers reads it back', () => {
    upsertServer(
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['x'], source: 'global' },
      null
    )
    const written = JSON.parse(fakeFiles.get(GLOBAL_PATH)!)
    expect(written.mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['x'] })
    const loaded = loadServers(null).find((s) => s.name === 'fs')!
    expect(loaded.transport).toBe('stdio')
  })

  it('writes a project server to the project file', () => {
    upsertServer(
      { name: 'proj-srv', transport: 'http', url: 'https://p', source: 'project' },
      '/proj'
    )
    const written = JSON.parse(fakeFiles.get(PROJECT_PATH)!)
    expect(written.mcpServers['proj-srv']).toEqual({ type: 'http', url: 'https://p' })
  })

  it('removeServer deletes the named entry from the right file', () => {
    setGlobalJson({ mcpServers: { gh: { transport: 'http', url: 'https://gh' } } })
    removeServer('gh', 'global', null)
    const written = JSON.parse(fakeFiles.get(GLOBAL_PATH)!)
    expect(written.mcpServers.gh).toBeUndefined()
  })
})

describe('enable / trust / spawn-consent state', () => {
  beforeEach(() => {
    fakeSettings = {}
  })

  it('isEnabled/setEnabled round-trip through settings', () => {
    expect(isEnabled('gh')).toBe(false)
    setEnabled('gh', true)
    expect(isEnabled('gh')).toBe(true)
    setEnabled('gh', false)
    expect(isEnabled('gh')).toBe(false)
  })

  it('global servers are always trusted, even with a project open', () => {
    // The whole point of the `source` param: a global server the user added at
    // the app level is trusted regardless of the current project. Asserting
    // BOTH the null-project and open-project cases so this can never silently
    // regress to "untrusted in every project conversation" again.
    expect(isTrusted('anything', 'global', null)).toBe(true)
    expect(isTrusted('my-global-server', 'global', '/proj')).toBe(true)
  })

  it('a global server marked untrusted (Smithery install) stays untrusted until trusted', () => {
    // Registry-sourced global servers must NOT be pre-trusted: their url/command
    // comes from the Smithery response, so the L2 trust gate has to fire before
    // they can connect (SSRF-on-enable otherwise).
    expect(isTrusted('exa-labs/exa-mcp', 'global', null)).toBe(true)
    markGlobalServerUntrusted('exa-labs/exa-mcp')
    expect(isTrusted('exa-labs/exa-mcp', 'global', null)).toBe(false)
    // A different global server the user added manually is unaffected.
    expect(isTrusted('my-manual-server', 'global', null)).toBe(true)
    trustGlobalServer('exa-labs/exa-mcp')
    expect(isTrusted('exa-labs/exa-mcp', 'global', null)).toBe(true)
  })

  it('project servers need opt-in trust, per project', () => {
    expect(isTrusted('proj-srv', 'project', '/proj')).toBe(false)
    // No project path -> cannot verify trust -> untrusted.
    expect(isTrusted('proj-srv', 'project', null)).toBe(false)
    trustProjectServer('proj-srv', '/proj')
    expect(isTrusted('proj-srv', 'project', '/proj')).toBe(true)
    // Trust is per-project: a different project is still untrusted.
    expect(isTrusted('proj-srv', 'project', '/other')).toBe(false)
  })

  it('hasSpawnConsent/grantSpawnConsent round-trip', () => {
    expect(hasSpawnConsent('local-tool')).toBe(false)
    grantSpawnConsent('local-tool')
    expect(hasSpawnConsent('local-tool')).toBe(true)
  })
})
