import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type {
  DiscoveredMcpServer,
  McpServerView,
  McpTransport,
  PermissionRuleEffect,
  RuleScope
} from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { Select } from '../../Select'
import type { SelectOption } from '../../Select'
import { BrowseSmitheryModal } from '../BrowseSmitheryModal'

// A settings row: title + description on the left, the control on the right.
function Row({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        <div className="set-row-desc">{desc}</div>
      </div>
      {children ?? null}
    </div>
  )
}

const RULE_OPTIONS: SelectOption<PermissionRuleEffect>[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' }
]

const ADD_OPTIONS: SelectOption<'manual' | 'browse' | 'import'>[] = [
  { value: 'manual', label: 'Add manually', description: 'Enter a URL or command yourself' },
  { value: 'browse', label: 'Browse Smithery', description: 'Search the Smithery registry' },
  {
    value: 'import',
    label: 'Import local…',
    description: 'Pick up servers already configured in Claude Desktop or .mcp.json'
  }
]

const ORIGIN_LABEL: Record<DiscoveredMcpServer['origin'], string> = {
  'claude-desktop': 'Claude Desktop',
  'project-mcp-json': 'project .mcp.json'
}

// Checkbox picker for Task 13 local discovery. A separate component so its
// own discover-on-open effect and selection state don't leak into the page.
function ImportLocalPicker({
  workspacePath,
  onClose,
  onImported
}: {
  workspacePath: string | null
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  const [found, setFound] = useState<DiscoveredMcpServer[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    let alive = true
    void window.bearcode.mcp.discover(workspacePath).then((servers) => {
      if (alive) setFound(servers)
    })
    return () => {
      alive = false
    }
  }, [workspacePath])

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const doImport = (): void => {
    const picked = (found ?? []).filter((s) => selected.has(s.name))
    if (picked.length === 0) return
    setImporting(true)
    void window.bearcode.mcp.import(picked, workspacePath).then(() => {
      setImporting(false)
      onImported()
      onClose()
    })
  }

  return (
    <div className="connector-add-form">
      {found === null ? (
        <div className="set-row-desc">Scanning…</div>
      ) : found.length === 0 ? (
        <div className="domain-empty">No local MCP servers found.</div>
      ) : (
        <>
          {found.map((s) => (
            <label key={`${s.origin}:${s.name}`} className="set-row">
              <input
                type="checkbox"
                checked={selected.has(s.name)}
                onChange={() => toggle(s.name)}
              />
              <div className="set-row-text">
                <div className="set-row-title">{s.name}</div>
                <div className="set-row-desc">
                  {ORIGIN_LABEL[s.origin]} · {s.transport === 'stdio' ? 'local' : 'remote'}
                  {s.transport === 'stdio' ? ` · ${s.command}` : ` · ${s.url}`}
                </div>
              </div>
            </label>
          ))}
          <button
            className="pill-btn primary"
            disabled={selected.size === 0 || importing}
            onClick={doImport}
          >
            {importing ? 'Importing…' : `Import selected (${selected.size})`}
          </button>
          <div className="set-row-desc">
            Secrets are not copied -- fill in any header/env values afterward.
          </div>
        </>
      )}
    </div>
  )
}

type ManualDraft = {
  name: string
  transport: McpTransport
  scope: 'global' | 'project'
  url: string
  command: string
  args: string
  headers: string
  env: string
}

const EMPTY_DRAFT: ManualDraft = {
  name: '',
  transport: 'http',
  scope: 'global',
  url: '',
  command: '',
  args: '',
  headers: '',
  env: ''
}

// Two RuleScopes are equal when both are 'global', or both name the same
// project. Used to reflect a tool's existing rule into its Select.
function sameScope(a: RuleScope, b: RuleScope): boolean {
  if (a === 'global' || b === 'global') return a === b
  return a.projectPath === b.projectPath
}

// Parses "k=v, k2=v2" into a Record, ignoring blank/malformed entries.
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const [k, ...rest] = part.split('=')
    const key = k?.trim()
    const val = rest.join('=').trim()
    if (key && val) out[key] = val
  }
  return out
}

export function ConnectorsPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const workspacePath = useAppStore((s) => s.workspacePath)
  const addPermissionRule = useAppStore((s) => s.addPermissionRule)
  const permissionRules = useAppStore((s) => s.permissionRules)
  const refreshPermissionRules = useAppStore((s) => s.refreshPermissionRules)

  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingConsent, setPendingConsent] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<'manual' | 'browse' | 'import' | null>(null)
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_DRAFT)
  // Server names with a sign-in flow in flight. mcp.authorize() blocks main-side
  // for the whole browser+loopback round-trip and the interim 'authorizing'
  // status isn't pushed to the renderer, so we track it locally: the row shows
  // "signing in…" and disables Sign in / Reconnect until the promise settles,
  // preventing a double-click from starting a second (PKCE-clobbering) flow.
  const [authorizing, setAuthorizing] = useState<ReadonlySet<string>>(() => new Set())

  const refresh = (): void => {
    void window.bearcode.mcp.list(workspacePath).then((list) => setServers(list))
  }

  useEffect(() => {
    let alive = true
    // ensureConnected (not list): opening the page non-interactively connects
    // any enabled+trusted idle server, so its status reflects reality (real
    // tool count / "connected") instead of a stale "not connected" — and it
    // surfaces in the @-menu — without the user hitting Reconnect after a
    // restart. Never opens an OAuth browser (interactive:false in main).
    void window.bearcode.mcp.ensureConnected(workspacePath).then((list) => {
      if (alive) setServers(list)
    })
    // Load the permission rules so each tool's Select can reflect its existing
    // effect on mount rather than always showing the default.
    void refreshPermissionRules()
    return () => {
      alive = false
    }
  }, [workspacePath, refreshPermissionRules])

  if (!settings) return null

  const enabled = settings.mcpEnabled === true

  const ruleScope: RuleScope = workspacePath ? { projectPath: workspacePath } : 'global'

  const toggleServer = (view: McpServerView, on: boolean): void => {
    // A local (stdio) server needs one-time spawn consent before its command
    // ever runs. Once granted (view.spawnConsented), don't re-prompt on every
    // subsequent enable toggle -- the recorded consent is honored in main.
    if (on && view.config.transport === 'stdio' && !view.spawnConsented) {
      setPendingConsent(view.config.name)
      return
    }
    void window.bearcode.mcp.setEnabled(view.config.name, on, workspacePath).then(refresh)
  }

  const confirmSpawn = (name: string): void => {
    void window.bearcode.mcp
      .spawnConsent(name)
      .then(() => window.bearcode.mcp.setEnabled(name, true, workspacePath))
      .then(() => {
        setPendingConsent(null)
        refresh()
      })
  }

  const toolRuleEffect = (server: string, tool: string): PermissionRuleEffect => {
    const match = `${server}.${tool}`
    const found = (permissionRules?.userRules ?? []).find(
      (r) => r.action === 'mcp' && r.match === match && sameScope(r.scope, ruleScope)
    )
    return found?.effect ?? 'ask'
  }

  const trustServer = (view: McpServerView): void => {
    // A global server pending trust (a Smithery install) is trusted without a
    // project path; a project-scoped server is trusted per-project.
    if (view.config.source === 'global') {
      void window.bearcode.mcp.trustGlobal(view.config.name).then(refresh)
      return
    }
    if (!workspacePath) return
    void window.bearcode.mcp.trust(view.config.name, workspacePath).then(refresh)
  }

  const reconnectServer = (name: string): void => {
    void window.bearcode.mcp.reconnect(name, workspacePath).then(refresh)
  }

  // Kicks the OAuth sign-in for a remote server that hit a 401 (opens the
  // system browser main-side; only the resulting status crosses back — never a
  // token). Refreshes the row when the flow settles.
  const authorizeServer = (name: string): void => {
    // Guard against a double-trigger: ignore the click if a flow is already in
    // flight for this server (the button is also disabled, this is defense in
    // depth). Mark the row authorizing immediately so the UI reflects it without
    // waiting for the blocking main-side call to resolve.
    if (authorizing.has(name)) return
    setAuthorizing((prev) => new Set(prev).add(name))
    void window.bearcode.mcp
      .authorize(name, workspacePath)
      .then(refresh)
      .finally(() => {
        setAuthorizing((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      })
  }

  const removeServer = (view: McpServerView): void => {
    void window.bearcode.mcp
      .remove(view.config.name, view.config.source, workspacePath)
      .then(refresh)
  }

  const setToolRule = (server: string, tool: string, effect: PermissionRuleEffect): void => {
    addPermissionRule({ scope: ruleScope, action: 'mcp', match: `${server}.${tool}`, effect })
  }

  const submitManualAdd = (): void => {
    const name = draft.name.trim()
    if (!name) return
    // Scope is an EXPLICIT choice, never a silent default. Without a workspace
    // open only 'global' is possible; with one open the user picks, so a
    // personal server (and its secrets) no longer lands in the committed
    // project file unless they intend it.
    const source: 'project' | 'global' = workspacePath ? draft.scope : 'global'
    const cfg =
      draft.transport === 'http'
        ? {
            name,
            transport: 'http' as const,
            url: draft.url.trim(),
            headers: parsePairs(draft.headers),
            source
          }
        : {
            name,
            transport: 'stdio' as const,
            command: draft.command.trim(),
            args: draft.args
              .split(',')
              .map((a) => a.trim())
              .filter(Boolean),
            env: parsePairs(draft.env),
            source
          }
    void window.bearcode.mcp.add(cfg, workspacePath).then(() => {
      setDraft(EMPTY_DRAFT)
      setAddMode(null)
      refresh()
    })
  }

  return (
    <>
      <div className="page-title">Connectors</div>
      <div className="page-sub">
        Connect MCP servers the agent can call as tools. Off by default.
      </div>

      <div className="set-group-title">Access</div>
      <div className="set-card">
        <Row
          title="Enable Connectors"
          desc="Let the agent call tools from MCP servers you configure below. When off, no MCP tool ever runs."
        >
          <Toggle
            ariaLabel="Enable connectors"
            checked={enabled}
            onChange={(on) => void saveSettings({ mcpEnabled: on })}
          />
        </Row>
      </div>

      <div className="set-group-title">Servers</div>
      <div className="set-card">
        {servers === null ? (
          <div className="connector-empty">Loading…</div>
        ) : servers.length === 0 ? (
          <div className="connector-empty">No servers yet.</div>
        ) : (
          servers.map((view) => {
            const name = view.config.name
            const isRemote = view.config.transport === 'http'
            const toolCount = view.status.state === 'connected' ? view.status.tools.length : 0
            const isConnected = view.status.state === 'connected'
            const isExpanded = expanded === name
            // In flight either per the main-side status or the local optimistic
            // set (the blocking authorize() call hasn't resolved yet).
            const isAuthorizing = view.status.state === 'authorizing' || authorizing.has(name)

            return (
              <div className="connector-server" key={name}>
                <div className="set-row">
                  <div className="set-row-text">
                    <div className="set-row-title">
                      {name}
                      <span className={'connector-badge' + (isRemote ? '' : ' local')}>
                        {isRemote ? 'remote' : 'local ⚠'}
                      </span>
                    </div>
                    <div className="set-row-desc">
                      <span className={'status-dot' + (isConnected ? ' ok' : '')} />
                      {isAuthorizing
                        ? 'signing in…'
                        : view.status.state === 'error'
                          ? `error: ${view.status.message}`
                          : view.status.state === 'disabled' && view.enabled
                            ? // enabled but not currently connected (idle) —
                              // "disabled" here would contradict the ON toggle.
                              'not connected'
                            : view.status.state}
                      {' · '}
                      {toolCount} tools
                    </div>
                  </div>
                  {view.status.state === 'untrusted' ? (
                    <button className="pill-btn" onClick={() => trustServer(view)}>
                      Trust
                    </button>
                  ) : null}
                  <button
                    className="pill-btn"
                    onClick={() => setExpanded(isExpanded ? null : name)}
                  >
                    {isExpanded ? 'Collapse' : 'Expand'}
                  </button>
                  {isRemote && (view.status.state === 'error' || isAuthorizing) ? (
                    <button
                      className="pill-btn primary"
                      disabled={isAuthorizing}
                      onClick={() => authorizeServer(name)}
                    >
                      {isAuthorizing ? 'Signing in…' : 'Sign in'}
                    </button>
                  ) : null}
                  {view.status.state === 'untrusted' ? null : (
                    <button
                      className="pill-btn"
                      disabled={isAuthorizing}
                      onClick={() => reconnectServer(name)}
                    >
                      Reconnect
                    </button>
                  )}
                  <button className="pill-btn" onClick={() => removeServer(view)}>
                    Remove
                  </button>
                  <Toggle
                    ariaLabel={`Enable ${name}`}
                    checked={view.enabled}
                    onChange={(on) => toggleServer(view, on)}
                  />
                </div>

                {view.status.state === 'untrusted' ? (
                  <div className="connector-consent" role="alert">
                    <span>
                      This server has not been trusted for this project. It will{' '}
                      {isRemote ? 'connect to' : 'run'}:
                      <code className="connector-consent-cmd">
                        {isRemote
                          ? view.config.url
                          : [view.config.command, ...(view.config.args ?? [])]
                              .filter(Boolean)
                              .join(' ')}
                      </code>
                      Trust it only if you recognize the exact {isRemote ? 'URL' : 'command'} above.
                    </span>
                  </div>
                ) : null}

                {pendingConsent === name ? (
                  <div className="connector-consent" role="alert">
                    <span>
                      {name} runs a local command that downloads and executes code on your machine.
                      Review the exact command before allowing it:
                      <code className="connector-consent-cmd">
                        {[view.config.command, ...(view.config.args ?? [])]
                          .filter(Boolean)
                          .join(' ')}
                      </code>
                      Allow it to run?
                    </span>
                    <button className="pill-btn primary" onClick={() => confirmSpawn(name)}>
                      Allow
                    </button>
                    <button className="pill-btn" onClick={() => setPendingConsent(null)}>
                      Cancel
                    </button>
                  </div>
                ) : null}

                {isExpanded && view.status.state === 'connected' ? (
                  <div className="connector-tools">
                    {view.status.tools.map((tool) => (
                      <div className="set-row" key={tool.name}>
                        <div className="set-row-text">
                          <div className="set-row-title">{tool.name}</div>
                          <div className="set-row-desc">{tool.description}</div>
                        </div>
                        <Select
                          ariaLabel={`${name} ${tool.name} rule`}
                          value={toolRuleEffect(name, tool.name)}
                          options={RULE_OPTIONS}
                          onChange={(effect) => setToolRule(name, tool.name, effect)}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="set-group-title">Add Server</div>
      <div className="set-card">
        <Row title="Add a server" desc="Add a server manually, or browse the Smithery registry.">
          <Select
            ariaLabel="Add server"
            value={addMode ?? 'manual'}
            options={ADD_OPTIONS}
            onChange={(v) => setAddMode(v)}
          />
        </Row>
        {addMode === 'manual' ? (
          <div className="connector-add-form">
            <input
              type="text"
              className="set-input"
              placeholder="Server name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Select
              ariaLabel="Transport"
              value={draft.transport}
              options={[
                { value: 'http', label: 'Remote (HTTP)' },
                { value: 'stdio', label: 'Local (stdio)' }
              ]}
              onChange={(transport) => setDraft({ ...draft, transport })}
            />
            {workspacePath ? (
              <Select
                ariaLabel="Scope"
                value={draft.scope}
                options={[
                  {
                    value: 'global',
                    label: 'Global (this machine)',
                    description: 'Private to you; never committed'
                  },
                  {
                    value: 'project',
                    label: 'Project (committed)',
                    description: 'Written to .agents/mcp.json and shared with the repo'
                  }
                ]}
                onChange={(scope) => setDraft({ ...draft, scope })}
              />
            ) : null}
            {draft.transport === 'http' ? (
              <>
                <input
                  type="text"
                  className="set-input"
                  placeholder="https://server.example/mcp"
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
                <input
                  type="text"
                  className="set-input"
                  placeholder="Headers: key=value, key2=value2"
                  value={draft.headers}
                  onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  className="set-input"
                  placeholder="Command, e.g. npx"
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
                <input
                  type="text"
                  className="set-input"
                  placeholder="Args, comma-separated"
                  value={draft.args}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                />
                <input
                  type="text"
                  className="set-input"
                  placeholder="Env: key=value, key2=value2"
                  value={draft.env}
                  onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                />
              </>
            )}
            <button className="pill-btn primary" onClick={submitManualAdd}>
              Add server
            </button>
          </div>
        ) : null}
        {addMode === 'import' ? (
          <ImportLocalPicker
            workspacePath={workspacePath}
            onClose={() => setAddMode(null)}
            onImported={refresh}
          />
        ) : null}
      </div>

      {addMode === 'browse' ? (
        <BrowseSmitheryModal
          projectPath={workspacePath}
          onClose={() => setAddMode(null)}
          onInstalled={refresh}
        />
      ) : null}
    </>
  )
}
