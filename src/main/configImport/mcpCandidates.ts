import { discoverLocalServers, loadServers } from '../mcp/store'
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
// file's frontmatter can. It can still be *unbuildable*, though: see the
// transport/shape guard below (final whole-branch review, Finding 5).
export function buildMcpCandidates(projectPath: string): ImportCandidate[] {
  const discovered = discoverLocalServers(projectPath)
  // A server whose NAME already exists in BearCode's own registry
  // (.agents/mcp.json / global mcp.json / enabled plugins) reached BearCode
  // through some other path -- the standalone "Import local…" picker, a
  // manual add, or a Smithery install -- and none of those write an
  // imported_config_sources row, so the DB-backed already-imported filter in
  // ipc.ts's scan handler can never catch it. Re-offering it here as a fresh,
  // pre-checked candidate would let "Import selected" silently re-import (and
  // header/env-blank) a connector the user already configured (final
  // whole-branch review, Finding 1). No `opts` needed: this is a pure
  // name-existence check, not an enumeration of trust-gated content, and
  // loadServers defaults its plugin-project split to untrusted, which never
  // throws and only ever narrows (never widens) what counts as "already
  // registered" here.
  const registeredNames = new Set(loadServers(projectPath).map((s) => s.name))
  const candidates: ImportCandidate[] = []
  for (const server of discovered) {
    if (registeredNames.has(server.name)) continue
    const sourcePath = mcpSourcePathFor(server)
    const tool = ORIGIN_TOOL[server.origin]
    if (sourcePath === null || tool === undefined) continue
    // classifyTransport (mcp/store.ts) falls back to 'http' for a malformed
    // entry with neither `command` nor `url` -- that config can never actually
    // connect, so it is marked unbuildable rather than shown as a live
    // candidate (Finding 5), matching how buildRuleCandidate/etc represent an
    // entry that failed to translate (candidateViews.ts's `view` helper).
    const malformed =
      (server.transport === 'stdio' && !server.command) ||
      (server.transport === 'http' && !server.url)
    if (malformed) {
      candidates.push({ sourcePath, kind: 'mcp', tool, buildable: false })
      continue
    }
    const preview =
      server.transport === 'stdio'
        ? `local · ${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`
        : `remote · ${server.url ?? ''}`
    candidates.push({ sourcePath, kind: 'mcp', tool, buildable: true, preview })
  }
  return candidates
}
