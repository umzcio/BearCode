// Pins the permission_rules row -> PermissionRule mapping (toRule), the seam
// store.test.ts's mocked '../db' module skips entirely -- which is why the R1
// action:'command' hardcoding bug shipped with a green unit suite (see
// .superpowers/sdd/task-6-report.md). The mapping is tested pure, on
// hand-built row objects: better-sqlite3's native binding is compiled for
// Electron's ABI and cannot load under plain-Node vitest, so both 'electron'
// and 'better-sqlite3' are mocked at module level and no database is opened.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))
vi.mock('better-sqlite3', () => ({
  default: vi.fn()
}))

import { toRule, type RuleRow } from './index'

const row = (overrides: Partial<RuleRow> = {}): RuleRow => ({
  id: 'rule-1',
  project_path: null,
  action: 'command',
  match: 'git *',
  effect: 'allow',
  ...overrides
})

describe('toRule', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("maps a stored action='edit' row through as an edit rule (R1 regression)", () => {
    const rule = toRule(row({ action: 'edit', match: 'guarded/**', effect: 'ask' }))
    expect(rule).not.toBeNull()
    expect(rule?.action).toBe('edit')
    expect(rule?.match).toBe('guarded/**')
    expect(rule?.effect).toBe('ask')
  })

  it("still maps a stored action='command' row as a command rule", () => {
    const rule = toRule(row({ action: 'command' }))
    expect(rule?.action).toBe('command')
    expect(rule?.match).toBe('git *')
    expect(rule?.effect).toBe('allow')
    expect(rule?.source).toBe('user')
  })

  it('maps project_path to scope: null is global, a path binds the project', () => {
    expect(toRule(row())?.scope).toBe('global')
    expect(toRule(row({ project_path: '/a' }))?.scope).toEqual({ projectPath: '/a' })
  })

  it('returns null and warns once for a row with an unknown action, never defaulting to command', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rule = toRule(row({ action: 'network', match: '*', effect: 'ask' }))
    expect(rule).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('network')
    expect(warnSpy.mock.calls[0][0]).toContain('rule-1')
  })
})
