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

// Regression for the Critical found by round-2 review: listAllModels()'s
// isLiveOnly post-filter applies across the FULL REGISTRY array, which
// includes 'ollama' -- a provider with no STATIC_MODELS entry and deliberately
// excluded from MANAGEABLE_PROVIDER_IDS ("fully dynamic/local, manages its own
// catalog"). Every real Ollama model id therefore resolved as isLiveOnly ===
// true, and since nothing can ever populate enabledLiveSet for an
// 'ollama/...' ref (listManageableModels never iterates Ollama either), real
// locally-pulled Ollama models silently vanished from listAllModels()'s
// result -- i.e. from the model picker and context-window meter.
describe('listAllModels leaves Ollama unaffected by the enabledLiveModels opt-in filter', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchAnthropicModels.mockReset()
    fetchGoogleModels.mockReset()
    fetchOpenAIModels.mockReset()
    getKey.mockReset()
    getKey.mockReturnValue(undefined) // no key for any first-party provider -> static fallback, no network
    getSettingsImpl.mockReturnValue({
      customModels: [],
      disabledModels: [],
      enabledLiveModels: [],
      modelMetadata: {},
      ollamaBaseUrl: 'http://localhost:11434'
    })
  })

  it('a real locally-pulled Ollama model survives listAllModels() untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/tags')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ models: [{ name: 'llama3' }] })
          })
        }
        if (url.endsWith('/api/show')) {
          // Simulate the existing catch-and-continue behavior: a failed
          // /api/show lookup still leaves the model in the list, just
          // without a contextWindow.
          return Promise.reject(new Error('not found'))
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })
    )

    const { listAllModels } = await import('./registry')
    const all = await listAllModels()
    const ollama = all.find((p) => p.id === 'ollama')!
    expect(ollama.reachable).toBe(true)
    const llama = ollama.models.find((m) => m.id === 'llama3')
    expect(llama).toBeDefined()
    expect(llama?.contextWindow).toBeUndefined()

    vi.unstubAllGlobals()
  })
})
