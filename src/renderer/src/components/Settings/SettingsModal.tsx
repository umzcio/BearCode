import { useEffect, useState } from 'react'
import type { SettingsInfo } from '@shared/types'
import { resolvePrice } from '@shared/pricing'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import {
  IconClose,
  IconGear,
  IconShield,
  IconPalette,
  IconPlug,
  IconGrid,
  IconScroll,
  IconBlocks,
  IconBrain,
  IconLink,
  IconGlobe,
  IconKeyboard,
  IconChat
} from '../icons'
import { PermissionRulesSection } from './PermissionRules'
import { GeneralPage } from './pages/GeneralPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { SettingPlaceholder } from './SettingPlaceholder'
import { SETTINGS_NAV, SETTINGS_FOOTER, FEEDBACK_URL } from './SettingsNav'
import type { SettingsPageId } from './SettingsNav'
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

// Resolves a SETTINGS_NAV item's icon name to its component.
const NAV_ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  IconGear,
  IconShield,
  IconPalette,
  IconPlug,
  IconGrid,
  IconScroll,
  IconBlocks,
  IconBrain,
  IconLink,
  IconGlobe,
  IconKeyboard,
  IconChat
}

// Intentional WIP panels for the Customize group (not "coming soon" badges).
const PLACEHOLDERS: Record<string, { title: string; description: string }> = {
  skills: {
    title: 'Skills',
    description:
      'Teach the agent reusable workflows and domain knowledge — arriving in a future update.'
  },
  connectors: {
    title: 'Connectors',
    description:
      'Connect MCP servers and external tools the agent can call — arriving in a future update.'
  },
  memory: {
    title: 'Memory',
    description:
      'Persistent memory the agent carries across conversations — arriving in a future update.'
  },
  integrations: {
    title: 'Integrations',
    description: 'Link BearCode to the services you already use — arriving in a future update.'
  },
  browser: {
    title: 'Browser',
    description: 'Give the agent controlled access to a real browser — arriving in a future update.'
  }
}

export function SettingsModal(): React.JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const settings = useAppStore((s) => s.settings)
  const initialPage = useAppStore((s) => s.settingsInitialPage)
  if (!open || !settings) return null
  // Remounts on each open, so drafts initialize fresh from current settings.
  return <SettingsPanel settings={settings} initialPage={initialPage} />
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
      {children ?? null}
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

function SettingsPanel({
  settings,
  initialPage
}: {
  settings: SettingsInfo
  initialPage: string | null
}): React.JSX.Element {
  const close = useAppStore((s) => s.closeSettings)
  const providers = useAppStore((s) => s.providers)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const syncPricing = useAppStore((s) => s.syncPricing)

  const [page, setPage] = useState<SettingsPageId>(() => {
    const ids = [...SETTINGS_NAV.flatMap((g) => g.items), ...SETTINGS_FOOTER].map((i) => i.id)
    return ids.includes(initialPage as SettingsPageId) ? (initialPage as SettingsPageId) : 'general'
  })
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

  const railItem = (item: {
    id: SettingsPageId
    label: string
    icon: string
  }): React.JSX.Element => {
    const Icon = NAV_ICONS[item.icon]
    return (
      <button
        key={item.id}
        className={'rail-item' + (page === item.id ? ' selected' : '')}
        onClick={() => setPage(item.id)}
      >
        {Icon ? <Icon size={16} /> : null}
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-panel">
        <div className="settings-rail">
          {SETTINGS_NAV.map((group) => (
            <div className="rail-group" key={group.label ?? 'ungrouped'}>
              {group.label ? <div className="rail-group-label">{group.label}</div> : null}
              {group.items.map((item) => railItem(item))}
            </div>
          ))}
          <div className="rail-spacer" />
          <div className="rail-footer">{SETTINGS_FOOTER.map((item) => railItem(item))}</div>
        </div>

        <div className="settings-content">
          <button className="content-close" title="Close" onClick={close}>
            <IconClose />
          </button>

          {page === 'general' ? <GeneralPage /> : null}

          {page === 'providers' ? <ProvidersPage /> : null}

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
              {/* "Agent Settings" (Security Preset / Outside-of-Folders File
                  Access / Sandbox Mode) are built as real controls in F8 (and
                  Sandbox in Phase G). Omitted here rather than shown as
                  control-less rows that read as broken. */}
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

          {PLACEHOLDERS[page] ? (
            <SettingPlaceholder
              title={PLACEHOLDERS[page].title}
              description={PLACEHOLDERS[page].description}
            />
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
              <div className="set-card pad">
                <div className="feedback-body">
                  <p className="feedback-text">
                    Found a bug or have an idea? Open an issue on GitHub — it goes straight to the
                    team.
                  </p>
                  <button className="pill-btn" onClick={() => window.open(FEEDBACK_URL, '_blank')}>
                    Report an Issue on GitHub
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
