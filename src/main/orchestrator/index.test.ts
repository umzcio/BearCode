import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  appendOrReplaceEvent: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  getLastResolvedModelRef: vi.fn(() => 'openai/gpt-5.6-sol'),
  getUrsaPipeline: vi.fn(() => undefined),
  getZombieRunIds: vi.fn(() => []),
  listConversations: vi.fn(() => []),
  setModelRef: vi.fn(),
  setUrsaPipelineStatus: vi.fn()
}))
vi.mock('./checkpointer', () => ({ pruneCheckpoints: vi.fn() }))

import {
  assertValidCommand,
  assertValidMentions,
  cancelRunOrchestrator,
  resolveUrsaPipelineOrchestrator
} from './index'
import {
  appendOrReplaceEvent,
  getLastResolvedModelRef,
  getUrsaPipeline,
  setUrsaPipelineStatus
} from '../db'
import { cancelPendingApproval, runGraph } from './graph'
import type { RunSink } from '../sink'
import type { Event } from '../../shared/types'

const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
const emittedEvents = (sink: RunSink): Event[] =>
  vi.mocked(sink.emit).mock.calls.map((c) => c[1] as Event)

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

  it('passes the learn built-in through (G-skills Task 8: /learn is sendable)', () => {
    expect(assertValidCommand({ name: 'learn', kind: 'builtin' })).toEqual({
      name: 'learn',
      kind: 'builtin'
    })
  })

  it('rejects a non-sendable built-in', () => {
    expect(() => assertValidCommand({ name: 'teamwork-preview', kind: 'builtin' })).toThrow(
      /cannot be sent as a command/
    )
  })
})

describe('resolveUrsaPipelineOrchestrator (Ursa Phase 2 consent gate)', () => {
  const steps = [
    { role: 'coder', modelRef: 'openai/gpt-5.6-sol', subtask: 'build it' },
    { role: 'reviewer', modelRef: 'anthropic/claude-sonnet-5', subtask: 'review it' }
  ]
  const proposed = {
    conversationId: 'c1',
    steps,
    status: 'proposed' as const,
    currentStep: 0,
    callId: 'card1'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getLastResolvedModelRef).mockReturnValue('openai/gpt-5.6-sol')
  })

  it('approve: flips the card to approved, marks the pipeline running, and returns to running', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(proposed)
    const sink = makeSink()
    resolveUrsaPipelineOrchestrator('c1', 'card1', true, sink)

    const card = emittedEvents(sink).find((e) => e.type === 'tool_call')
    expect(card).toMatchObject({
      type: 'tool_call',
      id: 'card1',
      tool: 'ursa_pipeline',
      input: { steps },
      approvalState: 'approved'
    })
    expect(appendOrReplaceEvent).toHaveBeenCalledWith('c1', expect.objectContaining({ id: 'card1' }))
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'running')
    expect(sink.setState).toHaveBeenCalledWith('c1', 'running')
  })

  it('deny: flips the card to denied, marks declined, and re-runs single-role WITHOUT re-classification', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(proposed)
    vi.mocked(runGraph).mockResolvedValue({ paused: false })
    const sink = makeSink()
    resolveUrsaPipelineOrchestrator('c1', 'card1', false, sink)

    const card = emittedEvents(sink).find((e) => e.type === 'tool_call')
    expect(card).toMatchObject({ approvalState: 'denied', tool: 'ursa_pipeline' })
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'declined')

    await vi.waitFor(() => expect(runGraph).toHaveBeenCalled())
    const opts = vi.mocked(runGraph).mock.calls[0][0]
    // Single-role, on the persisted fallback model, with the classification
    // bypass — never the 'ursa/auto' sentinel (which would re-classify).
    expect(opts.modelRef).toBe('openai/gpt-5.6-sol')
    expect(opts.ursaResolved).toEqual({ modelRef: 'openai/gpt-5.6-sol' })
  })

  it('no-op when the proposal is not in status "proposed" (stale click)', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue({ ...proposed, status: 'declined' })
    const sink = makeSink()
    resolveUrsaPipelineOrchestrator('c1', 'card1', true, sink)
    expect(sink.emit).not.toHaveBeenCalled()
    expect(setUrsaPipelineStatus).not.toHaveBeenCalled()
  })

  it('no-op when the clicked callId does not match the proposal', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(proposed)
    const sink = makeSink()
    resolveUrsaPipelineOrchestrator('c1', 'stale-card', true, sink)
    expect(sink.emit).not.toHaveBeenCalled()
    expect(setUrsaPipelineStatus).not.toHaveBeenCalled()
  })

  it('no-op when there is no pipeline for the conversation', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(undefined)
    const sink = makeSink()
    resolveUrsaPipelineOrchestrator('c1', 'card1', true, sink)
    expect(sink.emit).not.toHaveBeenCalled()
  })
})

describe('cancelRunOrchestrator — Stop while a pipeline is proposed', () => {
  const proposed = {
    conversationId: 'c1',
    steps: [{ role: 'coder', modelRef: 'openai/gpt-5.6-sol', subtask: 'x' }],
    status: 'proposed' as const,
    currentStep: 0,
    callId: 'card1'
  }

  beforeEach(() => vi.clearAllMocks())

  it('marks the proposal stopped, flips its card to denied, and cancels the run', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(proposed)
    const sink = makeSink()
    cancelRunOrchestrator('c1', sink)

    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'stopped')
    const card = emittedEvents(sink).find((e) => e.type === 'tool_call')
    expect(card).toMatchObject({ id: 'card1', tool: 'ursa_pipeline', approvalState: 'denied' })
    expect(sink.setState).toHaveBeenCalledWith('c1', 'cancelled')
    // Pre-graph proposal never entered pendingApprovals, so the normal parked
    // approval path is not taken.
    expect(cancelPendingApproval).not.toHaveBeenCalled()
  })

  it('falls through to the normal parked-approval path when no pipeline is proposed', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(undefined)
    vi.mocked(cancelPendingApproval).mockReturnValue(undefined)
    const sink = makeSink()
    cancelRunOrchestrator('c1', sink)
    expect(setUrsaPipelineStatus).not.toHaveBeenCalled()
    expect(cancelPendingApproval).toHaveBeenCalledWith('c1')
  })
})
