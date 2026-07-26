import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMcpCandidates, mcpSourcePathFor } from './mcpCandidates'
import * as mcpStore from '../mcp/store'
import type { DiscoveredMcpServer } from '../../shared/types'

describe('mcpSourcePathFor', () => {
  it('builds a synthetic per-server source path keyed by origin file + server name', () => {
    const s: DiscoveredMcpServer = {
      name: 'filesystem',
      origin: 'claude-settings-json',
      transport: 'stdio',
      command: 'npx'
    }
    expect(mcpSourcePathFor(s)).toBe('.claude/settings.json#filesystem')
  })

  it('maps each project-scoped origin to its own file prefix', () => {
    expect(
      mcpSourcePathFor({ name: 'a', origin: 'project-mcp-json', transport: 'http', url: 'https://a' })
    ).toBe('.mcp.json#a')
    expect(
      mcpSourcePathFor({ name: 'b', origin: 'cursor-mcp-json', transport: 'http', url: 'https://b' })
    ).toBe('.cursor/mcp.json#b')
    expect(
      mcpSourcePathFor({ name: 'c', origin: 'windsurf-mcp-json', transport: 'http', url: 'https://c' })
    ).toBe('.windsurf/mcp.json#c')
  })

  it('returns null for claude-desktop origin (not a project-relative source)', () => {
    expect(
      mcpSourcePathFor({ name: 'd', origin: 'claude-desktop', transport: 'http', url: 'https://d' })
    ).toBeNull()
  })
})

describe('buildMcpCandidates', () => {
  // Every test in this describe block mocks loadServers too (default: empty
  // registry) -- otherwise buildMcpCandidates would hit the REAL
  // ~/.bearcode/agents/mcp.json / <project>/.agents/mcp.json on the running
  // machine (same machine-dependency hazard as Finding 6, just for the
  // registry-exclusion check added by Finding 1) and tests would be flaky
  // depending on what the developer has actually configured.
  beforeEach(() => {
    vi.spyOn(mcpStore, 'loadServers').mockReturnValue([])
  })

  it('maps a discovered project-scoped server into an ImportCandidate', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates).toEqual([
      {
        sourcePath: '.claude/settings.json#filesystem',
        kind: 'mcp',
        tool: 'claude-code',
        buildable: true,
        preview: 'local · npx -y mcp-fs'
      }
    ])
  })

  it('excludes claude-desktop-origin servers (machine-level, not project-detected)', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'x', origin: 'claude-desktop', transport: 'http', url: 'https://x' }
    ])
    expect(buildMcpCandidates('/fake/project')).toEqual([])
  })

  it('maps cursor-mcp-json and windsurf-mcp-json origins to their respective tools', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'a', origin: 'cursor-mcp-json', transport: 'http', url: 'https://a' },
      { name: 'b', origin: 'windsurf-mcp-json', transport: 'http', url: 'https://b' }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates.find((c) => c.sourcePath.includes('cursor'))?.tool).toBe('cursor')
    expect(candidates.find((c) => c.sourcePath.includes('windsurf'))?.tool).toBe('windsurf')
  })

  // Final whole-branch review, Finding 1: a server that already reached
  // BearCode's own MCP registry via some other path (manual add, Smithery,
  // the standalone "Import local…" picker) must not be re-offered as a fresh,
  // pre-checked candidate -- re-importing it would blank its header/env
  // values without resetting trust/consent.
  it('excludes a discovered server whose name already exists in the project MCP registry', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'filesystem', origin: 'claude-settings-json', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] },
      { name: 'brand-new', origin: 'claude-settings-json', transport: 'stdio', command: 'npx', args: ['-y', 'other'] }
    ])
    vi.spyOn(mcpStore, 'loadServers').mockReturnValue([
      { name: 'filesystem', source: 'project', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates.map((c) => c.sourcePath)).toEqual(['.claude/settings.json#brand-new'])
  })

  // Final whole-branch review, Finding 5: classifyTransport falls back to
  // 'http' for an entry with neither `command` nor `url`, which would
  // otherwise render as a dead "http server with no url" candidate.
  it('marks a malformed stdio entry (no command) and http entry (no url) as unbuildable', () => {
    vi.spyOn(mcpStore, 'discoverLocalServers').mockReturnValue([
      { name: 'broken-stdio', origin: 'claude-settings-json', transport: 'stdio' },
      { name: 'broken-http', origin: 'claude-settings-json', transport: 'http' }
    ])
    const candidates = buildMcpCandidates('/fake/project')
    expect(candidates).toEqual([
      { sourcePath: '.claude/settings.json#broken-stdio', kind: 'mcp', tool: 'claude-code', buildable: false },
      { sourcePath: '.claude/settings.json#broken-http', kind: 'mcp', tool: 'claude-code', buildable: false }
    ])
  })
})
