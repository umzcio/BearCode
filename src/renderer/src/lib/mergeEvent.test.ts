import { describe, it, expect } from 'vitest'
import type { Event } from '@shared/types'
import { mergeEvent } from './mergeEvent'

const ev = (id: string, text: string): Event => ({ type: 'assistant_text', id, text }) as Event

describe('mergeEvent', () => {
  it('appends a new-id event', () => {
    const out = mergeEvent([ev('a', '1')], ev('b', '2'))
    expect(out.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('replaces the last element in place when the streaming id matches the tail', () => {
    const before = [ev('a', '1'), ev('b', 'par')]
    const out = mergeEvent(before, ev('b', 'partial'))
    expect(out).toHaveLength(2)
    expect((out[1] as { text: string }).text).toBe('partial')
    expect(out[0]).toBe(before[0]) // earlier events keep identity
  })

  it('replaces a non-tail element by id (fallback path)', () => {
    const before = [ev('a', '1'), ev('b', '2')]
    const out = mergeEvent(before, ev('a', '1-edited'))
    expect((out[0] as { text: string }).text).toBe('1-edited')
    expect(out[1]).toBe(before[1])
  })
})
