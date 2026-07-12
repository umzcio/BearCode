import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PluginEntry } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { BrowsePluginsModal } from '../BrowsePluginsModal'

export function PluginsPage(): JSX.Element {
  const workspacePath = useAppStore((s) => s.workspacePath)
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null)
  const [browsing, setBrowsing] = useState(false)

  const refresh = (): void => {
    void window.bearcode.plugins.list(workspacePath).then(setPlugins)
  }

  useEffect(() => {
    let alive = true
    void window.bearcode.plugins.list(workspacePath).then((l) => {
      if (alive) setPlugins(l)
    })
    return () => {
      alive = false
    }
  }, [workspacePath])

  return (
    <div>
      <div className="page-title">Plugins</div>
      <div className="page-sub">Installable bundles of skills, rules, and connectors.</div>
      <button className="pill-btn primary" onClick={() => setBrowsing(true)}>
        Browse Catalog
      </button>
      {plugins && plugins.length === 0 ? (
        <div className="plugin-empty">No plugins installed. Browse the catalog to add one.</div>
      ) : null}
      {(plugins ?? []).map((p) => (
        <div className="plugin-row set-card pad" key={`${p.scope}:${p.name}`}>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">
                {p.name}
                {p.version ? ` · ${p.version}` : ''}
              </div>
              <div className="set-row-desc">{p.description ?? ''}</div>
            </div>
            <Toggle
              ariaLabel={`Enable ${p.name}`}
              checked={p.enabled}
              onChange={(on) =>
                void window.bearcode.plugins
                  .setEnabled(p.scope, p.name, on, workspacePath)
                  .then(refresh)
              }
            />
          </div>
          <div className="plugin-contents">
            {p.skills.length ? <div>Skills: {p.skills.map((s) => s.name).join(', ')}</div> : null}
            {p.rules.length ? <div>Rules: {p.rules.map((r) => r.name).join(', ')}</div> : null}
            {p.servers.length ? (
              <div>Connectors: {p.servers.map((s) => s.name).join(', ')}</div>
            ) : null}
            {p.hookCount ? <div>{p.hookCount} hooks (not yet supported)</div> : null}
          </div>
          <div className="plugin-actions">
            {p.scope === 'global' ? (
              <button
                className="pill-btn"
                onClick={() => void window.bearcode.plugins.update(p.name).then(refresh)}
              >
                Update
              </button>
            ) : null}
            <button
              className="pill-btn"
              onClick={() =>
                void window.bearcode.plugins.uninstall(p.scope, p.name, workspacePath).then(refresh)
              }
            >
              Uninstall
            </button>
          </div>
        </div>
      ))}
      {browsing ? (
        <BrowsePluginsModal onClose={() => setBrowsing(false)} onInstalled={refresh} />
      ) : null}
    </div>
  )
}
