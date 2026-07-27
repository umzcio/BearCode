// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { CatalogTab } from './CatalogTab'

afterEach(cleanup)

describe('CatalogTab', () => {
  it('shows only disabled models as rows with a description and an Enable button', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }
          ]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)
    expect(screen.queryByText('Claude Opus 4.8')).toBeNull()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.getByText(/smallest, cheapest/)).toBeTruthy()
  })

  it('groups disabled models under a vendor section header', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)
    expect(screen.getByText('Anthropic')).toBeTruthy()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
  })

  it('groups disabled models from 2 different providers under their own vendor headers', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }]
        },
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#10a37f',
          models: [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', custom: false, enabled: false }]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] },
        { id: 'openai', displayName: 'OpenAI', color: '#10a37f', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)

    const anthropicHeading = screen.getByText('Anthropic')
    const openaiHeading = screen.getByText('OpenAI')
    expect(anthropicHeading).toBeTruthy()
    expect(openaiHeading).toBeTruthy()

    const anthropicGroup = anthropicHeading.closest('.ct-group')
    const openaiGroup = openaiHeading.closest('.ct-group')
    expect(anthropicGroup).toBeTruthy()
    expect(openaiGroup).toBeTruthy()
    expect(anthropicGroup).not.toBe(openaiGroup)

    expect(anthropicGroup?.textContent).toContain('Claude Haiku 4.5')
    expect(anthropicGroup?.textContent).not.toContain('GPT-5 Mini')
    expect(openaiGroup?.textContent).toContain('GPT-5 Mini')
    expect(openaiGroup?.textContent).not.toContain('Claude Haiku 4.5')
  })

  it('enables a model from its row', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }]
        }
      ],
      providers: [
        { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
      ],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] },
      setModelEnabled
    } as never)
    render(<CatalogTab />)
    fireEvent.click(screen.getByText('Enable'))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-haiku-4-5', true)
  })

  it('shows an empty state when every model is already enabled', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true }]
        }
      ],
      providers: [],
      settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] }
    } as never)
    render(<CatalogTab />)
    expect(screen.getByText('All models are enabled')).toBeTruthy()
  })

  it('shows a loading state when settings has not loaded yet', () => {
    useAppStore.setState({
      manageableModels: [],
      providers: [],
      settings: null
    } as never)
    render(<CatalogTab />)
    expect(screen.getByText('Loading models…')).toBeTruthy()
  })

  function seedMulti(): void {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }
          ]
        },
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#10a37f',
          models: [{ id: 'gpt-5-mini', label: 'GPT-5 Mini', custom: false, enabled: false }]
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
          color: '#10a37f',
          requiresKey: true,
          keyConfigured: true,
          reachable: true,
          models: []
        }
      ],
      settings: {
        modelPricing: {},
        modelMetadata: {
          'anthropic/claude-haiku-4-5': { mode: 'chat', capabilities: { vision: true } }
        },
        favoriteModels: []
      }
    } as never)
  }

  it('search filters catalog rows by model name', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.change(screen.getByPlaceholderText(/search catalog/i), { target: { value: 'haiku' } })
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.queryByText('GPT-5 Mini')).toBeNull()
  })

  it('search filters catalog rows by vendor name too', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.change(screen.getByPlaceholderText(/search catalog/i), { target: { value: 'openai' } })
    expect(screen.getByText('GPT-5 Mini')).toBeTruthy()
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull()
  })

  it('vendor filter narrows the catalog to one provider', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.click(screen.getByLabelText('Filter by vendor'))
    fireEvent.click(screen.getByRole('option', { name: /^OpenAI/ }))
    expect(screen.getByText('GPT-5 Mini')).toBeTruthy()
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull()
  })

  it('capability filter narrows the catalog to models with that capability', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.click(screen.getByLabelText('Filter by capability'))
    fireEvent.click(screen.getByText('Vision'))
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.queryByText('GPT-5 Mini')).toBeNull()
  })

  it('shows a filtered-empty state distinct from the all-enabled empty state', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.change(screen.getByPlaceholderText(/search catalog/i), { target: { value: 'nonexistent' } })
    expect(screen.getByText('No models match these filters')).toBeTruthy()
  })

  it('sorting by name flattens the vendor grouping into one alphabetical list', () => {
    seedMulti()
    render(<CatalogTab />)
    fireEvent.click(screen.getByLabelText('Sort'))
    fireEvent.click(screen.getByText('Name (A–Z)'))
    expect(screen.queryByText('Anthropic')).toBeNull()
    expect(screen.queryByText('OpenAI')).toBeNull()
    const names = Array.from(document.querySelectorAll('.ct-row-name')).map((el) => el.textContent)
    expect(names).toEqual(['Claude Haiku 4.5', 'GPT-5 Mini'])
  })
})
