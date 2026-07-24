import { useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { PROJECT_ICONS } from '../../ProjectSettings/projectIcons'
import { ErrorCard } from '../../ui/ErrorCard'

// Settings > Hermes: connection config for Zach's self-hosted Hermes Agent
// gateway (a separate device, reached over Tailscale/tunnel -- never
// localhost). Hermes runs its own agent loop server-side; this page only
// configures how BearCode reaches it, the same "enable + connection status"
// shape as UrsaPage, not a role-management page. The bearer token is
// deliberately never part of `settings` -- it's written via saveHermesToken
// (vault, main-side) so it never lands in settings.json.
export function HermesPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const testHermesConnection = useAppStore((s) => s.testHermesConnection)
  const saveHermesToken = useAppStore((s) => s.saveHermesToken)

  const [gatewayUrl, setGatewayUrl] = useState(settings?.hermesGatewayUrl ?? '')
  const [label, setLabel] = useState(settings?.hermesLabel ?? 'Hermes')
  const [token, setToken] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  if (!settings) return null
  const enabled = settings.hermesEnabled === true

  // Draft-then-save-on-blur, same pattern as GeneralPage's name/instructions
  // fields and UrsaPage's custom-instructions textarea: only persist when the
  // value actually changed.
  const saveGatewayUrl = (): void => {
    if (gatewayUrl !== (settings.hermesGatewayUrl ?? '')) void saveSettings({ hermesGatewayUrl: gatewayUrl })
  }
  const saveLabel = (): void => {
    if (label !== (settings.hermesLabel ?? '')) void saveSettings({ hermesLabel: label })
  }
  const saveToken = (): void => {
    if (token) void saveHermesToken(token)
  }
  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(await testHermesConnection(gatewayUrl, token || undefined))
    setTesting(false)
  }

  return (
    <>
      <div className="page-title">{label || 'Hermes'}</div>
      <div className="page-sub">
        Chat with your self-hosted Hermes Agent from inside BearCode — the same role it already
        plays in Telegram and Slack. Hermes does its own thinking; this only configures the
        connection.
      </div>

      <div className="set-group-title">Access</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Enable Hermes</div>
            <div className="set-row-desc">Adds a Hermes section to the sidebar. Off by default.</div>
          </div>
          <Toggle
            ariaLabel="Enable Hermes"
            checked={enabled}
            onChange={(on) => void saveSettings({ hermesEnabled: on })}
          />
        </div>
      </div>

      {enabled && (
        <>
          <div className="set-group-title">Connection</div>
          <div className="set-card pad">
            <div className="hermes-field">
              <div className="set-row-title">Gateway URL</div>
              <input
                className="set-input"
                aria-label="Gateway URL"
                placeholder="http://100.x.x.x:8642 (Tailscale / tunnel address)"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                onBlur={saveGatewayUrl}
              />
            </div>
            <div className="hermes-field">
              <div className="set-row-title">Bearer token</div>
              <input
                className="set-input"
                type="password"
                aria-label="Bearer token (optional)"
                placeholder="Leave blank if the gateway has no auth configured"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onBlur={saveToken}
              />
            </div>
            <div className="hermes-test-row">
              <button
                type="button"
                className="pill-btn"
                onClick={() => void runTest()}
                disabled={testing || !gatewayUrl}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              {testResult && testResult.ok ? (
                <span className="hermes-test-result">{testResult.message}</span>
              ) : null}
            </div>
            {testResult && !testResult.ok ? (
              <div className="hermes-test-error">
                <ErrorCard>{testResult.message}</ErrorCard>
              </div>
            ) : null}
          </div>

          <div className="set-group-title">Appearance</div>
          <div className="set-card pad">
            <div className="hermes-field">
              <div className="set-row-title">Sidebar label</div>
              <input
                className="set-input"
                aria-label="Sidebar label"
                maxLength={40}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={saveLabel}
              />
            </div>
            <div className="hermes-field">
              <div className="set-row-title">Icon</div>
              <div className="ps-icons">
                {Object.entries(PROJECT_ICONS).map(([iconName, Icon]) => (
                  <button
                    key={iconName}
                    type="button"
                    className={'ps-icon' + (settings.hermesIcon === iconName ? ' selected' : '')}
                    aria-label={iconName}
                    onClick={() => void saveSettings({ hermesIcon: iconName })}
                  >
                    <Icon size={16} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
