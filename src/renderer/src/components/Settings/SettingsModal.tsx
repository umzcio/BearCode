import { useEffect, useState } from 'react'
import type { SettingsInfo } from '@shared/types'
import { resolvePrice } from '@shared/pricing'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { RoarBear } from '../brand/RoarBear'
import { IconClose } from '../icons'
import { PermissionRulesSection } from './PermissionRules'
import { Select } from '../Select'
import './Settings.css'

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'New Conversation', keys: ['⌘', 'N'] },
  { label: 'Focus Input', keys: ['⌘', 'L'] },
  { label: 'Toggle Model Selector', keys: ['⌘', '/'] },
  { label: 'Toggle Mode Selector', keys: ['⌘', '.'] },
  { label: 'Toggle Sidebar', keys: ['⌘', 'B'] },
  { label: 'Search Chats & Projects', keys: ['⌘', 'K'] },
  { label: 'Open Settings', keys: ['⌘', ','] },
  { label: 'Send Message', keys: ['⏎'] },
  { label: 'New Line', keys: ['⇧', '⏎'] },
  { label: 'Close Modal or Menu', keys: ['esc'] }
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
  const saveSettings = useAppStore((s) => s.saveSettings)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const deleteAll = useAppStore((s) => s.deleteAllConversations)
  const syncPricing = useAppStore((s) => s.syncPricing)

  const [page, setPage] = useState('models')
  const [pricingSync, setPricingSync] = useState<{
    status: 'idle' | 'pending' | 'done' | 'error'
    msg: string
  }>({ status: 'idle', msg: '' })

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

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
              <PermissionRulesSection />
              <div className="set-group-title">Artifact Review</div>
              <div className="set-card">
                <Row
                  title="Artifact Review Policy"
                  desc="How the agent's submitted plans are handled. Request Review holds each plan for your review; Always Proceed approves it immediately. Applies to the next plan the agent submits."
                >
                  <div className="radio-col" role="radiogroup" aria-label="Artifact review policy">
                    <label className="radio-row">
                      <input
                        type="radio"
                        name="artifact-review-policy"
                        checked={settings.artifactReviewPolicy === 'request-review'}
                        onChange={() =>
                          void saveSettings({ artifactReviewPolicy: 'request-review' })
                        }
                      />
                      <span>Request Review (Recommended)</span>
                    </label>
                    <label className="radio-row">
                      <input
                        type="radio"
                        name="artifact-review-policy"
                        checked={settings.artifactReviewPolicy === 'always-proceed'}
                        onChange={() =>
                          void saveSettings({ artifactReviewPolicy: 'always-proceed' })
                        }
                      />
                      <span>Always Proceed</span>
                    </label>
                  </div>
                </Row>
              </div>
              <div className="set-group-title">Default Mode</div>
              <div className="set-card">
                <Row
                  title="Default Permission Mode"
                  desc="The permission mode new conversations start in. Bypass is per-conversation only and can never be a default."
                >
                  <Select
                    ariaLabel="Default permission mode"
                    value={settings.defaultPermissionMode}
                    onChange={(v) => void saveSettings({ defaultPermissionMode: v })}
                    options={[
                      { value: 'ask', label: 'Ask permissions' },
                      { value: 'accept-edits', label: 'Accept edits' },
                      { value: 'plan', label: 'Plan mode' },
                      { value: 'auto', label: 'Auto mode' }
                    ]}
                  />
                </Row>
              </div>
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
                  title="Enable Sandbox Mode"
                  desc="Restricts agent tools to a secure, isolated local sandbox."
                />
              </div>
            </>
          ) : null}

          {page === 'appearance' ? (
            <>
              <PageHead title="Appearance" sub="Theme and display options." />
              <div className="set-group-title">Theme</div>
              <div className="set-card">
                <Row title="Theme" desc="Dark, light, follow the system, or a custom palette.">
                  <Select
                    ariaLabel="Theme"
                    value={settings.theme}
                    onChange={(v) => void setAppearance({ theme: v })}
                    options={[
                      { value: 'dark', label: 'Dark' },
                      { value: 'light', label: 'Light' },
                      { value: 'system', label: 'System' },
                      { value: 'custom', label: 'Custom' }
                    ]}
                  />
                </Row>
                {settings.theme === 'custom' ? (
                  <>
                    <Row
                      title="Background"
                      desc="Base surface color; panels and borders derive from it."
                    >
                      <input
                        type="color"
                        aria-label="Background color"
                        className="color-input"
                        value={settings.customColors.bg}
                        onChange={(e) =>
                          void setAppearance({
                            customColors: { ...settings.customColors, bg: e.target.value }
                          })
                        }
                      />
                    </Row>
                    <Row title="Foreground" desc="Primary text color.">
                      <input
                        type="color"
                        aria-label="Foreground color"
                        className="color-input"
                        value={settings.customColors.fg}
                        onChange={(e) =>
                          void setAppearance({
                            customColors: { ...settings.customColors, fg: e.target.value }
                          })
                        }
                      />
                    </Row>
                    <Row title="Accent" desc="Buttons, links, and highlights.">
                      <input
                        type="color"
                        aria-label="Accent color"
                        className="color-input"
                        value={settings.customColors.accent}
                        onChange={(e) =>
                          void setAppearance({
                            customColors: { ...settings.customColors, accent: e.target.value }
                          })
                        }
                      />
                    </Row>
                  </>
                ) : null}
              </div>

              <div className="set-group-title">Display</div>
              <div className="set-card">
                <Row title="Font size" desc="Scales the interface.">
                  <Select
                    ariaLabel="Font size"
                    value={settings.fontSize}
                    onChange={(v) => void setAppearance({ fontSize: v })}
                    options={[
                      { value: 'small', label: 'Small' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'large', label: 'Large' }
                    ]}
                  />
                </Row>
                <Row title="Conversation width" desc="Maximum width of the conversation column.">
                  <Select
                    ariaLabel="Conversation width"
                    value={settings.conversationWidth}
                    onChange={(v) => void setAppearance({ conversationWidth: v })}
                    options={[
                      { value: 'default', label: 'Default' },
                      { value: 'narrow', label: 'Narrow' },
                      { value: 'wide', label: 'Wide' }
                    ]}
                  />
                </Row>
                <Row title="Chat font" desc="Font for conversation text.">
                  <Select
                    ariaLabel="Chat font"
                    value={settings.chatFont}
                    onChange={(v) => void setAppearance({ chatFont: v })}
                    options={[
                      { value: 'sans', label: 'Sans-serif' },
                      { value: 'serif', label: 'Serif' }
                    ]}
                  />
                </Row>
                <Row title="Reduce motion" desc="Minimize animations beyond the system setting.">
                  <Select
                    ariaLabel="Reduce motion"
                    value={settings.reduceMotion ? 'reduced' : 'system'}
                    onChange={(v) => void setAppearance({ reduceMotion: v === 'reduced' })}
                    options={[
                      { value: 'system', label: 'System' },
                      { value: 'reduced', label: 'Reduced' }
                    ]}
                  />
                </Row>
              </div>
            </>
          ) : null}

          {page === 'models' ? (
            <>
              <PageHead
                title="Models"
                sub="Local models, pricing, and the default model for new conversations."
              />
              <div className="set-group-title">Defaults</div>
              <div className="set-card">
                <Row
                  title="Default Model"
                  desc="The model new conversations start with. Last used keeps whatever you picked most recently."
                >
                  <Select
                    ariaLabel="Default model"
                    value={settings.defaultModelRef ?? ''}
                    onChange={(v) => void saveSettings({ defaultModelRef: v || null })}
                    options={[
                      { value: '', label: 'Last used' },
                      ...allModels.map((m) => ({ value: m.ref, label: m.label }))
                    ]}
                  />
                </Row>
              </div>

              <div className="set-group-title">Voice input</div>
              <div className="set-card">
                <Row
                  title="Speech-to-text backend"
                  desc="OpenAI Whisper transcribes in the cloud using your OpenAI key. Local runs on-device, offline, with no key."
                >
                  <Select
                    ariaLabel="Speech-to-text backend"
                    value={settings.sttBackend ?? 'openai'}
                    onChange={(v) => void saveSettings({ sttBackend: v })}
                    options={[
                      { value: 'openai', label: 'OpenAI Whisper (uses your OpenAI key)' },
                      { value: 'local', label: 'Local (offline)' }
                    ]}
                  />
                </Row>
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
                      const source = settings.modelPricing?.[m.ref]
                        ? 'synced'
                        : price
                          ? 'default'
                          : null
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
