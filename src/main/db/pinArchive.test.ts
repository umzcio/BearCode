import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'adaptive', defaultThinking: true })
}))

const calls: { sql: string; args: unknown[] }[] = []
let getRow: Record<string, unknown> | undefined
let allRows: Record<string, unknown>[] = []
const statement = {
  run: vi.fn((...args: unknown[]) => calls.push({ sql: lastPrepared, args })),
  all: vi.fn(() => allRows),
  get: vi.fn(() => getRow)
}
let lastPrepared = ''
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => {
        lastPrepared = sql
        return statement
      }),
      transaction: vi.fn((fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a))
    }
  })
}))

import { setPinned, setArchived, getConversationMeta } from './index'

beforeEach(() => {
  calls.length = 0
  allRows = []
  getRow = undefined
  vi.clearAllMocks()
})

describe('db pin/archive', () => {
  it('setPinned issues an UPDATE with a coerced 1/0', () => {
    setPinned('c1', true)
    expect(
      calls.some((c) => /UPDATE conversations SET pinned = \?/.test(c.sql) && c.args[0] === 1)
    ).toBe(true)
    setPinned('c1', false)
    expect(
      calls.some((c) => /UPDATE conversations SET pinned = \?/.test(c.sql) && c.args[0] === 0)
    ).toBe(true)
  })
  it('setArchived issues an UPDATE with a coerced 1/0', () => {
    setArchived('c1', false)
    expect(
      calls.some((c) => /UPDATE conversations SET archived = \?/.test(c.sql) && c.args[0] === 0)
    ).toBe(true)
    setArchived('c1', true)
    expect(
      calls.some((c) => /UPDATE conversations SET archived = \?/.test(c.sql) && c.args[0] === 1)
    ).toBe(true)
  })
  it('toMeta resolves pinned/archived (NULL -> false, 1 -> true)', () => {
    getRow = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, project_id: null, pinned: null, archived: null
    }
    expect(getConversationMeta('c1')?.pinned).toBe(false)
    expect(getConversationMeta('c1')?.archived).toBe(false)
    getRow = { ...getRow, pinned: 1, archived: 1 }
    expect(getConversationMeta('c1')?.pinned).toBe(true)
    expect(getConversationMeta('c1')?.archived).toBe(true)
  })
})
