// Ursa Phase 1 (Task 4): unit tests for the two classifier-context accessors,
// getRecentUrsaContext + getLastUrsaRole. better-sqlite3 can't load under
// plain-Node vitest, so it's mocked with a minimal in-memory events table
// (same precedent as getLastCompactionEvent.test.ts) real enough to round-trip
// appendEvent -> the accessors, exercising the picking/truncation/ordering
// logic against a fake that honors the two queries they issue.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'adaptive', defaultThinking: true })
}))

interface EventRow {
  id: string
  conversation_id: string
  seq: number
  type: string
  payload: string
  created_at: number
}

let events: EventRow[] = []

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: vi.fn((...args: unknown[]) => {
          if (/INSERT INTO events/.test(sql)) {
            const [id, conversation_id, seq, type, payload, created_at] = args as [
              string,
              string,
              number,
              string,
              string,
              number
            ]
            events.push({ id, conversation_id, seq, type, payload, created_at })
          }
        }),
        get: vi.fn((...args: unknown[]) => {
          if (/COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM events/.test(sql)) {
            const [conversationId] = args as [string]
            const max = events
              .filter((e) => e.conversation_id === conversationId)
              .reduce((m, e) => Math.max(m, e.seq), 0)
            return { seq: max + 1 }
          }
          if (/type = 'turn_meta'/.test(sql)) {
            const [conversationId] = args as [string]
            const matches = events
              .filter((e) => e.conversation_id === conversationId && e.type === 'turn_meta')
              .sort((a, b) => b.seq - a.seq)
            return matches[0] ? { payload: matches[0].payload } : undefined
          }
          return undefined
        }),
        all: vi.fn((...args: unknown[]) => {
          if (/type IN \('user_message', 'assistant_text'\)/.test(sql)) {
            const [conversationId] = args as [string]
            return events
              .filter(
                (e) =>
                  e.conversation_id === conversationId &&
                  (e.type === 'user_message' || e.type === 'assistant_text')
              )
              .sort((a, b) => b.seq - a.seq)
              .map((e) => ({ seq: e.seq, type: e.type, payload: e.payload }))
          }
          return []
        })
      }))
    }
  })
}))

import * as db from './index'

beforeEach(() => {
  events = []
})

describe('getRecentUrsaContext', () => {
  it('returns empty string on turn 1 (only the current user message exists)', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'hi' } as never)
    expect(db.getRecentUrsaContext(id)).toBe('')
  })

  it('excludes the current turn and formats prior turns oldest-first', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'build a todo app' } as never)
    db.appendEvent(id, { type: 'assistant_text', id: 'a1', text: 'Here is the app.' } as never)
    // The current (newest) user_message is dropped.
    db.appendEvent(id, { type: 'user_message', id: 'u2', text: 'now fix the bug' } as never)
    expect(db.getRecentUrsaContext(id)).toBe(
      'User: build a todo app\nAssistant: Here is the app.'
    )
  })

  it('keeps at most the last 3 user messages and last 1 assistant text', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'one' } as never)
    db.appendEvent(id, { type: 'assistant_text', id: 'a1', text: 'older reply' } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u2', text: 'two' } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u3', text: 'three' } as never)
    db.appendEvent(id, { type: 'assistant_text', id: 'a2', text: 'newer reply' } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u4', text: 'four' } as never)
    // current turn:
    db.appendEvent(id, { type: 'user_message', id: 'u5', text: 'five (current)' } as never)
    const out = db.getRecentUrsaContext(id)
    expect(out).toContain('User: four')
    expect(out).toContain('User: three')
    expect(out).toContain('User: two')
    expect(out).not.toContain('User: one') // 4th-oldest user message dropped
    expect(out).not.toContain('five (current)') // current turn excluded
    expect(out).toContain('Assistant: newer reply')
    expect(out).not.toContain('Assistant: older reply') // only last assistant kept
  })

  it('truncates long messages to ~300 chars with an ellipsis', () => {
    const id = db.createConversation('/p').id
    const long = 'x'.repeat(500)
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: long } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u2', text: 'current' } as never)
    const out = db.getRecentUrsaContext(id)
    expect(out).toBe(`User: ${'x'.repeat(300)}…`)
  })

  it('skips blank/whitespace-only messages', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'assistant_text', id: 'a1', text: '   ' } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'real prior' } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u2', text: 'current' } as never)
    expect(db.getRecentUrsaContext(id)).toBe('User: real prior')
  })
})

describe('getLastUrsaRole', () => {
  it('returns undefined when there is no turn_meta', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'hi' } as never)
    expect(db.getLastUrsaRole(id)).toBeUndefined()
  })

  it('returns the ursaRole of the most recent turn_meta', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, {
      type: 'turn_meta',
      id: 't1',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      startedAt: 0,
      endedAt: 1,
      ursaRole: 'coder'
    } as never)
    db.appendEvent(id, {
      type: 'turn_meta',
      id: 't2',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      startedAt: 2,
      endedAt: 3,
      ursaRole: 'reviewer'
    } as never)
    expect(db.getLastUrsaRole(id)).toBe('reviewer')
  })

  it('returns undefined when the most recent turn_meta carried no ursaRole', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, {
      type: 'turn_meta',
      id: 't1',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      startedAt: 0,
      endedAt: 1
    } as never)
    expect(db.getLastUrsaRole(id)).toBeUndefined()
  })
})
