import { describe, it, expect } from 'vitest'
import type { Event } from '@shared/types'
import { groupTurnsIncremental } from './transcript'

const user = (id: string, text: string): Event => ({ type: 'user_message', id, text }) as Event
const text = (id: string, t: string): Event => ({ type: 'assistant_text', id, text: t }) as Event
const meta = (id: string): Event => ({ type: 'turn_meta', id }) as Event

describe('groupTurnsIncremental', () => {
  it('reuses all item objects when events are unchanged', () => {
    const events: Event[] = [user('u1', 'hi'), text('a1', 'yo'), meta('m1')]
    const first = groupTurnsIncremental(null, events)
    const second = groupTurnsIncremental(first, events)
    expect(second.items[0]).toBe(first.items[0]) // stable reference
  })

  it('keeps finished turns stable when a new turn streams in', () => {
    const done: Event[] = [user('u1', 'hi'), text('a1', 'done'), meta('m1')]
    const first = groupTurnsIncremental(null, done)
    // A second turn begins and streams a partial assistant_text.
    const streaming: Event[] = [...done, user('u2', 'again'), text('a2', 'par')]
    const second = groupTurnsIncremental(first, streaming)
    expect(second.items[0]).toBe(first.items[0]) // turn 1 unchanged -> same object
    expect(second.items.length).toBe(2)
  })

  it('produces a fresh object for the live turn on a streamed replacement', () => {
    const base: Event[] = [user('u1', 'hi'), text('a1', 'par')]
    const first = groupTurnsIncremental(null, base)
    // upsertEvent replaced the last assistant_text with a new object, same id.
    const next: Event[] = [base[0], text('a1', 'partial-more')]
    const second = groupTurnsIncremental(first, next)
    expect(second.items[0]).not.toBe(first.items[0]) // live turn rebuilt
  })

  it('buckets ursa_step dividers into the turn step stream (in emit order)', () => {
    const div = (id: string, index: number): Event =>
      ({
        type: 'ursa_step',
        id,
        index,
        total: 2,
        role: 'coder',
        modelRef: 'anthropic/claude',
        subtask: 'do a thing'
      }) as Event
    const toolCall = (id: string): Event =>
      ({ type: 'tool_call', id, tool: 'run_command', input: { command: 'ls' } }) as Event
    const events: Event[] = [
      user('u1', 'build then review'),
      div('s1', 1),
      toolCall('t1'),
      div('s2', 2),
      toolCall('t2'),
      meta('m1')
    ]
    const { items } = groupTurnsIncremental(null, events)
    expect(items.length).toBe(1)
    const turn = items[0].kind === 'turn' ? items[0].turn : null
    expect(turn).not.toBeNull()
    // Dividers ride the step stream, interleaved in emit order with tool calls.
    expect(turn!.steps.map((e) => e.type)).toEqual([
      'ursa_step',
      'tool_call',
      'ursa_step',
      'tool_call'
    ])
  })
})
