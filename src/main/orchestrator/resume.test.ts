import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConversationMeta } from '../../shared/types'
import type { RunSink } from '../sink'

// resumeInterruptedRuns' detection must not depend on any event's message
// string (see the fix for the reviewer finding on Task 7): it consumes the
// authoritative "which conversations did the boot scan patch" list from
// `getZombieRunIds()`. For each dangling conversation it now attempts a full
// crash-resume via graph.rehydratePausedRun (A2), falling back to the
// degrade-clean `cancelled` broadcast when nothing is resumable. These mocks
// exercise the resume-vs-degrade branches directly.
const listConversations = vi.fn<() => ConversationMeta[]>()
const getZombieRunIds = vi.fn<() => string[]>()
const getConversationMeta = vi.fn<(id: string) => ConversationMeta | null>()
const getEvents = vi.fn(() => [] as unknown[])
const appendEvent = vi.fn()
// Ursa Phase 2: resumeInterruptedRuns marks a non-resumable 'running' pipeline
// 'stopped'. Default: no pipeline row -> the branch is a no-op for these tests.
const getUrsaPipeline = vi.fn<
  (id: string) => { status: string; callId?: string; steps?: unknown[] } | undefined
>(() => undefined)
const setUrsaPipelineStatus = vi.fn()
const appendOrReplaceEvent = vi.fn()

vi.mock('../db', () => ({
  listConversations: (...args: unknown[]) => listConversations(...(args as [])),
  getZombieRunIds: (...args: unknown[]) => getZombieRunIds(...(args as [])),
  getConversationMeta: (...args: [string]) => getConversationMeta(...args),
  getEvents: (...args: unknown[]) => getEvents(...(args as [])),
  appendEvent: (...args: unknown[]) => appendEvent(...args),
  appendOrReplaceEvent: (...args: unknown[]) => appendOrReplaceEvent(...args),
  getLastResolvedModelRef: vi.fn(() => null),
  getUrsaPipeline: (...args: [string]) => getUrsaPipeline(...args),
  advanceUrsaPipeline: vi.fn(),
  setUrsaPipelineStatus: (...args: unknown[]) => setUrsaPipelineStatus(...(args as [string, string])),
  setModelRef: vi.fn()
}))

// index.ts imports these from ./graph (and calls setOnResumeSettled at module
// load); mock the module so the heavy deepagents/langchain graph never loads.
const rehydratePausedRun = vi.fn<(...args: unknown[]) => Promise<boolean>>()

vi.mock('./graph', () => ({
  rehydratePausedRun: (...args: unknown[]) => rehydratePausedRun(...(args as [])),
  cancelPendingApproval: vi.fn(),
  resolveInterrupt: vi.fn(),
  runGraph: vi.fn(),
  setOnResumeSettled: vi.fn()
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

import { resumeInterruptedRuns, selectDanglingConversations } from './index'

function meta(id: string, modelRef: string | null = 'anthropic/claude-sonnet-5'): ConversationMeta {
  return {
    id,
    projectPath: null,
    title: null,
    modelRef,
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'accept-edits',
    activeRules: []
  }
}

function makeSink(): RunSink & {
  emit: ReturnType<typeof vi.fn>
  setState: ReturnType<typeof vi.fn>
  metaChanged: ReturnType<typeof vi.fn>
} {
  const emit = vi.fn<RunSink['emit']>()
  const setState = vi.fn<RunSink['setState']>()
  const metaChanged = vi.fn<RunSink['metaChanged']>()
  return { emit, setState, metaChanged }
}

describe('selectDanglingConversations (pure)', () => {
  it('keeps only conversations in the zombie-patched set', () => {
    const metas = [meta('a'), meta('b'), meta('c')]
    const result = selectDanglingConversations(metas, ['a', 'c'])
    expect(result.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('excludes conversations with an active in-process run (TOCTOU guard)', () => {
    const metas = [meta('a'), meta('b')]
    const result = selectDanglingConversations(metas, ['a', 'b'], new Set(['a']))
    expect(result.map((m) => m.id)).toEqual(['b'])
  })

  it('is a no-op detector when the zombie list is empty', () => {
    const metas = [meta('a')]
    expect(selectDanglingConversations(metas, [])).toEqual([])
  })
})

describe('resumeInterruptedRuns', () => {
  beforeEach(() => {
    listConversations.mockReset()
    getZombieRunIds.mockReset()
    getConversationMeta.mockReset()
    getEvents.mockReset()
    getEvents.mockReturnValue([])
    appendEvent.mockReset()
    rehydratePausedRun.mockReset()
    getUrsaPipeline.mockReset()
    getUrsaPipeline.mockReturnValue(undefined)
    setUrsaPipelineStatus.mockReset()
    appendOrReplaceEvent.mockReset()
  })

  it('resumable approval-paused conversation: rehydrated, NOT marked cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-resumable')])
    getZombieRunIds.mockReturnValue(['convo-resumable'])
    rehydratePausedRun.mockResolvedValue(true)
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(rehydratePausedRun).toHaveBeenCalledTimes(1)
    // rehydratePausedRun drives the awaiting-approval state itself; the scan
    // must NOT then broadcast cancelled over it.
    expect(sink.setState).not.toHaveBeenCalledWith('convo-resumable', 'cancelled')
  })

  it('dangling but not resumable (no interrupt): degrades to cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-midstream')])
    getZombieRunIds.mockReturnValue(['convo-midstream'])
    rehydratePausedRun.mockResolvedValue(false)
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(rehydratePausedRun).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledWith('convo-midstream', 'cancelled')
  })

  it('Ursa Phase 2: a non-resumable RUNNING pipeline is marked stopped (no zombie row)', async () => {
    listConversations.mockReturnValue([meta('convo-pipeline')])
    getZombieRunIds.mockReturnValue(['convo-pipeline'])
    rehydratePausedRun.mockResolvedValue(false) // crash left no resumable checkpoint
    getUrsaPipeline.mockReturnValue({ status: 'running' })
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('convo-pipeline', 'stopped')
    expect(sink.setState).toHaveBeenCalledWith('convo-pipeline', 'cancelled')
  })

  it('Ursa Phase 2: a RESUMABLE pipeline is left running (advances via onResumeSettled later)', async () => {
    listConversations.mockReturnValue([meta('convo-pipeline')])
    getZombieRunIds.mockReturnValue(['convo-pipeline'])
    rehydratePausedRun.mockResolvedValue(true) // the paused step re-parked cleanly
    getUrsaPipeline.mockReturnValue({ status: 'running' })
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    // Left 'running': the re-parked step will advance the pipeline once it settles.
    expect(setUrsaPipelineStatus).not.toHaveBeenCalled()
    expect(sink.setState).not.toHaveBeenCalledWith('convo-pipeline', 'cancelled')
  })

  it('Ursa Phase 2: a crashed PROPOSAL is neutralized (stopped + card flipped to denied)', async () => {
    // A crash while a pipeline proposal was still awaiting consent. The proposal
    // is pre-graph (never a resumable interrupt), so rehydrate returns false. If
    // the row were left 'proposed', the conversation degrades to 'cancelled' (re-
    // enabling the composer) yet resolveUrsaPipelineOrchestrator would still
    // accept a stale Approve and overwrite a fresh run's AbortController. The scan
    // must mark it 'stopped' and flip the persisted card to 'denied'.
    listConversations.mockReturnValue([meta('convo-proposal')])
    getZombieRunIds.mockReturnValue(['convo-proposal'])
    rehydratePausedRun.mockResolvedValue(false)
    getUrsaPipeline.mockReturnValue({
      status: 'proposed',
      callId: 'call-xyz',
      steps: [{ role: 'planner', modelRef: 'anthropic/x', subtask: 'plan' }]
    })
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('convo-proposal', 'stopped')
    // The persisted synthetic card is flipped to denied (emit + durable replace).
    const flipped = {
      type: 'tool_call',
      id: 'call-xyz',
      tool: 'ursa_pipeline',
      input: { steps: [{ role: 'planner', modelRef: 'anthropic/x', subtask: 'plan' }] },
      approvalState: 'denied'
    }
    expect(sink.emit).toHaveBeenCalledWith('convo-proposal', flipped)
    expect(appendOrReplaceEvent).toHaveBeenCalledWith('convo-proposal', flipped)
    expect(sink.setState).toHaveBeenCalledWith('convo-proposal', 'cancelled')
  })

  it('dangling with no modelRef: cancelled without attempting rehydrate', async () => {
    listConversations.mockReturnValue([meta('convo-no-model', null)])
    getZombieRunIds.mockReturnValue(['convo-no-model'])
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(rehydratePausedRun).not.toHaveBeenCalled()
    expect(sink.setState).toHaveBeenCalledWith('convo-no-model', 'cancelled')
  })

  it('non-dangling conversation: no rehydrate, no rebroadcast', async () => {
    listConversations.mockReturnValue([meta('convo-clean')])
    getZombieRunIds.mockReturnValue([]) // boot scan found nothing to patch
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(rehydratePausedRun).not.toHaveBeenCalled()
    expect(sink.setState).not.toHaveBeenCalled()
  })

  it('resumes and degrades independently per conversation', async () => {
    listConversations.mockReturnValue([meta('resumable'), meta('midstream'), meta('clean')])
    getZombieRunIds.mockReturnValue(['resumable', 'midstream'])
    rehydratePausedRun.mockImplementation(async (id: unknown) => id === 'resumable')
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(rehydratePausedRun).toHaveBeenCalledTimes(2)
    expect(sink.setState).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledWith('midstream', 'cancelled')
  })

  it('does not throw when rehydrate fails, and still degrades to cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-rehydrate-error')])
    getZombieRunIds.mockReturnValue(['convo-rehydrate-error'])
    rehydratePausedRun.mockRejectedValue(new Error('checkpoint read failed'))
    const sink = makeSink()

    await expect(resumeInterruptedRuns(sink)).resolves.toBeUndefined()

    expect(sink.setState).toHaveBeenCalledWith('convo-rehydrate-error', 'cancelled')
  })
})
