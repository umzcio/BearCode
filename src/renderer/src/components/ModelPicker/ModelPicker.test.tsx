// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
import { useAppStore } from '../../state/store'

afterEach(() => {
  cleanup()
})

const usableProvider = {
  id: 'anthropic',
  displayName: 'Anthropic',
  color: '#d97757',
  requiresKey: true,
  keyConfigured: true,
  reachable: true,
  models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]
}

describe('ModelPicker — Ursa entry', () => {
  it('shows a disabled Ursa row with an "enable" hint when ursaEnabled is false', () => {
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursaEnabled: false } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursaRow = screen.getByText('Ursa').closest('[role="option"]')
    expect(ursaRow?.className).toContain('disabled')
    expect(screen.getByText(/enable ursa in settings/i)).toBeInTheDocument()
  })

  it('shows a disabled Ursa row with an "add a key" hint when enabled but no provider is usable', () => {
    useAppStore.setState({
      providers: [] as never,
      modelRef: null,
      settings: { ursaEnabled: true } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursaRow = screen.getByText('Ursa').closest('[role="option"]')
    expect(ursaRow?.className).toContain('disabled')
    expect(screen.getByText(/add an api key/i)).toBeInTheDocument()
  })

  it('is selectable when enabled and at least one provider is usable, and selecting it sets modelRef to the sentinel', () => {
    const selectModel = vi.fn()
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursaEnabled: true } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Ursa'))
    expect(selectModel).toHaveBeenCalledWith('ursa/auto')
  })

  it('seeds the roving highlight on the Ursa row (not a fallback-0 match) when modelRef is the sentinel', () => {
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: 'ursa/auto',
      settings: { ursaEnabled: true } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const listbox = screen.getByRole('listbox')
    expect(listbox.getAttribute('aria-activedescendant')).toBe('opt-model-ursa')
    const ursaRow = listbox.querySelector('#opt-model-ursa')
    expect(ursaRow?.className).toContain('active')
  })

  it('still seeds the highlight on a concrete model row (not index 0) when modelRef is a real model', () => {
    const secondProvider = {
      ...usableProvider,
      id: 'openai',
      displayName: 'OpenAI',
      models: [{ id: 'gpt-5', label: 'GPT-5' }]
    }
    useAppStore.setState({
      providers: [usableProvider, secondProvider] as never,
      modelRef: 'openai/gpt-5',
      settings: { ursaEnabled: false } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const listbox = screen.getByRole('listbox')
    expect(listbox.getAttribute('aria-activedescendant')).toBe('opt-model-openai/gpt-5')
    const modelRow = listbox.querySelector('#opt-model-openai\\/gpt-5')
    expect(modelRow?.className).toContain('active')
  })
})

describe('ModelPicker — Ursus entry', () => {
  it('shows a disabled Ursus row with an "enable" hint when ursusEnabled is false', () => {
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursusEnabled: false } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursusRow = screen.getByText('Ursus').closest('[role="option"]')
    expect(ursusRow?.className).toContain('disabled')
    expect(screen.getByText(/enable ursus in settings/i)).toBeInTheDocument()
  })

  it('shows a disabled Ursus row with an "add openrouter key or run ollama" hint when enabled but neither is usable', () => {
    useAppStore.setState({
      providers: [] as never,
      modelRef: null,
      settings: { ursusEnabled: true } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursusRow = screen.getByText('Ursus').closest('[role="option"]')
    expect(ursusRow?.className).toContain('disabled')
    expect(screen.getByText(/add an openrouter key or run ollama/i)).toBeInTheDocument()
  })

  it('is selectable when enabled and openrouter is usable, and selecting it sets modelRef to the sentinel', () => {
    const selectModel = vi.fn()
    const openrouterProvider = {
      id: 'openrouter',
      displayName: 'OpenRouter',
      color: '#b58cff',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: []
    }
    useAppStore.setState({
      providers: [openrouterProvider] as never,
      modelRef: null,
      settings: { ursusEnabled: true } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Ursus'))
    expect(selectModel).toHaveBeenCalledWith('ursus/auto')
  })

  it('is selectable when enabled and ollama alone is reachable (no openrouter key)', () => {
    const selectModel = vi.fn()
    const openrouterProvider = {
      id: 'openrouter',
      displayName: 'OpenRouter',
      color: '#b58cff',
      requiresKey: true,
      keyConfigured: false,
      reachable: true,
      models: []
    }
    const ollamaProvider = {
      id: 'ollama',
      displayName: 'Ollama',
      color: '#3ecf8e',
      requiresKey: false,
      keyConfigured: true,
      reachable: true,
      models: []
    }
    useAppStore.setState({
      providers: [openrouterProvider, ollamaProvider] as never,
      modelRef: null,
      settings: { ursusEnabled: true } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Ursus'))
    expect(selectModel).toHaveBeenCalledWith('ursus/auto')
  })

  it('seeds the roving highlight on the Ursus row when modelRef is the sentinel', () => {
    const openrouterProvider = {
      id: 'openrouter',
      displayName: 'OpenRouter',
      color: '#b58cff',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: []
    }
    useAppStore.setState({
      providers: [openrouterProvider] as never,
      modelRef: 'ursus/auto',
      settings: { ursusEnabled: true } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const listbox = screen.getByRole('listbox')
    expect(listbox.getAttribute('aria-activedescendant')).toBe('opt-model-ursus')
  })
})

describe('ModelPicker — closes on Settings open', () => {
  it('closes when Settings opens', () => {
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursaEnabled: false } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
    // useAppStore.setState alone doesn't synchronously flush the resulting
    // re-render under React 19 + RTL's automatic batching outside act() --
    // wrap it so the assertion below observes the post-close DOM.
    act(() => {
      useAppStore.setState({ settingsOpen: true })
    })
    expect(screen.queryByText('Claude Sonnet 5')).toBeNull()
  })
})
