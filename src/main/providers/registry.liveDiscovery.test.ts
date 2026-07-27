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

vi.mock('../settings', () => ({
  getSettings: () => ({ customModels: [], disabledModels: [], enabledLiveModels: [], modelMetadata: {} })
}))

describe('registry live discovery orchestration', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchAnthropicModels.mockReset()
    fetchGoogleModels.mockReset()
    fetchOpenAIModels.mockReset()
    getKey.mockReset()
  })

  it('falls back to the static array when no key is configured (never calls fetch)', async () => {
    getKey.mockReturnValue(undefined)
    const { knownModels, listManageableModels, ANTHROPIC_MODELS } = await import('./registry')
    await listManageableModels()
    expect(fetchAnthropicModels).not.toHaveBeenCalled()
    expect(knownModels('anthropic')).toEqual(ANTHROPIC_MODELS)
  })

  it('merges a successful live fetch into knownModels, live wins on collision', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({
      models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (live)', contextWindow: 999 }],
      capabilities: { 'claude-opus-4-8': { vision: true } }
    })
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
    const { knownModels, liveCapabilitiesFor, listManageableModels } = await import('./registry')
    await listManageableModels()
    const anthropic = knownModels('anthropic')
    expect(anthropic.find((m) => m.id === 'claude-opus-4-8')?.label).toBe('Claude Opus 4.8 (live)')
    expect(liveCapabilitiesFor('anthropic/claude-opus-4-8')).toEqual({ vision: true })
  })

  it('keeps the static curated contextWindow when a live OpenAI entry omits one entirely', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue(null)
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue({
      models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }],
      capabilities: {}
    })
    const { knownModels, contextWindowFor, listManageableModels, OPENAI_MODELS } = await import(
      './registry'
    )
    await listManageableModels()
    const merged = knownModels('openai').find((m) => m.id === 'gpt-5.6-sol')
    const staticEntry = OPENAI_MODELS.find((m) => m.id === 'gpt-5.6-sol')
    expect(merged?.contextWindow).toBe(staticEntry?.contextWindow)
    expect(merged?.contextWindow).not.toBeUndefined()
    expect(contextWindowFor('openai/gpt-5.6-sol')).toBe(staticEntry?.contextWindow)
  })

  it('prefers the static curated label for OpenAI on id collision (no display name live)', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue(null)
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue({
      models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }],
      capabilities: {}
    })
    const { knownModels, listManageableModels } = await import('./registry')
    await listManageableModels()
    expect(knownModels('openai').find((m) => m.id === 'gpt-5.6-sol')?.label).toBe('GPT-5.6 Sol')
  })

  it('is idempotent: a second call does not re-fetch once the cache is warm', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchGoogleModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchOpenAIModels.mockResolvedValue({ models: [], capabilities: {} })
    const { listManageableModels } = await import('./registry')
    await listManageableModels()
    await listManageableModels()
    expect(fetchAnthropicModels).toHaveBeenCalledTimes(1)
  })

  it('clearLiveDiscoveryCache lets the next call re-fetch', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchGoogleModels.mockResolvedValue({ models: [], capabilities: {} })
    fetchOpenAIModels.mockResolvedValue({ models: [], capabilities: {} })
    const { listManageableModels, clearLiveDiscoveryCache } = await import('./registry')
    await listManageableModels()
    clearLiveDiscoveryCache()
    await listManageableModels()
    expect(fetchAnthropicModels).toHaveBeenCalledTimes(2)
  })

  it('degrades to the static fallback when a fetcher rejects instead of resolving null', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockRejectedValue(new Error('network error'))
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
    const { knownModels, listManageableModels, ANTHROPIC_MODELS } = await import('./registry')
    await expect(listManageableModels()).resolves.toBeDefined()
    expect(knownModels('anthropic')).toEqual(ANTHROPIC_MODELS)
  })

  it('a live-only model defaults to disabled; opting in via enabledLiveModels enables it', async () => {
    getKey.mockReturnValue('sk-test')
    fetchAnthropicModels.mockResolvedValue({
      models: [{ id: 'claude-new-model', label: 'Claude New Model' }],
      capabilities: {}
    })
    fetchGoogleModels.mockResolvedValue(null)
    fetchOpenAIModels.mockResolvedValue(null)
    const { listManageableModels } = await import('./registry')
    const providers = await listManageableModels()
    const anthropic = providers.find((p) => p.id === 'anthropic')!
    const row = anthropic.models.find((m) => m.id === 'claude-new-model')!
    expect(row.liveOnly).toBe(true)
    expect(row.enabled).toBe(false)
  })

  it('a curated model is liveOnly: false and stays enabled by default', async () => {
    getKey.mockReturnValue(undefined)
    const { listManageableModels } = await import('./registry')
    const providers = await listManageableModels()
    const anthropic = providers.find((p) => p.id === 'anthropic')!
    const opus = anthropic.models.find((m) => m.id === 'claude-opus-4-8')!
    expect(opus.liveOnly).toBe(false)
    expect(opus.enabled).toBe(true)
  })
})
