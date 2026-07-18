import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { ProviderIcon } from '../../ProviderIcon'
import { Loading } from '../../ui/Loading'

// Settings > Ursa: on/off switch + a read-only check that the providers
// Ursa's (code-curated, never user-editable) roles depend on have keys
// configured. Deliberately NOT a role-management page -- Ursa routes turns
// on its own, the same way Cursor's or Perplexity's own orchestrator entries
// aren't something the end user configures. The curated role table itself
// lives in main/orchestrator/ursa.ts.
export function UrsaPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [requiredProviders, setRequiredProviders] = useState<ProviderId[] | null>(null)

  useEffect(() => {
    let alive = true
    void window.bearcode.ursa.requiredProviders().then((ids) => {
      if (alive) setRequiredProviders(ids)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings) return null
  const enabled = settings.ursaEnabled === true

  return (
    <>
      <div className="page-title">Ursa</div>
      <div className="page-sub">
        Dynamic model routing. When enabled, selecting "Ursa" in the model picker hands each turn
        to whichever model best fits it — the routing itself isn't something you configure here.
      </div>

      <div className="set-group-title">Access</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Enable Ursa</div>
            <div className="set-row-desc">
              Makes "Ursa" selectable in the model picker. Off by default.
            </div>
          </div>
          <Toggle
            ariaLabel="Enable Ursa"
            checked={enabled}
            onChange={(on) => void saveSettings({ ursaEnabled: on })}
          />
        </div>
      </div>

      <div className="set-group-title">Provider Status</div>
      <div className="set-card">
        {requiredProviders === null ? (
          <Loading label="Checking…" />
        ) : (
          requiredProviders.map((id) => {
            const provider = providers.find((p) => p.id === id)
            const configured = Boolean(provider && (!provider.requiresKey || provider.keyConfigured))
            return (
              <div className="set-row" key={id}>
                <div className="set-row-text">
                  <div className="set-row-title">
                    <ProviderIcon provider={id} size={14} /> {provider?.displayName ?? id}
                  </div>
                  <div className="set-row-desc">
                    {configured ? 'API key configured' : 'No API key configured'}
                  </div>
                </div>
                <span className={'status-dot' + (configured ? ' ok' : '')} />
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
