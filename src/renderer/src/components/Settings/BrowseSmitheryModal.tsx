import { useState } from 'react'
import type { JSX } from 'react'
import type { McpServerConfig, McpServerView, SmitheryHit } from '@shared/types'

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

  const runSearch = (): void => {
    setError(null)
    setKeyMissing(false)
    void window.bearcode.mcp
      .smitherySearch(query)
      .then((results) => setHits(results))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        if (KEY_MISSING_RE.test(message)) {
          setKeyMissing(true)
          setHits(null)
        } else {
          setError(message)
        }
      })
  }

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

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="smithery-panel">
        <div className="smithery-header">
          <div className="page-title">Browse Smithery</div>
          <button className="pill-btn" onClick={onClose}>
            Close
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
              <button className="pill-btn" disabled={savingSecrets} onClick={finishSecrets}>
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
            {error ? (
              <div className="domain-empty" role="alert">
                {error}
              </div>
            ) : null}
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
              <button className="pill-btn" onClick={runSearch}>
                Search
              </button>
            </div>

            {keyMissing ? (
              <div className="domain-empty">
                You need to add a Smithery API key before you can browse the registry. Add one under
                Settings → Providers, then search again.
              </div>
            ) : null}

            {error ? (
              <div className="domain-empty" role="alert">
                {error}
              </div>
            ) : null}

            {hits !== null && hits.length === 0 && !keyMissing ? (
              <div className="domain-empty">No servers matched “{query}”.</div>
            ) : null}

            {hits !== null && hits.length > 0 ? (
              <div className="smithery-results">
                {hits.map((hit) => (
                  <div className="set-row smithery-hit" key={hit.id}>
                    <div className="set-row-text">
                      <div className="set-row-title">
                        {hit.name}
                        <span
                          className={'connector-badge' + (hit.transport === 'http' ? '' : ' local')}
                        >
                          {hit.transport === 'http' ? 'remote' : 'local'}
                        </span>
                        {typeof hit.toolCount === 'number' ? (
                          <span className="connector-badge">{hit.toolCount} tools</span>
                        ) : null}
                      </div>
                      <div className="set-row-desc">{hit.description}</div>
                      {OAUTH_HINT_RE.test(hit.id) ? (
                        <div className="set-row-desc smithery-oauth-note">
                          OAuth sign-in coming for this server — install still works if it accepts
                          an API key instead.
                        </div>
                      ) : null}
                    </div>
                    <button
                      className="pill-btn"
                      disabled={installingId === hit.id}
                      onClick={() => install(hit)}
                    >
                      {installingId === hit.id ? 'Installing…' : 'Install'}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
