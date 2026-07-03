import { describe, it, expect, vi } from 'vitest'

vi.mock('../keys', () => ({ getKey: (p: string) => (p === 'anthropic' ? 'sk-test' : undefined) }))

import { makeModel } from './models'

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
