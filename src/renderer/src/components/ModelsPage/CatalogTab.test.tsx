// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { CatalogTab } from './CatalogTab'

afterEach(cleanup)

describe('CatalogTab', () => {
  it('shows only disabled models as cards with a description and an Enable button', () => {
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

  it('enables a model from its card', () => {
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
})
