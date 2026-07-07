import { describe, it, expect } from 'vitest'
import { markForceCompact, consumeForceCompact, commandForcesCompact } from './forceCompact'
import type { CommandRef } from '../../shared/types'

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

describe('commandForcesCompact', () => {
  it('is true only for the /compact builtin', () => {
    expect(commandForcesCompact({ kind: 'builtin', name: 'compact' })).toBe(true)
    expect(commandForcesCompact({ kind: 'builtin', name: 'goal' })).toBe(false)
    expect(commandForcesCompact({ kind: 'builtin', name: 'grill-me' })).toBe(false)
    // A workflow named "compact" is NOT the builtin and must not force compaction.
    expect(commandForcesCompact({ kind: 'workflow', name: 'compact' })).toBe(false)
    expect(commandForcesCompact(null)).toBe(false)
  })

  it('sending a /compact turn marks force-compact so the summarizer runs forced', () => {
    // Mirrors runGraph's send-path gate: a /compact command marks the
    // conversation, and buildAgentAndContext's consumeForceCompact then fires
    // (returns true), which is what builds the aggressive forced summarizer.
    const conversationId = 'conv-compact'
    const command: CommandRef = { kind: 'builtin', name: 'compact' }
    if (commandForcesCompact(command)) markForceCompact(conversationId)
    expect(consumeForceCompact(conversationId)).toBe(true)
    // one-shot: a subsequent (non-compact) turn is not forced
    expect(consumeForceCompact(conversationId)).toBe(false)
  })
})
