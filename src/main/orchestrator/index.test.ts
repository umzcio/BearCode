import { describe, it, expect, vi } from 'vitest'

// index.ts imports ./graph (calling setOnResumeSettled at module load), ../db,
// and ./checkpointer, all of which touch electron/sqlite/langchain at load or
// call time. Mock them (same pattern as resume.test.ts) so importing the
// module under test never opens a real database or loads the heavy graph.
vi.mock('./graph', () => ({
  cancelPendingApproval: vi.fn(),
  clearAllPendingApprovals: vi.fn(),
  forgetPendingApproval: vi.fn(),
  rehydratePausedRun: vi.fn(),
  resolveInterrupt: vi.fn(),
  resolvePlanInterrupt: vi.fn(),
  runGraph: vi.fn(),
  setOnResumeSettled: vi.fn()
}))
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  getZombieRunIds: vi.fn(() => []),
  listConversations: vi.fn(() => []),
  setModelRef: vi.fn()
}))
vi.mock('./checkpointer', () => ({ pruneCheckpoints: vi.fn() }))

import { assertValidCommand, assertValidMentions } from './index'

describe('assertValidMentions', () => {
  it('returns [] for null and undefined', () => {
    expect(assertValidMentions(null)).toEqual([])
    expect(assertValidMentions(undefined)).toEqual([])
  })

  it('passes a valid file/rule/conversation/connector array through, dropping unknown fields', () => {
    const input = [
      { kind: 'file', name: 'src/a.ts', path: 'src/a.ts', bogus: 1 },
      { kind: 'rule', name: 'style' },
      { kind: 'conversation', name: 'Old chat', conversationId: 'c1' },
      { kind: 'connector', name: 'github' }
    ]
    expect(assertValidMentions(input)).toEqual([
      { kind: 'file', name: 'src/a.ts', path: 'src/a.ts' },
      { kind: 'rule', name: 'style' },
      { kind: 'conversation', name: 'Old chat', conversationId: 'c1' },
      { kind: 'connector', name: 'github' }
    ])
  })

  it('throws when mentions is not an array', () => {
    expect(() => assertValidMentions('x')).toThrow(/must be an array/)
  })

  it('throws on an unknown kind', () => {
    expect(() => assertValidMentions([{ kind: 'folder', name: 'x' }])).toThrow(/kind/)
  })

  it('throws on a missing/empty name', () => {
    expect(() => assertValidMentions([{ kind: 'file', name: '' }])).toThrow(/name/)
  })

  it('throws on a non-string path', () => {
    expect(() => assertValidMentions([{ kind: 'file', name: 'a', path: 5 }])).toThrow(/path/)
  })

  it('throws when the array is too large', () => {
    const big = Array.from({ length: 51 }, () => ({ kind: 'file', name: 'a' }))
    expect(() => assertValidMentions(big)).toThrow(/too many/)
  })
})

describe('assertValidCommand', () => {
  it('returns null for null and undefined', () => {
    expect(assertValidCommand(null)).toBeNull()
    expect(assertValidCommand(undefined)).toBeNull()
  })

  it('passes the sendable built-ins through', () => {
    expect(assertValidCommand({ name: 'goal', kind: 'builtin' })).toEqual({
      name: 'goal',
      kind: 'builtin'
    })
    expect(assertValidCommand({ name: 'compact', kind: 'builtin' })).toEqual({
      name: 'compact',
      kind: 'builtin'
    })
  })

  it('passes the browser built-in through (F4: /browser is sendable)', () => {
    expect(assertValidCommand({ name: 'browser', kind: 'builtin' })).toEqual({
      name: 'browser',
      kind: 'builtin'
    })
  })

  it('rejects a non-sendable built-in', () => {
    expect(() => assertValidCommand({ name: 'learn', kind: 'builtin' })).toThrow(
      /cannot be sent as a command/
    )
  })
})
