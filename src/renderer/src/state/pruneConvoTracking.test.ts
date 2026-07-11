import { describe, it, expect } from 'vitest'
import type { Event } from '@shared/types'
import { workedSecondsByTurn, pruneConvoTracking } from './store'

describe('pruneConvoTracking', () => {
  it("drops the deleted conversation's worked-seconds turn entries", () => {
    workedSecondsByTurn.set('u1', 5)
    workedSecondsByTurn.set('u2', 7)
    workedSecondsByTurn.set('other', 9)
    const events: Event[] = [
      { type: 'user_message', id: 'u1', text: 'a' } as Event,
      { type: 'assistant_text', id: 'a1', text: 'x' } as Event,
      { type: 'user_message', id: 'u2', text: 'b' } as Event
    ]
    pruneConvoTracking('conv1', events)
    expect(workedSecondsByTurn.has('u1')).toBe(false)
    expect(workedSecondsByTurn.has('u2')).toBe(false)
    expect(workedSecondsByTurn.has('other')).toBe(true)
  })
})
