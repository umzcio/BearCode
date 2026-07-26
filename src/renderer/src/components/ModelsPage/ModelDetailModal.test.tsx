// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelDetailModal } from './ModelDetailModal'

afterEach(cleanup)

const baseState = {
  manageableModels: [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      models: [
        {
          id: 'claude-sonnet-5',
          label: 'Claude Sonnet 5',
          contextWindow: 1_000_000,
          custom: false,
          enabled: true
        }
      ]
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      color: '#9ad0b7',
      models: [{ id: 'my-custom', label: 'My Custom', custom: true, enabled: false }]
    }
  ],
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
      keyConfigured: true,
      reachable: true,
      models: []
    }
  ],
  settings: {
    modelPricing: { 'anthropic/claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 } },
    modelMetadata: {
      'anthropic/claude-sonnet-5': {
        mode: 'chat' as const,
        maxOutputTokens: 8000,
        capabilities: {
          functionCalling: true,
          vision: false,
          responseSchema: false,
          reasoning: false,
          webSearch: false
        }
      }
    },
    favoriteModels: []
  }
}

describe('ModelDetailModal', () => {
  it('renders name, vendor, price, and an "on" capability', () => {
    useAppStore.setState(baseState as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText(/\$3 in.*\$15 out/)).toBeTruthy()
    expect(document.querySelector('.mdp-cap.on')).toBeTruthy()
  })

  it('shows "Capabilities unknown" for a model with no LiteLLM metadata', () => {
    useAppStore.setState(baseState as never)
    render(<ModelDetailModal modelRef="openai/my-custom" onClose={vi.fn()} />)
    expect(screen.getByText(/Capabilities unknown/)).toBeTruthy()
  })

  it('toggles enabled via the header switch', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ ...baseState, setModelEnabled } as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch', { name: /Claude Sonnet 5 enabled/i }))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-sonnet-5', false)
  })

  it('only shows the ⋮ menu for a custom model, offering Remove', () => {
    useAppStore.setState(baseState as never)
    const { rerender } = render(
      <ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />
    )
    expect(screen.queryByLabelText('More actions')).toBeNull()
    rerender(<ModelDetailModal modelRef="openai/my-custom" onClose={vi.fn()} />)
    expect(screen.getByLabelText('More actions')).toBeTruthy()
  })

  it('removes a custom model via the ⋮ menu and closes', () => {
    const removeCustomModel = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    useAppStore.setState({ ...baseState, removeCustomModel } as never)
    render(<ModelDetailModal modelRef="openai/my-custom" onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.click(screen.getByText('Remove custom model'))
    expect(removeCustomModel).toHaveBeenCalledWith('openai', 'my-custom')
    expect(onClose).toHaveBeenCalled()
  })

  it('toggles favorite via saveSettings', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ ...baseState, saveSettings } as never)
    render(<ModelDetailModal modelRef="anthropic/claude-sonnet-5" onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Favorite'))
    expect(saveSettings).toHaveBeenCalledWith({ favoriteModels: ['anthropic/claude-sonnet-5'] })
  })
})
