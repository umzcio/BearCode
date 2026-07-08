// FTS5 conversation-history search (F1 Task 2). better-sqlite3's native binding
// is compiled for Electron's ABI and cannot load under plain-Node vitest, so
// 'better-sqlite3' is mocked (same precedent as createConversation.test.ts).
// Unlike that test's inert stub, this one MUST exercise real FTS5 ranking,
// snippet() and MATCH filtering, so the mock is backed by Node's built-in
// node:sqlite (a Node builtin -- NOT better-sqlite3) via an adapter that
// presents the tiny slice of the better-sqlite3 API index.ts uses. Reached
// through process.getBuiltinModule so the vi.mock factory needs no out-of-scope
// references and cannot hit a class TDZ.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))

// Captures the live adapter instance so a test can run raw SQL against it (used
// to orphan an FTS row by deleting only its conversation row, proving the
// searchHistory join drops hits whose conversation no longer exists).
const holder = vi.hoisted(() => ({
  instances: [] as { rawExec: (sql: string, ...args: unknown[]) => void }[]
}))

vi.mock('better-sqlite3', () => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  // Extract better-sqlite3-style @named params actually present in the SQL, so
  // an object bound with extra keys (createConversation passes a full row) is
  // filtered down -- node:sqlite throws on unknown named parameters.
  const namedKeys = (sql: string): Set<string> =>
    new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]))
  const bind = (sql: string, args: unknown[]): unknown[] => {
    if (
      args.length === 1 &&
      args[0] !== null &&
      typeof args[0] === 'object' &&
      !Array.isArray(args[0]) &&
      !(args[0] instanceof Uint8Array)
    ) {
      const keys = namedKeys(sql)
      const filtered: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) {
        if (keys.has(k)) filtered[k] = v
      }
      return [filtered]
    }
    return args
  }
  class FakeStatement {
    constructor(
      private stmt: ReturnType<InstanceType<typeof DatabaseSync>['prepare']>,
      private sql: string
    ) {}
    run(...args: unknown[]): unknown {
      return this.stmt.run(...(bind(this.sql, args) as never[]))
    }
    get(...args: unknown[]): unknown {
      return this.stmt.get(...(bind(this.sql, args) as never[]))
    }
    all(...args: unknown[]): unknown {
      return this.stmt.all(...(bind(this.sql, args) as never[]))
    }
  }
  class FakeDatabase {
    private db: InstanceType<typeof DatabaseSync>
    constructor() {
      this.db = new DatabaseSync(':memory:')
    }
    pragma(s: string): void {
      this.db.exec(`PRAGMA ${s}`)
    }
    exec(sql: string): void {
      this.db.exec(sql)
    }
    prepare(sql: string): FakeStatement {
      return new FakeStatement(this.db.prepare(sql), sql)
    }
    transaction(fn: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
      return (...a: unknown[]) => {
        this.db.exec('BEGIN')
        try {
          const r = fn(...a)
          this.db.exec('COMMIT')
          return r
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }
    // Test-only escape hatch: run arbitrary SQL against the underlying DB.
    rawExec(sql: string, ...args: unknown[]): void {
      this.db.prepare(sql).run(...(args as never[]))
    }
  }
  return {
    default: vi.fn(function () {
      const d = new FakeDatabase()
      holder.instances.push(d)
      return d
    })
  }
})

import {
  appendEvent,
  appendOrReplaceEvent,
  createConversation,
  clearAll,
  deleteConversation,
  searchHistory,
  setTitle
} from './index'
import type { Event } from '../../shared/types'

const MARK_OPEN = '‹mark›'
const MARK_CLOSE = '‹/mark›'

const userMsg = (id: string, text: string): Event => ({ type: 'user_message', id, text })
const assistant = (id: string, text: string): Event => ({ type: 'assistant_text', id, text })
const toolCall = (id: string, input: unknown): Event => ({
  type: 'tool_call',
  id,
  tool: 'edit_file' as Event extends { type: 'tool_call'; tool: infer T } ? T : never,
  input,
  approvalState: 'approved' as never
})
const thinking = (id: string, text: string): Event => ({
  type: 'thinking',
  id,
  text,
  durationMs: 1
})

beforeEach(() => {
  clearAll()
  createConversation('/Users/z/proj-alpha', 'c-main')
  setTitle('c-main', 'Crossing puzzle')
  appendEvent('c-main', userMsg('u1', 'fox chicken grain'))
  appendEvent('c-main', assistant('a1', 'the farmer crosses the river'))
  appendEvent('c-main', toolCall('t1', { path: 'src/registry.ts', pattern: 'gemini' }))
  appendEvent('c-main', thinking('th1', 'hidden secret reasoning'))
})

describe('searchHistory', () => {
  it('returns one hit on the user_message event with a marked snippet', () => {
    const hits = searchHistory('fox')
    expect(hits).toHaveLength(1)
    const hit = hits[0]
    expect(hit.eventId).toBe('u1')
    expect(hit.conversationId).toBe('c-main')
    expect(hit.kind).toBe('user_message')
    expect(hit.title).toBe('Crossing puzzle')
    expect(hit.projectLabel).toBe('proj-alpha')
    expect(typeof hit.updatedAt).toBe('number')
    expect(hit.snippet).toContain(MARK_OPEN)
    expect(hit.snippet).toContain(MARK_CLOSE)
    expect(hit.snippet).toContain('fox')
  })

  it('finds the tool_call event by an indexed path token', () => {
    const hits = searchHistory('registry')
    expect(hits).toHaveLength(1)
    expect(hits[0].eventId).toBe('t1')
    expect(hits[0].kind).toBe('tool_call')
  })

  it('never indexes thinking text', () => {
    expect(searchHistory('hidden')).toEqual([])
  })

  it('does not throw on punctuation and still matches the bare token', () => {
    let hits: ReturnType<typeof searchHistory> = []
    expect(() => {
      hits = searchHistory('fox()')
    }).not.toThrow()
    expect(hits).toHaveLength(1)
    expect(hits[0].eventId).toBe('u1')
  })

  it('drops hits whose conversation no longer exists', () => {
    createConversation('/Users/z/proj-beta', 'c-del')
    appendEvent('c-del', userMsg('u2', 'a fox in the henhouse'))
    // Two conversations now match 'fox'.
    expect(searchHistory('fox')).toHaveLength(2)
    // Orphan c-del's FTS row by deleting ONLY its conversation row (leaves the
    // event_fts row behind), exercising the searchHistory join-drop guard.
    holder.instances[0].rawExec('DELETE FROM conversations WHERE id = ?', 'c-del')
    const hits = searchHistory('fox')
    expect(hits).toHaveLength(1)
    expect(hits[0].conversationId).toBe('c-main')
  })

  it('re-indexes an event in place on appendOrReplaceEvent', () => {
    appendOrReplaceEvent('c-main', userMsg('u1', 'wolf sheep cabbage'))
    expect(searchHistory('fox')).toEqual([])
    const hits = searchHistory('wolf')
    expect(hits).toHaveLength(1)
    expect(hits[0].eventId).toBe('u1')
  })

  it('removes a conversation FTS rows on deleteConversation', () => {
    deleteConversation('c-main')
    expect(searchHistory('fox')).toEqual([])
    expect(searchHistory('registry')).toEqual([])
  })
})
