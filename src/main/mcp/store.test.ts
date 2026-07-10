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
})

describe('upsertServer / removeServer', () => {
  beforeEach(() => {
    fakeFiles.clear()
    fakeSettings = {}
  })

  it('writes a global server without persisting the source field', () => {
    upsertServer({ name: 'gh', transport: 'http', url: 'https://gh', source: 'global' }, null)
    const written = JSON.parse(fakeFiles.get(GLOBAL_PATH)!)
    expect(written.mcpServers.gh).toEqual({ transport: 'http', url: 'https://gh' })
  })

  it('writes a project server to the project file', () => {
    upsertServer(
      { name: 'proj-srv', transport: 'http', url: 'https://p', source: 'project' },
      '/proj'
    )
    const written = JSON.parse(fakeFiles.get(PROJECT_PATH)!)
    expect(written.mcpServers['proj-srv']).toEqual({ transport: 'http', url: 'https://p' })
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

  it('global servers are always trusted', () => {
    expect(isTrusted('anything', null)).toBe(true)
  })

  it('project servers need opt-in trust', () => {
    expect(isTrusted('proj-srv', '/proj')).toBe(false)
    trustProjectServer('proj-srv', '/proj')
    expect(isTrusted('proj-srv', '/proj')).toBe(true)
  })

  it('hasSpawnConsent/grantSpawnConsent round-trip', () => {
    expect(hasSpawnConsent('local-tool')).toBe(false)
    grantSpawnConsent('local-tool')
    expect(hasSpawnConsent('local-tool')).toBe(true)
  })
})
