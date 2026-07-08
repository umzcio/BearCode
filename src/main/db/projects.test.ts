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
      transaction: vi.fn(
        (fn: (...a: unknown[]) => unknown) =>
          (...a: unknown[]) =>
            fn(...a)
      )
    }
  })
}))

import {
  createProject,
  listProjects,
  renameProject,
  deleteProject,
  setConversationProject,
  getConversationMeta,
  getProject,
  updateProjectSettings
} from './index'

beforeEach(() => {
  calls.length = 0
  allRows = []
  getRow = undefined
  vi.clearAllMocks()
})

describe('db projects', () => {
  it('createProject inserts and returns the (re-read) Project', () => {
    // createProject re-reads via getProject after applying any new-project
    // template, so the fake DB returns this row on the follow-up .get().
    getRow = {
      id: 'new',
      name: 'Campus',
      color: null,
      icon: null,
      default_model_ref: null,
      default_effort: null,
      default_permission_mode: null,
      created_at: 1,
      updated_at: 1
    }
    const p = createProject('Campus', null)
    expect(p.name).toBe('Campus')
    expect(calls.some((c) => /INSERT INTO projects/.test(c.sql))).toBe(true)
  })
  it('listProjects maps rows (old rows: F9 fields null → inherit)', () => {
    allRows = [{ id: 'p1', name: 'A', color: null, created_at: 1, updated_at: 2 }]
    expect(listProjects()).toEqual([
      {
        id: 'p1',
        name: 'A',
        color: null,
        icon: null,
        defaultModelRef: null,
        defaultEffort: null,
        defaultPermissionMode: null,
        createdAt: 1,
        updatedAt: 2
      }
    ])
  })
  it('getProject maps F9 columns and coerces a bad enum to null', () => {
    getRow = {
      id: 'p1',
      name: 'A',
      color: '#c96',
      icon: 'IconGrid',
      default_model_ref: 'anthropic/claude-opus-4-8',
      default_effort: 'high',
      default_permission_mode: 'not-a-mode',
      created_at: 1,
      updated_at: 2
    }
    expect(getProject('p1')).toEqual({
      id: 'p1',
      name: 'A',
      color: '#c96',
      icon: 'IconGrid',
      defaultModelRef: 'anthropic/claude-opus-4-8',
      defaultEffort: 'high',
      defaultPermissionMode: null, // 'not-a-mode' coerced away
      createdAt: 1,
      updatedAt: 2
    })
  })
  it('getProject returns null for a missing id', () => {
    getRow = undefined
    expect(getProject('nope')).toBeNull()
  })
  it('updateProjectSettings updates only present keys (null clears)', () => {
    updateProjectSettings('p1', { color: '#123', defaultEffort: 'low', defaultModelRef: null })
    const c = calls.find((c) => /UPDATE projects SET/.test(c.sql))
    expect(c).toBeTruthy()
    expect(c!.sql).toContain('color = ?')
    expect(c!.sql).toContain('default_effort = ?')
    expect(c!.sql).toContain('default_model_ref = ?')
    expect(c!.sql).not.toContain('icon = ?')
    // Columns are appended in field order: color, default_model_ref, default_effort.
    // args: color, modelRef(null), effort, updated_at, id
    expect(c!.args[0]).toBe('#123')
    expect(c!.args[1]).toBe(null)
    expect(c!.args[2]).toBe('low')
    expect(c!.args[c!.args.length - 1]).toBe('p1')
  })
  it('updateProjectSettings coerces a bad effort/mode to null before persisting', () => {
    updateProjectSettings('p1', {
      defaultEffort: 'yolo' as never,
      defaultPermissionMode: 'bypassy' as never
    })
    const c = calls.find((c) => /UPDATE projects SET/.test(c.sql))
    // order: default_effort, default_permission_mode, updated_at, id
    expect(c!.args[0]).toBe(null)
    expect(c!.args[1]).toBe(null)
  })
  it("SECURITY: 'bypass' is never a valid project default — coerced to null on write and read", () => {
    updateProjectSettings('p1', { defaultPermissionMode: 'bypass' })
    const c = calls.find((c) => /UPDATE projects SET/.test(c.sql))
    expect(c!.args[0]).toBe(null) // bypass dropped, not persisted
    // …and on read from a hand-edited column.
    getRow = {
      id: 'p1',
      name: 'A',
      color: null,
      icon: null,
      default_model_ref: null,
      default_effort: null,
      default_permission_mode: 'bypass',
      created_at: 1,
      updated_at: 2
    }
    expect(getProject('p1')?.defaultPermissionMode).toBeNull()
  })
  it('updateProjectSettings coerces a non-string color/icon to null', () => {
    updateProjectSettings('p1', { color: 42 as never, icon: {} as never })
    const c = calls.find((c) => /UPDATE projects SET/.test(c.sql))
    expect(c!.args[0]).toBe(null)
    expect(c!.args[1]).toBe(null)
  })
  it('updateProjectSettings with no settable keys is a no-op (no UPDATE)', () => {
    updateProjectSettings('p1', {})
    expect(calls.some((c) => /UPDATE projects SET/.test(c.sql))).toBe(false)
  })
  it('renameProject issues an UPDATE with the new name', () => {
    renameProject('p1', 'B')
    const c = calls.find((c) => /UPDATE projects SET name/.test(c.sql))
    expect(c?.args[0]).toBe('B')
  })
  it('deleteProject unassigns conversations then deletes the project', () => {
    deleteProject('p1')
    expect(calls.some((c) => /UPDATE conversations SET project_id = NULL/.test(c.sql))).toBe(true)
    expect(calls.some((c) => /DELETE FROM projects/.test(c.sql))).toBe(true)
  })
  it('setConversationProject persists a project id and null', () => {
    setConversationProject('c1', 'p1')
    expect(
      calls.some(
        (c) => /UPDATE conversations SET project_id = \?/.test(c.sql) && c.args[0] === 'p1'
      )
    ).toBe(true)
    setConversationProject('c1', null)
    expect(
      calls.some(
        (c) => /UPDATE conversations SET project_id = \?/.test(c.sql) && c.args[0] === null
      )
    ).toBe(true)
  })
  it('toMeta resolves projectId (null when column NULL)', () => {
    getRow = {
      id: 'c1',
      project_path: '',
      title: null,
      model_ref: null,
      created_at: 1,
      updated_at: 1,
      permission_mode: null,
      active_rules: null,
      effort: null,
      thinking: null,
      project_id: 'p1'
    }
    expect(getConversationMeta('c1')?.projectId).toBe('p1')
    getRow = { ...getRow, project_id: null }
    expect(getConversationMeta('c1')?.projectId).toBe(null)
  })
})
