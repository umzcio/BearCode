import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { McpServerConfig, McpServerView, SmitheryHit } from '@shared/types'
import { IconClose } from '../icons'
import { EmptyState } from '../ui/EmptyState'
import { Loading } from '../ui/Loading'
import { ErrorCard } from '../ui/ErrorCard'

// ============================================================================
// OAuth verification note (Task 12, 2026-07-09)
//
// Verified LIVE against the MCP authorization spec
// (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):
// the real flow is full OAuth 2.1 + PKCE + RFC 8707 resource indicators, with
// the client discovering the authorization server via a 401 + WWW-Authenticate
// header and RFC 9728 Protected Resource Metadata, then (usually) Dynamic
// Client Registration (RFC 7591) before the browser-redirect authorization
// code exchange. That is a substantial, security-sensitive flow (local
// redirect capture, PKCE verifier storage, token refresh) that does not exist
// anywhere in this codebase yet (Integrations OAuth plumbing referenced by the
// design doc is itself "upcoming", not yet built) and is well beyond a single
// modal's scope to invent safely.
//
// Task 11's Smithery registry client (registry.ts) does not surface a
// "requires OAuth" flag from the search/detail endpoints -- only a
// configSchema.required field list (mapped to ${VAULT:} secrets, the API-key/
// Bearer/env fallback per the plan). There is therefore no reliable signal
// from Smithery metadata alone to say a given server needs the full OAuth
// dance vs. a config field.
//
// Per the plan's own guardrail ("If OAuth cannot be confidently verified,
// implement the API-key path fully and stub OAuth behind a clear affordance
// rather than shipping a broken flow"), this modal fully implements the
// verified API-key/Bearer/env install path (search -> install -> prompt for
// required secrets -> mcp.setSecret), and renders a clearly-labeled "OAuth
// sign-in coming for this server" affordance for any server whose id/name
// suggests an OAuth-first provider (heuristic only, never silently claims to
// have signed in) instead of wiring a fake or broken browser-redirect flow.
// ============================================================================

const OAUTH_HINT_RE = /sentry|linear|slack|github(?!.*mcp-server-github)/i

interface Props {
  projectPath: string | null
  onClose: () => void
  onInstalled: (view: McpServerView) => void
}

const KEY_MISSING_RE = /No Smithery API key configured/i
const VAULT_REF_RE = /^\$\{VAULT:([^}]+)\}$/

// A secret the freshly-installed server needs the user to supply. Smithery
// configs land with `${VAULT:<key>}` placeholders in headers/env (registry.ts);
// the vault key is embedded in the placeholder itself, so we recover it here
// and prompt the user rather than leaving an empty credential that fails auth
// silently on enable.
interface PendingSecret {
  field: string
  vaultKey: string
}

function requiredSecrets(cfg: McpServerConfig): PendingSecret[] {
  const out: PendingSecret[] = []
  const scan = (rec?: Record<string, string>): void => {
    for (const [field, value] of Object.entries(rec ?? {})) {
      const m = VAULT_REF_RE.exec(value)
      if (m) out.push({ field, vaultKey: m[1] })
    }
  }
  scan(cfg.headers)
  scan(cfg.env)
  return out
}

// Monogram avatar for a server. Smithery does publish iconUrl, but the app CSP
// is `img-src 'self' data:` (no remote images), so a letter tile keyed to a
// hashed hue gives each server a stable, distinct mark without loosening CSP or
// per-icon network fetches. (Real logos would need an icon-proxy in main that
// returns a data: URL — a deliberate follow-up.)
function monogram(name: string): { letter: string; hue: number } {
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return { letter, hue: h }
}

export function BrowseSmitheryModal({ projectPath, onClose, onInstalled }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SmitheryHit[] | null>(null)
  const [keyMissing, setKeyMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  // After a successful install that needs secrets, the modal switches to a
  // secret-entry step for that server before finishing.
  const [pendingSecrets, setPendingSecrets] = useState<{
    view: McpServerView
    secrets: PendingSecret[]
  } | null>(null)
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [savingSecrets, setSavingSecrets] = useState(false)
  const [loading, setLoading] = useState(false)
  // Whether the current list is the default "popular" set (empty query) vs. a
  // search result, so the header can label it.
  const [isDefault, setIsDefault] = useState(true)

  const load = (q: string): void => {
    setError(null)
    setKeyMissing(false)
    setLoading(true)
    setIsDefault(q.trim() === '')
    void window.bearcode.mcp
      .smitherySearch(q)
      .then((results) => {
        setHits(results)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setLoading(false)
        const message = e instanceof Error ? e.message : String(e)
        if (KEY_MISSING_RE.test(message)) {
          setKeyMissing(true)
          setHits(null)
        } else {
          setError(message)
        }
      })
  }

  const runSearch = (): void => load(query)

  // Load the popular-servers default as soon as the modal opens, so it is not an
  // empty search box (matches Claude's connector browser).
  useEffect(() => {
    load('')
  }, [])

  // Esc closes only this modal, not the Settings window behind it. SettingsModal
  // listens for Escape on `window` (bubble phase); intercept in the CAPTURE phase
  // and stop propagation so Settings' handler never sees it. The listener exists
  // only while this modal is mounted, so Esc closes Settings normally once it's
  // gone.
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

  const install = (hit: SmitheryHit): void => {
    setInstallingId(hit.id)
    setError(null)
    void window.bearcode.mcp
      .smitheryInstall(hit.id, projectPath)
      .then((view) => {
        setInstallingId(null)
        const secrets = requiredSecrets(view.config)
        if (secrets.length === 0) {
          // Nothing to fill -- finish immediately.
          onInstalled(view)
          onClose()
          return
        }
        // Prompt for the server's required secrets before finishing so it is
        // not left connecting with empty ${VAULT:} credentials.
        setSecretDrafts({})
        setPendingSecrets({ view, secrets })
      })
      .catch((e: unknown) => {
        setInstallingId(null)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  const finishSecrets = (): void => {
    if (!pendingSecrets) return
    const { view, secrets } = pendingSecrets
    setSavingSecrets(true)
    setError(null)
    const writes = secrets
      .map((s) => ({ s, value: (secretDrafts[s.vaultKey] ?? '').trim() }))
      .filter((x) => x.value.length > 0)
      .map((x) => window.bearcode.mcp.setSecret(x.s.vaultKey, x.value))
    void Promise.all(writes)
      .then(() => {
        setSavingSecrets(false)
        setPendingSecrets(null)
        onInstalled(view)
        onClose()
      })
      .catch((e: unknown) => {
        setSavingSecrets(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  return createPortal(
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="smithery-panel">
        <div className="smithery-header">
          <div>
            <div className="page-title">Browse Smithery</div>
            <div className="smithery-sub">
              {pendingSecrets ? 'Finish setup' : 'Add an MCP server from the Smithery registry.'}
            </div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {pendingSecrets ? (
          <div className="smithery-secrets">
            <div className="set-row-desc">
              {pendingSecrets.view.config.name} needs the following{' '}
              {pendingSecrets.secrets.length === 1 ? 'value' : 'values'} to connect. They are stored
              in your encrypted vault, never written to the config file.
            </div>
            {pendingSecrets.secrets.map((s) => (
              <div className="key-row" key={s.vaultKey}>
                <span className="key-label" title={s.vaultKey}>
                  {s.field}
                </span>
                <input
                  type="password"
                  className="set-input"
                  placeholder="Enter value"
                  value={secretDrafts[s.vaultKey] ?? ''}
                  onChange={(e) => setSecretDrafts((d) => ({ ...d, [s.vaultKey]: e.target.value }))}
                />
              </div>
            ))}
            <div className="smithery-search-row">
              <button className="pill-btn primary" disabled={savingSecrets} onClick={finishSecrets}>
                {savingSecrets ? 'Saving…' : 'Save & finish'}
              </button>
              <button
                className="pill-btn"
                disabled={savingSecrets}
                onClick={() => {
                  const view = pendingSecrets.view
                  setPendingSecrets(null)
                  onInstalled(view)
                  onClose()
                }}
              >
                Skip for now
              </button>
            </div>
            {error ? <ErrorCard>{error}</ErrorCard> : null}
          </div>
        ) : (
          <>
            <div className="smithery-search-row">
              <input
                type="text"
                className="set-input"
                placeholder="Search Smithery servers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              />
              <button className="pill-btn primary" onClick={runSearch}>
                Search
              </button>
            </div>

            {keyMissing ? (
              <EmptyState
                title="Smithery API key required"
                hint="Add one in Settings → Providers → Smithery, then search again."
              />
            ) : error ? (
              <ErrorCard>{error}</ErrorCard>
            ) : loading ? (
              <Loading label="Loading servers…" />
            ) : hits !== null && hits.length === 0 ? (
              <EmptyState
                title={isDefault ? 'No servers found' : `No servers matched “${query}”`}
              />
            ) : hits !== null ? (
              <>
                <div className="smithery-list-label">
                  {isDefault ? 'Popular servers' : 'Results'}
                </div>
                <div className="smithery-results">
                  {hits.map((hit) => {
                    const mg = monogram(hit.name)
                    return (
                      <div className="smithery-hit" key={hit.id}>
                        <div
                          className="smithery-avatar"
                          style={{
                            backgroundColor: `hsl(${mg.hue} 55% 32%)`,
                            color: `hsl(${mg.hue} 70% 88%)`
                          }}
                          aria-hidden
                        >
                          {mg.letter}
                        </div>
                        <div className="smithery-hit-main">
                          <div className="smithery-hit-title">
                            <span className="smithery-hit-name">{hit.name}</span>
                            {hit.verified ? (
                              <span className="smithery-verified" title="Verified by Smithery">
                                ✓ Verified
                              </span>
                            ) : null}
                          </div>
                          {hit.description ? (
                            <div className="smithery-hit-desc">{hit.description}</div>
                          ) : null}
                          {OAUTH_HINT_RE.test(hit.id) ? (
                            <div className="smithery-hit-desc smithery-oauth-note">
                              OAuth sign-in coming — install still works if it accepts an API key.
                            </div>
                          ) : null}
                        </div>
                        <div className="smithery-hit-side">
                          <span
                            className={
                              'connector-badge' + (hit.transport === 'http' ? '' : ' local')
                            }
                          >
                            {hit.transport === 'http' ? 'Remote' : 'Local'}
                          </span>
                          <button
                            className="pill-btn primary"
                            disabled={installingId === hit.id}
                            onClick={() => install(hit)}
                          >
                            {installingId === hit.id ? 'Installing…' : 'Install'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
