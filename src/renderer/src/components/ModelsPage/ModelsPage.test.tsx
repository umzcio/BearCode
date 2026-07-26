// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelsPage } from './ModelsPage'

afterEach(cleanup)

function seed(): void {
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
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [], modelPricingSyncedAt: undefined },
    // Stub the mount-time refresh (Fix 1) so tests that don't care about it
    // don't hit the real window.bearcode IPC bridge, which doesn't exist here.
    refreshManageableModels: vi.fn().mockResolvedValue(undefined)
  } as never)
}

describe('ModelsPage', () => {
  it('defaults to the Models tab', () => {
    seed()
    render(<ModelsPage />)
    expect(document.querySelector('.models-tab')).toBeTruthy()
  })

  it('switches to Catalog and Pricing tabs', () => {
    seed()
    render(<ModelsPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Catalog' }))
    expect(document.querySelector('.catalog-tab')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Pricing' }))
    expect(document.querySelector('.pricing-tab')).toBeTruthy()
  })

  it('runs the header Sync metadata action', async () => {
    const syncPricing = vi
      .fn()
      .mockResolvedValue({ syncedCount: 1, metadataCount: 1, unmatched: [], syncedAt: Date.now() })
    seed()
    useAppStore.setState({ syncPricing } as never)
    render(<ModelsPage />)
    fireEvent.click(screen.getByText('Sync metadata'))
    await waitFor(() => expect(syncPricing).toHaveBeenCalled())
  })

  it('loads manageableModels on mount (regression: the page rendered empty on every fresh launch because nothing triggered the initial load)', () => {
    const refreshManageableModels = vi.fn().mockResolvedValue(undefined)
    seed()
    useAppStore.setState({ manageableModels: [], refreshManageableModels } as never)
    render(<ModelsPage />)
    expect(refreshManageableModels).toHaveBeenCalled()
  })

  it('shows a sync error via ErrorCard when the header Sync metadata action rejects', async () => {
    const syncPricing = vi.fn().mockRejectedValue(new Error('offline'))
    seed()
    useAppStore.setState({ syncPricing } as never)
    render(<ModelsPage />)
    fireEvent.click(screen.getByText('Sync metadata'))
    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy())
    expect(document.querySelector('.ui-error-card')).toBeTruthy()
  })
})
