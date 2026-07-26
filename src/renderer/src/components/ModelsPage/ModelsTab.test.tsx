// @vitest-environment jsdom
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { ModelsTab } from './ModelsTab'

afterEach(cleanup)

function seed(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    manageableModels: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        models: [
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000, custom: false, enabled: true },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000, custom: false, enabled: false }
        ]
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        color: '#9ad0b7',
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_050_000, custom: false, enabled: true }
        ]
      }
    ],
    // `providers[].models` mirrors what `window.bearcode.models.list()` returns in
    // production: only the EFFECTIVE (enabled) models per provider -- distinct from
    // `manageableModels` above, which includes disabled ones too. The default-model
    // picker is built from this list (matching the pre-redesign ModelsPage.tsx
    // convention), so it must carry the enabled models here for that picker to have
    // any options to select in the test below.
    providers: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#d97757',
        requiresKey: true,
        keyConfigured: true,
        reachable: true,
        models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 }]
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        color: '#9ad0b7',
        requiresKey: true,
        keyConfigured: false,
        reachable: true,
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_050_000 }]
      }
    ],
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [], defaultModelRef: null },
    ...overrides
  } as never)
}

describe('ModelsTab', () => {
  it('renders one row per manageable model across every provider', () => {
    seed()
    render(<ModelsTab />)
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
    expect(screen.getByText('GPT-5.6 Sol')).toBeTruthy()
  })

  it('filters by search text against the model label', () => {
    seed()
    render(<ModelsTab />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'opus' } })
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull()
  })

  it('"show enabled only" hides the disabled row', () => {
    seed()
    render(<ModelsTab />)
    fireEvent.click(screen.getByRole('switch', { name: /show enabled only/i }))
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull()
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
  })

  it('renders the provider-not-configured status with a Configure link for a model under an unconfigured provider', () => {
    const openSettings = vi.fn()
    seed({ openSettings })
    render(<ModelsTab />)
    const row = screen.getByText('GPT-5.6 Sol').closest('.mt-row') as HTMLElement
    expect(within(row).getByText('Provider not configured')).toBeTruthy()
    fireEvent.click(within(row).getByText('Configure →'))
    expect(openSettings).toHaveBeenCalledWith('providers')
  })

  it('toggles a row enabled via its inline switch', () => {
    const setModelEnabled = vi.fn().mockResolvedValue(undefined)
    seed({ setModelEnabled })
    render(<ModelsTab />)
    const row = screen.getByText('Claude Haiku 4.5').closest('.mt-row') as HTMLElement
    fireEvent.click(within(row).getByRole('switch'))
    expect(setModelEnabled).toHaveBeenCalledWith('anthropic/claude-haiku-4-5', true)
  })

  it('opens the detail modal from a row\'s ⋮ button', () => {
    seed()
    render(<ModelsTab />)
    const row = screen.getByText('Claude Opus 4.8').closest('.mt-row') as HTMLElement
    fireEvent.click(within(row).getByLabelText('More actions'))
    expect(screen.getByLabelText('Claude Opus 4.8 details')).toBeTruthy()
  })

  it('renders the default-model picker and saves a new choice', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    seed({ saveSettings })
    render(<ModelsTab />)
    fireEvent.click(screen.getByLabelText('Default model'))
    fireEvent.click(screen.getByText('OpenAI: GPT-5.6 Sol'))
    expect(saveSettings).toHaveBeenCalledWith({ defaultModelRef: 'openai/gpt-5.6-sol' })
  })

  it('paginates when there are more rows than the page size', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      label: `Model ${i}`,
      custom: false,
      enabled: true
    }))
    seed({
      manageableModels: [{ id: 'anthropic', displayName: 'Anthropic', color: '#d97757', models: many }]
    })
    render(<ModelsTab />)
    fireEvent.click(screen.getByLabelText('Page size'))
    fireEvent.click(screen.getByText('10'))
    expect(screen.getByText(/Showing 1–10 of 12/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(screen.getByText(/Showing 11–12 of 12/)).toBeTruthy()
  })
})
