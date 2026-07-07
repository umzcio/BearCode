import { describe, it, expect } from 'vitest'
import { resolvePrice, BUNDLED_PRICES } from './pricing'

describe('resolvePrice', () => {
  it('returns a bundled Anthropic price out of the box', () => {
    expect(resolvePrice('anthropic/claude-opus-4-8')).toEqual({ inputPer1M: 5, outputPer1M: 25 })
  })
  it('synced override wins over bundled', () => {
    const synced = { 'anthropic/claude-opus-4-8': { inputPer1M: 4, outputPer1M: 20 } }
    expect(resolvePrice('anthropic/claude-opus-4-8', synced)).toEqual({
      inputPer1M: 4,
      outputPer1M: 20
    })
  })
  it('null for a model with no bundled and no synced price', () => {
    expect(resolvePrice('ollama/llama3')).toBeNull()
  })
  it('synced fills a model that has no bundled default', () => {
    const synced = { 'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 } }
    expect(resolvePrice('openai/gpt-5.1', synced)).toEqual({ inputPer1M: 2, outputPer1M: 8 })
  })
  it('bundled table has the three Anthropic models', () => {
    expect(Object.keys(BUNDLED_PRICES)).toEqual(
      expect.arrayContaining([
        'anthropic/claude-opus-4-8',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-haiku-4-5'
      ])
    )
  })
})
