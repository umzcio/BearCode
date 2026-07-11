// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SettingsModal } from './SettingsModal'
import { ProvidersPage } from './pages/ProvidersPage'
import { GeneralPage } from './pages/GeneralPage'
import { FEEDBACK_URL } from './SettingsNav'

const settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModelRef: null,
  defaultPermissionMode: 'accept-edits',
  disabledBuiltins: [],
  artifactReviewPolicy: 'request-review',
  dataPath: '/tmp/data'
}

const setSpy = vi.fn((patch: Record<string, unknown>) => Promise.resolve({ ...settings, ...patch }))

beforeEach(() => {
  // jsdom does not implement matchMedia; RoarBear (in the General placeholder) reads it.
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false })
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    permissions: { list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] })) },
    models: {
      list: vi.fn(() => Promise.resolve([])),
      manageable: vi.fn(() => Promise.resolve([]))
    },
    browser: {
      status: vi.fn(() =>
        Promise.resolve({ installed: false, connected: false, conversationId: null })
      ),
      clearSession: vi.fn(() => Promise.resolve())
    },
    mcp: {
      list: vi.fn(() => Promise.resolve([])),
      ensureConnected: vi.fn(() => Promise.resolve([])),
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      setEnabled: vi.fn(() => Promise.resolve({ state: 'disabled' })),
      trust: vi.fn(() => Promise.resolve({ state: 'disabled' })),
      spawnConsent: vi.fn(() => Promise.resolve()),
      reconnect: vi.fn(() => Promise.resolve({ state: 'disabled' })),
      status: vi.fn(() => Promise.resolve({ state: 'disabled' })),
      setSecret: vi.fn(() => Promise.resolve()),
      smitherySearch: vi.fn(() => Promise.resolve([])),
      smitheryInstall: vi.fn()
    },
    integrations: {
      status: vi.fn(() => Promise.resolve([])),
      githubDeviceStart: vi.fn(),
      githubDevicePoll: vi.fn(),
      githubConnectPat: vi.fn(),
      connectBitbucket: vi.fn(),
      disconnect: vi.fn(() => Promise.resolve())
    },
    skills: {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      setEnabled: vi.fn(() => Promise.resolve()),
      save: vi.fn()
    },
    memory: {
      list: vi.fn(() =>
        Promise.resolve({
          global: { entries: [], sizeBytes: 0 },
          project: { entries: [], sizeBytes: 0 }
        })
      ),
      add: vi.fn(() => Promise.resolve('ok')),
      update: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve())
    }
  }
  useAppStore.setState({
    settingsOpen: true,
    settings: settings as never,
    providers: [],
    conversations: {}
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SettingsModal default permission mode', () => {
  it('offers the four selectable modes (never Bypass) and saves the pick', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Permissions')) // rail nav to the Permissions page
    fireEvent.click(screen.getByLabelText('Default permission mode')) // open the custom dropdown
    // role="option" matches only the menu items (not the trigger). Each item's
    // text is "Label✓" (the always-rendered check span), so strip it.
    const options = screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))
    expect(options).toEqual(['Ask permissions', 'Accept edits', 'Plan mode', 'Auto mode'])
    const auto = screen.getAllByRole('option').find((o) => o.textContent?.includes('Auto mode'))
    fireEvent.click(auto as HTMLElement)
    // F8: saving the default mode also carries the re-derived security preset.
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ defaultPermissionMode: 'auto' }))
  })
})

describe('SettingsModal Providers split', () => {
  it('Providers page shows the API-key inputs and the Ollama URL field', () => {
    render(<ProvidersPage />)
    // Anthropic key input (unconfigured → its placeholder shows)
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
    // Ollama base URL field
    expect(screen.getByPlaceholderText('http://localhost:11434')).toBeTruthy()
  })

  it('Models page no longer shows the API-key inputs', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Models'))
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull()
  })
})

describe('SettingsModal shell — grouped nav, routing, feedback', () => {
  const rail = (): HTMLElement => document.querySelector('.settings-rail') as HTMLElement

  it('renders both group labels, every item label, and the pinned footer', () => {
    render(<SettingsModal />)
    const nav = within(rail())
    expect(nav.getByText('Settings')).toBeTruthy()
    expect(nav.getByText('Customize')).toBeTruthy()
    for (const label of [
      'General',
      'Permissions',
      'Appearance',
      'Providers',
      'Models',
      'Skills',
      'Connectors',
      'Memory',
      'Integrations',
      'Browser'
    ]) {
      expect(nav.getByText(label)).toBeTruthy()
    }
    expect(nav.getByText('Shortcuts')).toBeTruthy()
    expect(nav.getByText('Provide Feedback')).toBeTruthy()
  })

  it('defaults to the General page', () => {
    render(<SettingsModal />)
    // General page shows the Profile + Custom Instructions sections.
    expect(screen.getByText('Custom Instructions')).toBeTruthy()
    expect(screen.getByPlaceholderText('Your name')).toBeTruthy()
  })

  it('has no Account, Projects, or Conversations nav entries', () => {
    render(<SettingsModal />)
    expect(screen.queryByText('Account')).toBeNull()
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Conversations')).toBeNull()
  })

  it('portals the dropdown menu outside .app-select so it is not clipped', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Permissions'))
    fireEvent.click(screen.getByLabelText('Default permission mode'))
    const option = screen.getAllByRole('option')[0]
    // Menu is portaled to <body>, so options are NOT inside the trigger wrapper.
    expect(option.closest('.app-select')).toBeNull()
  })

  it('routes: Providers shows a key input, Models does not', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Providers'))
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
    fireEvent.click(screen.getByText('Models'))
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull()
  })

  it('opens directly on the Providers page when openSettings targets it (missing-key flow)', () => {
    useAppStore.setState({ settingsInitialPage: 'providers' })
    render(<SettingsModal />)
    // Lands on Providers (API-key input visible) without any nav click.
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
  })

  it('the Memory tab renders the real Memory page (not a placeholder)', () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Memory'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(document.querySelector('.page-title')?.textContent).toBe('Memory')
  })

  it('the Skills tab renders the real Skills page (not a placeholder)', () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Skills'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(document.querySelector('.page-title')?.textContent).toBe('Skills')
  })

  it('the Browser tab renders the real Browser page (not a placeholder)', () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Browser'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(screen.getByRole('switch', { name: /enable browser/i })).toBeTruthy()
  })

  it('the Connectors tab renders the real Connectors page (not a placeholder)', () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Connectors'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(screen.getByRole('switch', { name: /enable connectors/i })).toBeTruthy()
  })

  it('the Integrations tab renders the real Integrations page (not a placeholder)', () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Integrations'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(screen.getByRole('button', { name: /connect github/i })).toBeTruthy()
  })

  it('never renders the text "coming soon"', () => {
    render(<SettingsModal />)
    const labels = [
      'General',
      'Permissions',
      'Appearance',
      'Providers',
      'Models',
      'Skills',
      'Connectors',
      'Memory',
      'Integrations',
      'Browser',
      'Shortcuts'
    ]
    for (const label of labels) {
      fireEvent.click(within(rail()).getByText(label))
      expect(screen.queryByText(/coming soon/i)).toBeNull()
    }
  })

  it('Provide Feedback opens the feedback URL via window.open', () => {
    const openSpy = vi.fn()
    ;(window as unknown as { open: unknown }).open = openSpy
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Provide Feedback'))
    fireEvent.click(screen.getByRole('button', { name: /github/i }))
    expect(openSpy).toHaveBeenCalledWith(FEEDBACK_URL, '_blank')
  })
})

describe('SettingsModal General page', () => {
  it('shows the Profile fields, Custom Instructions, the data Location, and Delete-all', () => {
    render(<GeneralPage />)
    // Profile fields
    expect(screen.getByPlaceholderText('Your name')).toBeTruthy()
    expect(screen.getByPlaceholderText('e.g. Ursa')).toBeTruthy()
    // Custom Instructions section
    expect(screen.getByText('Custom Instructions')).toBeTruthy()
    // Data card: the storage location (from settings.dataPath)
    expect(screen.getByText('/tmp/data')).toBeTruthy()
    // Delete All conversations control
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
  })

  it('saves a profile field on blur, and not when unchanged', () => {
    render(<GeneralPage />)
    const name = screen.getByPlaceholderText('Your name')
    // Blur with no change → no save (change-detection guard).
    fireEvent.blur(name)
    expect(setSpy).not.toHaveBeenCalled()
    // Change + blur → persists via saveSettings.
    fireEvent.change(name, { target: { value: 'Ursa' } })
    fireEvent.blur(name)
    expect(setSpy).toHaveBeenCalledWith({ profileName: 'Ursa' })
  })
})

describe('SettingsModal Voice input', () => {
  it('renders the STT backend picker and saves the pick', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Models'))
    fireEvent.click(screen.getByLabelText('Speech-to-text backend')) // open the custom dropdown
    const options = screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))
    expect(options).toEqual(['OpenAI Whisper (uses your OpenAI key)', 'Local (offline)'])
    const local = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('Local (offline)'))
    fireEvent.click(local as HTMLElement)
    expect(setSpy).toHaveBeenCalledWith({ sttBackend: 'local' })
  })
})

describe('SettingsModal Model Pricing', () => {
  const providers = [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#c96',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }]
    },
    {
      id: 'ollama',
      displayName: 'Ollama',
      color: '#888',
      requiresKey: false,
      keyConfigured: false,
      reachable: true,
      models: [{ id: 'llama3', label: 'Llama 3' }]
    }
  ]

  it('renders a priced row per model with source, and Sync updates the result line', async () => {
    const syncResult = { syncedCount: 2, unmatched: ['openai/gpt-x'], syncedAt: 1_700_000_000_000 }
    const syncSpy = vi.fn(() => Promise.resolve(syncResult))
    const getSpy = vi.fn(() =>
      Promise.resolve({ ...settings, modelPricingSyncedAt: syncResult.syncedAt } as never)
    )
    ;(window as unknown as { bearcode: unknown }).bearcode = {
      settings: { set: setSpy, get: getSpy },
      permissions: { list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] })) },
      pricing: { sync: syncSpy },
      models: {
        list: vi.fn(() => Promise.resolve([])),
        manageable: vi.fn(() => Promise.resolve([]))
      }
    }
    useAppStore.setState({
      settingsOpen: true,
      settings: settings as never,
      providers: providers as never,
      conversations: {}
    })

    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Models'))

    expect(screen.getByText('Model Pricing')).toBeTruthy()
    // Bundled-priced model shows a price + the "default" source tag.
    expect(screen.getByText('Anthropic: Opus 4.8')).toBeTruthy()
    expect(screen.getByText('$5')).toBeTruthy()
    expect(screen.getByText('$25')).toBeTruthy()
    // Unpriced (Ollama) model still appears.
    expect(screen.getByText('Ollama: Llama 3')).toBeTruthy()
    // No sync yet → bundled defaults notice.
    expect(screen.getByText(/bundled defaults/i)).toBeTruthy()

    const btn = screen.getByRole('button', { name: /sync prices/i })
    fireEvent.click(btn)
    expect(syncSpy).toHaveBeenCalled()
    await screen.findByText(/2 synced/)
    expect(screen.getByText(/1 unmatched/)).toBeTruthy()
  })
})
