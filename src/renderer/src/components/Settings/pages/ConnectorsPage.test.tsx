// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { ConnectorsPage } from './ConnectorsPage'

const baseSettings = {
  mcpEnabled: false,
  dataPath: '/tmp/data'
}

const setSpy = vi.fn((patch: Record<string, unknown>) =>
  Promise.resolve({ ...baseSettings, ...patch })
)

const listSpy = vi.fn(() =>
  Promise.resolve([
    {
      config: {
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example/github',
        source: 'global'
      },
      enabled: true,
      status: {
        state: 'connected',
        tools: [
          { name: 'get_issue', description: 'Fetch an issue', readOnlyHint: true },
          { name: 'create_issue', description: 'Create an issue', readOnlyHint: false }
        ]
      }
    }
  ])
)
const addSpy = vi.fn(() => Promise.resolve())
const setEnabledSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))
const trustSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))
const trustGlobalSpy = vi.fn(() => Promise.resolve({ state: 'disabled' }))
const spawnConsentSpy = vi.fn(() => Promise.resolve())
const reconnectSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))
const removeSpy = vi.fn(() => Promise.resolve())
const setSecretSpy = vi.fn(() => Promise.resolve())
const addRuleSpy = vi.fn(() => Promise.resolve())

function mount(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    mcp: {
      list: listSpy,
      add: addSpy,
      remove: removeSpy,
      setEnabled: setEnabledSpy,
      trust: trustSpy,
      trustGlobal: trustGlobalSpy,
      spawnConsent: spawnConsentSpy,
      reconnect: reconnectSpy,
      status: vi.fn(() => Promise.resolve({ state: 'connected', tools: [] })),
      setSecret: setSecretSpy,
      smitherySearch: vi.fn(() => Promise.resolve([])),
      smitheryInstall: vi.fn()
    },
    permissions: {
      addRule: addRuleSpy,
      list: vi.fn(() => Promise.resolve({ userRules: [], builtins: [] }))
    }
  }
  useAppStore.setState({
    settings: { ...baseSettings, ...overrides } as never,
    workspacePath: null,
    addPermissionRule: addRuleSpy as never
  })
  render(<ConnectorsPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  listSpy.mockResolvedValue([
    {
      config: {
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example/github',
        source: 'global'
      },
      enabled: true,
      status: {
        state: 'connected',
        tools: [
          { name: 'get_issue', description: 'Fetch an issue', readOnlyHint: true },
          { name: 'create_issue', description: 'Create an issue', readOnlyHint: false }
        ]
      }
    }
  ] as never)
})

describe('ConnectorsPage (Task 9)', () => {
  it('renders the page title', () => {
    mount()
    expect(screen.getByText('Connectors')).toBeTruthy()
  })

  it('renders a master enable toggle bound to settings.mcpEnabled', () => {
    mount()
    const toggle = screen.getByRole('switch', { name: /enable connectors/i })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('toggling the master enable persists { mcpEnabled: true }', () => {
    mount()
    fireEvent.click(screen.getByRole('switch', { name: /enable connectors/i }))
    expect(setSpy).toHaveBeenCalledWith({ mcpEnabled: true })
  })

  it('renders a server row per mcp.list() result with a status dot + tool count', async () => {
    mount({ mcpEnabled: true })
    await waitFor(() => expect(listSpy).toHaveBeenCalled())
    expect(await screen.findByText('github')).toBeTruthy()
    expect(screen.getByText(/2 tools/i)).toBeTruthy()
  })

  it('spawn-consent card shows the exact command AND args npx would execute', async () => {
    // The package npx downloads and runs is attacker-nameable for a Smithery
    // stdio install; the consent prompt must reveal it, not just "npx".
    listSpy.mockResolvedValue([
      {
        config: {
          name: 'evil/pkg',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'evil/pkg'],
          source: 'global'
        },
        enabled: false,
        status: { state: 'disabled' },
        spawnConsented: false
      }
    ] as never)
    mount({ mcpEnabled: true })
    await waitFor(() => expect(screen.getByText('evil/pkg')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: /enable evil\/pkg/i }))
    await waitFor(() => expect(screen.getByText(/npx -y evil\/pkg/)).toBeTruthy())
    // The command must NOT have been enabled just by revealing consent.
    expect(setEnabledSpy).not.toHaveBeenCalled()
  })

  it('trusting an untrusted global server calls trustGlobal (no project path needed)', async () => {
    listSpy.mockResolvedValue([
      {
        config: {
          name: 'exa-labs/exa-mcp',
          transport: 'http',
          url: 'https://mcp.exa.ai',
          source: 'global'
        },
        enabled: false,
        status: { state: 'untrusted' },
        spawnConsented: false
      }
    ] as never)
    mount({ mcpEnabled: true })
    await waitFor(() => expect(screen.getByText('exa-labs/exa-mcp')).toBeTruthy())
    fireEvent.click(screen.getByText('Trust'))
    await waitFor(() => expect(trustGlobalSpy).toHaveBeenCalledWith('exa-labs/exa-mcp'))
    expect(trustSpy).not.toHaveBeenCalled()
  })
})
