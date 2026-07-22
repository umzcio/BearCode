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
  setOnResumeSettled: vi.fn(),
  setStartUrsaPipeline: vi.fn()
}))
vi.mock('../db', () => ({
  advanceUrsaPipeline: vi.fn(),
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
  resolveUrsaPipelineOrchestrator,
  runUrsaPipeline,
  startReviewFromClarification
} from './index'
import {
  advanceUrsaPipeline,
  appendOrReplaceEvent,
  getEvents,
  getLastResolvedModelRef,
  getUrsaPipeline,
  setUrsaPipelineStatus
} from '../db'
import { cancelPendingApproval, runGraph, setOnResumeSettled } from './graph'
import type { UrsaPipelineRecord } from '../db'
import type { RunSink } from '../sink'
import type { Event } from '../../shared/types'

// index.ts registers its onResumeSettled callback at module load; capture it
// now (before any beforeEach clearAllMocks wipes the recorded call) so the
// pause/resume test can simulate a paused pipeline step settling.
const onResumeSettled = vi.mocked(setOnResumeSettled).mock.calls[0]?.[0] as (
  conversationId: string,
  sink: RunSink,
  failed: boolean
) => void

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

describe('startReviewFromClarification (Review mode Phase H, Task 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getLastResolvedModelRef).mockReturnValue('openai/gpt-5.6-sol')
    vi.mocked(getEvents).mockReturnValue([
      { type: 'user_message', id: 'u1', text: 'review this for issues', createdAt: Date.now() }
    ] as Event[])
    vi.mocked(runGraph).mockResolvedValue({ paused: false })
  })

  it('re-dispatches a run for the conversation with the answered lens+scope pre-resolved', async () => {
    const sink = makeSink()
    startReviewFromClarification('c1', 'security', 'src/auth', sink)

    await vi.waitFor(() => expect(runGraph).toHaveBeenCalled())
    const opts = vi.mocked(runGraph).mock.calls[0][0]
    // The re-dispatched run reads the conversation's last user_message back
    // (mirrors runDeclinedPipelineSingleRole's lastUserMessageFull()) and the
    // persisted resolved model (mirrors its getLastResolvedModelRef() read),
    // with reviewResolved set so runGraph skips resolveReviewRequest entirely.
    expect(opts.conversationId).toBe('c1')
    expect(opts.userText).toBe('review this for issues')
    expect(opts.modelRef).toBe('openai/gpt-5.6-sol')
    expect(opts.reviewResolved).toEqual({ lens: 'security', scope: 'src/auth' })
  })

  it('fails honestly instead of guessing when no model was ever resolved for this conversation', () => {
    vi.mocked(getLastResolvedModelRef).mockReturnValue(null)
    const sink = makeSink()
    startReviewFromClarification('c1', 'security', 'src/auth', sink)

    expect(runGraph).not.toHaveBeenCalled()
    expect(sink.setState).toHaveBeenCalledWith('c1', 'error')
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

  it('Stop while a pipeline is RUNNING marks it stopped and still runs the parked-approval path', () => {
    // Sub-case: a step paused at a tool-approval interrupt. abort() is a no-op,
    // cancelPendingApproval below cancels the parked card, and runUrsaPipeline is
    // NOT on the stack -- so cancelRunOrchestrator must mark the row 'stopped'.
    vi.mocked(getUrsaPipeline).mockReturnValue({ ...proposed, status: 'running' })
    vi.mocked(cancelPendingApproval).mockReturnValue(undefined)
    const sink = makeSink()
    cancelRunOrchestrator('c1', sink)
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'stopped')
    expect(cancelPendingApproval).toHaveBeenCalledWith('c1')
  })
})

describe('runUrsaPipeline (Ursa Phase 2 step-execution loop)', () => {
  const steps = [
    { role: 'coder', modelRef: 'openai/gpt-5.6-sol', subtask: 'build it' },
    { role: 'reviewer', modelRef: 'anthropic/claude-sonnet-5', subtask: 'review it' },
    { role: 'grunt', modelRef: 'anthropic/claude-haiku-4-5', subtask: 'polish it' }
  ]
  const running = (currentStep = 0): UrsaPipelineRecord => ({
    conversationId: 'c1',
    steps,
    status: 'running',
    currentStep,
    callId: 'card1'
  })

  beforeEach(() => vi.clearAllMocks())

  it('drives every step in order on its own model, advances after each, then marks done', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(running(0))
    vi.mocked(runGraph).mockResolvedValue({ paused: false })
    const sink = makeSink()
    await runUrsaPipeline('c1', sink, new AbortController().signal)

    expect(runGraph).toHaveBeenCalledTimes(3)
    const calls = vi.mocked(runGraph).mock.calls.map((c) => c[0])
    expect(calls[0].modelRef).toBe('openai/gpt-5.6-sol')
    expect(calls[0].ursaStep).toMatchObject({ index: 1, total: 3, role: 'coder', subtask: 'build it' })
    expect(calls[1].modelRef).toBe('anthropic/claude-sonnet-5')
    expect(calls[1].ursaStep).toMatchObject({ index: 2, total: 3, role: 'reviewer' })
    expect(calls[2].ursaStep).toMatchObject({ index: 3, total: 3, role: 'grunt' })
    // Advanced once per completed step; pipeline finalized 'done'.
    expect(advanceUrsaPipeline).toHaveBeenCalledTimes(3)
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'done')
  })

  it('stops the loop when a step pauses (does not advance, does not mark done)', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(running(0))
    vi.mocked(runGraph).mockResolvedValue({ paused: true })
    const sink = makeSink()
    await runUrsaPipeline('c1', sink, new AbortController().signal)

    expect(runGraph).toHaveBeenCalledTimes(1)
    expect(advanceUrsaPipeline).not.toHaveBeenCalled()
    expect(setUrsaPipelineStatus).not.toHaveBeenCalled()
  })

  it('halts and marks stopped when a step fails, without starting the next step', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(running(0))
    vi.mocked(runGraph)
      .mockResolvedValueOnce({ paused: false })
      .mockResolvedValueOnce({ paused: false, failed: true })
    const sink = makeSink()
    await runUrsaPipeline('c1', sink, new AbortController().signal)

    // Step 1 completed (advanced); step 2 failed -> stop; step 3 never ran.
    expect(runGraph).toHaveBeenCalledTimes(2)
    expect(advanceUrsaPipeline).toHaveBeenCalledTimes(1)
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'stopped')
    expect(setUrsaPipelineStatus).not.toHaveBeenCalledWith('c1', 'done')
  })

  it('Stop (already-aborted signal) halts before starting any step and marks stopped', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(running(0))
    const controller = new AbortController()
    controller.abort()
    const sink = makeSink()
    await runUrsaPipeline('c1', sink, controller.signal)

    expect(runGraph).not.toHaveBeenCalled()
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'stopped')
  })

  it('is a no-op when the pipeline is not in status "running" (stale re-entry)', async () => {
    vi.mocked(getUrsaPipeline).mockReturnValue({ ...running(0), status: 'stopped' })
    const sink = makeSink()
    await runUrsaPipeline('c1', sink, new AbortController().signal)
    expect(runGraph).not.toHaveBeenCalled()
  })

  it('pauses mid-step, then re-enters via onResumeSettled to advance and finish', async () => {
    // Faithfully simulate the persisted status/cursor mutating across the pause:
    // approve -> 'running'@0; step 1 pauses; the tool-approval resolves and the
    // step settles -> onResumeSettled advances to 1 and drives step 2 to done.
    const steps2 = steps.slice(0, 2)
    let status: UrsaPipelineRecord['status'] = 'proposed'
    let currentStep = 0
    vi.mocked(getUrsaPipeline).mockImplementation(() => ({
      conversationId: 'c1',
      steps: steps2,
      status,
      currentStep,
      callId: 'card1'
    }))
    vi.mocked(setUrsaPipelineStatus).mockImplementation((_id, s) => {
      status = s
    })
    vi.mocked(advanceUrsaPipeline).mockImplementation(() => {
      currentStep += 1
    })
    vi.mocked(getLastResolvedModelRef).mockReturnValue('openai/gpt-5.6-sol')
    vi.mocked(runGraph)
      .mockResolvedValueOnce({ paused: true }) // step 1 parks on a tool approval
      .mockResolvedValue({ paused: false }) // step 2 completes cleanly

    const sink = makeSink()
    // Approve seeds the AbortController into `aborts` and kicks the runner.
    resolveUrsaPipelineOrchestrator('c1', 'card1', true, sink)
    await vi.waitFor(() => expect(runGraph).toHaveBeenCalledTimes(1))
    expect(advanceUrsaPipeline).not.toHaveBeenCalled()

    // The parked step's approval resolves and it settles cleanly -> onResumeSettled.
    onResumeSettled('c1', sink, false)
    await vi.waitFor(() => expect(runGraph).toHaveBeenCalledTimes(2))
    expect(advanceUrsaPipeline).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runGraph).mock.calls[1][0].ursaStep).toMatchObject({ index: 2, total: 2 })
    expect(status).toBe('done')
  })

  it('onResumeSettled halts the pipeline (marks stopped) when the resumed step failed', () => {
    vi.mocked(getUrsaPipeline).mockReturnValue(running(0))
    const sink = makeSink()
    onResumeSettled('c1', sink, true)
    // Failed resume: no advance, no next step -- pipeline honestly stopped.
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'stopped')
    expect(advanceUrsaPipeline).not.toHaveBeenCalled()
    expect(runGraph).not.toHaveBeenCalled()
  })
})
