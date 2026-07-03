import { useState } from 'react'
import type { ProviderId, SettingsInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconClose } from '../icons'
import './Settings.css'

const KEY_PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' }
]

export function SettingsModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const settings = useAppStore((s) => s.settings)
  if (!open || !settings) return null
  // Remounts on each open, so drafts initialize fresh from current settings.
  return <SettingsPanel settings={settings} />
}

function SettingsPanel({ settings }: { settings: SettingsInfo }): React.JSX.Element {
  const close = useAppStore((s) => s.closeSettings)
  const providers = useAppStore((s) => s.providers)
  const saveKey = useAppStore((s) => s.saveKey)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const deleteAll = useAppStore((s) => s.deleteAllConversations)

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaBaseUrl)

  const configured = (id: ProviderId): boolean =>
    providers.find((p) => p.id === id)?.keyConfigured ?? false

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ ref: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
  )

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-panel">
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button className="close" title="Close" onClick={close}>
            <IconClose />
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <div className="section-label">API keys</div>
            {KEY_PROVIDERS.map((p) => (
              <div className="key-row" key={p.id}>
                <span className={'status-dot' + (configured(p.id) ? ' ok' : '')} />
                <span className="key-label">{p.label}</span>
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

          <div className="settings-section">
            <div className="section-label">Ollama</div>
            <div className="key-row">
              <span
                className={
                  'status-dot' + (providers.find((p) => p.id === 'ollama')?.reachable ? ' ok' : '')
                }
              />
              <span className="key-label">Base URL</span>
              <input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
              <button
                className="small-btn"
                disabled={ollamaUrl === settings.ollamaBaseUrl}
                onClick={() => void saveSettings({ ollamaBaseUrl: ollamaUrl })}
              >
                Save
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="section-label">Agent</div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.autoApproveCommands}
                onChange={(e) => void saveSettings({ autoApproveCommands: e.target.checked })}
              />
              <span>Auto-approve commands</span>
              <span className="row-hint">Commands run without asking first. Off by default.</span>
            </label>
            <div className="select-row">
              <span className="key-label">Default model</span>
              <select
                value={settings.defaultModelRef ?? ''}
                onChange={(e) => void saveSettings({ defaultModelRef: e.target.value || null })}
              >
                <option value="">Last used</option>
                {allModels.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-section">
            <div className="section-label">Data</div>
            <div className="data-row">
              <span className="key-label">Location</span>
              <span className="data-path">{settings.dataPath}</span>
            </div>
            <button
              className="danger-btn"
              onClick={() => {
                if (window.confirm('Delete all conversations? This cannot be undone.')) {
                  void deleteAll()
                }
              }}
            >
              Delete all conversations
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
