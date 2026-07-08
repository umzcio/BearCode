// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { ModelsPage } from './ModelsPage'

const settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  defaultModelRef: null,
  defaultPermissionMode: 'accept-edits',
  disabledBuiltins: [],
  artifactReviewPolicy: 'request-review',
  dataPath: '/tmp/data',
  modelPricing: {},
  disabledModels: [],
  customModels: []
}

const manageable = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    color: '#d97757',
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        contextWindow: 1000000,
        custom: false,
        enabled: true
      },
      { id: 'my-custom', label: 'My Custom', contextWindow: 200000, custom: true, enabled: true }
    ]
  },
  { id: 'openai', displayName: 'OpenAI', color: '#9ad0b7', models: [] }
]

const setSpy = vi.fn((patch: Record<string, unknown>) => Promise.resolve({ ...settings, ...patch }))

beforeEach(() => {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    models: {
      list: vi.fn(() => Promise.resolve([])),
      manageable: vi.fn(() => Promise.resolve(manageable))
    }
  }
  useAppStore.setState({
    settings: settings as never,
    providers: [],
    manageableModels: manageable as never
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ModelsPage management UI (F7)', () => {
  it('renders a Manage Models section with a toggle per model', () => {
    render(<ModelsPage />)
    expect(screen.getByText('Manage Models')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Claude Opus 4\.8 enabled/ })).toBeTruthy()
    expect(screen.getByRole('switch', { name: /My Custom enabled/ })).toBeTruthy()
  })

  it('toggling a curated model off saves it into disabledModels', () => {
    render(<ModelsPage />)
    fireEvent.click(screen.getByRole('switch', { name: /Claude Opus 4\.8 enabled/ }))
    expect(setSpy).toHaveBeenCalledWith({ disabledModels: ['anthropic/claude-opus-4-8'] })
  })

  it('shows a Remove control only for custom models', () => {
    render(<ModelsPage />)
    // Exactly one Remove button (for the custom model).
    const removes = screen.getAllByRole('button', { name: /remove/i })
    expect(removes).toHaveLength(1)
    fireEvent.click(removes[0])
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ customModels: [], disabledModels: [] })
    )
  })

  it('Add model is disabled until id, label, and a positive context window are set', () => {
    render(<ModelsPage />)
    const addBtn = screen.getByRole('button', { name: 'Add model' }) as HTMLButtonElement
    expect(addBtn.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('e.g. gemini-3.1-pro-preview'), {
      target: { value: 'new-model' }
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. Gemini 3.1 Pro'), {
      target: { value: 'New Model' }
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. 1000000'), { target: { value: '400000' } })
    expect(addBtn.disabled).toBe(false)
    fireEvent.click(addBtn)
    expect(setSpy).toHaveBeenCalledWith({
      customModels: [
        { provider: 'anthropic', id: 'new-model', label: 'New Model', contextWindow: 400000 }
      ]
    })
  })

  it('still renders the Model Pricing section (regression)', () => {
    render(<ModelsPage />)
    expect(screen.getByText('Model Pricing')).toBeTruthy()
    expect(screen.getByRole('button', { name: /sync prices/i })).toBeTruthy()
  })

  it('warns about a curated-id collision but keeps Add enabled', () => {
    render(<ModelsPage />)
    fireEvent.change(screen.getByPlaceholderText('e.g. gemini-3.1-pro-preview'), {
      target: { value: 'claude-opus-4-8' }
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. Gemini 3.1 Pro'), {
      target: { value: 'Override' }
    })
    fireEvent.change(screen.getByPlaceholderText('e.g. 1000000'), { target: { value: '1000000' } })
    expect(screen.getByText(/will override/i)).toBeTruthy()
    const addBtn = screen.getByRole('button', { name: 'Add model' }) as HTMLButtonElement
    expect(addBtn.disabled).toBe(false)
  })
})

describe('ModelsPage add-model provider default', () => {
  it('defaults the provider picker to Anthropic', () => {
    render(<ModelsPage />)
    const picker = screen.getByLabelText('Add model provider')
    expect(within(picker).getByText('Anthropic')).toBeTruthy()
  })
})
