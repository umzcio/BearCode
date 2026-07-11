import { useEffect, useState } from 'react'
import type { SettingsInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
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
import { GeneralPage } from './pages/GeneralPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { ModelsPage } from './pages/ModelsPage'
import { PermissionsPage } from './pages/PermissionsPage'
import { BrowserPage } from './pages/BrowserPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { SkillsPage } from './pages/SkillsPage'
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
  { label: 'Conversation History', keys: ['⌘', 'K'] },
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
  memory: {
    title: 'Memory',
    description:
      'Persistent memory the agent carries across conversations — arriving in a future update.'
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
  const setAppearance = useAppStore((s) => s.setAppearance)

  const [page, setPage] = useState<SettingsPageId>(() => {
    const ids = [...SETTINGS_NAV.flatMap((g) => g.items), ...SETTINGS_FOOTER].map((i) => i.id)
    return ids.includes(initialPage as SettingsPageId) ? (initialPage as SettingsPageId) : 'general'
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

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

          {page === 'permissions' ? <PermissionsPage /> : null}

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

          {page === 'models' ? <ModelsPage /> : null}

          {page === 'browser' ? <BrowserPage /> : null}

          {page === 'connectors' ? <ConnectorsPage /> : null}

          {page === 'integrations' ? <IntegrationsPage /> : null}

          {page === 'skills' ? <SkillsPage /> : null}

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
