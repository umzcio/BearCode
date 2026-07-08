import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ProviderId } from '@shared/types'
import { resolvePrice } from '@shared/pricing'
import { useAppStore } from '../../../state/store'
import { relativeAge } from '../../../lib/time'
import { Select } from '../../Select'
import { Toggle } from '../../Toggle'

// The four first-party providers a custom model can be added under (Ollama is
// dynamic/local and manages its own catalog).
const ADDABLE_PROVIDERS: { value: ProviderId; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' }
]

export function ModelsPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const manageableModels = useAppStore((s) => s.manageableModels)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const syncPricing = useAppStore((s) => s.syncPricing)
  const refreshManageableModels = useAppStore((s) => s.refreshManageableModels)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const addCustomModel = useAppStore((s) => s.addCustomModel)
  const removeCustomModel = useAppStore((s) => s.removeCustomModel)

  const [pricingSync, setPricingSync] = useState<{
    status: 'idle' | 'pending' | 'done' | 'error'
    msg: string
  }>({ status: 'idle', msg: '' })

  // Add-model draft.
  const [addProvider, setAddProvider] = useState<ProviderId>('anthropic')
  const [addId, setAddId] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [addCtx, setAddCtx] = useState('')

  useEffect(() => {
    void refreshManageableModels()
  }, [refreshManageableModels])

  if (!settings) return null

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ ref: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
  )

  const runPricingSync = (): void => {
    setPricingSync({ status: 'pending', msg: '' })
    void syncPricing()
      .then((r) =>
        setPricingSync({
          status: 'done',
          msg: `${r.syncedCount} synced · ${r.unmatched.length} unmatched`
        })
      )
      .catch((e) =>
        setPricingSync({ status: 'error', msg: e instanceof Error ? e.message : 'Sync failed' })
      )
  }

  const ctxNum = Number(addCtx)
  const addValid =
    addId.trim().length > 0 && addLabel.trim().length > 0 && Number.isFinite(ctxNum) && ctxNum > 0
  // Warn (but still allow — custom overrides) when the id collides with a curated
  // model of the same provider.
  const collides = manageableModels
    .find((p) => p.id === addProvider)
    ?.models.some((m) => !m.custom && m.id === addId.trim())

  const submitAdd = (): void => {
    if (!addValid) return
    void addCustomModel({
      provider: addProvider,
      id: addId.trim(),
      label: addLabel.trim(),
      contextWindow: Math.round(ctxNum)
    })
    setAddId('')
    setAddLabel('')
    setAddCtx('')
  }

  const fmtCtx = (n?: number): string => {
    if (!n) return ''
    const size =
      n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
        : `${Math.round(n / 1000)}K`
    return `${size} context`
  }

  return (
    <>
      <div className="page-title">Models</div>
      <div className="page-sub">
        The default model, which models appear in the picker, custom models, and pricing.
      </div>

      <div className="set-group-title">Defaults</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Default Model</div>
            <div className="set-row-desc">
              The model new conversations start with. Last used keeps whatever you picked most
              recently.
            </div>
          </div>
          <Select
            ariaLabel="Default model"
            value={settings.defaultModelRef ?? ''}
            onChange={(v) => void saveSettings({ defaultModelRef: v || null })}
            options={[
              { value: '', label: 'Last used' },
              ...allModels.map((m) => ({ value: m.ref, label: m.label }))
            ]}
          />
        </div>
      </div>

      <div className="set-group-title">Voice input</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Speech-to-text backend</div>
            <div className="set-row-desc">
              OpenAI Whisper transcribes in the cloud using your OpenAI key. Local runs on-device,
              offline, with no key.
            </div>
          </div>
          <Select
            ariaLabel="Speech-to-text backend"
            value={settings.sttBackend ?? 'openai'}
            onChange={(v) => void saveSettings({ sttBackend: v })}
            options={[
              { value: 'openai', label: 'OpenAI Whisper (uses your OpenAI key)' },
              { value: 'local', label: 'Local (offline)' }
            ]}
          />
        </div>
      </div>

      <div className="set-group-title">Manage Models</div>
      <div className="set-row-desc" style={{ marginBottom: 10 }}>
        Turn models off to hide them from the picker everywhere, or add a model your provider ships
        that isn&apos;t listed yet.
      </div>
      {manageableModels.map((p) => (
        <div key={p.id} style={{ marginBottom: 14 }}>
          <div className="set-group-title model-provider-head">
            <span className="provider-dot" style={{ background: p.color }} />
            {p.displayName}
          </div>
          <div className="set-card pad">
            {p.models.length === 0 ? (
              <div className="set-row-desc">No models.</div>
            ) : (
              p.models.map((m) => (
                <div className="model-manage-row" key={m.id}>
                  <div className="model-manage-label">
                    <span className="model-manage-name">
                      {m.label}
                      {m.custom ? ' · custom' : ''}
                    </span>
                    {m.contextWindow ? (
                      <span className="model-ctx">{fmtCtx(m.contextWindow)}</span>
                    ) : null}
                  </div>
                  <div className="model-manage-controls">
                    <Toggle
                      checked={m.enabled}
                      ariaLabel={`${m.label} enabled`}
                      onChange={(on) => void setModelEnabled(`${p.id}/${m.id}`, on)}
                    />
                    {m.custom ? (
                      <button
                        className="model-remove-btn"
                        onClick={() => void removeCustomModel(p.id, m.id)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ))}

      <div className="set-group-title">Add a model</div>
      <div className="set-card pad">
        <div className="add-model-grid">
          <div className="add-model-field">
            <label>Provider</label>
            <Select
              ariaLabel="Add model provider"
              value={addProvider}
              onChange={(v) => setAddProvider(v)}
              options={ADDABLE_PROVIDERS}
            />
          </div>
          <div className="add-model-field">
            <label>Model ID</label>
            <input
              className="set-input"
              placeholder="e.g. gemini-3.1-pro-preview"
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
            />
          </div>
          <div className="add-model-field">
            <label>Display name</label>
            <input
              className="set-input"
              placeholder="e.g. Gemini 3.1 Pro"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
            />
          </div>
          <div className="add-model-field">
            <label>Context window (tokens)</label>
            <input
              className="set-input"
              type="number"
              min="1"
              placeholder="e.g. 1000000"
              value={addCtx}
              onChange={(e) => setAddCtx(e.target.value)}
            />
          </div>
        </div>
        {collides ? (
          <div className="add-model-hint">
            A built-in model with this ID exists for {addProvider}; your custom entry will override
            it.
          </div>
        ) : null}
        <button className="pill-btn" onClick={submitAdd} disabled={!addValid}>
          Add model
        </button>
      </div>

      <div className="set-group-title">Model Pricing</div>
      <div className="set-card pad">
        <div className="pricing-intro">
          USD per 1M tokens. Sync pulls current prices from LiteLLM.
        </div>
        <table className="pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {allModels.map((m) => {
              const price = resolvePrice(m.ref, settings.modelPricing)
              const source = settings.modelPricing?.[m.ref] ? 'synced' : price ? 'default' : null
              return (
                <tr key={m.ref}>
                  <td className="pricing-model">{m.label}</td>
                  <td>{price ? `$${price.inputPer1M}` : '—'}</td>
                  <td>{price ? `$${price.outputPer1M}` : '—'}</td>
                  <td>
                    {source ? (
                      <span className={'price-src ' + source}>{source}</span>
                    ) : (
                      <span className="price-src none">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="pricing-actions">
          <button
            className="pill-btn"
            onClick={runPricingSync}
            disabled={pricingSync.status === 'pending'}
          >
            {pricingSync.status === 'pending' ? 'Syncing…' : 'Sync prices'}
          </button>
          {pricingSync.status === 'done' ? (
            <span className="pricing-result">{pricingSync.msg}</span>
          ) : null}
          {pricingSync.status === 'error' ? (
            <span className="pricing-result err">{pricingSync.msg}</span>
          ) : null}
        </div>
        <div className="pricing-synced">
          {settings.modelPricingSyncedAt
            ? `Last synced ${relativeAge(settings.modelPricingSyncedAt)}`
            : 'Using bundled defaults'}
        </div>
      </div>
    </>
  )
}
