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
    permissions: { list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] })) }
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
    expect(setSpy).toHaveBeenCalledWith({ defaultPermissionMode: 'auto' })
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
    // General page's intentional WIP placeholder.
    expect(screen.getByText('Profile & Custom Instructions')).toBeTruthy()
  })

  it('has no Account, Projects, or Conversations nav entries', () => {
    render(<SettingsModal />)
    expect(screen.queryByText('Account')).toBeNull()
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Conversations')).toBeNull()
  })

  it('routes: Providers shows a key input, Models does not', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Providers'))
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
    fireEvent.click(screen.getByText('Models'))
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull()
  })

  it('each Customize tab shows an intentional placeholder', () => {
    render(<SettingsModal />)
    for (const label of ['Skills', 'Connectors', 'Memory', 'Integrations', 'Browser']) {
      fireEvent.click(screen.getByText(label))
      expect(document.querySelector('.coming-block')).toBeTruthy()
    }
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
  it('shows the data Location, a Delete-all control, and the profile placeholder', () => {
    render(<GeneralPage />)
    // Data card: the storage location (from settings.dataPath)
    expect(screen.getByText('/tmp/data')).toBeTruthy()
    // Delete All conversations control
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy()
    // Intentional WIP placeholder for the account/profile content
    expect(screen.getByText('Profile & Custom Instructions')).toBeTruthy()
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
      pricing: { sync: syncSpy }
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
