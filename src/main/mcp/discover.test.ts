import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same in-memory fs/os mock idiom as store.test.ts -- discoverLocalServers is
// read-only over foreign config files, so this proves it never touches real
// disk and degrades cleanly rather than throwing.
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
  writeFileSync: vi.fn(() => {
    throw new Error('discoverLocalServers must never write')
  })
}))

vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({})),
  setSettings: vi.fn()
}))
vi.mock('../keys', () => ({ resolveVaultRefs: vi.fn((v: string) => v) }))

import { discoverLocalServers } from './store'

const DESKTOP_PATH = '/fake-home/Library/Application Support/Claude/claude_desktop_config.json'
const PROJECT_PATH = '/fake/project/.mcp.json'

beforeEach(() => {
  fakeFiles.clear()
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
})
