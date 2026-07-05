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

vi.mock('../db', () => ({
  listConversations: (...args: unknown[]) => listConversations(...(args as [])),
  getZombieRunIds: (...args: unknown[]) => getZombieRunIds(...(args as [])),
  getConversationMeta: (...args: [string]) => getConversationMeta(...args),
  getEvents: (...args: unknown[]) => getEvents(...(args as [])),
  appendEvent: (...args: unknown[]) => appendEvent(...args),
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
    executionMode: 'planning'
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
