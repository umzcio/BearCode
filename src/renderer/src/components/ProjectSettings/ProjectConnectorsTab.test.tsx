// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectConnectorsTab } from './ProjectConnectorsTab'

const projectServer = {
  config: { name: 'proj-server', transport: 'http' as const, url: 'https://x', source: 'project' as const },
  enabled: true,
  status: { state: 'disabled' as const },
  spawnConsented: false
}
const globalServer = {
  config: { name: 'global-server', transport: 'http' as const, url: 'https://y', source: 'global' as const },
  enabled: true,
  status: { state: 'disabled' as const },
  spawnConsented: false
}
const untrustedServer = {
  config: { name: 'untrusted-server', transport: 'stdio' as const, command: 'npx', args: ['x'], source: 'project' as const },
  enabled: false,
  status: { state: 'untrusted' as const },
  spawnConsented: false
}

const listSpy = vi.fn(() => Promise.resolve([projectServer, globalServer, untrustedServer]))
const addSpy = vi.fn(() => Promise.resolve())
const setEnabledConfigOnlySpy = vi.fn(() => Promise.resolve())
const trustSpy = vi.fn(() => Promise.resolve({ state: 'disabled' }))
const removeSpy = vi.fn(() => Promise.resolve())
const ensureConnectedSpy = vi.fn(() => Promise.resolve([]))
const setEnabledSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))
const reconnectSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))
const authorizeSpy = vi.fn(() => Promise.resolve({ state: 'connected', tools: [] }))

function mount(): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    mcp: {
      list: listSpy,
      add: addSpy,
      setEnabledConfigOnly: setEnabledConfigOnlySpy,
      trust: trustSpy,
      remove: removeSpy,
      ensureConnected: ensureConnectedSpy,
      setEnabled: setEnabledSpy,
      reconnect: reconnectSpy,
      authorize: authorizeSpy
    }
  }
  render(<ProjectConnectorsTab projectPath="/proj" />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectConnectorsTab', () => {
  it('calls list (not ensureConnected) on mount, scoped to the project path', async () => {
    mount()
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('/proj'))
    expect(ensureConnectedSpy).not.toHaveBeenCalled()
  })

  it('shows only project-scoped servers, never global ones', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('proj-server')).toBeInTheDocument())
    expect(screen.queryByText('global-server')).not.toBeInTheDocument()
  })

  it('shows Trust for an untrusted server and calls mcp.trust on click', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('untrusted-server')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Trust'))
    expect(trustSpy).toHaveBeenCalledWith('untrusted-server', '/proj')
  })

  it('toggling enabled calls setEnabledConfigOnly, never the live setEnabled', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('proj-server')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('switch', { name: 'Enable proj-server' }))
    expect(setEnabledConfigOnlySpy).toHaveBeenCalledWith('proj-server', false)
    expect(setEnabledSpy).not.toHaveBeenCalled()
  })

  it('never shows live-connect affordances (Reconnect/Sign in/Expand)', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('proj-server')).toBeInTheDocument())
    expect(screen.queryByText('Reconnect')).not.toBeInTheDocument()
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument()
    expect(screen.queryByText('Expand')).not.toBeInTheDocument()
  })

  it('adding a server always uses source: project and calls mcp.add with the project path', async () => {
    mount()
    await waitFor(() => expect(screen.getByPlaceholderText('Server name')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'new-one' } })
    fireEvent.change(screen.getByPlaceholderText('https://server.example/mcp'), {
      target: { value: 'https://new' }
    })
    fireEvent.click(screen.getByText('Add server'))
    await waitFor(() =>
      expect(addSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'new-one', source: 'project' }),
        '/proj'
      )
    )
  })

  it('shows an empty state when there are no project servers', async () => {
    listSpy.mockResolvedValueOnce([globalServer])
    mount()
    await waitFor(() => expect(screen.getByText(/no servers yet/i)).toBeInTheDocument())
  })
})
