import { describe, it, expect } from 'vitest'
import {
  supportsNativePdf,
  capabilitiesFor,
  getProvider,
  PERPLEXITY_MODELS,
  XAI_MODELS
} from './registry'

describe('supportsNativePdf', () => {
  it('is true for the first-party providers', () => {
    expect(supportsNativePdf('anthropic')).toBe(true)
    expect(supportsNativePdf('google')).toBe(true)
    expect(supportsNativePdf('openai')).toBe(true)
  })
  it('is false for OpenAI-compatible endpoints and Ollama (fallback to text)', () => {
    expect(supportsNativePdf('openrouter')).toBe(false)
    expect(supportsNativePdf('ollama')).toBe(false)
  })
  it('is false for Perplexity (OpenAI-compatible endpoint, extract-to-text fallback)', () => {
    expect(supportsNativePdf('perplexity')).toBe(false)
  })
  it('is false for xAI (OpenAI-compatible endpoint, extract-to-text fallback)', () => {
    expect(supportsNativePdf('xai')).toBe(false)
  })
})

describe('Perplexity provider registry entry', () => {
  it('lists the three curated Sonar models with their context windows', async () => {
    const entry = getProvider('perplexity')
    expect(entry.displayName).toBe('Perplexity')
    expect(entry.color).toBe('#20B8CD')
    expect(entry.requiresKey).toBe(true)
    const { models, reachable } = await entry.listModels()
    expect(reachable).toBe(true)
    expect(models).toEqual(PERPLEXITY_MODELS)
    expect(models.map((m) => m.id)).toEqual(['sonar', 'sonar-pro', 'sonar-reasoning-pro'])
    expect(models.map((m) => m.contextWindow)).toEqual([128_000, 200_000, 128_000])
  })
})

describe('xAI provider registry entry', () => {
  it('lists the three curated Grok models with their context windows', async () => {
    const entry = getProvider('xai')
    expect(entry.displayName).toBe('xAI')
    expect(entry.requiresKey).toBe(true)
    const { models, reachable } = await entry.listModels()
    expect(reachable).toBe(true)
    expect(models).toEqual(XAI_MODELS)
    expect(models.map((m) => m.id)).toEqual(['grok-4.5', 'grok-4.3', 'grok-4-fast'])
    expect(models.map((m) => m.contextWindow)).toEqual([500_000, 1_000_000, 2_000_000])
  })
})

describe('capabilitiesFor', () => {
  it('returns reasoning capability for a GPT-5.6 model', () => {
    const caps = capabilitiesFor('openai/gpt-5.6-luna')
    expect(caps?.reasoning?.effort).toBe('medium')
    expect(caps?.strengths).toContain('code')
  })

  it('returns no reasoning capability for Claude Haiku', () => {
    const caps = capabilitiesFor('anthropic/claude-haiku-4-5')
    expect(caps?.reasoning).toBeUndefined()
    expect(caps?.costTier).toBe('low')
  })

  it('returns null for an unknown model ref', () => {
    expect(capabilitiesFor('openai/not-a-real-model')).toBeNull()
  })
})
