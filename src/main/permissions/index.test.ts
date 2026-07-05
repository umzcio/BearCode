import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PermissionRule } from '../../shared/types'

// The db module loads native better-sqlite3 (Electron ABI); it MUST be mocked
// so this pure-resolver test runs under plain-Node vitest. Same posture as
// permissions/store.test.ts.
vi.mock('../db', () => ({
  getConversationMeta: vi.fn(() => null)
}))
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({ defaultPermissionMode: 'accept-edits' }))
}))
// getEffectiveRules is the engine boundary: a deny rule proves the engine ran.
// Under bypass it must NOT be consulted at all. index.ts re-exports SEVEN names
// from './store'; store.ts transitively imports native better-sqlite3 via '../db',
// so importOriginal is unsafe -- stub every re-exported name (the extra six are
// never invoked by the resolver path) so the module links under any resolution.
vi.mock('./store', () => ({
  getEffectiveRules: vi.fn((): PermissionRule[] => [
    { id: 'd', scope: 'global', action: 'command', match: '*', effect: 'deny', source: 'user' },
    { id: 'de', scope: 'global', action: 'edit', match: '**', effect: 'deny', source: 'user' }
  ]),
  addUserRule: vi.fn(),
  mergeRules: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn(),
  toggleDisabledBuiltin: vi.fn()
}))

import { getConversationMeta } from '../db'
import { getEffectiveRules } from './store'
import { evaluateCommandForConversation, evaluateEditForConversation } from './index'

const asMode = (permissionMode: string): void => {
  vi.mocked(getConversationMeta).mockReturnValue({
    id: 'c1',
    projectPath: '/tmp/p',
    title: null,
    modelRef: null,
    createdAt: 0,
    updatedAt: 0,
    permissionMode: permissionMode as never,
    // executionMode is still a REQUIRED ConversationMeta field until Task 4
    // removes it (this task runs first, and src/main test files are typechecked).
    // Task 4 Step 24b deletes this line.
    executionMode: 'planning' as never,
    activeRules: []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getEffectiveRules).mockReturnValue([
    { id: 'd', scope: 'global', action: 'command', match: '*', effect: 'deny', source: 'user' },
    { id: 'de', scope: 'global', action: 'edit', match: '**', effect: 'deny', source: 'user' }
  ])
})

describe('bypass short-circuit (design §4.2/§6)', () => {
  it('command: bypass returns run WITHOUT consulting the rules engine', () => {
    asMode('bypass')
    expect(evaluateCommandForConversation('rm -rf /', 'c1', '/tmp/p')).toBe('run')
    expect(getEffectiveRules).not.toHaveBeenCalled()
  })
  it('edit: bypass returns apply WITHOUT consulting the rules engine', () => {
    asMode('bypass')
    expect(evaluateEditForConversation('.env', 'c1', '/tmp/p')).toBe('apply')
    expect(getEffectiveRules).not.toHaveBeenCalled()
  })
})

describe('non-bypass modes still run the engine (deny wins)', () => {
  it('command: a matching deny blocks under accept-edits', () => {
    asMode('accept-edits')
    expect(evaluateCommandForConversation('rm -rf /', 'c1', '/tmp/p')).toBe('block')
    expect(getEffectiveRules).toHaveBeenCalledTimes(1)
  })
  it('edit: a matching deny blocks under auto', () => {
    asMode('auto')
    expect(evaluateEditForConversation('.env', 'c1', '/tmp/p')).toBe('block')
    expect(getEffectiveRules).toHaveBeenCalledTimes(1)
  })
  it('edit: plan mode blocks via the fallback when no rule matches', () => {
    asMode('plan')
    vi.mocked(getEffectiveRules).mockReturnValue([])
    expect(evaluateEditForConversation('src/a.ts', 'c1', '/tmp/p')).toBe('block')
  })
})
