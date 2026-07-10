// ============================================================================
// Smithery Registry API — CONFIRMED SHAPE
//
// Verified LIVE against https://smithery.ai/docs on 2026-07-09, specifically:
//   - https://smithery.ai/docs/api-reference/servers/list-all-servers.md
//   - https://smithery.ai/docs/api-reference/servers/get-a-server.md
//   - https://smithery.ai/docs/use/connect
//
// Base URL: https://api.smithery.ai
// Auth:     `Authorization: Bearer <SMITHERY_API_KEY>` (Bearer token / API key).
//
// Search/list:  GET /servers?q=<query>&pageSize=<n>
//   -> { servers: [{ id, qualifiedName, displayName, description, verified,
//                     useCount, isDeployed, remote, bySmithery, createdAt,
//                     score }], pagination: {...} }
//   The list endpoint does NOT return a tool count or a tools array — only
//   the detail endpoint below does, so `SmitheryHit.toolCount` is left
//   undefined for search results (per the plan's optional field).
//
// Detail:  GET /servers/{qualifiedName}  (qualifiedName's `/` URL-encoded)
//   -> { qualifiedName, displayName, description, iconUrl, remote,
//        deploymentUrl, security: { scanPassed }, resources, prompts,
//        connections: [ { type: 'http', deploymentUrl, configSchema } |
//                        { type: 'stdio', bundleUrl, runtime, configSchema } ],
//        tools: [ { name, description, inputSchema, outputSchema } ] }
//
// ASSUMPTION (flagged per the plan's verify-before-coding gate — not found in
// the fetched docs): the docs' client-config examples
// (https://smithery.ai/docs/use/connect) only show remote/http servers driven
// via `deploymentUrl` + `headers` carrying config values (e.g.
// `smithery mcp add <qualifiedName> --headers '{"key": "value"}'`). No worked
// example of a *local client's* stdio launch command was found in the fetched
// pages. For a `type: 'stdio'` connection this client maps to the
// conventional Smithery CLI launch pattern `command: 'npx', args: ['-y',
// qualifiedName]`, threading the connection's `configSchema.required` fields
// through as env vars. If this assumption is wrong for a given server it
// degrades to an `error` status card (see Tasks 5/10) — it never blocks a
// conversation.
// ============================================================================

import type { McpServerConfig, McpTransport, SmitheryHit } from '../../shared/types'
import { getVaultSecret } from '../keys'

const REGISTRY_BASE = 'https://api.smithery.ai'

/** Thrown when no Smithery API key is configured in the vault. The UI (Task
 * 12's BrowseSmitheryModal) catches this and renders an empty-state pointing
 * at Providers/keys instead of a raw error. */
export class SmitheryKeyMissingError extends Error {
  constructor() {
    super('No Smithery API key configured (vault key "smithery:apiKey")')
    this.name = 'SmitheryKeyMissingError'
  }
}

function requireApiKey(): string {
  const key = getVaultSecret('smithery:apiKey')
  if (!key) throw new SmitheryKeyMissingError()
  return key
}

interface RawSmitheryServer {
  qualifiedName: string
  displayName?: string
  description?: string
  remote?: boolean
  iconUrl?: string | null
  useCount?: number
  verified?: boolean
}

interface RawSmitheryConfigSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

interface RawSmitheryConnection {
  type: McpTransport
  deploymentUrl?: string
  bundleUrl?: string
  runtime?: string
  configSchema?: RawSmitheryConfigSchema
}

interface RawSmitheryServerDetail {
  qualifiedName: string
  displayName?: string
  deploymentUrl?: string
  connections?: RawSmitheryConnection[]
}

/** Searches the Smithery registry for public MCP servers. An empty query omits
 * the `q` param to return a general list, which the modal uses (sorted by
 * useCount) as a "popular servers" default before the user searches. Results are
 * sorted by useCount desc so the most-connected servers surface first. */
export async function smitherySearch(query: string): Promise<SmitheryHit[]> {
  const key = requireApiKey()
  const q = query.trim()
  const url = q
    ? `${REGISTRY_BASE}/servers?q=${encodeURIComponent(q)}&pageSize=30`
    : `${REGISTRY_BASE}/servers?pageSize=30`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) {
    throw new Error(`Smithery search failed: ${res.status}`)
  }
  const body = (await res.json()) as { servers?: RawSmitheryServer[] }
  const servers = Array.isArray(body.servers) ? body.servers : []
  return servers
    .map((s) => ({
      id: s.qualifiedName,
      name: s.displayName || s.qualifiedName,
      description: s.description ?? '',
      transport: (s.remote ? 'http' : 'stdio') as McpTransport,
      iconUrl: s.iconUrl ?? null,
      useCount: typeof s.useCount === 'number' ? s.useCount : 0,
      verified: s.verified === true
    }))
    .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
}

// Picks the connection to install. A server can advertise several (e.g. both
// stdio and http); rather than blindly taking connections[0] (which could be an
// http entry with no deploymentUrl -> a url:'' server that can only ever error
// on enable), prefer the first connection that carries a usable endpoint, and
// only fall back to the first entry if none do.
function pickConnection(
  detail: RawSmitheryServerDetail
): RawSmitheryConnection | undefined {
  const conns = detail.connections ?? []
  const usable = conns.find((c) =>
    c.type === 'stdio' ? true : Boolean(c.deploymentUrl ?? detail.deploymentUrl)
  )
  return usable ?? conns[0]
}

/** Fetches a single Smithery server's detail and maps it to an
 * `McpServerConfig`, filling required config fields with `${VAULT:}`
 * placeholders (never inline secret values). `source` controls where the config
 * is written and, for globals, whether it lands trust-gated -- the caller
 * derives it from whether a project is open; either way the server is NOT
 * pre-trusted (see ipc.ts smithery-install). The vault-key scheme
 * (`mcp:<name>:<section>:<field>`) matches the manual-add scrubber
 * (ipc.ts scrubMcpSecretsToVault) so a server's secret keys are reconstructible
 * by convention. */
export async function fetchSmitheryConfig(
  id: string,
  source: 'global' | 'project' = 'global'
): Promise<McpServerConfig> {
  const key = requireApiKey()
  const res = await fetch(`${REGISTRY_BASE}/servers/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!res.ok) {
    throw new Error(`Smithery server fetch failed: ${res.status}`)
  }
  const detail = (await res.json()) as RawSmitheryServerDetail
  const name = detail.qualifiedName || id
  const conn = pickConnection(detail)
  const requiredFields = conn?.configSchema?.required ?? []

  if (conn?.type === 'stdio') {
    const env: Record<string, string> = {}
    for (const field of requiredFields) {
      env[field] = `\${VAULT:mcp:${name}:env:${field}}`
    }
    return {
      name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', name],
      env,
      source
    }
  }

  const headers: Record<string, string> = {}
  for (const field of requiredFields) {
    headers[field] = `\${VAULT:mcp:${name}:headers:${field}}`
  }
  return {
    name,
    transport: 'http',
    url: conn?.deploymentUrl ?? detail.deploymentUrl ?? '',
    headers,
    source
  }
}
