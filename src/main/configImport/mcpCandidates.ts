import { discoverLocalServers } from '../mcp/store'
import type { DiscoveredMcpServer } from '../../shared/types'
import type { ImportCandidate, ImportTool } from './types'

const ORIGIN_PREFIX: Partial<Record<DiscoveredMcpServer['origin'], string>> = {
  'project-mcp-json': '.mcp.json',
  'claude-settings-json': '.claude/settings.json',
  'cursor-mcp-json': '.cursor/mcp.json',
  'windsurf-mcp-json': '.windsurf/mcp.json'
}

const ORIGIN_TOOL: Partial<Record<DiscoveredMcpServer['origin'], ImportTool>> = {
  'project-mcp-json': 'claude-code',
  'claude-settings-json': 'claude-code',
  'cursor-mcp-json': 'cursor',
  'windsurf-mcp-json': 'windsurf'
}

// A synthetic per-server tracking key: one file can define several servers,
// and imported_config_sources is keyed on (projectPath, sourcePath), so the
// key must be per-server, not per-file. Returns null for 'claude-desktop' --
// that's a machine-level config, not something detected IN this project, so
// it has no project-relative path to synthesize and is excluded from the
// unified modal entirely (buildMcpCandidates filters it out below).
export function mcpSourcePathFor(server: DiscoveredMcpServer): string | null {
  const prefix = ORIGIN_PREFIX[server.origin]
  return prefix ? `${prefix}#${server.name}` : null
}

// Unlike rules/workflows/skills, a discovered MCP server is already valid
// parsed JSON -- there is no translation step that can fail the way a rule
// file's frontmatter can, so every mapped candidate is buildable: true.
export function buildMcpCandidates(projectPath: string): ImportCandidate[] {
  const discovered = discoverLocalServers(projectPath)
  const candidates: ImportCandidate[] = []
  for (const server of discovered) {
    const sourcePath = mcpSourcePathFor(server)
    const tool = ORIGIN_TOOL[server.origin]
    if (sourcePath === null || tool === undefined) continue
    const preview =
      server.transport === 'stdio'
        ? `local · ${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`
        : `remote · ${server.url ?? ''}`
    candidates.push({ sourcePath, kind: 'mcp', tool, buildable: true, preview })
  }
  return candidates
}
