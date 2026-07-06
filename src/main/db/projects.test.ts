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

import {
  createProject,
  listProjects,
  renameProject,
  deleteProject,
  setConversationProject,
  getConversationMeta
} from './index'

beforeEach(() => {
  calls.length = 0
  allRows = []
  getRow = undefined
  vi.clearAllMocks()
})

describe('db projects', () => {
  it('createProject inserts and returns a Project', () => {
    const p = createProject('Campus', null)
    expect(p.name).toBe('Campus')
    expect(typeof p.id).toBe('string')
    expect(p.id.length).toBeGreaterThan(0)
  })
  it('listProjects maps rows', () => {
    allRows = [{ id: 'p1', name: 'A', color: null, created_at: 1, updated_at: 2 }]
    expect(listProjects()).toEqual([
      { id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 2 }
    ])
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
    expect(calls.some((c) => /UPDATE conversations SET project_id = \?/.test(c.sql) && c.args[0] === 'p1')).toBe(true)
    setConversationProject('c1', null)
    expect(calls.some((c) => /UPDATE conversations SET project_id = \?/.test(c.sql) && c.args[0] === null)).toBe(true)
  })
  it('toMeta resolves projectId (null when column NULL)', () => {
    getRow = {
      id: 'c1', project_path: '', title: null, model_ref: null,
      created_at: 1, updated_at: 1, permission_mode: null, active_rules: null,
      effort: null, thinking: null, project_id: 'p1'
    }
    expect(getConversationMeta('c1')?.projectId).toBe('p1')
    getRow = { ...getRow, project_id: null }
    expect(getConversationMeta('c1')?.projectId).toBe(null)
  })
})
