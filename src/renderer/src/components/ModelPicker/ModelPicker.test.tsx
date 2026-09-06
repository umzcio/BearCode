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
      settings: { favoriteModels: ['ursa/auto'], ursaEnabled: false } as never
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
      settings: { favoriteModels: ['ursa/auto'], ursaEnabled: true } as never
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
      settings: { favoriteModels: ['ursa/auto'], ursaEnabled: true } as never,
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
      settings: { favoriteModels: ['ursa/auto'], ursaEnabled: true } as never
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
      settings: { favoriteModels: ['openai/gpt-5'], ursaEnabled: false } as never
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
      settings: { favoriteModels: ['ursus/auto'], ursusEnabled: false } as never
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
      settings: { favoriteModels: ['ursus/auto'], ursusEnabled: true } as never
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
      settings: { favoriteModels: ['ursus/auto'], ursusEnabled: true } as never,
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
      settings: { favoriteModels: ['ursus/auto'], ursusEnabled: true } as never,
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
      settings: { favoriteModels: ['ursus/auto'], ursusEnabled: true } as never
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
    expect(screen.getByRole('listbox')).toBeTruthy()
    // useAppStore.setState alone doesn't synchronously flush the resulting
    // re-render under React 19 + RTL's automatic batching outside act() --
    // wrap it so the assertion below observes the post-close DOM.
    act(() => {
      useAppStore.setState({ settingsOpen: true })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('ModelPicker — favorites-first picker', () => {
  const twoProviders = [
    usableProvider,
    {
      id: 'xai',
      displayName: 'xAI',
      color: '#9aa0a6',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: [
        { id: 'grok-4.6', label: 'Grok 4.6' },
        { id: 'grok-4.5', label: 'Grok 4.5', contextWindow: 500_000 }
      ]
    }
  ]

  it('opens on Favorites listing exactly the starred refs — no Modes, no ride-along', () => {
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {} as never,
      settings: { ursaEnabled: false, favoriteModels: ['xai/grok-4.6'] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button', { name: /claude sonnet 5/i }))
    expect(screen.getByRole('tab', { name: /favorites/i }).className).toContain('on')
    // No always-pinned Modes section: sentinels appear only when starred.
    expect(screen.queryByText('Modes')).not.toBeInTheDocument()
    expect(screen.queryByText('Ursa')).not.toBeInTheDocument()
    expect(screen.getByText('Grok 4.6')).toBeInTheDocument()
    // The unstarred current model no longer rides along — the trigger button
    // is the only place its name appears.
    expect(screen.getAllByText('Claude Sonnet 5')).toHaveLength(1)
    expect(screen.queryByText('Grok 4.5')).not.toBeInTheDocument()
  })

  it('shows the teaching empty state when nothing is starred', () => {
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: null,
      conversations: {} as never,
      settings: { ursaEnabled: false, favoriteModels: [] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/no favorites yet/i)).toBeInTheDocument()
  })

  it('search filters the whole catalog from any tab and ignores tab scoping', () => {
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: null,
      conversations: {} as never,
      settings: { ursaEnabled: false, favoriteModels: [] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(screen.getByPlaceholderText(/search models/i), {
      target: { value: 'grok' }
    })
    expect(screen.getByText('Grok 4.6')).toBeInTheDocument()
    expect(screen.getByText('Grok 4.5')).toBeInTheDocument()
    expect(screen.queryByText('Claude Sonnet 5')).not.toBeInTheDocument()
    // Tabs hide while searching (results replace the tabbed views).
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('star toggle persists through saveSettings({ favoriteModels })', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: null,
      conversations: {} as never,
      saveSettings: saveSettings as never,
      settings: { ursaEnabled: false, favoriteModels: ['anthropic/claude-sonnet-5'] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: /unfavorite claude sonnet 5/i }))
    expect(saveSettings).toHaveBeenCalledWith({ favoriteModels: [] })
  })

  it('Recent tab lists distinct models from conversation history, newest first', () => {
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: null,
      conversations: {
        a: { modelRef: 'xai/grok-4.5', updatedAt: 300 },
        b: { modelRef: 'anthropic/claude-sonnet-5', updatedAt: 200 },
        c: { modelRef: 'xai/grok-4.5', updatedAt: 100 }
      } as never,
      settings: { ursaEnabled: false, favoriteModels: [] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('tab', { name: /recent/i }))
    const rows = screen
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
      .filter((t) => t.includes('Grok') || t.includes('Claude'))
    expect(rows[0]).toContain('Grok 4.5')
    expect(rows[1]).toContain('Claude Sonnet 5')
    expect(rows).toHaveLength(2)
  })

  it('shows context-window and cost tags on informed rows', () => {
    useAppStore.setState({
      providers: twoProviders as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: ['xai/grok-4.5'],
        modelPricing: { 'xai/grok-4.5': { inputPer1M: 3, outputPer1M: 15 } }
      } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('500K')).toBeInTheDocument()
    expect(screen.getByText('$$')).toBeInTheDocument()
  })
})

describe('ModelPicker — multi-instance Ollama', () => {
  const ollamaProvider = {
    id: 'ollama',
    displayName: 'Ollama',
    color: '#3ecf8e',
    requiresKey: false,
    keyConfigured: true,
    reachable: true,
    models: [
      { id: 'llama3.2:latest', label: 'Llama 3.2' },
      { id: 'gpu-box/qwen3:32b', label: 'Qwen 3 32B' }
    ]
  }
  const twoInstances = [
    { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
    { id: 'gpu-box', name: 'GPU Box', baseUrl: 'http://gpu-box:11434' }
  ]
  const oneInstance = [{ id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }]

  const openOllamaRail = (): HTMLElement => {
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('tab', { name: /^all$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }))
    return screen.getByRole('listbox')
  }

  it('groups rows under per-instance subheaders when two instances are configured', () => {
    useAppStore.setState({
      providers: [ollamaProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        ollamaInstances: twoInstances
      } as never
    })
    const listbox = openOllamaRail()
    const subheaders = [...listbox.querySelectorAll('.mpk-instance-label')].map(
      (el) => el.textContent
    )
    expect(subheaders).toEqual(['Local', 'GPU Box'])
    // Primary (unprefixed) model renders under the primary's subheader, the
    // namespaced one under its own — and the grouped order matches.
    const texts = [...listbox.querySelectorAll('.mpk-instance-label, [role="option"]')].map(
      (el) => el.textContent ?? ''
    )
    const order = ['Local', 'Llama 3.2', 'GPU Box', 'Qwen 3 32B']
    let at = 0
    for (const t of texts) {
      if (at < order.length && t.includes(order[at])) at++
    }
    expect(at).toBe(order.length)
  })

  it('renders no subheaders with a single configured instance (default look unchanged)', () => {
    useAppStore.setState({
      providers: [ollamaProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        ollamaInstances: oneInstance
      } as never
    })
    const listbox = openOllamaRail()
    expect(listbox.querySelector('.mpk-instance-label')).toBeNull()
    expect(screen.getByText('Llama 3.2')).toBeInTheDocument()
  })

  it('renders no subheaders when every visible model is on the primary instance', () => {
    useAppStore.setState({
      providers: [
        { ...ollamaProvider, models: [{ id: 'llama3.2:latest', label: 'Llama 3.2' }] }
      ] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        ollamaInstances: twoInstances
      } as never
    })
    const listbox = openOllamaRail()
    expect(listbox.querySelector('.mpk-instance-label')).toBeNull()
    expect(screen.getByText('Llama 3.2')).toBeInTheDocument()
  })

  it('trigger pill disambiguates a namespaced selection with the instance name', () => {
    useAppStore.setState({
      providers: [ollamaProvider] as never,
      modelRef: 'ollama/gpu-box/qwen3:32b',
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        ollamaInstances: twoInstances
      } as never
    })
    render(<ModelPicker />)
    expect(screen.getByText('Qwen 3 32B · GPU Box')).toBeInTheDocument()
  })

  it('Ursus stays gated on a reachable ollama row when multiple instances are configured', () => {
    const selectModel = vi.fn()
    useAppStore.setState({
      providers: [ollamaProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursusEnabled: true,
        favoriteModels: ['ursus/auto'],
        ollamaInstances: twoInstances
      } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursusRow = screen.getByText('Ursus').closest('[role="option"]')
    expect(ursusRow?.className).not.toContain('disabled')
    fireEvent.click(screen.getByText('Ursus'))
    expect(selectModel).toHaveBeenCalledWith('ursus/auto')
  })
})

describe('ModelPicker — multi-endpoint compat', () => {
  const compatProvider = {
    id: 'compat',
    displayName: 'Compatible',
    color: '#7c8cf8',
    requiresKey: false,
    keyConfigured: true,
    reachable: true,
    models: [
      { id: 'qwen3:32b', label: 'Qwen 3 32B' },
      // Non-primary endpoint id + a model id that itself contains a slash.
      { id: 'work/aitech/llama-4:70b', label: 'Llama 4 70B' }
    ]
  }
  const twoEndpoints = [
    { id: 'home', name: 'Home', baseUrl: 'http://localhost:1234/v1' },
    { id: 'work', name: 'Work Box', baseUrl: 'http://work:8000/v1' }
  ]
  const oneEndpoint = [{ id: 'home', name: 'Home', baseUrl: 'http://localhost:1234/v1' }]

  const openCompatRail = (): HTMLElement => {
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('tab', { name: /^all$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Compatible' }))
    return screen.getByRole('listbox')
  }

  it('groups rows under per-endpoint subheaders when two endpoints are configured', () => {
    useAppStore.setState({
      providers: [compatProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: twoEndpoints
      } as never
    })
    const listbox = openCompatRail()
    const subheaders = [...listbox.querySelectorAll('.mpk-instance-label')].map(
      (el) => el.textContent
    )
    expect(subheaders).toEqual(['Home', 'Work Box'])
    // Primary (unprefixed) model renders under the primary's subheader, the
    // namespaced one under its own — and the grouped order matches.
    const texts = [...listbox.querySelectorAll('.mpk-instance-label, [role="option"]')].map(
      (el) => el.textContent ?? ''
    )
    const order = ['Home', 'Qwen 3 32B', 'Work Box', 'Llama 4 70B']
    let at = 0
    for (const t of texts) {
      if (at < order.length && t.includes(order[at])) at++
    }
    expect(at).toBe(order.length)
  })

  it('renders no subheaders with a single configured endpoint (default look unchanged)', () => {
    useAppStore.setState({
      providers: [compatProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: oneEndpoint
      } as never
    })
    const listbox = openCompatRail()
    expect(listbox.querySelector('.mpk-instance-label')).toBeNull()
    expect(screen.getByText('Qwen 3 32B')).toBeInTheDocument()
  })

  it('renders no subheaders with zero configured endpoints', () => {
    useAppStore.setState({
      providers: [compatProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: []
      } as never
    })
    const listbox = openCompatRail()
    expect(listbox.querySelector('.mpk-instance-label')).toBeNull()
    expect(screen.getByText('Qwen 3 32B')).toBeInTheDocument()
  })

  it('renders no subheaders when every visible model is on the primary endpoint', () => {
    useAppStore.setState({
      providers: [
        { ...compatProvider, models: [{ id: 'qwen3:32b', label: 'Qwen 3 32B' }] }
      ] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: twoEndpoints
      } as never
    })
    const listbox = openCompatRail()
    expect(listbox.querySelector('.mpk-instance-label')).toBeNull()
    expect(screen.getByText('Qwen 3 32B')).toBeInTheDocument()
  })

  it('trigger pill disambiguates a namespaced selection with the endpoint name', () => {
    useAppStore.setState({
      providers: [compatProvider] as never,
      modelRef: 'compat/work/aitech/llama-4:70b',
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: twoEndpoints
      } as never
    })
    render(<ModelPicker />)
    expect(screen.getByText('Llama 4 70B · Work Box')).toBeInTheDocument()
  })

  it('shows no cost tag for compat models (unpriced, not "free")', () => {
    useAppStore.setState({
      providers: [compatProvider] as never,
      modelRef: null,
      conversations: {} as never,
      settings: {
        ursaEnabled: false,
        favoriteModels: [],
        compatEndpoints: twoEndpoints
      } as never
    })
    openCompatRail()
    expect(screen.queryByText('free')).not.toBeInTheDocument()
  })
})
