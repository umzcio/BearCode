import { describe, it, expect } from 'vitest'
import { EFFORT_LEVELS, EFFORT_LABELS, isEffortLevel, effortCapabilities } from './effort'

describe('effort constants + guard', () => {
  it('lists all six levels, adaptive first', () => {
    expect(EFFORT_LEVELS).toEqual(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('labels xhigh as Extra', () => {
    expect(EFFORT_LABELS.xhigh).toBe('Extra')
    expect(EFFORT_LABELS.adaptive).toBe('Adaptive')
  })
  it('isEffortLevel accepts valid levels and rejects garbage', () => {
    expect(isEffortLevel('max')).toBe(true)
    expect(isEffortLevel('ultra')).toBe(false)
    expect(isEffortLevel(3)).toBe(false)
    expect(isEffortLevel(null)).toBe(false)
  })
})

describe('effortCapabilities', () => {
  it('Anthropic non-Haiku: both enabled', () => {
    expect(effortCapabilities('anthropic/claude-opus-4-8')).toEqual({
      effortEnabled: true, thinkingEnabled: true
    })
  })
  it('Anthropic Haiku: both greyed', () => {
    expect(effortCapabilities('anthropic/claude-haiku-4-5')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('Google non-1.x: thinking only', () => {
    expect(effortCapabilities('google/gemini-2.5-pro')).toEqual({
      effortEnabled: false, thinkingEnabled: true
    })
  })
  it('Google 1.x: both greyed', () => {
    expect(effortCapabilities('google/gemini-1.5-pro')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('Ollama: thinking only', () => {
    expect(effortCapabilities('ollama/llama3')).toEqual({
      effortEnabled: false, thinkingEnabled: true
    })
  })
  it('OpenAI reasoning models (gpt-5*, o*): effort only, no thinking toggle', () => {
    expect(effortCapabilities('openai/gpt-5.6-sol')).toEqual({
      effortEnabled: true, thinkingEnabled: false
    })
    expect(effortCapabilities('openai/gpt-5')).toEqual({ effortEnabled: true, thinkingEnabled: false })
    expect(effortCapabilities('openai/o3')).toEqual({ effortEnabled: true, thinkingEnabled: false })
  })
  it('OpenAI non-reasoning models (gpt-5-chat*, gpt-4*): both greyed', () => {
    expect(effortCapabilities('openai/gpt-5-chat')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
    expect(effortCapabilities('openai/gpt-4o')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('openrouter: both greyed (arbitrary third-party models, no guaranteed support)', () => {
    expect(effortCapabilities('openrouter/anthropic/claude-opus-4-8')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('perplexity: both greyed (hits the default -- no reasoning.effort support)', () => {
    expect(effortCapabilities('perplexity/sonar-pro')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('xai: both greyed (hits the default -- no reasoning.effort support)', () => {
    expect(effortCapabilities('xai/grok-4.5')).toEqual({
      effortEnabled: false, thinkingEnabled: false
    })
  })
  it('null / malformed ref: both greyed', () => {
    expect(effortCapabilities(null)).toEqual({ effortEnabled: false, thinkingEnabled: false })
    expect(effortCapabilities('bogus')).toEqual({ effortEnabled: false, thinkingEnabled: false })
  })
})
