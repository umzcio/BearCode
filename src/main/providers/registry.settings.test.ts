import { describe, it, expect, vi, beforeEach } from 'vitest'

// The settings-backed registry readers (contextWindowFor custom fallback,
// allKnownModelRefs opt-out) resolve custom/disabled from getSettings(); mock it
// so we can drive those branches deterministically.
const settings = {
  customModels: [] as unknown[],
  disabledModels: [] as string[]
}
vi.mock('../settings', () => ({ getSettings: () => settings }))
vi.mock('../keys', () => ({ getKey: () => 'k', keyStatus: () => ({}) }))

import { contextWindowFor, allKnownModelRefs } from './registry'

beforeEach(() => {
  settings.customModels = []
  settings.disabledModels = []
})

describe('contextWindowFor', () => {
  it('resolves a curated model window', () => {
    expect(contextWindowFor('anthropic/claude-opus-4-8')).toBe(1_000_000)
  })
  it('falls back to a custom model window', () => {
    settings.customModels = [
      { provider: 'openai', id: 'my-model', label: 'My', contextWindow: 128_000 }
    ]
    expect(contextWindowFor('openai/my-model')).toBe(128_000)
  })
  it('returns null for an unknown model', () => {
    expect(contextWindowFor('openai/does-not-exist')).toBeNull()
  })
})

describe('allKnownModelRefs', () => {
  it('excludes a disabled ref and includes a custom ref', () => {
    settings.disabledModels = ['anthropic/claude-opus-4-8']
    settings.customModels = [
      { provider: 'google', id: 'gemini-x', label: 'Gemini X', contextWindow: 1_000_000 }
    ]
    const refs = allKnownModelRefs()
    expect(refs).not.toContain('anthropic/claude-opus-4-8')
    expect(refs).toContain('google/gemini-x')
    // A different curated model is still present.
    expect(refs).toContain('anthropic/claude-sonnet-5')
  })
})
