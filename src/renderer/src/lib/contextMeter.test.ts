import { describe, it, expect } from 'vitest'
import { estimateTokens, conversationTokens, contextUsage, contextWindowFor } from './contextMeter'
import type { Event, ProviderModels } from '@shared/types'

describe('contextMeter', () => {
  it('estimateTokens ~ chars/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
  })
  it('conversationTokens sums text over user/assistant/tool_result', () => {
    const events: Event[] = [
      { type: 'user_message', id: 'u', text: 'a'.repeat(8) },
      { type: 'assistant_text', id: 'a', text: 'b'.repeat(4) },
      { type: 'tool_result', id: 't', callId: 'c', output: 'c'.repeat(4), durationMs: 0, truncated: false },
      { type: 'error', id: 'e', message: 'ignored', recoverable: true }
    ]
    expect(conversationTokens(events)).toBe(2 + 1 + 1) // 8/4 + 4/4 + 4/4
  })
  it('contextUsage computes pct + near (>=80%)', () => {
    expect(contextUsage(50, 100)).toEqual({ pct: 50, near: false })
    expect(contextUsage(80, 100)).toEqual({ pct: 80, near: true })
    expect(contextUsage(120, 100)).toEqual({ pct: 120, near: true })
  })
  it('contextWindowFor resolves via providers + modelRef', () => {
    const providers: ProviderModels[] = [
      { id: 'anthropic', displayName: 'A', color: '#000', requiresKey: true, keyConfigured: true, reachable: true, models: [{ id: 'claude-opus-4-8', label: 'Opus', contextWindow: 1_000_000 }] }
    ] as unknown as ProviderModels[]
    expect(contextWindowFor(providers, 'anthropic/claude-opus-4-8')).toBe(1_000_000)
    expect(contextWindowFor(providers, 'anthropic/unknown')).toBeUndefined()
    expect(contextWindowFor(providers, null)).toBeUndefined()
  })
})
