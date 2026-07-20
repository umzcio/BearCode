// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UrsusPage } from './UrsusPage'
import { useAppStore } from '../../../state/store'

const requiredProvidersSpy = vi.fn(() => Promise.resolve(['ollama', 'openrouter']))
const saveSettings = vi.fn().mockResolvedValue(undefined)

function mount(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    ursus: { requiredProviders: requiredProvidersSpy }
  }
  useAppStore.setState({
    settings: { ursusEnabled: false, ...overrides } as never,
    providers: [
      {
        id: 'openrouter',
        displayName: 'OpenRouter',
        color: '#b58cff',
        requiresKey: true,
        keyConfigured: true,
        reachable: true,
        models: []
      },
      {
        id: 'ollama',
        displayName: 'Ollama',
        color: '#3ecf8e',
        requiresKey: false,
        keyConfigured: true,
        reachable: false,
        models: []
      }
    ] as never,
    saveSettings
  })
  render(<UrsusPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  requiredProvidersSpy.mockClear()
  saveSettings.mockClear()
})

describe('UrsusPage', () => {
  it('has no role-management UI (Ursus is not user-configurable)', () => {
    mount()
    expect(screen.queryByText('Add role')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Role name')).not.toBeInTheDocument()
  })

  it('toggling Enable Ursus saves ursusEnabled', () => {
    mount({ ursusEnabled: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Ursus' }))
    expect(saveSettings).toHaveBeenCalledWith({ ursusEnabled: true })
  })

  it('reflects the toggle state from settings', () => {
    mount({ ursusEnabled: true })
    expect(screen.getByRole('switch', { name: 'Enable Ursus' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('shows OpenRouter status from keyConfigured and Ollama status from live reachable', async () => {
    mount()
    await waitFor(() => expect(requiredProvidersSpy).toHaveBeenCalled())
    expect(await screen.findByText('OpenRouter')).toBeInTheDocument()
    expect(screen.getByText('API key configured')).toBeInTheDocument()
    expect(await screen.findByText('Ollama')).toBeInTheDocument()
    expect(screen.getByText('Not reachable')).toBeInTheDocument()
  })

  it('hides the custom-instructions textarea when Ursus is disabled', () => {
    mount({ ursusEnabled: false })
    expect(screen.queryByText('Custom Instructions')).not.toBeInTheDocument()
  })

  it('shows the custom-instructions textarea when Ursus is enabled, seeded from settings', () => {
    mount({ ursusEnabled: true, ursusInstructions: 'prefer local models' })
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('prefer local models')
  })

  it('saves ursusInstructions on blur when the value changed', () => {
    mount({ ursusEnabled: true, ursusInstructions: '' })
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'route quick things to grunt' } })
    fireEvent.blur(textarea)
    expect(saveSettings).toHaveBeenCalledWith({ ursusInstructions: 'route quick things to grunt' })
  })
})
