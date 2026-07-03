import { useEffect, useState } from 'react'
import type { ProviderId, SettingsInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { RoarBear } from '../brand/RoarBear'
import { IconClose } from '../icons'
import './Settings.css'

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'New Conversation', keys: ['⌘', 'N'] },
  { label: 'Focus Input', keys: ['⌘', 'L'] },
  { label: 'Toggle Model Selector', keys: ['⌘', '/'] },
  { label: 'Toggle Sidebar', keys: ['⌘', 'B'] },
  { label: 'Open Settings', keys: ['⌘', ','] },
  { label: 'Send Message', keys: ['⏎'] },
  { label: 'New Line', keys: ['⇧', '⏎'] },
  { label: 'Close Modal or Menu', keys: ['esc'] }
]

const KEY_PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' }
]

const GENERAL_PAGES: { id: string; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'models', label: 'Models' },
  { id: 'customizations', label: 'Customizations' },
  { id: 'browser', label: 'Browser' },
  { id: 'app', label: 'App' }
]

export function SettingsModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const settings = useAppStore((s) => s.settings)
  if (!open || !settings) return null
  // Remounts on each open, so drafts initialize fresh from current settings.
  return <SettingsPanel settings={settings} />
}

function ComingSoon(): React.JSX.Element {
  return (
    <div className="coming-block">
      <RoarBear scale={3} />
      <span>coming soon</span>
    </div>
  )
}

function ComingTag(): React.JSX.Element {
  return <span className="coming-tag">coming soon</span>
}

function Row({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        <div className="set-row-desc">{desc}</div>
      </div>
      {children ?? <ComingTag />}
    </div>
  )
}

function PageHead({ title, sub }: { title: string; sub: string }): React.JSX.Element {
  return (
    <>
      <div className="page-title">{title}</div>
      <div className="page-sub">{sub}</div>
    </>
  )
}

function SettingsPanel({ settings }: { settings: SettingsInfo }): React.JSX.Element {
  const close = useAppStore((s) => s.closeSettings)
  const providers = useAppStore((s) => s.providers)
  const conversations = useAppStore((s) => s.conversations)
  const saveKey = useAppStore((s) => s.saveKey)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const deleteAll = useAppStore((s) => s.deleteAllConversations)

  const [page, setPage] = useState('models')
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaBaseUrl)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const configured = (id: ProviderId): boolean =>
    providers.find((p) => p.id === id)?.keyConfigured ?? false

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ ref: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
  )

  const projectLabels: string[] = []
  for (const convo of Object.values(conversations)) {
    if (convo.projectLabel !== 'No folder' && !projectLabels.includes(convo.projectLabel)) {
      projectLabels.push(convo.projectLabel)
    }
  }

  const railItem = (id: string, label: string): React.JSX.Element => (
    <button
      key={id}
      className={'rail-item' + (page === id ? ' selected' : '')}
      onClick={() => setPage(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-panel">
        <div className="settings-rail">
          <div className="rail-group-label">General</div>
          {GENERAL_PAGES.map((p) => railItem(p.id, p.label))}
          {projectLabels.length > 0 ? (
            <>
              <div className="rail-group-label">Projects</div>
              {projectLabels.map((label) => railItem(`project:${label}`, label))}
            </>
          ) : null}
          <div className="rail-group-label">Not in Project</div>
          {railItem('conversations', 'Conversations')}
          <div className="rail-spacer" />
          {railItem('shortcuts', 'Shortcuts')}
          {railItem('feedback', 'Provide Feedback')}
        </div>

        <div className="settings-content">
          <button className="content-close" title="Close" onClick={close}>
            <IconClose />
          </button>

          {page === 'account' ? (
            <>
              <PageHead title="Account" sub="Your BearCode account and sign-in." />
              <ComingSoon />
            </>
          ) : null}

          {page === 'permissions' ? (
            <>
              <PageHead
                title="Permissions"
                sub="Global agent permissions. These apply everywhere unless a project overrides them."
              />
              <div className="set-group-title">Agent Settings</div>
              <div className="set-card">
                <Row
                  title="Security Preset"
                  desc="Choose a predefined security preset for the agent. This controls terminal auto-execution policy, and file access policy."
                />
                <Row
                  title="Outside of Folders File Access Policy"
                  desc="Configures how the agent tries to access files outside of its working folders."
                />
                <Row
                  title="Terminal Command Auto Execution"
                  desc="Controls whether terminal commands require your approval before running."
                >
                  <select
                    value={settings.autoApproveCommands ? 'auto' : 'review'}
                    onChange={(e) =>
                      void saveSettings({ autoApproveCommands: e.target.value === 'auto' })
                    }
                  >
                    <option value="review">Require Review</option>
                    <option value="auto">Auto Execute</option>
                  </select>
                </Row>
                <Row
                  title="Enable Sandbox Mode"
                  desc="Restricts agent tools to a secure, isolated local sandbox."
                />
              </div>
            </>
          ) : null}

          {page === 'appearance' ? (
            <>
              <PageHead title="Appearance" sub="Theme and display options." />
              <ComingSoon />
            </>
          ) : null}

          {page === 'models' ? (
            <>
              <PageHead
                title="Models"
                sub="Provider API keys, local models, and the default model for new conversations."
              />
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
                      {(keyDrafts[p.id] ?? '').trim()
                        ? 'Save'
                        : configured(p.id)
                          ? 'Remove'
                          : 'Save'}
                    </button>
                  </div>
                ))}
              </div>

              <div className="set-group-title">Ollama</div>
              <div className="set-card pad">
                <div className="key-row">
                  <span
                    className={
                      'status-dot' +
                      (providers.find((p) => p.id === 'ollama')?.reachable ? ' ok' : '')
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

              <div className="set-group-title">Defaults</div>
              <div className="set-card">
                <Row
                  title="Default Model"
                  desc="The model new conversations start with. Last used keeps whatever you picked most recently."
                >
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
                </Row>
              </div>
            </>
          ) : null}

          {page === 'customizations' ? (
            <>
              <PageHead title="Customizations" sub="Rules and custom instructions for the agent." />
              <ComingSoon />
            </>
          ) : null}

          {page === 'browser' ? (
            <>
              <PageHead title="Browser" sub="Browser tools for the agent." />
              <ComingSoon />
            </>
          ) : null}

          {page === 'app' ? (
            <>
              <PageHead title="App" sub="Application data and housekeeping." />
              <div className="set-group-title">Data</div>
              <div className="set-card">
                <Row title="Location" desc={settings.dataPath}>
                  <span />
                </Row>
                <Row
                  title="Delete All Conversations"
                  desc="Removes every conversation and staged diff. This cannot be undone."
                >
                  <button
                    className="danger-btn"
                    onClick={() => {
                      if (window.confirm('Delete all conversations? This cannot be undone.')) {
                        void deleteAll()
                      }
                    }}
                  >
                    Delete
                  </button>
                </Row>
              </div>
            </>
          ) : null}

          {page.startsWith('project:') ? (
            <>
              <PageHead
                title={page.slice('project:'.length)}
                sub="Agent settings and permissions for this project."
              />
              <ComingSoon />
            </>
          ) : null}

          {page === 'conversations' ? (
            <>
              <PageHead
                title="Conversations"
                sub="Agent settings and permissions for conversations outside of projects."
              />
              <ComingSoon />
            </>
          ) : null}

          {page === 'shortcuts' ? (
            <>
              <PageHead
                title="Shortcuts"
                sub="Keyboard shortcuts for quick navigation and control."
              />
              <div className="set-card">
                {SHORTCUTS.map((s) => (
                  <div className="shortcut-row" key={s.label}>
                    <span>{s.label}</span>
                    <span className="keycaps">
                      {s.keys.map((k) => (
                        <kbd className="keycap" key={k}>
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {page === 'feedback' ? (
            <>
              <PageHead title="Provide Feedback" sub="Tell us what BearCode should do better." />
              <ComingSoon />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
