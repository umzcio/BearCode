import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { HermesConnectionMode } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Select } from '../../Select'
import { Toggle } from '../../Toggle'
import { PROJECT_ICONS } from '../../ProjectSettings/projectIcons'
import { ErrorCard } from '../../ui/ErrorCard'

type HermesSaveField = 'mode' | 'gatewayUrl' | 'nativeUrl'

interface SaveOwner {
  generation: number
  pending: Promise<void> | null
}

// Settings > Hermes: connection config for Zach's self-hosted Hermes Agent
// gateway (a separate device, reached over Tailscale/tunnel -- never
// localhost). Hermes runs its own agent loop server-side; this page only
// configures how BearCode reaches it. The legacy token and native platform key
// are deliberately never part of `settings` -- both are written to separate
// main-side vault entries so neither can land in settings.json.
export function HermesPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const testHermesConnection = useAppStore((s) => s.testHermesConnection)
  const saveHermesToken = useAppStore((s) => s.saveHermesToken)
  const saveHermesPlatformKey = useAppStore((s) => s.saveHermesPlatformKey)

  const [mode, setMode] = useState<HermesConnectionMode>(
    settings?.hermesConnectionMode === 'native' ? 'native' : 'legacy'
  )
  const [gatewayUrl, setGatewayUrl] = useState(settings?.hermesGatewayUrl ?? '')
  const [nativeUrl, setNativeUrl] = useState(settings?.hermesNativeUrl ?? '')
  const [label, setLabel] = useState(settings?.hermesLabel ?? 'Hermes')
  const [token, setToken] = useState('')
  const [platformKey, setPlatformKey] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saveErrors, setSaveErrors] = useState<Partial<Record<HermesSaveField, string>>>({})
  const modeDirty = useRef(false)
  const gatewayUrlDirty = useRef(false)
  const nativeUrlDirty = useRef(false)
  const modeSaveOwner = useRef<SaveOwner>({ generation: 0, pending: null })
  const gatewayUrlSaveOwner = useRef<SaveOwner>({ generation: 0, pending: null })
  const nativeUrlSaveOwner = useRef<SaveOwner>({ generation: 0, pending: null })

  const authoritativeMode: HermesConnectionMode =
    settings?.hermesConnectionMode === 'native' ? 'native' : 'legacy'

  useEffect(() => {
    if (!modeDirty.current) setMode(authoritativeMode)
  }, [authoritativeMode])
  useEffect(() => {
    if (!gatewayUrlDirty.current) setGatewayUrl(settings?.hermesGatewayUrl ?? '')
  }, [settings?.hermesGatewayUrl])
  useEffect(() => {
    if (!nativeUrlDirty.current) setNativeUrl(settings?.hermesNativeUrl ?? '')
  }, [settings?.hermesNativeUrl])

  if (!settings) return null
  const enabled = settings.hermesEnabled === true
  const currentAuthoritativeSettings = () => useAppStore.getState().settings ?? settings
  const describeSaveError = (field: string, error: unknown): string =>
    `Could not save ${field}: ${error instanceof Error ? error.message : 'Unknown error'}`
  const clearSaveError = (field: HermesSaveField): void => {
    setSaveErrors((current) => {
      if (current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }
  const setSaveError = (field: HermesSaveField, message: string): void => {
    setSaveErrors((current) => ({ ...current, [field]: message }))
  }
  const enqueueSave = (owner: SaveOwner, operation: () => Promise<void>): void => {
    const run = owner.pending ? owner.pending.then(operation, operation) : operation()
    owner.pending = run
    void run.then(
      () => {
        if (owner.pending === run) owner.pending = null
      },
      () => {
        if (owner.pending === run) owner.pending = null
      }
    )
  }

  // Draft-then-save-on-blur, same pattern as GeneralPage's name/instructions
  // fields and UrsaPage's custom-instructions textarea: only persist when the
  // value actually changed.
  const saveGatewayUrl = (): void => {
    const draft = gatewayUrl
    const generation = gatewayUrlSaveOwner.current.generation
    enqueueSave(gatewayUrlSaveOwner.current, async () => {
      const authoritative = currentAuthoritativeSettings().hermesGatewayUrl ?? ''
      if (draft === authoritative) {
        if (gatewayUrlSaveOwner.current.generation === generation) {
          gatewayUrlDirty.current = false
        }
        return
      }
      try {
        await saveSettings({ hermesGatewayUrl: draft })
        if (gatewayUrlSaveOwner.current.generation === generation) {
          setGatewayUrl(currentAuthoritativeSettings().hermesGatewayUrl ?? '')
        }
      } catch (error) {
        if (gatewayUrlSaveOwner.current.generation === generation) {
          setGatewayUrl(currentAuthoritativeSettings().hermesGatewayUrl ?? '')
          setSaveError('gatewayUrl', describeSaveError('Gateway URL', error))
        }
      } finally {
        if (gatewayUrlSaveOwner.current.generation === generation) {
          gatewayUrlDirty.current = false
        }
      }
    })
  }
  const saveNativeUrl = (): void => {
    const draft = nativeUrl
    const generation = nativeUrlSaveOwner.current.generation
    enqueueSave(nativeUrlSaveOwner.current, async () => {
      const authoritative = currentAuthoritativeSettings().hermesNativeUrl ?? ''
      if (draft === authoritative) {
        if (nativeUrlSaveOwner.current.generation === generation) {
          nativeUrlDirty.current = false
        }
        return
      }
      try {
        await saveSettings({ hermesNativeUrl: draft })
        if (nativeUrlSaveOwner.current.generation === generation) {
          setNativeUrl(currentAuthoritativeSettings().hermesNativeUrl ?? '')
        }
      } catch (error) {
        if (nativeUrlSaveOwner.current.generation === generation) {
          setNativeUrl(currentAuthoritativeSettings().hermesNativeUrl ?? '')
          setSaveError('nativeUrl', describeSaveError('Native WebSocket URL', error))
        }
      } finally {
        if (nativeUrlSaveOwner.current.generation === generation) {
          nativeUrlDirty.current = false
        }
      }
    })
  }
  const saveLabel = (): void => {
    if (label !== (settings.hermesLabel ?? '')) void saveSettings({ hermesLabel: label })
  }
  const saveToken = (): void => {
    if (token) void saveHermesToken(token)
  }
  const savePlatformKey = (): void => {
    if (platformKey) void saveHermesPlatformKey(platformKey)
  }
  const selectMode = (nextMode: HermesConnectionMode): void => {
    const generation = ++modeSaveOwner.current.generation
    modeDirty.current = true
    setMode(nextMode)
    clearSaveError('mode')
    setTestResult(null)
    enqueueSave(modeSaveOwner.current, async () => {
      const authoritative = currentAuthoritativeSettings()
      const authoritativeMode =
        authoritative.hermesConnectionMode === 'native' ? 'native' : 'legacy'
      if (nextMode === authoritativeMode) {
        if (modeSaveOwner.current.generation === generation) modeDirty.current = false
        return
      }
      try {
        await saveSettings({ hermesConnectionMode: nextMode })
        if (modeSaveOwner.current.generation === generation) {
          const saved = currentAuthoritativeSettings()
          setMode(saved.hermesConnectionMode === 'native' ? 'native' : 'legacy')
        }
      } catch (error) {
        if (modeSaveOwner.current.generation === generation) {
          const saved = currentAuthoritativeSettings()
          setMode(saved.hermesConnectionMode === 'native' ? 'native' : 'legacy')
          setSaveError('mode', describeSaveError('Hermes connection mode', error))
        }
      } finally {
        if (modeSaveOwner.current.generation === generation) modeDirty.current = false
      }
    })
  }
  const runTest = async (): Promise<void> => {
    setTesting(true)
    const url = mode === 'native' ? nativeUrl : gatewayUrl
    const secret = mode === 'native' ? platformKey : token
    try {
      setTestResult(await testHermesConnection(mode, url, secret || undefined))
    } finally {
      setTesting(false)
    }
  }
  const activeUrl = mode === 'native' ? nativeUrl : gatewayUrl
  const saveError =
    saveErrors.mode ?? (mode === 'native' ? saveErrors.nativeUrl : saveErrors.gatewayUrl) ?? null

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
            <div className="set-row-desc">
              Adds a Hermes section to the sidebar. Off by default.
            </div>
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
              <div className="set-row-title">Connection mode</div>
              <Select
                ariaLabel="Connection mode"
                value={mode}
                onChange={selectMode}
                options={[
                  { value: 'native', label: 'Native Platform' },
                  { value: 'legacy', label: 'Legacy API' }
                ]}
              />
            </div>
            <div className="hermes-field">
              <div className="set-row-desc">
                {mode === 'native'
                  ? 'BearCode must be open, and the BearCode plugin must be installed on Hermes.'
                  : 'Legacy API is text-only and provides no file or approval guarantees.'}
              </div>
            </div>
            {mode === 'native' ? (
              <>
                <div className="hermes-field">
                  <div className="set-row-title">Native WebSocket URL</div>
                  <input
                    className="set-input"
                    aria-label="Native WebSocket URL"
                    placeholder="ws://umzspark:8643"
                    value={nativeUrl}
                    onChange={(e) => {
                      ++nativeUrlSaveOwner.current.generation
                      nativeUrlDirty.current = true
                      clearSaveError('nativeUrl')
                      setNativeUrl(e.target.value)
                    }}
                    onBlur={saveNativeUrl}
                  />
                </div>
                <div className="hermes-field">
                  <div className="set-row-title">Platform key</div>
                  <input
                    className="set-input"
                    type="password"
                    aria-label="Platform key"
                    placeholder="Stored securely in the BearCode vault"
                    value={platformKey}
                    onChange={(e) => setPlatformKey(e.target.value)}
                    onBlur={savePlatformKey}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="hermes-field">
                  <div className="set-row-title">Gateway URL</div>
                  <input
                    className="set-input"
                    aria-label="Gateway URL"
                    placeholder="http://100.x.x.x:8642 (Tailscale / tunnel address)"
                    value={gatewayUrl}
                    onChange={(e) => {
                      ++gatewayUrlSaveOwner.current.generation
                      gatewayUrlDirty.current = true
                      clearSaveError('gatewayUrl')
                      setGatewayUrl(e.target.value)
                    }}
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
              </>
            )}
            {saveError ? (
              <div className="hermes-test-error">
                <ErrorCard>{saveError}</ErrorCard>
              </div>
            ) : null}
            <div className="hermes-test-row">
              <button
                type="button"
                className="pill-btn"
                onClick={() => void runTest()}
                disabled={testing || !activeUrl}
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
