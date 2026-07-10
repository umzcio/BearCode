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
import type { McpServerConfig } from '../../shared/types'
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

// A server entry on disk, keyed by name under `mcpServers`, with no
// `source`/`name` fields (those are derived at load time).
type RawServerEntry = Omit<McpServerConfig, 'name' | 'source'>

function readServerMap(path: string): Record<string, RawServerEntry> {
  const read = readFileCapped(path, MAX_MCP_JSON_BYTES)
  if (!read) return {}
  try {
    const parsed = JSON.parse(read.text) as { mcpServers?: unknown }
    const servers = parsed.mcpServers
    if (!servers || typeof servers !== 'object') return {}
    return servers as Record<string, RawServerEntry>
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
    out[name] = { ...entry, name, source }
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
  const { name: _name, source: _source, ...rest } = cfg
  servers[cfg.name] = rest
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
export function isTrusted(name: string, projectPath: string | null): boolean {
  if (!projectPath) return true
  const trustedMap = getSettings().mcpTrustedProjectServers ?? {}
  return (trustedMap[projectPath] ?? []).includes(name)
}

export function trustProjectServer(name: string, projectPath: string): void {
  const trustedMap = getSettings().mcpTrustedProjectServers ?? {}
  const current = trustedMap[projectPath] ?? []
  const next = { ...trustedMap, [projectPath]: Array.from(new Set([...current, name])) }
  setSettings({ mcpTrustedProjectServers: next })
}

export function hasSpawnConsent(name: string): boolean {
  return (getSettings().mcpSpawnConsented ?? []).includes(name)
}

export function grantSpawnConsent(name: string): void {
  const current = getSettings().mcpSpawnConsented ?? []
  setSettings({ mcpSpawnConsented: Array.from(new Set([...current, name])) })
}
