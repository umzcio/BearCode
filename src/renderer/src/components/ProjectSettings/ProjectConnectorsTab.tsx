import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { McpServerView } from '@shared/types'
import { Toggle } from '../Toggle'
import { EmptyState } from '../ui/EmptyState'
import { Loading } from '../ui/Loading'
import { ConnectorAddForm, EMPTY_MANUAL_DRAFT, parsePairs } from '../Settings/ConnectorAddForm'
import type { ManualDraft } from '../Settings/ConnectorAddForm'

// Project-scoped connector management for the per-project Settings modal
// (a project the user may not currently have open as their active
// workspace). Config-only by design: never calls ensureConnected/reconnect/
// authorize, and enable/disable goes through setEnabledConfigOnly, so
// nothing here ever spawns a process or opens an OAuth browser for a
// project that isn't live. See planning/2026-07-14-project-connectors-
// skills-design.md.
export function ProjectConnectorsTab({ projectPath }: { projectPath: string }): JSX.Element {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [draft, setDraft] = useState<ManualDraft>({ ...EMPTY_MANUAL_DRAFT, scope: 'project' })

  const refresh = (): void => {
    void window.bearcode.mcp.list(projectPath).then((list) => setServers(list))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const projectServers = (servers ?? []).filter((v) => v.config.source === 'project')

  const toggleServer = (name: string, on: boolean): void => {
    void window.bearcode.mcp.setEnabledConfigOnly(name, on).then(refresh)
  }

  const trustServer = (name: string): void => {
    void window.bearcode.mcp.trust(name, projectPath).then(refresh)
  }

  const removeServer = (view: McpServerView): void => {
    void window.bearcode.mcp.remove(view.config.name, 'project', projectPath).then(refresh)
  }

  const submitManualAdd = (): void => {
    const name = draft.name.trim()
    if (!name) return
    const cfg =
      draft.transport === 'http'
        ? {
            name,
            transport: 'http' as const,
            url: draft.url.trim(),
            headers: parsePairs(draft.headers),
            source: 'project' as const
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
            source: 'project' as const
          }
    void window.bearcode.mcp.add(cfg, projectPath).then(() => {
      setDraft({ ...EMPTY_MANUAL_DRAFT, scope: 'project' })
      refresh()
    })
  }

  return (
    <>
      <div className="page-title">Connectors</div>
      <div className="page-sub">MCP servers and tools scoped to this project.</div>

      <div className="set-group-title">Servers</div>
      <div className="set-card">
        {servers === null ? (
          <div className="set-row">
            <Loading />
          </div>
        ) : projectServers.length === 0 ? (
          <div className="set-row">
            <EmptyState title="No servers yet" hint="Add one below." />
          </div>
        ) : (
          projectServers.map((view) => {
            const name = view.config.name
            const isRemote = view.config.transport === 'http'
            return (
              <div className="set-row" key={name}>
                <div className="set-row-text">
                  <div className="set-row-title">
                    {name}
                    <span className={'connector-badge' + (isRemote ? '' : ' local')}>
                      {isRemote ? 'remote' : 'local ⚠'}
                    </span>
                  </div>
                </div>
                {view.status.state === 'untrusted' ? (
                  <button className="pill-btn" onClick={() => trustServer(name)}>
                    Trust
                  </button>
                ) : null}
                <button className="pill-btn" onClick={() => removeServer(view)}>
                  Remove
                </button>
                <Toggle
                  ariaLabel={`Enable ${name}`}
                  checked={view.enabled}
                  onChange={(on) => toggleServer(name, on)}
                />
              </div>
            )
          })
        )}
      </div>

      <div className="set-group-title">Add Server</div>
      <div className="set-card">
        <ConnectorAddForm
          draft={draft}
          onChange={setDraft}
          onSubmit={submitManualAdd}
          showScopeSelector={false}
        />
      </div>
    </>
  )
}
