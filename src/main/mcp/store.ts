// MCP (Connectors) config store: reads global (`~/.bearcode/agents/mcp.json`)
// and project (`<project>/.agents/mcp.json`) server configs, merges them
// (project wins by name, same idiom as agentsDir/index.ts), resolves
// `${VAULT:key}` references in headers/env, and persists enable/trust/
// spawn-consent state through the app's settings store. Pure Node builtins
// only, no new deps. Malformed or missing JSON never throws -- callers
// always get back an array (at worst empty), per design 11 / Global
// Constraints.
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { McpServerConfig, McpTransport } from '../../shared/types'
import { getSettings, setSettings } from '../settings'
import { resolveVaultRefs } from '../keys'

const MAX_MCP_JSON_BYTES = 64 * 1024

// Bounded, stat-gated file read -- same hardening as agentsDir/index.ts's
// readFileCapped (regular-files-only via stats.isFile() before any open,
// and a preallocated-buffer bound via readSync rather than a whole-file
// readFileSync). Copied locally per the plan rather than exported from
// agentsDir, which is a distinct subsystem.
function readFileCapped(path: string, cap: number): { text: string; truncated: boolean } | null {
  let fd: number
  let size: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    size = stats.size
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const toRead = Math.min(size, cap)
    const buf = Buffer.alloc(toRead)
    let offset = 0
    while (offset < toRead) {
      const n = readSync(fd, buf, offset, toRead - offset, offset)
      if (n === 0) break
      offset += n
    }
    return { text: buf.toString('utf8', 0, offset), truncated: size > cap }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function globalMcpPath(): string {
  return join(homedir(), '.bearcode', 'agents', 'mcp.json')
}

function projectMcpPath(projectPath: string): string {
  return join(projectPath, '.agents', 'mcp.json')
}

// A server entry as it appears ON DISK under `mcpServers`. Claude Code-
// compatible (design §2): the transport lives in the `type` field
// ('http'/'sse'/'stdio'), NOT `transport`. We also tolerate a legacy
// `transport` field so configs BearCode itself wrote before this fix keep
// loading. `name`/`source` are derived at load time, never persisted.
interface RawServerEntry {
  type?: string
  transport?: string
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}

// Classify a raw entry's transport. Precedence: explicit `type` (Claude Code
// shape) -> legacy `transport` -> infer from shape. A `command` with no url
// means stdio (still gated by spawn consent downstream); anything ambiguous or
// unknown falls back to 'http', which CANNOT spawn a local process -- so a
// missing/garbled field can never silently launch an arbitrary command
// (the exact hole the reviewer flagged).
function classifyTransport(entry: RawServerEntry): McpTransport {
  const declared = entry.type ?? entry.transport
  if (declared === 'stdio') return 'stdio'
  if (declared === 'http' || declared === 'sse' || declared === 'streamable-http') return 'http'
  if (declared === undefined && typeof entry.command === 'string' && !entry.url) return 'stdio'
  return 'http'
}

// Serialize a runtime config back to the on-disk (Claude Code) shape: the
// runtime `transport` field becomes `type`, and `name`/`source` are dropped.
function toRawEntry(cfg: McpServerConfig): RawServerEntry {
  const { name: _name, source: _source, transport, ...rest } = cfg
  return { type: transport, ...rest }
}

function readServerMap(path: string): Record<string, RawServerEntry> {
  const read = readFileCapped(path, MAX_MCP_JSON_BYTES)
  if (!read) return {}
  try {
    const parsed = JSON.parse(read.text) as { mcpServers?: unknown }
    const servers = parsed.mcpServers
    if (!servers || typeof servers !== 'object') return {}
    // Drop any non-object entry (e.g. `"x": "oops"`) so a malformed value can
    // never spread into an indexed-char garbage config downstream.
    const out: Record<string, RawServerEntry> = {}
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        out[name] = entry as RawServerEntry
      }
    }
    return out
  } catch {
    return {}
  }
}

function toConfigMap(
  raw: Record<string, RawServerEntry>,
  source: 'global' | 'project'
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [name, entry] of Object.entries(raw)) {
    out[name] = {
      name,
      source,
      transport: classifyTransport(entry),
      url: entry.url,
      headers: entry.headers,
      command: entry.command,
      args: entry.args,
      env: entry.env
    }
  }
  return out
}

// Pure helper (exported for test): merges a global and project server map
// keyed by name into a single array, project entries overwriting global
// entries of the same name. Mirrors agentsDir/index.ts's merge idiom
// (global into a Map, then project .set() overwrites, Array.from(values())).
export function mergeServerMaps(
  global: Record<string, McpServerConfig>,
  project: Record<string, McpServerConfig>
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>()
  for (const [name, cfg] of Object.entries(global)) byName.set(name, { ...cfg, source: 'global' })
  for (const [name, cfg] of Object.entries(project)) byName.set(name, { ...cfg, source: 'project' })
  return Array.from(byName.values())
}

export function loadServers(projectPath: string | null): McpServerConfig[] {
  const global = toConfigMap(readServerMap(globalMcpPath()), 'global')
  const project = projectPath
    ? toConfigMap(readServerMap(projectMcpPath(projectPath)), 'project')
    : {}
  return mergeServerMaps(global, project)
}

// Replaces `${VAULT:key}` references in headers/env values with the
// decrypted secret. Config on disk must only ever contain such refs, never
// plaintext secrets (design 11).
export function resolveConfig(cfg: McpServerConfig): McpServerConfig {
  const mapVals = (o?: Record<string, string>): Record<string, string> | undefined =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveVaultRefs(v)])) : undefined
  return { ...cfg, headers: mapVals(cfg.headers), env: mapVals(cfg.env) }
}

function pathForSource(cfg: Pick<McpServerConfig, 'source'>, projectPath: string | null): string {
  if (cfg.source === 'project') {
    if (!projectPath)
      throw new Error('cannot write a project MCP server config without a project path')
    return projectMcpPath(projectPath)
  }
  return globalMcpPath()
}

function writeServerMap(path: string, servers: Record<string, RawServerEntry>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2))
}

export function upsertServer(cfg: McpServerConfig, projectPath: string | null): void {
  const path = pathForSource(cfg, projectPath)
  const servers = readServerMap(path)
  servers[cfg.name] = toRawEntry(cfg)
  writeServerMap(path, servers)
}

export function removeServer(
  name: string,
  source: 'global' | 'project',
  projectPath: string | null
): void {
  const path = pathForSource({ source }, projectPath)
  if (!existsSync(path)) return
  const servers = readServerMap(path)
  delete servers[name]
  writeServerMap(path, servers)
}

// ---- enable / trust / spawn-consent state (settings-backed) ----

export function isEnabled(name: string): boolean {
  return (getSettings().mcpEnabledServers ?? []).includes(name)
}

export function setEnabled(name: string, on: boolean): void {
  const current = getSettings().mcpEnabledServers ?? []
  const next = on ? Array.from(new Set([...current, name])) : current.filter((n) => n !== name)
  setSettings({ mcpEnabledServers: next })
}

// Global servers are always trusted (they were explicitly added by the
// user at the app level). Project servers require an explicit per-project
// opt-in, since a project's `.agents/mcp.json` may arrive via a cloned repo
// and its author is not necessarily the current user (design 11).
export function isTrusted(
  name: string,
  source: 'global' | 'project',
  projectPath: string | null
): boolean {
  // Global servers were added by the user at the app level -> trusted by
  // default, regardless of whether a project is open. (The prior signature
  // ignored `source` and treated EVERY server as untrusted whenever a project
  // was open, which hid the user's own global servers behind a Trust button and
  // filtered them out of buildMcpTools -- the bug the reviewer flagged.)
  // EXCEPTION: a global server installed from the Smithery registry carries a
  // url/command chosen by an untrusted registry response, not typed by the
  // user, so it is recorded in mcpUntrustedGlobalServers and stays untrusted
  // (L2 trust-gated, so a malicious deploymentUrl cannot connect on enable)
  // until the user explicitly trusts it.
  if (source === 'global') {
    return !(getSettings().mcpUntrustedGlobalServers ?? []).includes(name)
  }
  // A project-source server requires an explicit per-project opt-in, since a
  // project's committed `.agents/mcp.json` may arrive via a cloned repo whose
  // author is not the current user (design §4). Without a project path there
  // is no trust map to consult, so it cannot be trusted.
  if (!projectPath) return false
  const trustedMap = getSettings().mcpTrustedProjectServers ?? {}
  return (trustedMap[projectPath] ?? []).includes(name)
}

export function trustProjectServer(name: string, projectPath: string): void {
  const trustedMap = getSettings().mcpTrustedProjectServers ?? {}
  const current = trustedMap[projectPath] ?? []
  const next = { ...trustedMap, [projectPath]: Array.from(new Set([...current, name])) }
  setSettings({ mcpTrustedProjectServers: next })
}

// Records a global server as untrusted until the user opts in. Called when a
// server is installed from the Smithery registry (its url/command is registry-
// supplied, not user-typed), so the L2 trust gate fires before it can connect.
export function markGlobalServerUntrusted(name: string): void {
  const current = getSettings().mcpUntrustedGlobalServers ?? []
  setSettings({ mcpUntrustedGlobalServers: Array.from(new Set([...current, name])) })
}

// The user's explicit opt-in for a global server that was pending trust (e.g. a
// Smithery install). Removes it from the untrusted set so isTrusted() returns
// true and the server may connect.
export function trustGlobalServer(name: string): void {
  const current = getSettings().mcpUntrustedGlobalServers ?? []
  setSettings({ mcpUntrustedGlobalServers: current.filter((n) => n !== name) })
}

export function hasSpawnConsent(name: string): boolean {
  return (getSettings().mcpSpawnConsented ?? []).includes(name)
}

export function grantSpawnConsent(name: string): void {
  const current = getSettings().mcpSpawnConsented ?? []
  setSettings({ mcpSpawnConsented: Array.from(new Set([...current, name])) })
}
