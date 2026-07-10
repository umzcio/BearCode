import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { GithubDeviceStart, IntegrationProvider, IntegrationStatus } from '@shared/types'
import { IconClose } from '../../icons'
import { useAppStore } from '../../../state/store'

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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function statusFor(
  list: IntegrationStatus[] | null,
  provider: IntegrationProvider
): IntegrationStatus {
  return list?.find((s) => s.provider === provider) ?? { provider, connected: false }
}

function describe(status: IntegrationStatus, providerLabel: string): string {
  if (!status.connected) {
    return `Not connected. Enables private git clone/push and ${providerLabel.toLowerCase()}_* tools.`
  }
  const scopes = status.scopes && status.scopes.length > 0 ? ` · ${status.scopes.join(', ')}` : ''
  return `Connected as @${status.login ?? 'unknown'}${scopes}`
}

// GitHub connect modal: Device Flow by default, with a "paste a token instead"
// fallback (design §6/§11 -- Device Flow needs a real registered client_id to
// work live; PAT works with zero setup). Portaled to document.body + a
// capture-phase Esc listener that stops propagation (BrowseSmitheryModal's
// lesson: Esc must close only this modal, not the Settings window behind it).
function GithubConnectModal({
  onClose,
  onConnected
}: {
  onClose: () => void
  onConnected: (status: IntegrationStatus) => void
}): JSX.Element {
  const [mode, setMode] = useState<'device' | 'pat'>('device')
  const [device, setDevice] = useState<GithubDeviceStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pat, setPat] = useState('')
  const [connecting, setConnecting] = useState(false)
  // Derived, not stored: "waiting for authorization" is simply "a device code
  // exists and neither an error nor a connect has resolved yet" -- no
  // separate boolean to keep in sync with the two async effects below.
  const waitingForAuthorization = device !== null && error === null

  // Start the device flow as soon as the modal opens in device mode. Reset of
  // any stale device/error from a previous attempt happens in the "Use Device
  // Flow instead" handler (before setMode fires this effect), never
  // synchronously in the effect body itself.
  useEffect(() => {
    if (mode !== 'device') return undefined
    let alive = true
    void window.bearcode.integrations
      .githubDeviceStart()
      .then((d) => {
        if (alive) setDevice(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e))
      })
    return () => {
      alive = false
    }
  }, [mode])

  // Once a device code exists, poll (a single long-lived IPC call main-side
  // honors slow_down/expiry/denial) until it resolves or the user switches
  // away from device mode.
  useEffect(() => {
    if (!device) return undefined
    let alive = true
    void window.bearcode.integrations
      .githubDevicePoll(device.deviceCode, device.interval)
      .then((status) => {
        if (alive) onConnected(status)
      })
      .catch((e: unknown) => {
        if (alive) setError(msg(e))
      })
    return () => {
      alive = false
      // Cancel the main-side poll so a closed modal doesn't leave it running
      // until the device code expires.
      void window.bearcode.integrations.cancelGithubDevice(device.deviceCode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device])

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

  const connectPat = (): void => {
    const token = pat.trim()
    if (!token) return
    setConnecting(true)
    setError(null)
    void window.bearcode.integrations
      .githubConnectPat(token)
      .then((status) => {
        setConnecting(false)
        onConnected(status)
      })
      .catch((e: unknown) => {
        setConnecting(false)
        setError(msg(e))
      })
  }

  return createPortal(
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="smithery-panel">
        <div className="smithery-header">
          <div>
            <div className="page-title">Connect GitHub</div>
            <div className="smithery-sub">
              {mode === 'device' ? 'Device Flow sign-in' : 'Paste a personal access token'}
            </div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        {mode === 'device' ? (
          <div className="smithery-secrets">
            {error ? (
              <div className="domain-empty" role="alert">
                {error}
              </div>
            ) : device ? (
              <>
                <div className="set-row-desc">
                  Enter this code at the GitHub page, then approve access.
                </div>
                <div className="key-row">
                  <span className="key-label">Code</span>
                  <span className="mono">{device.userCode}</span>
                </div>
                <div className="smithery-search-row">
                  <button
                    className="pill-btn primary"
                    onClick={() => window.open(device.verificationUri, '_blank')}
                  >
                    Open GitHub
                  </button>
                </div>
                <div className="set-row-desc">
                  {waitingForAuthorization ? 'Waiting for authorization…' : ''}
                </div>
              </>
            ) : (
              <div className="set-row-desc">Requesting a device code…</div>
            )}
            <div className="smithery-search-row">
              <button className="pill-btn" onClick={() => setMode('pat')}>
                Paste a token instead
              </button>
            </div>
          </div>
        ) : (
          <div className="smithery-secrets">
            <div className="set-row-desc">
              Paste a GitHub personal access token (repo scope). Stored only in your encrypted
              vault, never written to disk in plaintext.
            </div>
            <div className="key-row">
              <span className="key-label">Token</span>
              <input
                type="password"
                className="set-input"
                placeholder="ghp_…"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
              />
            </div>
            {error ? (
              <div className="domain-empty" role="alert">
                {error}
              </div>
            ) : null}
            <div className="smithery-search-row">
              <button className="pill-btn primary" disabled={connecting} onClick={connectPat}>
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
              <button
                className="pill-btn"
                onClick={() => {
                  // Clear any stale device/error from a previous attempt
                  // BEFORE switching mode, so the device-start effect (keyed
                  // on `mode`) begins from a clean slate rather than needing
                  // to reset state synchronously inside its own body.
                  setDevice(null)
                  setError(null)
                  setMode('device')
                }}
              >
                Use Device Flow instead
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// Bitbucket has no client-secret-free device flow (design §11), so its
// connect form is a plain inline username + app-password pair rather than a
// modal.
function BitbucketConnectForm({
  onConnected,
  onCancel
}: {
  onConnected: (status: IntegrationStatus) => void
  onCancel: () => void
}): JSX.Element {
  const [username, setUsername] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const u = username.trim()
    const p = appPassword.trim()
    if (!u || !p) return
    setConnecting(true)
    setError(null)
    void window.bearcode.integrations
      .connectBitbucket(u, p)
      .then((status) => {
        setConnecting(false)
        onConnected(status)
      })
      .catch((e: unknown) => {
        setConnecting(false)
        setError(msg(e))
      })
  }

  return (
    <div className="connector-add-form">
      <input
        type="text"
        className="set-input"
        placeholder="Bitbucket username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        className="set-input"
        placeholder="App password"
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
      />
      {error ? (
        <div className="domain-empty" role="alert">
          {error}
        </div>
      ) : null}
      <button className="pill-btn primary" disabled={connecting} onClick={submit}>
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
      <button className="pill-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

export function IntegrationsPage(): JSX.Element {
  const [statuses, setStatuses] = useState<IntegrationStatus[] | null>(null)
  const [githubModalOpen, setGithubModalOpen] = useState(false)
  const [bitbucketFormOpen, setBitbucketFormOpen] = useState(false)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const refresh = (): void => {
    void window.bearcode.integrations.status().then(setStatuses)
  }

  useEffect(() => {
    refresh()
  }, [])

  const github = statusFor(statuses, 'github')
  const bitbucket = statusFor(statuses, 'bitbucket')

  const disconnect = (provider: IntegrationProvider): void => {
    void window.bearcode.integrations.disconnect(provider).then(refresh)
  }

  return (
    <>
      <div className="page-title">Integrations</div>
      <div className="page-sub">
        Connect GitHub or Bitbucket for private git access and PR/issue tools. Off until connected.
      </div>

      <div className="set-group-title">GitHub</div>
      <div className="set-card">
        <Row title="GitHub" desc={describe(github, 'GitHub')}>
          {github.connected ? (
            <button
              className="pill-btn"
              aria-label="Disconnect GitHub"
              onClick={() => disconnect('github')}
            >
              Disconnect
            </button>
          ) : (
            <button
              className="pill-btn primary"
              aria-label="Connect GitHub"
              onClick={() => setGithubModalOpen(true)}
            >
              Connect
            </button>
          )}
        </Row>
        <div className="set-row set-row-editor">
          <div className="set-row-text">
            <div className="set-row-title">OAuth App client ID</div>
            <div className="set-row-desc">
              Optional — for Device Flow sign-in. Leave blank to use a personal access token
              (the recommended zero-setup path).
            </div>
          </div>
          <input
            type="text"
            className="set-input"
            placeholder="Iv1.…"
            value={settings?.githubClientId ?? ''}
            onChange={(e) => void saveSettings({ githubClientId: e.target.value })}
          />
        </div>
      </div>

      <div className="set-group-title">Bitbucket</div>
      <div className="set-card">
        <Row title="Bitbucket" desc={describe(bitbucket, 'Bitbucket')}>
          {bitbucket.connected ? (
            <button
              className="pill-btn"
              aria-label="Disconnect Bitbucket"
              onClick={() => disconnect('bitbucket')}
            >
              Disconnect
            </button>
          ) : (
            <button
              className="pill-btn primary"
              aria-label="Connect Bitbucket"
              onClick={() => setBitbucketFormOpen((o) => !o)}
            >
              Connect
            </button>
          )}
        </Row>
        {!bitbucket.connected && bitbucketFormOpen ? (
          <BitbucketConnectForm
            onConnected={() => {
              setBitbucketFormOpen(false)
              refresh()
            }}
            onCancel={() => setBitbucketFormOpen(false)}
          />
        ) : null}
      </div>

      {githubModalOpen ? (
        <GithubConnectModal
          onClose={() => setGithubModalOpen(false)}
          onConnected={() => {
            setGithubModalOpen(false)
            refresh()
          }}
        />
      ) : null}
    </>
  )
}
