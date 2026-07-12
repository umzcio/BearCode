// MCP (Connectors) config store: reads global (`~/.bearcode/agents/mcp.json`)
// and project (`<project>/.agents/mcp.json`) server configs, merges them
// (project wins by name, same idiom as agentsDir/index.ts), resolves
// `${VAULT:key}` references in headers/env, and persists enable/trust/
// spawn-consent state through the app's settings store. Pure Node builtins
// only, no new deps. Malformed or missing JSON never throws -- callers
// always get back an array (at worst empty), per design 11 / Global
// Constraints.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig, McpTransport } from '../../shared/types'
import { getSettings, setSettings } from '../settings'
import { resolveVaultRefs } from '../keys'
import { readFileCapped } from '../fsCapped'
import { enumeratePluginIngredients } from '../plugins'

const MAX_MCP_JSON_BYTES = 64 * 1024

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

// `opts.trusted` gates PROJECT-scope plugin mcp.json ingredients exactly like
// loadAgentsContent's `trusted` flag gates project skills/rules (a project's
// .agents/plugins/ may arrive via a cloned repo). Global-scope plugin
// ingredients are enumerated unconditionally (enumeratePluginIngredients
// already applies that split). Defaults to untrusted so a caller that forgets
// to pass `opts` never picks up project plugin servers silently.
export function loadServers(
  projectPath: string | null,
  opts?: { trusted?: boolean }
): McpServerConfig[] {
  const global = toConfigMap(readServerMap(globalMcpPath()), 'global')
  const project = projectPath
    ? toConfigMap(readServerMap(projectMcpPath(projectPath)), 'project')
    : {}
  const servers = mergeServerMaps(global, project)

  // Fold in enabled plugins' mcp.json servers, tagged with `plugin`. A plugin
  // server that shares a bare NAME with a direct global/project server (or
  // with an already-enumerated plugin server) is skipped entirely, never
  // enumerated -- isEnabled/setEnabled/hasSpawnConsent/grantSpawnConsent
  // (store.ts) and McpManager's connection identity (this.servers/
  // findConfig, manager.ts) are ALL keyed on the bare `name` only (isTrusted
  // is the sole exception, keyed by `${plugin}:${name}` when `plugin` is
  // set). If two live configs shared one bare name, toggling one would
  // silently flip the enabled/spawn-consent bit read for the other, and
  // `.find(c => c.name === name)` would always resolve the earlier (direct)
  // entry -- so a colliding plugin server could never actually be launched
  // even after the user explicitly trusted it via trustPluginServer.
  // Rejecting the collision at enumeration time closes this at the root: a
  // bare name maps to at most one live config, so every bare-name-keyed
  // lookup downstream is unambiguous by construction. (Previously this
  // checked `seen.has(`${pluginName}:${name}`)` against a `seen` set seeded
  // with BARE names -- a key-space mismatch that meant the check almost
  // never fired, so colliding plugin servers slipped through anyway.)
  const seen = new Set(servers.map((s) => s.name))
  const ing = enumeratePluginIngredients(projectPath, { trusted: opts?.trusted ?? false })
  for (const { pluginName, path } of ing.mcpConfigs) {
    const raw = readServerMap(path)
    for (const [name, entry] of Object.entries(raw)) {
      if (seen.has(name)) continue
      seen.add(name)
      servers.push({
        name,
        source: 'global',
        transport: classifyTransport(entry),
        url: entry.url,
        headers: entry.headers,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        plugin: pluginName
      })
    }
  }
  return servers
}

// ---- read-only discovery of servers configured elsewhere (Task 13) ----

// Claude Desktop's own config file. Read-only: BearCode never writes here.
function claudeDesktopConfigPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
}

// The Claude Code-style project config a repo may already commit. Distinct
// from BearCode's own `<project>/.agents/mcp.json` (projectMcpPath above) --
// this is a DIFFERENT file this reads but never writes.
function projectDotMcpJsonPath(projectPath: string): string {
  return join(projectPath, '.mcp.json')
}

function toDiscovered(
  name: string,
  entry: RawServerEntry,
  origin: DiscoveredMcpServer['origin']
): DiscoveredMcpServer {
  return {
    name,
    origin,
    transport: classifyTransport(entry),
    url: entry.url,
    headers: entry.headers,
    command: entry.command,
    args: entry.args,
    env: entry.env
  }
}

// Read-only discovery of MCP servers already configured by other tools: a
// project's committed `.mcp.json` (Claude Code-style) and the Claude Desktop
// config. Uses the same hardened readServerMap (readFileCapped + JSON.parse
// try/catch) as the rest of this module, so a missing or malformed file
// degrades to [] and NEVER throws or mutates the source file (design §8 G3).
// Deduped by name: a project's `.mcp.json` wins over Claude Desktop's config,
// mirroring the project-over-global precedence used elsewhere in this file.
export function discoverLocalServers(projectPath: string | null): DiscoveredMcpServer[] {
  const byName = new Map<string, DiscoveredMcpServer>()
  const desktopRaw = readServerMap(claudeDesktopConfigPath())
  for (const [name, entry] of Object.entries(desktopRaw)) {
    byName.set(name, toDiscovered(name, entry, 'claude-desktop'))
  }
  if (projectPath) {
    const projectRaw = readServerMap(projectDotMcpJsonPath(projectPath))
    for (const [name, entry] of Object.entries(projectRaw)) {
      byName.set(name, toDiscovered(name, entry, 'project-mcp-json'))
    }
  }
  return Array.from(byName.values())
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
  // Clear the name-keyed enable / spawn-consent / trust state FIRST, before any
  // early return: trust/consent are keyed on the bare name, so if this state
  // survives removal a later server that RECYCLES the name (manual re-add,
  // Smithery install, import) silently inherits the full consent granted to the
  // old config -- the "consent-for-one-command-runs-another" class G3 closes for
  // the import path via invalidateStaleConsentOnImport, but the other re-add
  // paths never run that guard. Resetting on removal closes them all at the
  // source (G3 whole-branch review, finding 1). setEnabled/revokeSpawnConsent
  // no-op cleanly when nothing is set.
  setEnabled(name, false)
  revokeSpawnConsent(name)
  if (source === 'project') {
    if (projectPath) untrustProjectServer(name, projectPath)
  } else {
    // A previously Smithery-installed (pending-trust) global leaves a stale
    // untrusted marker; drop it so a fresh re-add starts from the normal global
    // default rather than a phantom untrusted state for a server that's gone.
    trustGlobalServer(name)
  }
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
  projectPath: string | null,
  plugin?: string
): boolean {
  // A plugin-sourced server (Phase G plugins arc) is untrusted by default
  // regardless of `source` -- its url/command was authored by the plugin,
  // not typed by the user, so the usual "global == trusted by default" and
  // per-project trust-map branches below must NOT apply to it. Trust is only
  // ever granted explicitly, keyed on the plugin-qualified name so trusting
  // one plugin's server never trusts a differently-sourced server that
  // happens to share the same bare name.
  if (plugin) {
    return (getSettings().mcpTrustedPluginServers ?? []).includes(`${plugin}:${name}`)
  }
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

// Removes a project server's per-project trust opt-in, so its L2 Trust gate
// re-fires. Called when a project-target name is removed or rebound to a
// different exec identity (import), so a recycled/retargeted name can't inherit
// the trust the user granted the OLD config (G3 whole-branch review, findings 1 & 2).
export function untrustProjectServer(name: string, projectPath: string): void {
  const trustedMap = getSettings().mcpTrustedProjectServers ?? {}
  const current = trustedMap[projectPath]
  if (!current || !current.includes(name)) return
  const next = { ...trustedMap, [projectPath]: current.filter((n) => n !== name) }
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

// The user's explicit opt-in for a plugin-sourced server (see isTrusted's
// `plugin` branch above). Keyed on the plugin-qualified name so trusting one
// plugin's `db` server never trusts another plugin's (or a direct) `db`.
export function trustPluginServer(plugin: string, name: string): void {
  const current = getSettings().mcpTrustedPluginServers ?? []
  setSettings({ mcpTrustedPluginServers: Array.from(new Set([...current, `${plugin}:${name}`])) })
}

export function untrustPluginServer(plugin: string, name: string): void {
  const current = getSettings().mcpTrustedPluginServers ?? []
  setSettings({ mcpTrustedPluginServers: current.filter((n) => n !== `${plugin}:${name}`) })
}

export function hasSpawnConsent(name: string): boolean {
  return (getSettings().mcpSpawnConsented ?? []).includes(name)
}

export function grantSpawnConsent(name: string): void {
  const current = getSettings().mcpSpawnConsented ?? []
  setSettings({ mcpSpawnConsented: Array.from(new Set([...current, name])) })
}

export function revokeSpawnConsent(name: string): void {
  const current = getSettings().mcpSpawnConsented ?? []
  setSettings({ mcpSpawnConsented: current.filter((n) => n !== name) })
}

// ---- import collision guard (Task 13 review) ----

// The fields of a config that determine what actually RUNS or connects: the
// command + args for stdio, the url for http. Header/env VALUES are excluded
// on purpose -- imports blank them, and they don't change which binary/endpoint
// executes. Used to decide whether an import binds a name to a *different*
// executable identity than the consent already granted for that bare name.
function execIdentity(
  cfg: Pick<McpServerConfig, 'transport' | 'command' | 'args' | 'url'>
): string {
  return cfg.transport === 'stdio'
    ? `stdio ${cfg.command ?? ''} ${JSON.stringify(cfg.args ?? [])}`
    : `http ${cfg.url ?? ''}`
}

// Trust, enable, and spawn-consent are all keyed on the bare server NAME. Every
// other creation path (manual add, Smithery) creates a name and its consent
// together, but IMPORT can bind an attacker-influenced foreign config to a name
// whose consent already exists -- so the new command/url would silently inherit
// the gates granted for the OLD one (G3 review, findings 1 & 2). Call this
// BEFORE upserting an imported config: if a config already effectively owns this
// name (the merged project-over-global winner) and its executable identity
// differs from the incoming one, drop the stale name-keyed spawn-consent and
// enable state so the spawn-consent prompt re-fires against the real new
// command, and untrust a global target so its Trust gate re-fires too (project
// targets already start untrusted via the per-project trust map). Returns true
// when stale consent was invalidated. No-op for a brand-new name or a re-import
// of the identical config.
export function invalidateStaleConsentOnImport(
  cfg: McpServerConfig,
  projectPath: string | null
): boolean {
  const existing = loadServers(projectPath).find((c) => c.name === cfg.name)
  if (!existing) return false
  if (execIdentity(existing) === execIdentity(cfg)) return false
  setEnabled(cfg.name, false)
  revokeSpawnConsent(cfg.name)
  if (cfg.source === 'global') {
    markGlobalServerUntrusted(cfg.name)
  } else if (projectPath) {
    // A project target may have been explicitly TRUSTED for this project before
    // the rebind (the old comment wrongly assumed project targets always start
    // untrusted). If we don't clear it, re-enabling connects to the NEW url/
    // command with the OLD trust -- e.g. shipping ${VAULT:}-resolved headers to a
    // rebound https://evil with no re-trust prompt (G3 whole-branch review,
    // finding 2). Untrust so the L2 Trust gate re-fires against the new identity.
    untrustProjectServer(cfg.name, projectPath)
  }
  return true
}
