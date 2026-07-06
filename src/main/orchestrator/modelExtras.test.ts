import { describe, it, expect } from 'vitest'
import { buildModelExtras } from './models'

describe('buildModelExtras', () => {
  it('Anthropic non-Haiku, defaults (adaptive + thinking on) = today: thinking, no effort', () => {
    expect(buildModelExtras('anthropic', 'claude-opus-4-8', {})).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' }
    })
  })
  it('Anthropic tier adds outputConfig.effort', () => {
    expect(buildModelExtras('anthropic', 'claude-opus-4-8', { effort: 'high' })).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      outputConfig: { effort: 'high' }
    })
  })
  it('Anthropic thinking OFF omits the thinking param (keeps effort)', () => {
    expect(buildModelExtras('anthropic', 'claude-opus-4-8', { thinking: false, effort: 'max' }))
      .toEqual({ outputConfig: { effort: 'max' } })
  })
  it('Anthropic Haiku: never thinks, no effort, regardless of opts', () => {
    expect(buildModelExtras('anthropic', 'claude-haiku-4-5', { thinking: true, effort: 'max' }))
      .toEqual({})
  })
  it('Anthropic adaptive sends no outputConfig', () => {
    expect(buildModelExtras('anthropic', 'claude-opus-4-8', { effort: 'adaptive' }))
      .toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
  })
  it('Google non-1.x thinking on = today: thinkingConfig; effort ignored', () => {
    expect(buildModelExtras('google', 'gemini-2.5-pro', { effort: 'high' })).toEqual({
      thinkingConfig: { includeThoughts: true }
    })
  })
  it('Google non-1.x thinking OFF omits thinkingConfig', () => {
    expect(buildModelExtras('google', 'gemini-2.5-pro', { thinking: false })).toEqual({})
  })
  it('Google 1.x: nothing', () => {
    expect(buildModelExtras('google', 'gemini-1.5-pro', {})).toEqual({})
  })
  it('Ollama reflects the thinking toggle', () => {
    expect(buildModelExtras('ollama', 'llama3', {})).toEqual({ think: true })
    expect(buildModelExtras('ollama', 'llama3', { thinking: false })).toEqual({ think: false })
  })
  it('OpenAI / openrouter: nothing (reasoning folded, no thinking knob)', () => {
    expect(buildModelExtras('openai', 'gpt-5', { effort: 'high', thinking: false })).toEqual({})
    expect(buildModelExtras('openrouter', 'x/y', { effort: 'max' })).toEqual({})
  })
})
