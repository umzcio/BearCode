import { describe, it, expect } from 'vitest'
import {
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  OPENROUTER_MODELS,
  contextLengthFromShow
} from './registry'

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
  // Shape verified live against a real Ollama /api/show for ornith:35b, which
  // reports its window under the architecture-prefixed qwen35moe.context_length.
  describe('contextLengthFromShow (Ollama /api/show)', () => {
    it('reads an architecture-prefixed context_length', () => {
      expect(
        contextLengthFromShow({
          model_info: { 'general.architecture': 'qwen35moe', 'qwen35moe.context_length': 262_144 }
        })
      ).toBe(262_144)
    })

    it('works for any architecture prefix, not just the one we sampled', () => {
      expect(contextLengthFromShow({ model_info: { 'llama.context_length': 131_072 } })).toBe(
        131_072
      )
    })

    it('is undefined when the field is absent, malformed, or the payload is junk', () => {
      expect(contextLengthFromShow({ model_info: { 'general.architecture': 'gemma4' } })).toBeUndefined()
      expect(contextLengthFromShow({ model_info: { 'x.context_length': 'lots' } })).toBeUndefined()
      expect(contextLengthFromShow({ model_info: { 'x.context_length': 0 } })).toBeUndefined()
      expect(contextLengthFromShow({})).toBeUndefined()
      expect(contextLengthFromShow(null)).toBeUndefined()
    })
  })

  it('openrouter models carry a context window', () => {
    expect(OPENROUTER_MODELS.every((m) => typeof m.contextWindow === 'number')).toBe(true)
    const kimi = OPENROUTER_MODELS.find((m) => m.id === 'moonshotai/kimi-k3')
    expect(kimi?.contextWindow).toBe(1_048_576)
  })
})
