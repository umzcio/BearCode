import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { ProviderIcon } from '../../ProviderIcon'
import { Loading } from '../../ui/Loading'
import ursusBear from '../../../assets/ursus-bear.svg'

// Cap kept in sync with the main-process coercion (settings.ts
// URSUS_INSTRUCTIONS_MAX). The write path enforces it regardless; maxLength is a
// UI courtesy so the field can't grow past what will actually be persisted.
const URSUS_INSTRUCTIONS_MAX = 2000

// Settings > Ursus: on/off switch + a read-only check of the providers Ursus's
// (code-curated, never user-editable) roles depend on. Deliberately NOT a
// role-management page -- same philosophy as UrsaPage.tsx. Ursus is restricted
// to OpenRouter/Ollama; unlike UrsaPage's uniform "key configured" check, the
// Ollama row here reads the store's LIVE reachable field (same field
// ProvidersPage.tsx's own Ollama status dot already reads) since Ollama has no
// key to configure -- reachability is the actual eligibility gate. The curated
// role table itself lives in main/orchestrator/ursus.ts.
export function UrsusPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [requiredProviders, setRequiredProviders] = useState<ProviderId[] | null>(null)
  const [instructions, setInstructions] = useState(settings?.ursusInstructions ?? '')

  useEffect(() => {
    let alive = true
    void window.bearcode.ursus.requiredProviders().then((ids) => {
      if (alive) setRequiredProviders(ids)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings) return null
  const enabled = settings.ursusEnabled === true

  const saveInstructions = (): void => {
    if (instructions !== (settings.ursusInstructions ?? ''))
      void saveSettings({ ursusInstructions: instructions })
  }

  return (
    <>
      <div className="page-title">
        <img className="page-title-icon" src={ursusBear} alt="" />
        Ursus
      </div>
      <div className="page-sub">
        Dynamic model routing restricted to OpenRouter and local Ollama models -- no
        frontier providers. When enabled, selecting "Ursus" in the model picker hands
        each turn to whichever model best fits it.
      </div>

      <div className="set-group-title">Access</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Enable Ursus</div>
            <div className="set-row-desc">
              Makes "Ursus" selectable in the model picker. Off by default.
            </div>
          </div>
          <Toggle
            ariaLabel="Enable Ursus"
            checked={enabled}
            onChange={(on) => void saveSettings({ ursusEnabled: on })}
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
            const isOllama = id === 'ollama'
            const configured = isOllama
              ? Boolean(provider?.reachable)
              : Boolean(provider && (!provider.requiresKey || provider.keyConfigured))
            const statusText = isOllama
              ? provider?.reachable
                ? 'Reachable'
                : 'Not reachable'
              : configured
                ? 'API key configured'
                : 'No API key configured'
            return (
              <div className="set-row" key={id}>
                <div className="set-row-text">
                  <div className="set-row-title">
                    <ProviderIcon provider={id} size={14} /> {provider?.displayName ?? id}
                  </div>
                  <div className="set-row-desc">{statusText}</div>
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
              Optional guidance Ursus&apos;s router reads every turn. Advisory only --
              it biases which model handles a turn but can never override the
              built-in roles.
            </div>
            <textarea
              className="set-textarea"
              rows={4}
              maxLength={URSUS_INSTRUCTIONS_MAX}
              placeholder="e.g. Prefer the coder for anything touching this repo."
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
