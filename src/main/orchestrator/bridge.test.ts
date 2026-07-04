import { describe, it, expect } from 'vitest'
import { textDeltaEvent, thinkingDeltaEvent } from './bridge'

describe('bridge mappers', () => {
  it('maps accumulated text to an assistant_text event (upsert by id)', () => {
    const e = textDeltaEvent('a1', 'Hello wor')
    expect(e).toEqual({ type: 'assistant_text', id: 'a1', text: 'Hello wor' })
  })
  it('tags a subagent', () => {
    const e = textDeltaEvent('a1', 'hi', 'researcher')
    expect(e).toMatchObject({ agentId: 'researcher' })
  })
  it('maps thinking with duration', () => {
    const e = thinkingDeltaEvent('t1', 'reasoning...', 1200)
    expect(e).toEqual({ type: 'thinking', id: 't1', text: 'reasoning...', durationMs: 1200 })
  })
})
