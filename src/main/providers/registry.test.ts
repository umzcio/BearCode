import { describe, it, expect } from 'vitest'
import { supportsNativePdf } from './registry'

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
