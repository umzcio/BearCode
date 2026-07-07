import { describe, it, expect } from 'vitest'
import { markForceCompact, consumeForceCompact } from './forceCompact'

describe('forceCompact', () => {
  it('consume returns false when not marked', () => {
    expect(consumeForceCompact('never-marked')).toBe(false)
  })

  it('consume is one-shot: true once after marking, false thereafter', () => {
    markForceCompact('conv-1')
    expect(consumeForceCompact('conv-1')).toBe(true)
    expect(consumeForceCompact('conv-1')).toBe(false)
  })

  it('tracks conversations independently', () => {
    markForceCompact('conv-a')
    expect(consumeForceCompact('conv-b')).toBe(false)
    expect(consumeForceCompact('conv-a')).toBe(true)
  })
})
