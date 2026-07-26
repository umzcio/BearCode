// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { PricingTab } from './PricingTab'

afterEach(cleanup)

function seed(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    manageableModels: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true }]
      }
    ],
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', color: '#d97757', requiresKey: true, keyConfigured: true, reachable: true, models: [] }
    ],
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] },
    ...overrides
  } as never)
}

describe('PricingTab', () => {
  it('lists every model with its resolved price and source', () => {
    seed()
    render(<PricingTab />)
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('$5')).toBeTruthy()
    expect(screen.getByText('$25')).toBeTruthy()
    expect(screen.getByText('default')).toBeTruthy()
  })

  it('runs a sync and shows the result', async () => {
    const syncPricing = vi
      .fn()
      .mockResolvedValue({ syncedCount: 3, metadataCount: 3, unmatched: [], syncedAt: Date.now() })
    seed({ syncPricing })
    render(<PricingTab />)
    fireEvent.click(screen.getByText('Sync prices'))
    await waitFor(() => expect(screen.getByText(/3 synced/)).toBeTruthy())
  })

  it('shows an error card when sync fails', async () => {
    const syncPricing = vi.fn().mockRejectedValue(new Error('offline'))
    seed({ syncPricing })
    render(<PricingTab />)
    fireEvent.click(screen.getByText('Sync prices'))
    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy())
  })
})
