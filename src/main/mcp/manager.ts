// MCP (Connectors) lifecycle manager: connects to a server's
// MultiServerMCPClient once on enable() (enumerate-on-enable), caches its
// tool list for cheap repeated reads, and connects on demand for a bare
// callTool() so a tool call never depends on a prior explicit enable().
// Mirrors browser/manager.ts's singleton + stash idioms (BrowserManager,
// manager.ts:28, :263-277) so the two subsystems read the same way.
import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpServerConfig, McpToolInfo, McpServerStatus } from '../../shared/types'
import { loadServers, resolveConfig, isEnabled, isTrusted, hasSpawnConsent } from './store'
import { makeMcpOAuthProvider, type McpOAuthProvider } from './oauthProvider'

// MCP client + adapter errors can carry ANSI color codes and multi-line
// "Call log" dumps (same shape Playwright throws -- see
// browser/manager.ts's cleanPlaywrightError). Strip down to the first line
// so the tool-call card + the agent see a clean message.
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const firstLine = raw
    .split('\n')[0]
    .replace(/\[[0-9;]*m/g, '')
    .trim()
  return firstLine || raw
}

// Detects whether a failed connection is a 401/OAuth challenge (vs a network
// or config error) so enable() knows to launch the interactive sign-in flow
// instead of surfacing a dead error. mcp-adapters wraps the SDK's
// UnauthorizedError into an MCPClientError whose message is
// "Authentication failed for HTTP server …" and preserves the "(HTTP 401)"
// marker / a numeric `.code`; the gmail smoke case surfaced as
// "Missing Authorization header". We match all of those, case-insensitively.
// Verified against node_modules/@langchain/mcp-adapters/dist/client.js
// (_createAuthenticationErrorMessage / _getHttpErrorCode) 2026-07-09.
function isAuthChallenge(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code
  if (code === 401) return true
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    msg.includes('authentication failed') ||
    msg.includes('unauthorized') ||
    msg.includes('(http 401)') ||
    msg.includes('oauth') ||
    msg.includes('missing authorization')
  )
}

// Minimal surface this module needs from a langchain DynamicStructuredTool
// (as returned by MultiServerMCPClient#getTools) -- narrowed rather than
// importing the real type so the vitest mock in manager.test.ts only needs
// to supply these fields.
interface McpAdapterTool {
  name: string
  description?: string
  metadata?: { annotations?: { readOnlyHint?: boolean } }
  // The tool's real input schema (a zod schema built by mcp-adapters from the
  // server's JSON inputSchema). buildMcpTools reuses this when presenting the
  // gated wrapper tool to the model, so the model sees the real typed args AND
  // the schema stays provider-compatible (a generic z.record placeholder
  // serializes to `propertyNames`, which Gemini's function-declaration API
  // rejects, failing the whole turn).
  schema?: unknown
  invoke?: (args: unknown) => Promise<unknown>
  func?: (args: unknown) => Promise<unknown>
}
interface McpAdapterClient {
  getTools: (...args: unknown[]) => Promise<McpAdapterTool[]>
  close?: () => Promise<void>
}

function toConnection(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.transport === 'http') {
    return { transport: 'http', url: cfg.url, headers: cfg.headers }
  }
  return { transport: 'stdio', command: cfg.command, args: cfg.args, env: cfg.env }
}

function toToolInfo(t: McpAdapterTool): McpToolInfo {
  return {
    name: t.name,
    description: t.description ?? '',
    readOnlyHint: t.metadata?.annotations?.readOnlyHint === true
  }
}

interface ServerEntry {
  client: McpAdapterClient
  status: McpServerStatus
  tools: McpAdapterTool[]
}

class McpManager {
  private servers = new Map<string, ServerEntry>()
  private projectProvider: () => string | null = () => null

  // One vault-backed OAuthClientProvider per remote server, created lazily and
  // reused so saved tokens/client-registration survive across reconnects (and
  // so an in-flight loopback capture has a stable home to dispose). Disposed +
  // dropped on teardown(name); all disposed on a full teardown().
  private oauthProviders = new Map<string, McpOAuthProvider>()

  // In-flight OAuth sign-in per server. `mcp.authorize()` blocks main-side for
  // the whole browser+loopback round-trip (up to the loopback timeout), and the
  // renderer can't observe the interim 'authorizing' status, so a user can click
  // "Sign in" again while the first flow is still running. A second concurrent
  // auth() on the shared provider would overwrite the first's PKCE code verifier
  // (oauthProvider codeVerifierMem is a single slot) and open a second browser
  // tab, breaking the first token exchange. We dedupe here: a second sign-in for
  // the same server returns the in-flight promise instead of starting a new flow.
  private inFlightAuth = new Map<string, Promise<McpServerStatus>>()

  private oauthProviderFor(name: string): McpOAuthProvider {
    let p = this.oauthProviders.get(name)
    if (!p) {
      p = makeMcpOAuthProvider(name)
      this.oauthProviders.set(name, p)
    }
    return p
  }

  // Wired by the tool layer (mirrors browserManager.setPolicyProvider) so
  // connect-on-demand callTool() knows which project's server config to
  // resolve without the graph/tool layer having to thread a project path
  // through every call site.
  setProjectProvider(fn: () => string | null): void {
    this.projectProvider = fn
  }

  private findConfig(name: string, projectPath: string | null): McpServerConfig | undefined {
    return loadServers(projectPath).find((c) => c.name === name)
  }

  // Security floor at the single process/connection chokepoint. enable() is the
  // ONLY path that constructs a MultiServerMCPClient -- set-enabled, reconnect,
  // and connect-on-demand callTool() all funnel through here -- so gating it
  // once closes, in the main process, every launch path at once:
  //   - reconnect/set-enabled/connect-on-demand can no longer open a connection
  //     to a committed-project server the user never TRUSTED (was: one click on
  //     an untrusted row exfiltrated vault secrets to the committed URL);
  //   - a stdio server can no longer spawn its command without explicit
  //     spawn CONSENT (was: hasSpawnConsent had zero callers);
  //   - a DISABLED server can no longer be resurrected on demand.
  // Returns a human-readable denial reason, or null when launch is permitted.
  private launchDenial(cfg: McpServerConfig, projectPath: string | null): string | null {
    if (!isEnabled(cfg.name)) return `MCP server is not enabled: ${cfg.name}`
    if (!isTrusted(cfg.name, cfg.source, projectPath))
      return `MCP server is not trusted for this project: ${cfg.name}`
    if (cfg.transport === 'stdio' && !hasSpawnConsent(cfg.name))
      return `Local MCP server requires spawn consent before it can run: ${cfg.name}`
    return null
  }

  async enable(name: string, projectPath: string | null): Promise<McpServerStatus> {
    const cfg = this.findConfig(name, projectPath)
    if (!cfg) {
      const status: McpServerStatus = { state: 'error', message: `unknown MCP server: ${name}` }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
    const denial = this.launchDenial(cfg, projectPath)
    if (denial) {
      const status: McpServerStatus = { state: 'error', message: denial }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
    const resolved = resolveConfig(cfg)
    // Only remote (http) servers can do OAuth. Attach the provider up front
    // ONLY when it already holds saved tokens, so a first connect to an
    // unauthenticated server fails fast with a clean 401 (rather than the SDK
    // transport auto-opening the browser inside getTools() and blocking the
    // connect on the loopback). The interactive flow is driven explicitly by
    // signIn() below once we've detected the challenge.
    const provider = cfg.transport === 'http' ? this.oauthProviderFor(name) : undefined
    const haveTokens = provider ? Boolean(await provider.tokens()) : false
    try {
      return await this.connect(name, resolved, haveTokens ? provider : undefined)
    } catch (e) {
      if (provider && isAuthChallenge(e)) {
        return this.signIn(name, resolved, provider)
      }
      const status: McpServerStatus = { state: 'error', message: cleanError(e) }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
  }

  // Opens ONE MultiServerMCPClient connection and enumerates tools. Throws on
  // failure (the caller decides whether that's an OAuth challenge worth a
  // sign-in or a terminal error). When `provider` is passed the transport uses
  // it for auth (reads the vaulted tokens); it is omitted on an unauthenticated
  // first attempt so the transport never launches a browser on its own.
  private async connect(
    name: string,
    resolved: McpServerConfig,
    provider?: McpOAuthProvider
  ): Promise<McpServerStatus> {
    const connection = toConnection(resolved)
    if (provider) connection.authProvider = provider
    const clientConfig = { mcpServers: { [name]: connection } }
    const client = new MultiServerMCPClient(
      clientConfig as ConstructorParameters<typeof MultiServerMCPClient>[0]
    ) as unknown as McpAdapterClient
    const rawTools = await client.getTools()
    const status: McpServerStatus = { state: 'connected', tools: rawTools.map(toToolInfo) }
    this.servers.set(name, { client, status, tools: rawTools })
    this.lastStatus.set(name, status)
    return status
  }

  // Drives the interactive OAuth sign-in for a remote server: marks the row
  // 'authorizing', runs the SDK auth() flow (browser + loopback + token
  // exchange via the vault-backed provider), then reconnects using the freshly
  // vaulted tokens. Any failure (cancel/timeout/exchange) clears to 'error'.
  // SECURITY: tokens live only in the vault (via the provider); none is logged
  // or returned — the resolved McpServerStatus never carries a secret.
  private async signIn(
    name: string,
    resolved: McpServerConfig,
    provider: McpOAuthProvider
  ): Promise<McpServerStatus> {
    if (resolved.transport !== 'http' || !resolved.url) {
      const status: McpServerStatus = {
        state: 'error',
        message: `OAuth sign-in is only available for remote servers: ${name}`
      }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
    // Coalesce a concurrent sign-in for the same server onto the running flow
    // (see inFlightAuth): a double-click on "Sign in", or an enable()-triggered
    // 401 racing a manual authorize(), must not spawn a second auth() that
    // clobbers the shared PKCE verifier or opens a second browser tab.
    const inFlight = this.inFlightAuth.get(name)
    if (inFlight) return inFlight
    const flow = this.runSignIn(name, resolved, resolved.url, provider)
    this.inFlightAuth.set(name, flow)
    try {
      return await flow
    } finally {
      this.inFlightAuth.delete(name)
    }
  }

  private async runSignIn(
    name: string,
    resolved: McpServerConfig,
    url: string,
    provider: McpOAuthProvider
  ): Promise<McpServerStatus> {
    const authorizing: McpServerStatus = { state: 'authorizing' }
    this.lastStatus.set(name, authorizing)
    try {
      await this.runOAuthFlow(url, provider)
      // Tokens are now vaulted; reconnect with the provider so the transport
      // presents them.
      return await this.connect(name, resolved, provider)
    } catch (e) {
      provider.dispose()
      const status: McpServerStatus = { state: 'error', message: cleanError(e) }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
  }

  // The two-step SDK continuation (design §3): the first auth() runs discovery
  // → dynamic client registration → PKCE and calls the provider's
  // redirectToAuthorization (open browser + block on the loopback capture),
  // returning 'REDIRECT'; we then hand the captured code back for the token
  // exchange, which returns 'AUTHORIZED'. If auth() short-circuits to
  // 'AUTHORIZED' (a still-valid saved token) we skip the exchange.
  private async runOAuthFlow(serverUrl: string, provider: McpOAuthProvider): Promise<void> {
    await provider.prepare()
    try {
      const first = await auth(provider, { serverUrl })
      if (first !== 'AUTHORIZED') {
        const code = provider.takeAuthorizationCode()
        if (!code) throw new Error('OAuth sign-in was cancelled or timed out')
        const second = await auth(provider, { serverUrl, authorizationCode: code })
        if (second !== 'AUTHORIZED') throw new Error('OAuth token exchange did not complete')
      }
    } finally {
      provider.dispose()
    }
  }

  // Explicit (re)trigger for the "Sign in" action on an errored remote row.
  // Tears down any stale connection, then runs the same sign-in flow. If a
  // valid token is already vaulted the SDK auth() returns AUTHORIZED without a
  // browser round-trip and we simply reconnect.
  async authorize(name: string, projectPath: string | null): Promise<McpServerStatus> {
    const cfg = this.findConfig(name, projectPath)
    if (!cfg) {
      const status: McpServerStatus = { state: 'error', message: `unknown MCP server: ${name}` }
      this.lastStatus.set(name, status)
      return status
    }
    const denial = this.launchDenial(cfg, projectPath)
    if (denial) {
      const status: McpServerStatus = { state: 'error', message: denial }
      this.lastStatus.set(name, status)
      return status
    }
    if (cfg.transport !== 'http') {
      const status: McpServerStatus = {
        state: 'error',
        message: `OAuth sign-in is only available for remote servers: ${name}`
      }
      this.lastStatus.set(name, status)
      return status
    }
    // Close any existing client but keep the provider (its saved tokens/client
    // registration are reused by the sign-in).
    const existing = this.servers.get(name)
    if (existing?.client.close) {
      try {
        await existing.client.close()
      } catch {
        // best-effort
      }
    }
    this.servers.delete(name)
    return this.signIn(name, resolveConfig(cfg), this.oauthProviderFor(name))
  }

  // Tracks the most recent status per server independent of whether the
  // server is currently connected, so statusOf() reflects an error even
  // after the (never-created) connection is gone from `servers`.
  private lastStatus = new Map<string, McpServerStatus>()

  statusOf(name: string): McpServerStatus {
    return this.lastStatus.get(name) ?? { state: 'disabled' }
  }

  listTools(name: string): McpToolInfo[] {
    return (this.servers.get(name)?.tools ?? []).map(toToolInfo)
  }

  // Main-only accessor for a tool's real input schema (NOT part of McpToolInfo,
  // which crosses IPC to the renderer where a zod schema wouldn't serialize).
  // buildMcpTools uses it so the gated wrapper presents the server's real typed
  // arguments to the model instead of an opaque, Gemini-incompatible placeholder.
  toolSchema(name: string, tool: string): unknown {
    return this.servers.get(name)?.tools.find((t) => t.name === tool)?.schema
  }

  async callTool(name: string, tool: string, args: unknown): Promise<string> {
    let entry = this.servers.get(name)
    if (!entry) {
      const status = await this.enable(name, this.projectProvider())
      if (status.state !== 'connected') {
        throw new Error(
          status.state === 'error' ? status.message : `MCP server not connected: ${name}`
        )
      }
      entry = this.servers.get(name)
    }
    if (!entry) throw new Error(`MCP server not connected: ${name}`)
    const target = entry.tools.find((t) => t.name === tool)
    if (!target) throw new Error(`MCP tool not found: ${name}.${tool}`)
    const invoke = target.invoke ?? target.func
    if (!invoke) throw new Error(`MCP tool ${name}.${tool} is not callable`)
    const result = await invoke(args)
    return typeof result === 'string' ? result : JSON.stringify(result)
  }

  async reconnect(name: string, projectPath: string | null): Promise<McpServerStatus> {
    await this.teardown(name)
    return this.enable(name, projectPath)
  }

  async teardown(name?: string): Promise<void> {
    if (name) {
      const entry = this.servers.get(name)
      if (entry?.client.close) {
        try {
          await entry.client.close()
        } catch {
          // best-effort -- a stuck server shouldn't block teardown
        }
      }
      this.servers.delete(name)
      this.lastStatus.delete(name)
      this.oauthProviders.get(name)?.dispose()
      this.oauthProviders.delete(name)
      return
    }
    for (const entry of this.servers.values()) {
      if (entry.client.close) {
        try {
          await entry.client.close()
        } catch {
          // best-effort -- a stuck server shouldn't block teardown
        }
      }
    }
    for (const provider of this.oauthProviders.values()) provider.dispose()
    this.oauthProviders.clear()
    this.inFlightAuth.clear()
    this.servers.clear()
    this.lastStatus.clear()
    this.stash.clear()
  }

  // Out-of-band large-payload channel (mirrors browserManager's screenshot
  // stash, manager.ts:263-277): a tool that returns a large result stashes
  // it here keyed by the provider tool-call id and returns a short
  // placeholder to the model; graph.ts splices the stashed payload into the
  // persisted tool_result for the step card.
  private stash = new Map<string, string>()
  stashResult(toolCallId: string, payload: string): void {
    this.stash.set(toolCallId, payload)
  }
  peekStashedResult(toolCallId: string): string | undefined {
    return this.stash.get(toolCallId)
  }
  takeStashedResult(toolCallId: string): string | undefined {
    const payload = this.stash.get(toolCallId)
    this.stash.delete(toolCallId)
    return payload
  }
}

export const mcpManager = new McpManager()
