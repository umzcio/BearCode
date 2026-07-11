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

import { getProjectSettings, upsertProjectSettings, listProjectSettings } from './index'

beforeEach(() => {
  calls.length = 0
  allRows = []
  getRow = undefined
  vi.clearAllMocks()
})

describe('project_settings (folder = project)', () => {
  it('getProjectSettings maps a row and coerces a bad enum to null', () => {
    getRow = {
      path: '/Users/zach/Desktop/Test',
      name: 'Campus',
      color: '#c96',
      icon: 'IconBrain',
      default_model_ref: 'anthropic/claude-opus-4-8',
      default_effort: 'high',
      default_permission_mode: 'nope'
    }
    expect(getProjectSettings('/Users/zach/Desktop/Test')).toEqual({
      path: '/Users/zach/Desktop/Test',
      name: 'Campus',
      color: '#c96',
      icon: 'IconBrain',
      defaultModelRef: 'anthropic/claude-opus-4-8',
      defaultEffort: 'high',
      defaultPermissionMode: null,
      sandboxMode: false,
      sandboxAllowNetwork: false
    })
  })
  it('getProjectSettings returns null for an unknown path', () => {
    getRow = undefined
    expect(getProjectSettings('/nope')).toBeNull()
  })
  it('upsertProjectSettings ensures the row then updates only present keys', () => {
    upsertProjectSettings('/p', { color: '#123', defaultEffort: 'low' })
    expect(calls.some((c) => /INSERT OR IGNORE INTO project_settings/.test(c.sql))).toBe(true)
    const u = calls.find((c) => /UPDATE project_settings SET/.test(c.sql))
    expect(u!.sql).toContain('color = ?')
    expect(u!.sql).toContain('default_effort = ?')
    expect(u!.sql).not.toContain('icon = ?')
    expect(u!.args[0]).toBe('#123')
    expect(u!.args[1]).toBe('low')
    expect(u!.args[u!.args.length - 1]).toBe('/p')
  })
  it("SECURITY: 'bypass' never persists as a folder default permission mode", () => {
    upsertProjectSettings('/p', { defaultPermissionMode: 'bypass' })
    const u = calls.find((c) => /UPDATE project_settings SET/.test(c.sql))
    expect(u!.args[0]).toBe(null)
  })
  it('coerces a non-string color to null', () => {
    upsertProjectSettings('/p', { color: 42 as never })
    const u = calls.find((c) => /UPDATE project_settings SET/.test(c.sql))
    expect(u!.args[0]).toBe(null)
  })
  it('an empty patch is a no-op — no phantom all-null row is inserted', () => {
    upsertProjectSettings('/p', {})
    expect(calls.some((c) => /INSERT OR IGNORE INTO project_settings/.test(c.sql))).toBe(false)
    expect(calls.some((c) => /UPDATE project_settings SET/.test(c.sql))).toBe(false)
  })
  it('a name-only patch updates just name', () => {
    upsertProjectSettings('/p', { name: 'My Repo' })
    const u = calls.find((c) => /UPDATE project_settings SET/.test(c.sql))
    expect(u!.sql).toContain('name = ?')
    expect(u!.args[0]).toBe('My Repo')
  })
  it('listProjectSettings maps all rows', () => {
    allRows = [
      {
        path: '/a',
        name: null,
        color: null,
        icon: null,
        default_model_ref: null,
        default_effort: null,
        default_permission_mode: null
      }
    ]
    expect(listProjectSettings()).toEqual([
      {
        path: '/a',
        name: null,
        color: null,
        icon: null,
        defaultModelRef: null,
        defaultEffort: null,
        defaultPermissionMode: null,
        sandboxMode: false,
        sandboxAllowNetwork: false
      }
    ])
  })
})
