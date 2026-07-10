// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BrowseSmitheryModal } from './BrowseSmitheryModal'

const searchSpy = vi.fn()
const installSpy = vi.fn()
const setSecretSpy = vi.fn(() => Promise.resolve())
const onClose = vi.fn()
const onInstalled = vi.fn()

function mount(): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    mcp: {
      smitherySearch: searchSpy,
      smitheryInstall: installSpy,
      setSecret: setSecretSpy
    }
  }
  render(
    <BrowseSmitheryModal projectPath="/tmp/proj" onClose={onClose} onInstalled={onInstalled} />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BrowseSmitheryModal', () => {
  it('shows the Smithery-key empty state when search rejects with the key-missing error', async () => {
    searchSpy.mockRejectedValue(
      new Error('No Smithery API key configured (vault key "smithery:apiKey")')
    )
    mount()
    fireEvent.change(screen.getByPlaceholderText('Search Smithery servers…'), {
      target: { value: 'exa' }
    })
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(screen.getByText(/add a Smithery API key/i)).toBeTruthy())
    expect(screen.getByText(/Providers/)).toBeTruthy()
  })

  it('lists SmitheryHits for a typed query', async () => {
    searchSpy.mockResolvedValue([
      {
        id: 'exa-labs/exa-mcp',
        name: 'Exa Search',
        description: 'Web search for AI',
        transport: 'http'
      },
      { id: 'some/local-tool', name: 'Local Tool', description: 'A stdio tool', transport: 'stdio' }
    ])
    mount()
    fireEvent.change(screen.getByPlaceholderText('Search Smithery servers…'), {
      target: { value: 'exa' }
    })
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(screen.getByText('Exa Search')).toBeTruthy())
    expect(screen.getByText('Web search for AI')).toBeTruthy()
    expect(screen.getByText('Local Tool')).toBeTruthy()
    expect(searchSpy).toHaveBeenCalledWith('exa')
  })

  it('prompts for required secrets after install and writes each via mcp.setSecret', async () => {
    searchSpy.mockResolvedValue([
      {
        id: 'exa-labs/exa-mcp',
        name: 'Exa Search',
        description: 'Web search for AI',
        transport: 'http'
      }
    ])
    // Install returns a config carrying an unfilled ${VAULT:} placeholder --
    // exactly what fetchSmitheryConfig writes for a required config field.
    installSpy.mockResolvedValue({
      config: {
        name: 'exa-labs/exa-mcp',
        transport: 'http',
        url: 'https://mcp.exa.ai',
        headers: { exaApiKey: '${VAULT:mcp:exa-labs/exa-mcp:headers:exaApiKey}' },
        source: 'global'
      },
      enabled: false,
      status: { state: 'untrusted' },
      spawnConsented: false
    })
    mount()
    fireEvent.change(screen.getByPlaceholderText('Search Smithery servers…'), {
      target: { value: 'exa' }
    })
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(screen.getByText('Exa Search')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    // A secret-entry step appears instead of closing immediately.
    await waitFor(() => expect(screen.getByText('exaApiKey')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Enter value'), {
      target: { value: 'secret-token' }
    })
    fireEvent.click(screen.getByText('Save & finish'))

    await waitFor(() =>
      expect(setSecretSpy).toHaveBeenCalledWith(
        'mcp:exa-labs/exa-mcp:headers:exaApiKey',
        'secret-token'
      )
    )
    await waitFor(() => expect(onInstalled).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('clicking Install calls smitheryInstall(id, projectPath) and closes on success', async () => {
    searchSpy.mockResolvedValue([
      {
        id: 'exa-labs/exa-mcp',
        name: 'Exa Search',
        description: 'Web search for AI',
        transport: 'http'
      }
    ])
    installSpy.mockResolvedValue({
      config: { name: 'exa-labs/exa-mcp', transport: 'http', url: 'https://x', source: 'global' },
      enabled: false,
      status: { state: 'disabled' },
      spawnConsented: false
    })
    mount()
    fireEvent.change(screen.getByPlaceholderText('Search Smithery servers…'), {
      target: { value: 'exa' }
    })
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(screen.getByText('Exa Search')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith('exa-labs/exa-mcp', '/tmp/proj'))
    await waitFor(() => expect(onInstalled).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
