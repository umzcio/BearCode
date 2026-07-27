// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
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
        models: [
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', custom: false, enabled: true },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', custom: false, enabled: false }
        ]
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        color: '#9ad0b7',
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', custom: false, enabled: true }]
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
    settings: { modelPricing: {}, modelMetadata: {}, favoriteModels: [] },
    ...overrides
  } as never)
}

describe('PricingTab', () => {
  it('lists every enabled model with its resolved price, source, and vendor', () => {
    seed()
    render(<PricingTab />)
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0)
    expect(screen.getByText('$5')).toBeTruthy()
    expect(screen.getByText('$25')).toBeTruthy()
    expect(screen.getByText('default')).toBeTruthy()
  })

  it('defaults to "show enabled only", hiding the disabled row', () => {
    seed()
    render(<PricingTab />)
    expect(screen.queryByText('Claude Haiku 4.5')).toBeNull()
  })

  it('toggling "show enabled only" off reveals the disabled row', () => {
    seed()
    render(<PricingTab />)
    fireEvent.click(screen.getByRole('switch', { name: /show enabled only/i }))
    expect(screen.getByText('Claude Haiku 4.5')).toBeTruthy()
  })

  it('search filters by model name and vendor', () => {
    seed()
    render(<PricingTab />)
    fireEvent.change(screen.getByPlaceholderText(/search models/i), { target: { value: 'gpt' } })
    expect(screen.getByText('GPT-5.6 Sol')).toBeTruthy()
    expect(screen.queryByText('Claude Opus 4.8')).toBeNull()
  })

  it('vendor filter narrows the table to one provider', () => {
    seed()
    render(<PricingTab />)
    fireEvent.click(screen.getByLabelText('Filter by vendor'))
    fireEvent.click(screen.getByRole('option', { name: /^OpenAI/ }))
    expect(screen.getByText('GPT-5.6 Sol')).toBeTruthy()
    expect(screen.queryByText('Claude Opus 4.8')).toBeNull()
  })

  it('sorting by price orders rows by resolved input price', () => {
    seed()
    render(<PricingTab />)
    fireEvent.click(screen.getByLabelText('Sort'))
    fireEvent.click(screen.getByText('Price: high to low'))
    const names = Array.from(document.querySelectorAll('.pt-model-name')).map((el) => el.textContent)
    expect(names).toEqual(['Claude Opus 4.8', 'GPT-5.6 Sol'])
  })

  it('shows an empty state when no model matches the filters', () => {
    seed()
    render(<PricingTab />)
    fireEvent.change(screen.getByPlaceholderText(/search models/i), { target: { value: 'nonexistent' } })
    expect(screen.getByText('No models match these filters')).toBeTruthy()
  })
})
