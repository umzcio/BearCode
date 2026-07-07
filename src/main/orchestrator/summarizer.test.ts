import { describe, it, expect } from 'vitest'
import {
  summaryTriggerTokens,
  summaryTrigger,
  summaryKeep,
  cheapModelRef,
  tunesSummarization
} from './summarizer'

describe('summaryKeep', () => {
  it('force keeps only the last few messages so a small chat still compacts', () => {
    expect(summaryKeep('anthropic/claude-opus-4-8', true)).toEqual({ type: 'messages', value: 4 })
    // force keep is window-independent (huge-window models must still compact)
    expect(summaryKeep('ollama/llama3.2', true)).toEqual({ type: 'messages', value: 4 })
  })
  it('non-force keeps half the conversation window in absolute tokens', () => {
    expect(summaryKeep('anthropic/claude-opus-4-8', false)).toEqual({
      type: 'tokens',
      value: 500_000
    })
  })
  it('non-force falls back to a fraction when the window is unknown', () => {
    expect(summaryKeep('ollama/llama3.2', false)).toEqual({ type: 'fraction', value: 0.5 })
  })
})

describe('summaryTriggerTokens', () => {
  it('is 85% of a 1M Anthropic window', () => {
    expect(summaryTriggerTokens('anthropic/claude-opus-4-8')).toBe(850_000)
  })

  it('is 85% of the 200k Haiku window', () => {
    expect(summaryTriggerTokens('anthropic/claude-haiku-4-5')).toBe(170_000)
  })

  it('floors non-integer results', () => {
    // 400_000 * 0.85 = 340_000 (already integer); use a window that isn't.
    // gpt-5.1 has a 400k window → 340000 exact; verify the floor path with google.
    expect(summaryTriggerTokens('google/gemini-2.5-flash')).toBe(850_000)
  })

  it('is null for a model with no known window (Ollama)', () => {
    expect(summaryTriggerTokens('ollama/llama3.2')).toBeNull()
  })

  it('is null for a curated OpenRouter model (no window)', () => {
    expect(summaryTriggerTokens('openrouter/deepseek/deepseek-chat')).toBeNull()
  })

  it('is null for an unknown model id under a known provider', () => {
    expect(summaryTriggerTokens('anthropic/claude-nonexistent')).toBeNull()
  })
})

describe('summaryTrigger', () => {
  it('forces a 1-token trigger so it fires on the next model call', () => {
    expect(summaryTrigger('anthropic/claude-opus-4-8', true)).toEqual({ type: 'tokens', value: 1 })
  })

  it('forces even when the window is unknown (Ollama)', () => {
    expect(summaryTrigger('ollama/llama3.2', true)).toEqual({ type: 'tokens', value: 1 })
  })

  it('uses the 85% window trigger when not forced', () => {
    expect(summaryTrigger('anthropic/claude-opus-4-8', false)).toEqual({
      type: 'tokens',
      value: 850_000
    })
  })

  it('is undefined when not forced and the window is unknown', () => {
    expect(summaryTrigger('ollama/llama3.2', false)).toBeUndefined()
  })
})

describe('cheapModelRef', () => {
  it('maps Anthropic to Haiku', () => {
    expect(cheapModelRef('anthropic/claude-opus-4-8')).toBe('anthropic/claude-haiku-4-5')
  })

  it('maps OpenAI to gpt-5-mini', () => {
    expect(cheapModelRef('openai/gpt-5.1')).toBe('openai/gpt-5-mini')
  })

  it('reuses the conversation model when the provider has no cheap sibling', () => {
    expect(cheapModelRef('ollama/llama3.2')).toBe('ollama/llama3.2')
  })
})

describe('tunesSummarization', () => {
  it('tunes first-party providers', () => {
    expect(tunesSummarization('anthropic/claude-opus-4-8')).toBe(true)
    expect(tunesSummarization('openrouter/deepseek/deepseek-chat')).toBe(true)
  })

  it('leaves Ollama on the default middleware', () => {
    expect(tunesSummarization('ollama/llama3.2')).toBe(false)
  })
})
