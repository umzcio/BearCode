// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UrsaPage } from './UrsaPage'
import { useAppStore } from '../../../state/store'

const requiredProvidersSpy = vi.fn(() => Promise.resolve(['anthropic', 'openai']))
const saveSettings = vi.fn().mockResolvedValue(undefined)

function mount(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    ursa: { requiredProviders: requiredProvidersSpy }
  }
  useAppStore.setState({
    settings: { ursaEnabled: false, ...overrides } as never,
    providers: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        requiresKey: true,
        keyConfigured: true,
        reachable: true,
        models: []
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        color: '#9ad0b7',
        requiresKey: true,
        keyConfigured: false,
        reachable: true,
        models: []
      }
    ] as never,
    saveSettings
  })
  render(<UrsaPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  requiredProvidersSpy.mockClear()
  saveSettings.mockClear()
})

describe('UrsaPage', () => {
  it('has no role-management UI (Ursa is not user-configurable)', () => {
    mount()
    expect(screen.queryByText('Add role')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Role name')).not.toBeInTheDocument()
    expect(screen.queryByText('Guardrails')).not.toBeInTheDocument()
  })

  it('toggling Enable Ursa saves ursaEnabled', () => {
    mount({ ursaEnabled: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Ursa' }))
    expect(saveSettings).toHaveBeenCalledWith({ ursaEnabled: true })
  })

  it('reflects the toggle state from settings', () => {
    mount({ ursaEnabled: true })
    expect(screen.getByRole('switch', { name: 'Enable Ursa' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('shows a read-only key-configured status per provider Ursa depends on', async () => {
    mount()
    await waitFor(() => expect(requiredProvidersSpy).toHaveBeenCalled())
    expect(await screen.findByText('Anthropic')).toBeInTheDocument()
    expect(await screen.findByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('API key configured')).toBeInTheDocument()
    expect(screen.getByText('No API key configured')).toBeInTheDocument()
  })

  it('hides the custom-instructions textarea when Ursa is disabled', () => {
    mount({ ursaEnabled: false })
    expect(screen.queryByText('Custom Instructions')).not.toBeInTheDocument()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('shows the custom-instructions textarea when Ursa is enabled, seeded from settings', () => {
    mount({ ursaEnabled: true, ursaInstructions: 'route quick questions to the fast model' })
    expect(screen.getByText('Custom Instructions')).toBeInTheDocument()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe('route quick questions to the fast model')
  })

  it('saves ursaInstructions on blur when the value changed', () => {
    mount({ ursaEnabled: true, ursaInstructions: '' })
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'prefer the coder' } })
    fireEvent.blur(textarea)
    expect(saveSettings).toHaveBeenCalledWith({ ursaInstructions: 'prefer the coder' })
  })

  it('does not save on blur when the textarea value is unchanged', () => {
    mount({ ursaEnabled: true, ursaInstructions: 'keep me' })
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.blur(textarea)
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
