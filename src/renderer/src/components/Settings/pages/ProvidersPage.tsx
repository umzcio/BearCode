import { useState } from 'react'
import type { JSX } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { ProviderIcon } from '../../ProviderIcon'

const KEY_PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' }
]

export function ProvidersPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveKey = useAppStore((s) => s.saveKey)
  const saveSettings = useAppStore((s) => s.saveSettings)

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [ollamaUrl, setOllamaUrl] = useState(settings?.ollamaBaseUrl ?? '')

  if (!settings) return null

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
    </>
  )
}
