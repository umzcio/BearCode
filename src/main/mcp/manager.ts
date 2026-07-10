// MCP (Connectors) lifecycle manager: connects to a server's
// MultiServerMCPClient once on enable() (enumerate-on-enable), caches its
// tool list for cheap repeated reads, and connects on demand for a bare
// callTool() so a tool call never depends on a prior explicit enable().
// Mirrors browser/manager.ts's singleton + stash idioms (BrowserManager,
// manager.ts:28, :263-277) so the two subsystems read the same way.
import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import type { McpServerConfig, McpToolInfo, McpServerStatus } from '../../shared/types'
import { loadServers, resolveConfig, isEnabled, isTrusted, hasSpawnConsent } from './store'

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
    try {
      const resolved = resolveConfig(cfg)
      const clientConfig = { mcpServers: { [name]: toConnection(resolved) } }
      const client = new MultiServerMCPClient(
        clientConfig as ConstructorParameters<typeof MultiServerMCPClient>[0]
      ) as unknown as McpAdapterClient
      const rawTools = await client.getTools()
      const status: McpServerStatus = { state: 'connected', tools: rawTools.map(toToolInfo) }
      this.servers.set(name, { client, status, tools: rawTools })
      this.lastStatus.set(name, status)
      return status
    } catch (e) {
      const status: McpServerStatus = { state: 'error', message: cleanError(e) }
      this.servers.delete(name)
      this.lastStatus.set(name, status)
      return status
    }
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
