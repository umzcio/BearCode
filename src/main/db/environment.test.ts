// F3: conversation environment ('local' | 'worktree') + spawned worktrees
// metadata. Mocks better-sqlite3 at module level -- same precedent as
// pinArchive.test.ts/createConversation.test.ts, since the native binding
// can't load under plain-Node vitest.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('../settings', () => ({
  getSettings: () => ({ defaultEffort: 'adaptive', defaultThinking: true })
}))

const calls: { sql: string; args: unknown[] }[] = []
let getRow: Record<string, unknown> | undefined
let lastPrepared = ''
const statement = {
  run: vi.fn((...args: unknown[]) => calls.push({ sql: lastPrepared, args })),
  all: vi.fn(() => []),
  get: vi.fn(() => getRow)
}
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => {
        lastPrepared = sql
        return statement
      }),
      transaction: vi.fn(
        (fn: (...a: unknown[]) => unknown) =>
          (...a: unknown[]) =>
            fn(...a)
      )
    }
  })
}))

import { createConversation, getConversationMeta, setEnvironment } from './index'

beforeEach(() => {
  calls.length = 0
  getRow = undefined
  vi.clearAllMocks()
})

describe('conversation environment', () => {
  it('defaults to local with no worktrees', () => {
    const c = createConversation('/proj')
    expect(c.environment).toBe('local')
    expect(c.worktrees).toEqual([])
  })

  it('setEnvironment issues an UPDATE with environment + JSON worktrees', () => {
    const wt = [
      { repoPath: '/proj', worktreePath: '/wt/proj', branch: 'bearcode/x', baseBranch: 'main' }
    ]
    setEnvironment('c1', 'worktree', wt)
    const call = calls.find((c) => /UPDATE conversations SET environment = \?/.test(c.sql))
    expect(call).toBeDefined()
    expect(call!.args[0]).toBe('worktree')
    expect(call!.args[1]).toBe(JSON.stringify(wt))
  })

  it('reads back a persisted environment + worktrees row', () => {
    const wt = [
      { repoPath: '/proj', worktreePath: '/wt/proj', branch: 'bearcode/x', baseBranch: 'main' }
    ]
    getRow = {
      id: 'c1',
      project_path: '/proj',
      title: null,
      model_ref: null,
      created_at: 1,
      updated_at: 1,
      permission_mode: null,
      active_rules: null,
      effort: null,
      thinking: null,
      project_id: null,
      pinned: null,
      archived: null,
      environment: 'worktree',
      worktrees: JSON.stringify(wt)
    }
    const got = getConversationMeta('c1')!
    expect(got.environment).toBe('worktree')
    expect(got.worktrees).toEqual(wt)
  })

  it('recovers from malformed worktrees JSON as []', () => {
    getRow = {
      id: 'c1',
      project_path: '/proj',
      title: null,
      model_ref: null,
      created_at: 1,
      updated_at: 1,
      permission_mode: null,
      active_rules: null,
      effort: null,
      thinking: null,
      project_id: null,
      pinned: null,
      archived: null,
      environment: null,
      worktrees: '{not json'
    }
    const got = getConversationMeta('c1')!
    expect(got.environment).toBe('local')
    expect(Array.isArray(got.worktrees)).toBe(true)
    expect(got.worktrees).toEqual([])
  })
})
