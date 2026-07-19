import { useState } from 'react'
import type { JSX } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { ProviderIcon } from '../../ProviderIcon'

const KEY_PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' },
  { id: 'perplexity', label: 'Perplexity', placeholder: 'pplx-…' },
  { id: 'xai', label: 'xAI', placeholder: 'xai-…' }
]

export function ProvidersPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveKey = useAppStore((s) => s.saveKey)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [ollamaUrl, setOllamaUrl] = useState(settings?.ollamaBaseUrl ?? '')
  const [smitheryKey, setSmitheryKey] = useState('')
  const [smitherySaved, setSmitherySaved] = useState(false)

  if (!settings) return null

  // The Smithery registry API key lives in the vault (write-only over IPC --
  // there is no getter, so the key never crosses back to the renderer). Browse
  // Smithery (Connectors) reads it in main via getVaultSecret('smithery:apiKey')
  // and shows an empty-state pointing here when it is absent, so this field is
  // the one place that writes it.
  const saveSmitheryKey = (): void => {
    const value = smitheryKey.trim()
    if (!value) return
    void window.bearcode.mcp.setSecret('smithery:apiKey', value).then(() => {
      setSmitheryKey('')
      setSmitherySaved(true)
    })
  }

  const configured = (id: ProviderId): boolean =>
    providers.find((p) => p.id === id)?.keyConfigured ?? false

  return (
    <>
      <div className="page-title">Providers</div>
      <div className="page-sub">
        API keys and local model endpoints. Connection status is shown per provider.
      </div>

      <div className="set-group-title">API Keys</div>
      <div className="set-card pad">
        {KEY_PROVIDERS.map((p) => (
          <div className="key-row" key={p.id}>
            <span className={'status-dot' + (configured(p.id) ? ' ok' : '')} />
            <span className="key-label icon-label">
              <ProviderIcon provider={p.id} size={14} />
              {p.label}
            </span>
            <input
              type="password"
              placeholder={configured(p.id) ? 'Configured' : p.placeholder}
              value={keyDrafts[p.id] ?? ''}
              onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
            />
            <button
              className="small-btn"
              disabled={!(keyDrafts[p.id] ?? '').trim() && !configured(p.id)}
              onClick={() => {
                void saveKey(p.id, (keyDrafts[p.id] ?? '').trim())
                setKeyDrafts((d) => ({ ...d, [p.id]: '' }))
              }}
            >
              {(keyDrafts[p.id] ?? '').trim() ? 'Save' : configured(p.id) ? 'Remove' : 'Save'}
            </button>
          </div>
        ))}
      </div>

      <div className="set-group-title">Ollama</div>
      <div className="set-card pad">
        <div className="key-row">
          <span
            className={
              'status-dot' + (providers.find((p) => p.id === 'ollama')?.reachable ? ' ok' : '')
            }
          />
          <span className="key-label icon-label" title="Base URL">
            <ProviderIcon provider="ollama" size={14} />
            Ollama
          </span>
          <input
            type="text"
            value={ollamaUrl}
            placeholder="http://localhost:11434"
            onChange={(e) => setOllamaUrl(e.target.value)}
          />
          <button
            className="small-btn"
            disabled={ollamaUrl === settings.ollamaBaseUrl}
            onClick={() => void saveSettings({ ollamaBaseUrl: ollamaUrl })}
          >
            Save
          </button>
        </div>
      </div>

      <div className="set-group-title">Smithery</div>
      <div className="set-card pad">
        <div className="key-row">
          <span className={'status-dot' + (smitherySaved ? ' ok' : '')} />
          <span className="key-label" title="Smithery registry API key">
            Smithery API key
          </span>
          <input
            type="password"
            placeholder={smitherySaved ? 'Saved' : 'smithery-…'}
            value={smitheryKey}
            onChange={(e) => {
              setSmitheryKey(e.target.value)
              setSmitherySaved(false)
            }}
          />
          <button className="small-btn" disabled={!smitheryKey.trim()} onClick={saveSmitheryKey}>
            Save
          </button>
        </div>
        <div className="page-sub" style={{ marginTop: 6 }}>
          Used to browse and install servers from the Smithery registry under Connectors.
        </div>
      </div>
    </>
  )
}
