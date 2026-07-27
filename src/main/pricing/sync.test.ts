import { describe, it, expect } from 'vitest'
import { parseLiteLLM } from './sync'

// Minimal shape of LiteLLM's model_prices_and_context_window.json (per-token USD
// costs + capability/shape fields), verified against a live fetch 2026-07-26.
const fixture = {
  'claude-opus-4-8': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    mode: 'chat',
    max_input_tokens: 200000,
    max_output_tokens: 32000,
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true
  },
  'gpt-5.1': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000008,
    mode: 'chat',
    supports_response_schema: true,
    supports_reasoning: true
  },
  embed_only: {
    mode: 'embedding',
    max_input_tokens: 8000
  },
  sample_spec: { note: 'ignored, no cost or shape fields' }
}
const refs = ['anthropic/claude-opus-4-8', 'openai/gpt-5.1', 'embedding/embed_only', 'ollama/llama3']

describe('parseLiteLLM', () => {
  it('matches our refs to LiteLLM keys and converts per-token cost to per-1M', () => {
    const { prices } = parseLiteLLM(fixture, refs)
    expect(prices['anthropic/claude-opus-4-8']).toEqual({ inputPer1M: 5, outputPer1M: 25 })
    expect(prices['openai/gpt-5.1']).toEqual({ inputPer1M: 2, outputPer1M: 8 })
  })

  it('captures mode, context limits, and supports_* flags into metadata', () => {
    const { metadata } = parseLiteLLM(fixture, refs)
    expect(metadata['anthropic/claude-opus-4-8']).toEqual({
      mode: 'chat',
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      capabilities: {
        functionCalling: true,
        vision: true,
        responseSchema: false,
        reasoning: false,
        webSearch: false,
        codeExecution: false,
        pdfInput: true
      }
    })
    expect(metadata['openai/gpt-5.1']?.capabilities).toEqual({
      functionCalling: false,
      vision: false,
      responseSchema: true,
      reasoning: true,
      webSearch: false,
      codeExecution: false,
      pdfInput: false
    })
  })

  it('maps an unrecognized LiteLLM mode string to "other"', () => {
    const { metadata } = parseLiteLLM(fixture, refs)
    expect(metadata['embedding/embed_only']?.mode).toBe('embedding')
  })

  it('reports a ref with no matching LiteLLM entry as unmatched', () => {
    const { unmatched } = parseLiteLLM(fixture, refs)
    expect(unmatched).toContain('ollama/llama3')
  })

  it('ignores entries with neither cost nor shape fields', () => {
    const { prices, metadata } = parseLiteLLM(fixture, refs)
    expect(Object.keys(prices)).not.toContain('sample_spec')
    expect(Object.keys(metadata)).not.toContain('sample_spec')
  })

  it('captures supports_pdf_input as pdfInput, and defaults codeExecution to false (no LiteLLM equivalent)', () => {
    const { metadata } = parseLiteLLM(
      {
        'claude-opus-4-8': {
          mode: 'chat',
          supports_pdf_input: true
        }
      },
      ['anthropic/claude-opus-4-8']
    )
    expect(metadata['anthropic/claude-opus-4-8']?.capabilities.pdfInput).toBe(true)
    expect(metadata['anthropic/claude-opus-4-8']?.capabilities.codeExecution).toBe(false)
  })
})
