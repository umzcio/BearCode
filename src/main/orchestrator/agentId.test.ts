import { describe, it, expect } from 'vitest'
import type { Event } from '../../shared/types'

// subagentLabel returns a short label for non-main agents, else null.
import { subagentLabel } from './agentId'

describe('subagentLabel', () => {
  it('returns null for the main agent', () => {
    const ev = { type: 'assistant_text', id: '1', text: 'hi', agentId: 'main' } as Event
    expect(subagentLabel(ev)).toBeNull()
  })
  it('returns the id for a subagent', () => {
    const ev = { type: 'assistant_text', id: '1', text: 'hi', agentId: 'researcher' } as Event
    expect(subagentLabel(ev)).toBe('researcher')
  })
  it('returns null when agentId is absent', () => {
    const ev = { type: 'assistant_text', id: '1', text: 'hi' } as Event
    expect(subagentLabel(ev)).toBeNull()
  })
})
