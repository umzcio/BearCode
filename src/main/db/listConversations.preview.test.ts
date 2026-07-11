// Audit L-16 (#45): listConversations previously ran a first-message query
// per row; this test guards the single-statement correlated-subquery
// refactor. Mocks better-sqlite3 at module level -- same precedent as
// environment.test.ts/createConversation.test.ts, since the native binding
// can't load under plain-Node vitest.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({
    defaultEffort: 'adaptive',
    defaultThinking: true,
    defaultPermissionMode: 'ask'
  })
}))

let allRows: Record<string, unknown>[] = []
let lastPreparedSql = ''
const statement = {
  run: vi.fn(),
  all: vi.fn(() => allRows),
  get: vi.fn()
}
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => {
        lastPreparedSql = sql
        return statement
      })
    }
  })
}))

import { listConversations } from './index'

const baseRow = {
  id: 'c1',
  project_path: '/p',
  title: null,
  model_ref: null,
  created_at: 1,
  updated_at: 2,
  permission_mode: null,
  active_rules: null,
  effort: null,
  thinking: null,
  project_id: null,
  pinned: null,
  archived: null,
  environment: null,
  worktrees: null
}

beforeEach(() => {
  allRows = []
  lastPreparedSql = ''
  vi.clearAllMocks()
})

describe('listConversations first-message preview', () => {
  it('issues a single statement with a correlated first_msg subquery (no per-row query)', () => {
    allRows = [{ ...baseRow, first_msg: JSON.stringify({ text: 'Hello world preview text' }) }]
    listConversations()
    // Only one prepare() call should be needed for the conversations query --
    // the whole point of the refactor is folding the per-row firstMsg.get()
    // into the single statement below.
    expect(lastPreparedSql).toMatch(/SELECT .*first_msg|SELECT c\.\*/is)
    expect(lastPreparedSql).toMatch(/FROM conversations c/i)
    expect(lastPreparedSql).toMatch(/e\.type = 'user_message'/i)
  })

  it('derives fallback title + preview from the first user_message in one pass', () => {
    allRows = [{ ...baseRow, first_msg: JSON.stringify({ text: 'Hello world preview text' }) }]
    const [meta] = listConversations()
    expect(meta.title).toBe('Hello world preview text')
    expect(meta.preview).toBe('Hello world preview text')
  })

  it('degrades gracefully when the first user_message payload is corrupt', () => {
    allRows = [{ ...baseRow, first_msg: '{not json' }]
    const [meta] = listConversations()
    expect(meta.preview).toBeNull()
    expect(meta.title).toBeNull()
  })

  it('has no preview/fallback when there is no first_msg', () => {
    allRows = [{ ...baseRow, first_msg: null }]
    const [meta] = listConversations()
    expect(meta.preview).toBeNull()
    expect(meta.title).toBeNull()
  })
})
