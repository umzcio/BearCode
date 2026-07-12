import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { MarketplacePlugin, PluginManifest } from '@shared/types'
import { IconClose } from '../icons'

// Task 11 of the plugins arc: the real catalog/add-marketplace/
// install-from-URL/review-card flow (replaces the Task 10 open/close-only
// scaffold wholesale). Mirrors BrowseSmitheryModal's shell -- portal,
// `.modal-overlay open`, capture-phase Escape, `.smithery-panel` -- but the
// install path always lands on a review card (Task 8's prepareInstall stages
// a candidate without writing anything real) so the user sees every skill,
// rule, and MCP server a plugin would add, verbatim, before confirmInstall
// copies it into the live plugins tree.
interface Props {
  // Task 11 of the hooks arc: this modal doubles as the "Browse Skills"
  // catalog. 'skills' reworks the copy and filters the catalog to
  // `kind === 'skill'` entries only; everything else (install flow, review
  // card, add-marketplace) is shared verbatim. Defaults to 'plugins'.
  mode?: 'plugins' | 'skills'
  onClose: () => void
  onInstalled: () => void
}

interface Review {
  manifest: PluginManifest
  stagePath: string
}

// Electron wraps a main-process rejection as
// `Error invoking remote method 'bearcode:...': Error: <real message>`.
// Peel that (and a leading `Error:`) so the user sees only our message.
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

export function BrowsePluginsModal({ mode = 'plugins', onClose, onInstalled }: Props): JSX.Element {
  const [catalog, setCatalog] = useState<MarketplacePlugin[] | null>(null)
  const [mkUrl, setMkUrl] = useState('')
  const [installUrl, setInstallUrl] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filteredCatalog = (catalog ?? []).filter((p) =>
    mode === 'skills' ? p.kind === 'skill' : true
  )

  const load = (): void => {
    void window.bearcode.plugins.catalog().then(setCatalog)
  }
  useEffect(() => {
    load()
  }, [])

  // Esc closes only this modal, not the Settings window behind it -- Settings
  // listens for Escape on `window` in the bubble phase; intercept in the
  // capture phase and stop propagation so it never sees it while this modal
  // is mounted (matches BrowseSmitheryModal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const startInstall = (p: MarketplacePlugin): void => {
    setError(null)
    setBusy(p.name)
    void window.bearcode.plugins
      .prepareInstall(p.source, p.marketplaceUrl)
      .then(setReview)
      .catch((e: unknown) => setError(cleanError(e)))
      .finally(() => setBusy(null))
  }

  const startInstallFromUrl = (): void => {
    if (!installUrl.trim()) return
    setError(null)
    setBusy(installUrl)
    void window.bearcode.plugins
      .installFromUrl(installUrl)
      .then((r) => {
        setInstallUrl('')
        setReview(r)
      })
      .catch((e: unknown) => setError(cleanError(e)))
      .finally(() => setBusy(null))
  }

  const addMarketplace = (): void => {
    if (!mkUrl.trim()) return
    setError(null)
    void window.bearcode.plugins
      .addMarketplace(mkUrl)
      .then(() => {
        setMkUrl('')
        load()
      })
      .catch((e: unknown) => setError(cleanError(e)))
  }

  const confirm = (): void => {
    if (!review) return
    setError(null)
    void window.bearcode.plugins
      .confirmInstall(review.stagePath)
      .then(() => {
        setReview(null)
        onInstalled()
      })
      .catch((e: unknown) => setError(cleanError(e)))
  }

  return createPortal(
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="smithery-panel">
        <div className="smithery-header">
          <div>
            <div className="page-title">
              {mode === 'skills' ? 'Browse Skills' : 'Browse Plugins'}
            </div>
            <div className="smithery-sub">
              {review
                ? 'Review before installing'
                : mode === 'skills'
                  ? 'Browse and install skills.'
                  : 'Install bundles of skills, rules, and connectors.'}
            </div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {error ? (
          <div className="domain-empty" role="alert">
            {error}
          </div>
        ) : null}

        {review ? (
          <div className="plugin-review">
            <div className="set-group-title">Install “{review.manifest.name}”?</div>
            {review.manifest.skills.length ? (
              <div>Skills: {review.manifest.skills.map((s) => s.name).join(', ')}</div>
            ) : null}
            {review.manifest.rules.length ? (
              <div>
                Rules: {review.manifest.rules.map((r) => `${r.name} (${r.activation})`).join(', ')}
              </div>
            ) : null}
            {review.manifest.servers.map((s) => (
              <div className="plugin-review-server" key={s.name}>
                <b>{s.name}</b> — {s.transport}:{' '}
                <code>{s.command ? [s.command, ...(s.args ?? [])].join(' ') : (s.url ?? '')}</code>
              </div>
            ))}
            {review.manifest.hookCount ? (
              <div>{review.manifest.hookCount} hooks (not yet supported)</div>
            ) : null}
            <div className="plugin-review-actions">
              <button className="pill-btn" onClick={() => setReview(null)}>
                Cancel
              </button>
              <button className="pill-btn primary" onClick={confirm}>
                Install
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="plugin-add-row">
              <input
                type="text"
                className="set-input"
                placeholder="Add marketplace URL (https/ssh)"
                value={mkUrl}
                onChange={(e) => setMkUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMarketplace()}
              />
              <button className="pill-btn" disabled={!mkUrl.trim()} onClick={addMarketplace}>
                Add
              </button>
            </div>
            <div className="plugin-add-row">
              <input
                type="text"
                className="set-input"
                placeholder="Install from git URL"
                value={installUrl}
                onChange={(e) => setInstallUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startInstallFromUrl()}
              />
              <button
                className="pill-btn"
                disabled={!installUrl.trim() || busy === installUrl}
                onClick={startInstallFromUrl}
              >
                {busy === installUrl ? 'Installing…' : 'Install'}
              </button>
            </div>

            {catalog === null ? (
              <div className="smithery-empty">Loading catalog…</div>
            ) : filteredCatalog.length === 0 ? (
              <div className="smithery-empty">
                {mode === 'skills'
                  ? 'No skills in the catalog yet. Add a marketplace above.'
                  : 'No plugins in the catalog yet. Add a marketplace above.'}
              </div>
            ) : (
              <div className="smithery-results">
                {filteredCatalog.map((p) => (
                  <div className="smithery-hit" key={`${p.marketplaceUrl}#${p.name}`}>
                    <div className="smithery-hit-main">
                      <div className="smithery-hit-title">
                        <span className="smithery-hit-name">{p.name}</span>
                      </div>
                      <div className="smithery-hit-desc">{p.description}</div>
                    </div>
                    <button
                      className="pill-btn primary"
                      disabled={busy === p.name}
                      onClick={() => startInstall(p)}
                    >
                      {busy === p.name ? 'Preparing…' : 'Install'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
