// Audit H-8: closeOutTurn previously called getEvents() (full history,
// JSON.parse every payload) at the end of every turn just to fold out the
// last compaction marker. getLastCompactionEvent replaces that with a single
// indexed query. better-sqlite3 can't load under plain-Node vitest, so it's
// mocked with a minimal in-memory events table (same precedent as
// createConversation.test.ts/environment.test.ts) real enough to round-trip
// appendEvent -> getLastCompactionEvent.
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
          // INSERT INTO conversations, event_fts, UPDATE conversations updated_at: no-op
        }),
        get: vi.fn((...args: unknown[]) => {
          if (/COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM events/.test(sql)) {
            const [conversationId] = args as [string]
            const max = events
              .filter((e) => e.conversation_id === conversationId)
              .reduce((m, e) => Math.max(m, e.seq), 0)
            return { seq: max + 1 }
          }
          if (
            /SELECT payload FROM events\s+WHERE conversation_id = \? AND type = 'compaction'/.test(
              sql
            )
          ) {
            const [conversationId] = args as [string]
            const matches = events
              .filter((e) => e.conversation_id === conversationId && e.type === 'compaction')
              .sort((a, b) => b.seq - a.seq)
            return matches[0] ? { payload: matches[0].payload } : undefined
          }
          return undefined
        }),
        all: vi.fn(() => [])
      }))
    }
  })
}))

import * as db from './index'

beforeEach(() => {
  events = []
})

describe('getLastCompactionEvent', () => {
  it('returns null when no compaction marker exists', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'hi' } as never)
    expect(db.getLastCompactionEvent(id)).toBeNull()
  })

  it('returns the most recent compaction cutoff', () => {
    const id = db.createConversation('/p').id
    db.appendEvent(id, { type: 'compaction', id: 'c1', summarizedCount: 4 } as never)
    db.appendEvent(id, { type: 'user_message', id: 'u1', text: 'hi' } as never)
    db.appendEvent(id, { type: 'compaction', id: 'c2', summarizedCount: 9 } as never)
    expect(db.getLastCompactionEvent(id)).toEqual({ summarizedCount: 9 })
  })
})
