// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SettingsModal } from './SettingsModal'
import { ProvidersPage } from './pages/ProvidersPage'
import { GeneralPage } from './pages/GeneralPage'

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
    render(<SettingsModal />) // 'models' is the default page
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull()
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
    render(<SettingsModal />) // 'models' is the default page
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

    render(<SettingsModal />) // 'models' is the default page

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
