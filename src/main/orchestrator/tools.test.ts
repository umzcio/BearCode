import { describe, it, expect, vi, beforeEach } from 'vitest'

// tools.ts imports ../permissions, which reaches ../db (electron/sqlite at
// call time); mock the whole module so importing the module under test never
// opens a real database, and so the deny gate's rules-engine calls are
// observable.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run')
}))

import { evaluateCommandForConversation } from '../permissions'
import {
  buildTools,
  clearDeniedReplayPins,
  pinDeniedReplays,
  takeDeniedEditReplayPin,
  takeDeniedReplayPin
} from './tools'

beforeEach(() => {
  clearDeniedReplayPins('convo')
  clearDeniedReplayPins('other')
  vi.mocked(evaluateCommandForConversation).mockClear()
  vi.mocked(evaluateCommandForConversation).mockReturnValue('run')
})

describe('denied-replay pins (execution-layer deny enforcement)', () => {
  it('returns false when nothing is pinned', () => {
    expect(takeDeniedReplayPin('convo', 'tc1', 'git push --force')).toBe(false)
  })

  it('consumes a toolCallId pin exactly once', () => {
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', command: 'git push --force' }])
    expect(takeDeniedReplayPin('convo', 'tc1', 'git push --force')).toBe(true)
    // Take-once: a later, genuinely new call reusing the provider id (non-
    // Anthropic providers can) must not be silently denied.
    expect(takeDeniedReplayPin('convo', 'tc1', 'git push --force')).toBe(false)
  })

  it('never lets an approved sibling with an identical command claim a toolCallId pin', () => {
    // Deny 'git push' (tc1), approve the identical 'git push' (tc2): tc2's
    // replay must fall through to normal evaluation, not steal tc1's denial.
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', command: 'git push' }])
    expect(takeDeniedReplayPin('convo', 'tc2', 'git push')).toBe(false)
    expect(takeDeniedReplayPin('convo', 'tc1', 'git push')).toBe(true)
  })

  it('falls back to the command multiset only for id-less pins and id-less calls', () => {
    pinDeniedReplays('convo', [{ command: 'make' }, { command: 'make' }])
    // A call carrying a toolCallId never claims an id-less pin.
    expect(takeDeniedReplayPin('convo', 'tc1', 'make')).toBe(false)
    expect(takeDeniedReplayPin('convo', undefined, 'make')).toBe(true)
    expect(takeDeniedReplayPin('convo', undefined, 'make')).toBe(true)
    expect(takeDeniedReplayPin('convo', undefined, 'make')).toBe(false)
  })

  it('scopes pins per conversation and clears them wholesale', () => {
    pinDeniedReplays('convo', [{ toolCallId: 'tc1' }])
    expect(takeDeniedReplayPin('other', 'tc1', 'ls')).toBe(false)
    clearDeniedReplayPins('convo')
    expect(takeDeniedReplayPin('convo', 'tc1', 'ls')).toBe(false)
  })

  it('pinning an empty batch leaves earlier state untouched (no-op)', () => {
    pinDeniedReplays('convo', [])
    expect(takeDeniedReplayPin('convo', undefined, 'ls')).toBe(false)
  })
})

describe('denied-replay pins for edits (takeDeniedEditReplayPin)', () => {
  it('returns false when nothing is pinned', () => {
    expect(takeDeniedEditReplayPin('convo', 'tc1', 'src/a.ts')).toBe(false)
  })

  it('consumes a toolCallId pin exactly once', () => {
    pinDeniedReplays('convo', [{ toolCallId: 'tc1', editPath: 'src/a.ts' }])
    expect(takeDeniedEditReplayPin('convo', 'tc1', 'src/a.ts')).toBe(true)
    expect(takeDeniedEditReplayPin('convo', 'tc1', 'src/a.ts')).toBe(false)
  })

  it('falls back to the raw-path multiset only for id-less pins and id-less calls', () => {
    pinDeniedReplays('convo', [{ editPath: 'a.txt' }, { editPath: 'a.txt' }])
    // A call carrying a toolCallId never claims an id-less pin.
    expect(takeDeniedEditReplayPin('convo', 'tc1', 'a.txt')).toBe(false)
    expect(takeDeniedEditReplayPin('convo', undefined, 'a.txt')).toBe(true)
    expect(takeDeniedEditReplayPin('convo', undefined, 'a.txt')).toBe(true)
    expect(takeDeniedEditReplayPin('convo', undefined, 'a.txt')).toBe(false)
  })

  it('keeps the command and edit-path fallback namespaces separate', () => {
    // A denied command whose string happens to equal a path must never
    // satisfy an edit replay, and vice versa.
    pinDeniedReplays('convo', [{ command: 'a.txt' }, { editPath: 'make' }])
    expect(takeDeniedEditReplayPin('convo', undefined, 'a.txt')).toBe(false)
    expect(takeDeniedReplayPin('convo', undefined, 'make')).toBe(false)
    expect(takeDeniedReplayPin('convo', undefined, 'a.txt')).toBe(true)
    expect(takeDeniedEditReplayPin('convo', undefined, 'make')).toBe(true)
  })
})

describe('run_command deny gate (replayed tool honors the recorded denial)', () => {
  it('returns the denied message without consulting the rules engine when pinned', async () => {
    // The finding's repro: 'always allow git *' saved from a sibling card
    // makes the re-evaluation return 'run' for the denied force-push. The pin
    // must win before the rules engine is even asked.
    pinDeniedReplays('convo', [{ toolCallId: 'tc9', command: 'git push --force origin main' }])
    const [runCommandTool] = buildTools('/tmp', 'convo')
    const out = await runCommandTool.invoke({ command: 'git push --force origin main' }, {
      toolCallId: 'tc9'
    } as never)
    expect(out).toBe('User denied this command.')
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
  })

  it('falls through to normal evaluation when not pinned', async () => {
    vi.mocked(evaluateCommandForConversation).mockReturnValue('block')
    const [runCommandTool] = buildTools('/tmp', 'convo')
    const out = await runCommandTool.invoke({ command: 'rm -rf /' }, {
      toolCallId: 'tc1'
    } as never)
    expect(out).toBe('This command was blocked by a permission rule.')
    expect(evaluateCommandForConversation).toHaveBeenCalledWith('rm -rf /', 'convo', '/tmp')
  })
})
