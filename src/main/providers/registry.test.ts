import { describe, it, expect } from 'vitest'
import { supportsNativePdf, capabilitiesFor } from './registry'

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
