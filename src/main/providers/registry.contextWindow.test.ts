import { describe, it, expect } from 'vitest'
import { ANTHROPIC_MODELS, GOOGLE_MODELS, OPENROUTER_MODELS } from './registry'

describe('model context windows', () => {
  it('anthropic models carry a context window', () => {
    const opus = ANTHROPIC_MODELS.find((m) => m.id === 'claude-opus-4-8')
    expect(opus?.contextWindow).toBe(1_000_000)
    const haiku = ANTHROPIC_MODELS.find((m) => m.id === 'claude-haiku-4-5')
    expect(haiku?.contextWindow).toBe(200_000)
  })
  it('google models carry a context window', () => {
    expect(GOOGLE_MODELS.every((m) => typeof m.contextWindow === 'number')).toBe(true)
  })
  it('openrouter models omit it (varied/unknown)', () => {
    expect(OPENROUTER_MODELS.every((m) => m.contextWindow === undefined)).toBe(true)
  })
})
