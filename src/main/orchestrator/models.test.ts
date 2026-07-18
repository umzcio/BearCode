import { describe, it, expect, vi } from 'vitest'

vi.mock('../keys', () => ({ getKey: (p: string) => (p === 'anthropic' ? 'sk-test' : undefined) }))

import { makeModel, buildModelExtras } from './models'

describe('makeModel', () => {
  it('builds an Anthropic model when the key exists', () => {
    const m = makeModel('anthropic/claude-haiku-4-5')
    expect(m).toBeTruthy()
    expect(m._llmType()).toContain('anthropic')
  })
  it('throws a clear error when the key is missing', () => {
    expect(() => makeModel('openai/gpt-5.1')).toThrow(/openai/i)
  })
})

describe('buildModelExtras — OpenAI reasoning models', () => {
  it('sets reasoning.effort for a GPT-5.6 model using the registry default', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', {})
    expect(extras.reasoning).toEqual({ effort: 'medium' })
  })

  it('maps the conversation EffortLevel onto reasoning.effort when set', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'high' })
    expect(extras.reasoning).toEqual({ effort: 'high' })
  })

  it('maps "adaptive" to "medium" and "max" to "xhigh" (OpenAI has no adaptive/max tier)', () => {
    expect(buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'adaptive' }).reasoning).toEqual({
      effort: 'medium'
    })
    expect(buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'max' }).reasoning).toEqual({
      effort: 'xhigh'
    })
  })

  it('sets nothing for a non-reasoning OpenAI model (registry has no entry)', () => {
    const extras = buildModelExtras('openai', 'some-legacy-model', {})
    expect(extras).toEqual({})
  })

  it('forces useResponsesApi so reasoning + function tools can coexist (Chat Completions rejects reasoning_effort with tools)', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', {})
    expect(extras.useResponsesApi).toBe(true)
  })

  it('never forces useResponsesApi for openrouter, even though it shares the OpenAI-compatible client', () => {
    const extras = buildModelExtras('openrouter', 'deepseek/deepseek-chat', {})
    expect(extras).toEqual({})
  })
})
