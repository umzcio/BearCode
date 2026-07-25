import { describe, it, expect, vi } from 'vitest'
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
})
