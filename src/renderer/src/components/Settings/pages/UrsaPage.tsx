import { useEffect, useState } from 'react'
// Cap kept in sync with the main-process coercion (settings.ts
// URSA_INSTRUCTIONS_MAX). The write path enforces it regardless; maxLength is a
// UI courtesy so the field can't grow past what will actually be persisted.
const URSA_INSTRUCTIONS_MAX = 2000
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
  const [instructions, setInstructions] = useState(settings?.ursaInstructions ?? '')

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

  // Persist on blur only when the value actually changed (matches the
  // draft-then-save pattern GeneralPage's custom-instructions field uses).
  const saveInstructions = (): void => {
    if (instructions !== (settings.ursaInstructions ?? ''))
      void saveSettings({ ursaInstructions: instructions })
  }

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

      {enabled && (
        <>
          <div className="set-group-title">Custom Instructions</div>
          <div className="set-card pad">
            <div className="set-row-desc" style={{ marginBottom: 8 }}>
              Optional guidance Ursa&apos;s router reads every turn. Advisory only — it biases which
              model handles a turn but can never override the built-in roles.
            </div>
            <textarea
              className="set-textarea"
              rows={4}
              maxLength={URSA_INSTRUCTIONS_MAX}
              placeholder="e.g. Prefer the coder for anything touching this repo. Route quick questions to the fast model."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={saveInstructions}
            />
          </div>
        </>
      )}
    </>
  )
}
