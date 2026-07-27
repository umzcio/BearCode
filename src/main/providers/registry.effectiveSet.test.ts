// Regression coverage for the Critical bug this fix round exists to close:
// listManageableModels() (the Models page's data source) and
// listAllModels()/allKnownModelRefs() (the picker + pricing sync's data
// source) must agree on which "provider/modelId" refs are enabled. Before the
// fix, mergeModels' consumers never consulted enabledLiveModels, so a
// live-only model shown as disabled on the Models page stayed fully visible
// in the picker with no way to hide it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchAnthropicModels = vi.fn()
const fetchGoogleModels = vi.fn()
const fetchOpenAIModels = vi.fn()
vi.mock('./liveDiscovery', () => ({
  fetchAnthropicModels: (...args: unknown[]) => fetchAnthropicModels(...args),
  fetchGoogleModels: (...args: unknown[]) => fetchGoogleModels(...args),
  fetchOpenAIModels: (...args: unknown[]) => fetchOpenAIModels(...args)
}))

const getKey = vi.fn()
vi.mock('../keys', () => ({
  getKey: (...args: unknown[]) => getKey(...args),
  keyStatus: () => ({
    anthropic: true,
    openai: true,
    google: true,
    openrouter: true,
    perplexity: true,
    xai: true,
    ollama: true
  })
}))

const getSettingsImpl = vi.fn(() => ({
  customModels: [],
  disabledModels: [],
  enabledLiveModels: [] as string[],
  modelMetadata: {},
  ollamaBaseUrl: 'http://localhost:11434'
}))
vi.mock('../settings', () => ({
  getSettings: () => getSettingsImpl()
}))

describe('listManageableModels vs listAllModels/allKnownModelRefs agree on enabled refs', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchAnthropicModels.mockReset()
    fetchGoogleModels.mockReset()
    fetchOpenAIModels.mockReset()
    getKey.mockReset()
    getKey.mockReturnValue('sk-test')
    getSettingsImpl.mockReturnValue({
      customModels: [],
      disabledModels: [],
      enabledLiveModels: [],
      modelMetadata: {},
      ollamaBaseUrl: 'http://localhost:11434'
    })
    fetchAnthropicModels.mockResolvedValue({
      models: [{ id: 'claude-new-model', label: 'Claude New Model' }],
      capabilities: {}
    })
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
  })

  it('a live-only model defaults disabled on the Models page and absent from the picker/pricing set', async () => {
    const { listManageableModels, listAllModels, allKnownModelRefs } = await import('./registry')

    const manageable = await listManageableModels()
    const anthropicManageable = manageable.find((p) => p.id === 'anthropic')!
    const row = anthropicManageable.models.find((m) => m.id === 'claude-new-model')!
    expect(row.liveOnly).toBe(true)
    expect(row.enabled).toBe(false)

    const all = await listAllModels()
    const anthropicAll = all.find((p) => p.id === 'anthropic')!
    expect(anthropicAll.models.some((m) => m.id === 'claude-new-model')).toBe(false)

    const refs = allKnownModelRefs()
    expect(refs).not.toContain('anthropic/claude-new-model')
  })

  it('opting in via enabledLiveModels makes both sides agree it is enabled/visible', async () => {
    getSettingsImpl.mockReturnValue({
      customModels: [],
      disabledModels: [],
      enabledLiveModels: ['anthropic/claude-new-model'],
      modelMetadata: {},
      ollamaBaseUrl: 'http://localhost:11434'
    })
    const { listManageableModels, listAllModels, allKnownModelRefs } = await import('./registry')

    const manageable = await listManageableModels()
    const anthropicManageable = manageable.find((p) => p.id === 'anthropic')!
    const row = anthropicManageable.models.find((m) => m.id === 'claude-new-model')!
    expect(row.enabled).toBe(true)

    const all = await listAllModels()
    const anthropicAll = all.find((p) => p.id === 'anthropic')!
    expect(anthropicAll.models.some((m) => m.id === 'claude-new-model')).toBe(true)

    const refs = allKnownModelRefs()
    expect(refs).toContain('anthropic/claude-new-model')
  })
})
