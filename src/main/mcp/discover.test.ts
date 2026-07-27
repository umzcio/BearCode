import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same in-memory fs/os mock idiom as store.test.ts -- discoverLocalServers is
// read-only over foreign config files, so this proves it never touches real
// disk and degrades cleanly rather than throwing.
const fakeFiles = new Map<string, string>()
// Lets a test simulate a symlinked project config file whose realpath
// resolves somewhere other than its literal path -- e.g. `.mcp.json` or
// `.cursor/mcp.json` actually being a symlink pointing outside the project
// root. Defaults to identity (no override => realpathSync(p) === p), so
// every pre-existing test is unaffected: isPathWithinRoot's realpath-based
// containment check (fsCapped.ts) then reduces to the same lexical "does the
// literal path start with root" check the code always effectively had here.
const fakeRealpathOverrides = new Map<string, string>()
vi.mock('os', () => ({ homedir: vi.fn(() => '/fake-home') }))
vi.mock('fs', async () => {
  // Pull the REAL `constants` (O_RDONLY/O_NOFOLLOW/etc) from the actual `fs`
  // module rather than hand-rolling numeric values -- readFileCapped
  // (fsCapped.ts, round3 plan 004) now references constants.O_RDONLY /
  // constants.O_NOFOLLOW unconditionally, so this mock must provide the real
  // ones for those bitwise flag checks to behave correctly.
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    constants: actual.constants,
    statSync: vi.fn((path: string) => {
      const contents = fakeFiles.get(path)
      if (contents === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return { isFile: () => true, size: Buffer.byteLength(contents, 'utf8') }
    }),
    // readFileCapped now lstats before statting (symlink-safe config-import
    // scan hardening) -- these fake files are never symlinks.
    lstatSync: vi.fn((path: string) => {
      const contents = fakeFiles.get(path)
      if (contents === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return { isSymbolicLink: () => false }
    }),
    openSync: vi.fn((path: string) => path),
    // readFileCapped (round3 plan 004) now fstats the OPEN DESCRIPTOR instead
    // of statSync-ing the pathname -- in this mock, `fd` is just the literal
    // path string returned by the openSync mock above, so this looks up the
    // same fakeFiles map keyed by that "fd". Must return the same shape
    // readFileCapped reads off it: `.isFile()` and `.size`.
    fstatSync: vi.fn((fd: string) => {
      const contents = fakeFiles.get(fd)
      if (contents === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return { isFile: () => true, size: Buffer.byteLength(contents, 'utf8') }
    }),
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
    writeFileSync: vi.fn(() => {
      throw new Error('discoverLocalServers must never write')
    }),
    realpathSync: vi.fn((path: string) => fakeRealpathOverrides.get(path) ?? path)
  }
})

vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({})),
  setSettings: vi.fn()
}))
vi.mock('../keys', () => ({ resolveVaultRefs: vi.fn((v: string) => v) }))

import { discoverLocalServers } from './store'

const DESKTOP_PATH = '/fake-home/Library/Application Support/Claude/claude_desktop_config.json'
const PROJECT_PATH = '/fake/project/.mcp.json'
const CLAUDE_SETTINGS_PATH = '/fake/project/.claude/settings.json'
const CURSOR_MCP_PATH = '/fake/project/.cursor/mcp.json'
const WINDSURF_MCP_PATH = '/fake/project/.windsurf/mcp.json'

beforeEach(() => {
  fakeFiles.clear()
  fakeRealpathOverrides.clear()
})

describe('discoverLocalServers', () => {
  it('returns [] when nothing exists on disk', () => {
    expect(discoverLocalServers(null)).toEqual([])
    expect(discoverLocalServers('/fake/project')).toEqual([])
  })

  it('degrades to [] on malformed JSON rather than throwing', () => {
    fakeFiles.set(DESKTOP_PATH, '{ this is not json')
    fakeFiles.set('/fake/project/.mcp.json', '{ also not json')
    expect(() => discoverLocalServers('/fake/project')).not.toThrow()
    expect(discoverLocalServers('/fake/project')).toEqual([])
  })

  it('parses the Claude Desktop config, tagging origin', () => {
    fakeFiles.set(
      DESKTOP_PATH,
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }
        }
      })
    )
    const found = discoverLocalServers(null)
    expect(found).toEqual([
      {
        name: 'filesystem',
        origin: 'claude-desktop',
        transport: 'stdio',
        url: undefined,
        headers: undefined,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: undefined
      }
    ])
  })

  it('parses a project .mcp.json, tagging origin', () => {
    fakeFiles.set(
      PROJECT_PATH,
      JSON.stringify({
        mcpServers: {
          api: { type: 'http', url: 'https://example.com/mcp' }
        }
      })
    )
    const found = discoverLocalServers('/fake/project')
    expect(found).toEqual([
      {
        name: 'api',
        origin: 'project-mcp-json',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: undefined,
        command: undefined,
        args: undefined,
        env: undefined
      }
    ])
  })

  it('dedups by name, project .mcp.json winning over Claude Desktop', () => {
    fakeFiles.set(
      DESKTOP_PATH,
      JSON.stringify({ mcpServers: { shared: { type: 'stdio', command: 'desktop-cmd' } } })
    )
    fakeFiles.set(
      PROJECT_PATH,
      JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://project.example' } } })
    )
    const found = discoverLocalServers('/fake/project')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      name: 'shared',
      origin: 'project-mcp-json',
      transport: 'http'
    })
  })

  it('never mutates the source files', () => {
    fakeFiles.set(
      DESKTOP_PATH,
      JSON.stringify({ mcpServers: { x: { type: 'http', url: 'https://x.example' } } })
    )
    const before = fakeFiles.get(DESKTOP_PATH)
    discoverLocalServers(null)
    expect(fakeFiles.get(DESKTOP_PATH)).toBe(before)
  })

  it("discovers servers from .claude/settings.json's mcpServers key", () => {
    fakeFiles.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'mcp-fs'] } } })
    )
    const found = discoverLocalServers('/fake/project')
    expect(found).toContainEqual(
      expect.objectContaining({ name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio' })
    )
  })

  it('discovers servers from .cursor/mcp.json', () => {
    fakeFiles.set(
      CURSOR_MCP_PATH,
      JSON.stringify({ mcpServers: { github: { url: 'https://example.com/mcp' } } })
    )
    const found = discoverLocalServers('/fake/project')
    expect(found).toContainEqual(
      expect.objectContaining({ name: 'github', origin: 'cursor-mcp-json', transport: 'http' })
    )
  })

  it('discovers servers from .windsurf/mcp.json', () => {
    fakeFiles.set(
      WINDSURF_MCP_PATH,
      JSON.stringify({ mcpServers: { search: { url: 'https://example.com/search' } } })
    )
    const found = discoverLocalServers('/fake/project')
    expect(found).toContainEqual(
      expect.objectContaining({ name: 'search', origin: 'windsurf-mcp-json', transport: 'http' })
    )
  })

  it('degrades to empty on malformed JSON in any of the three new files, never throws', () => {
    fakeFiles.set(CLAUDE_SETTINGS_PATH, 'not json{{{')
    expect(() => discoverLocalServers('/fake/project')).not.toThrow()
    expect(discoverLocalServers('/fake/project')).toEqual([])
  })

  it('rejects a project .mcp.json symlinked outside the project root, without dropping other project sources', () => {
    // .mcp.json LOOKS like it lives at /fake/project/.mcp.json but its
    // realpath actually resolves outside /fake/project (root) -- e.g. an
    // attacker-controlled repo replacing the committed .mcp.json with a
    // symlink to somewhere else on disk. isPathWithinRoot (fsCapped.ts) must
    // catch this via realpathSync even though lstatSync on the leaf reports
    // non-symlink in this mock.
    fakeFiles.set(
      PROJECT_PATH,
      JSON.stringify({ mcpServers: { evil: { type: 'http', url: 'https://evil.example' } } })
    )
    fakeRealpathOverrides.set(PROJECT_PATH, '/outside/evil/.mcp.json')
    // A second, non-overridden project source in the same discovery call, to
    // prove the rejection is scoped to the escaping file only.
    fakeFiles.set(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify({ mcpServers: { good: { type: 'http', url: 'https://good.example' } } })
    )

    const found = discoverLocalServers('/fake/project')

    expect(found.find((s) => s.name === 'evil')).toBeUndefined()
    expect(found).toContainEqual(
      expect.objectContaining({ name: 'good', origin: 'claude-settings-json' })
    )
  })

  it('rejects a project .cursor/mcp.json symlinked outside the project root, without dropping other project sources', () => {
    fakeFiles.set(
      CURSOR_MCP_PATH,
      JSON.stringify({ mcpServers: { evil: { url: 'https://evil.example' } } })
    )
    fakeRealpathOverrides.set(CURSOR_MCP_PATH, '/outside/evil/mcp.json')
    fakeFiles.set(
      WINDSURF_MCP_PATH,
      JSON.stringify({ mcpServers: { good: { url: 'https://good.example' } } })
    )

    const found = discoverLocalServers('/fake/project')

    expect(found.find((s) => s.name === 'evil')).toBeUndefined()
    expect(found).toContainEqual(
      expect.objectContaining({ name: 'good', origin: 'windsurf-mcp-json' })
    )
  })
})
