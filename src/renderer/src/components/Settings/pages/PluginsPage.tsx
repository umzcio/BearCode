import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PluginEntry } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { BrowsePluginsModal } from '../BrowsePluginsModal'
import { EmptyState } from '../../ui/EmptyState'
import { Loading } from '../../ui/Loading'
import { useAnimatedUnmount } from '../../../lib/useAnimatedUnmount'

export function PluginsPage(): JSX.Element {
  const workspacePath = useAppStore((s) => s.workspacePath)
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null)
  const [browsing, setBrowsing] = useState(false)
  // BrowsePluginsModal owns no open/closed state of its own; keep it mounted
  // through its exit transition here.
  const { mounted: browseMounted, state: browseState } = useAnimatedUnmount(browsing)

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
      {plugins === null ? (
        <Loading />
      ) : plugins.length === 0 ? (
        <EmptyState title="No plugins installed" hint="Browse the catalog to add one." />
      ) : null}
      {(plugins ?? []).map((p) => (
        // Keyed on the canonical on-disk identity (scope + dirName), never the
        // spoofable manifest display `name` -- two plugins that declare the
        // same `name` would otherwise collide on the same React key.
        <div className="plugin-row set-card pad" key={`${p.scope}:${p.dirName}`}>
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
                  .setEnabled(p.scope, p.dirName, on, workspacePath)
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
            {/* A marketplace-subpath install has no .git to `git pull` --
                updatePlugin would silently no-op for it, so Update is only
                offered when the plugin's on-disk install is actually
                updatable (main/plugins/index.ts scanScope). */}
            {p.scope === 'global' && p.updatable ? (
              <button
                className="pill-btn"
                onClick={() => void window.bearcode.plugins.update(p.dirName).then(refresh)}
              >
                Update
              </button>
            ) : null}
            <button
              className="pill-btn"
              onClick={() =>
                void window.bearcode.plugins
                  .uninstall(p.scope, p.dirName, workspacePath)
                  .then(refresh)
              }
            >
              Uninstall
            </button>
          </div>
        </div>
      ))}
      {browseMounted ? (
        <BrowsePluginsModal
          onClose={() => setBrowsing(false)}
          onInstalled={refresh}
          state={browseState}
        />
      ) : null}
    </div>
  )
}
