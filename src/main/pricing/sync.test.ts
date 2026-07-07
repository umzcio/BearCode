import { describe, it, expect } from 'vitest'
import { parseLiteLLM } from './sync'

// Minimal shape of LiteLLM's model_prices_and_context_window.json (per-token USD).
const fixture = {
  'claude-opus-4-8': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
  'gpt-5.1': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
  sample_spec: { note: 'ignored, no cost fields' }
}
// Our curated model refs to match against.
const refs = ['anthropic/claude-opus-4-8', 'openai/gpt-5.1', 'ollama/llama3']

describe('parseLiteLLM', () => {
  it('matches our refs to LiteLLM keys and converts per-token to per-1M', () => {
    const { prices, unmatched } = parseLiteLLM(fixture, refs)
    expect(prices['anthropic/claude-opus-4-8']).toEqual({ inputPer1M: 5, outputPer1M: 25 })
    expect(prices['openai/gpt-5.1']).toEqual({ inputPer1M: 2, outputPer1M: 8 })
    expect(unmatched).toContain('ollama/llama3')
  })
  it('ignores entries without cost fields', () => {
    const { prices } = parseLiteLLM(fixture, refs)
    expect(Object.keys(prices)).not.toContain('sample_spec')
  })
})
