// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SettingsModal } from './SettingsModal'
import { ProvidersPage } from './pages/ProvidersPage'
import { GeneralPage } from './pages/GeneralPage'
import { FEEDBACK_URL } from './SettingsNav'

const settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaInstances: [{ id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }],
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
    compatSetKey: vi.fn(() => Promise.resolve()),
    compatKeyStatus: vi.fn(() => Promise.resolve({})),
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
})

describe('SettingsModal Ollama instances', () => {
  const twoInstances = [
    { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
    { id: 'gpu-box', name: 'GPU Box', baseUrl: 'http://192.168.1.10:11434' }
  ]
  const withInstances = (instances: typeof twoInstances): void => {
    useAppStore.setState({
      settings: { ...settings, ollamaInstances: instances } as never
    })
  }

  it('lists each configured instance with its name, URL, and the primary tag', () => {
    withInstances(twoInstances)
    render(<ProvidersPage />)
    expect(screen.getByText('Local')).toBeTruthy()
    expect(screen.getByText('GPU Box')).toBeTruthy()
    expect(screen.getByText('http://192.168.1.10:11434')).toBeTruthy()
    // First entry is labeled as the primary (only shown with 2+ instances).
    expect(screen.getByText('Primary')).toBeTruthy()
  })

  it('adds a server from the add row, deriving a kebab id from the name', () => {
    render(<ProvidersPage />)
    fireEvent.change(screen.getByLabelText('New server name'), { target: { value: 'GPU Box' } })
    fireEvent.change(screen.getByLabelText('New server URL'), {
      target: { value: 'http://192.168.1.10:11434' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(setSpy).toHaveBeenCalledWith({
      ollamaInstances: [
        { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
        { id: 'gpu-box', name: 'GPU Box', baseUrl: 'http://192.168.1.10:11434' }
      ]
    })
  })

  it('blocks Add with a visible hint when the URL is not a valid http(s) URL', () => {
    render(<ProvidersPage />)
    fireEvent.change(screen.getByLabelText('New server name'), { target: { value: 'GPU Box' } })
    fireEvent.change(screen.getByLabelText('New server URL'), { target: { value: 'not-a-url' } })
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/valid http\(s\) URL/)).toBeTruthy()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('edits a server URL inline, keeping its id and name', () => {
    render(<ProvidersPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Local' }))
    fireEvent.change(screen.getByLabelText('Edit server URL'), {
      target: { value: 'http://localhost:11435' }
    })
    const editRow = screen.getByLabelText('Edit server URL').closest('.key-row') as HTMLElement
    fireEvent.click(within(editRow).getByRole('button', { name: 'Save' }))
    expect(setSpy).toHaveBeenCalledWith({
      ollamaInstances: [{ id: 'local', name: 'Local', baseUrl: 'http://localhost:11435' }]
    })
  })

  it('removing the primary promotes the next server (it becomes the first entry)', () => {
    withInstances(twoInstances)
    render(<ProvidersPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Local' }))
    expect(setSpy).toHaveBeenCalledWith({
      ollamaInstances: [{ id: 'gpu-box', name: 'GPU Box', baseUrl: 'http://192.168.1.10:11434' }]
    })
  })

  it('removing the last server sends an empty list (main resets to the default local instance)', () => {
    render(<ProvidersPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Local' }))
    expect(setSpy).toHaveBeenCalledWith({ ollamaInstances: [] })
  })
})

describe('SettingsModal compat endpoints (OpenAI-compatible servers)', () => {
  const oneEndpoint = [{ id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' }]
  const withEndpoints = (endpoints: typeof oneEndpoint): void => {
    useAppStore.setState({
      settings: { ...settings, compatEndpoints: endpoints } as never
    })
  }
  const compatMocks = (): {
    setKey: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
  } => {
    const b = (
      window as unknown as {
        bearcode: { compatSetKey: unknown; compatKeyStatus: unknown }
      }
    ).bearcode
    return {
      setKey: b.compatSetKey as ReturnType<typeof vi.fn>,
      status: b.compatKeyStatus as ReturnType<typeof vi.fn>
    }
  }

  it('renders the card (with just the add row) when no endpoints are configured, fetching key status on mount', () => {
    render(<ProvidersPage />)
    expect(screen.getByText('OpenAI-Compatible Servers')).toBeTruthy()
    expect(screen.getByLabelText('New endpoint name')).toBeTruthy()
    expect(compatMocks().status).toHaveBeenCalled()
  })

  it('adds an endpoint without a key, deriving a kebab id from the name', () => {
    render(<ProvidersPage />)
    fireEvent.change(screen.getByLabelText('New endpoint name'), { target: { value: 'vLLM' } })
    fireEvent.change(screen.getByLabelText('New endpoint URL'), {
      target: { value: 'http://localhost:8000/v1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect(setSpy).toHaveBeenCalledWith({
      compatEndpoints: [{ id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' }]
    })
    expect(compatMocks().setKey).not.toHaveBeenCalled()
  })

  it('adds an endpoint with an optional API key, written to the vault under the new id', () => {
    render(<ProvidersPage />)
    fireEvent.change(screen.getByLabelText('New endpoint name'), { target: { value: 'LM Studio' } })
    fireEvent.change(screen.getByLabelText('New endpoint URL'), {
      target: { value: 'http://localhost:1234/v1' }
    })
    fireEvent.change(screen.getByLabelText('New endpoint API key'), {
      target: { value: 'secret-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect(setSpy).toHaveBeenCalledWith({
      compatEndpoints: [{ id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' }]
    })
    expect(compatMocks().setKey).toHaveBeenCalledWith('lm-studio', 'secret-key')
  })

  it('shows the Configured indicator from compatKeyStatus (booleans only, keys never come back)', async () => {
    withEndpoints(oneEndpoint)
    compatMocks().status.mockResolvedValue({ vllm: true })
    render(<ProvidersPage />)
    // Placeholder flips once the async status fetch resolves.
    expect(await screen.findByPlaceholderText('Configured')).toBeTruthy()
    expect(screen.getByTitle('API key configured')).toBeTruthy()
  })

  it('saves a per-endpoint key write-only and refetches status', async () => {
    withEndpoints(oneEndpoint)
    render(<ProvidersPage />)
    const keyInput = screen.getByLabelText('API key for vLLM')
    fireEvent.change(keyInput, { target: { value: 'sk-local' } })
    const row = keyInput.closest('.key-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(compatMocks().setKey).toHaveBeenCalledWith('vllm', 'sk-local')
    // Mount fetch + post-save refetch (chained off the setKey promise).
    await waitFor(() => expect(compatMocks().status.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('removing an endpoint clears its vault key (empty string) and promotes the next one', () => {
    withEndpoints([
      ...oneEndpoint,
      { id: 'tabby', name: 'TabbyAPI', baseUrl: 'http://localhost:5000/v1' }
    ])
    render(<ProvidersPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove vLLM' }))
    expect(setSpy).toHaveBeenCalledWith({
      compatEndpoints: [{ id: 'tabby', name: 'TabbyAPI', baseUrl: 'http://localhost:5000/v1' }]
    })
    expect(compatMocks().setKey).toHaveBeenCalledWith('vllm', '')
  })

  it('blocks Add with a visible hint when the URL is not a valid http(s) URL', () => {
    render(<ProvidersPage />)
    fireEvent.change(screen.getByLabelText('New endpoint name'), { target: { value: 'vLLM' } })
    fireEvent.change(screen.getByLabelText('New endpoint URL'), { target: { value: 'not-a-url' } })
    expect(
      (screen.getByRole('button', { name: 'Add endpoint' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.getByText(/valid http\(s\) URL/)).toBeTruthy()
    expect(setSpy).not.toHaveBeenCalled()
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

  it('routes to Providers and shows a key input', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByText('Providers'))
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeTruthy()
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

  it('the Integrations tab renders the real Integrations page (not a placeholder)', async () => {
    render(<SettingsModal />)
    fireEvent.click(within(rail()).getByText('Integrations'))
    expect(document.querySelector('.coming-block')).toBeNull()
    expect(await screen.findByRole('button', { name: /connect github/i })).toBeTruthy()
  })

  it('never renders the text "coming soon"', () => {
    render(<SettingsModal />)
    const labels = [
      'General',
      'Permissions',
      'Appearance',
      'Providers',
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
    fireEvent.click(screen.getByText('Voice'))
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
