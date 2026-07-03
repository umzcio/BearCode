import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConversationMeta } from '../../shared/types'
import type { RunSink } from '../ursa/run'

// resumeInterruptedRuns' detection must not depend on any event's message
// string (see the fix for the reviewer finding on Task 7): it consumes the
// authoritative "which conversations did the boot scan patch" list from
// `getZombieRunIds()`, then cross-checks the (separate) LangGraph
// checkpointer. These mocks let the branches that can't be triggered by a
// live run -- checkpoint present vs. absent, dangling vs. not -- be exercised
// directly.
const listConversations = vi.fn<() => ConversationMeta[]>()
const getZombieRunIds = vi.fn<() => string[]>()
const getConversationMeta = vi.fn<(id: string) => ConversationMeta | null>()
const appendEvent = vi.fn()

vi.mock('../db', () => ({
  listConversations: (...args: unknown[]) => listConversations(...(args as [])),
  getZombieRunIds: (...args: unknown[]) => getZombieRunIds(...(args as [])),
  getConversationMeta: (...args: [string]) => getConversationMeta(...args),
  appendEvent: (...args: unknown[]) => appendEvent(...args)
}))

const getTuple = vi.fn()

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple })
}))

import { resumeInterruptedRuns, selectDanglingConversations } from './index'

function meta(id: string): ConversationMeta {
  return { id, projectPath: null, title: null, modelRef: null, createdAt: 0, updatedAt: 0 }
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
    appendEvent.mockReset()
    getTuple.mockReset()
  })

  it('dangling conversation WITH a checkpoint present: still rebroadcasts cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-with-checkpoint')])
    getZombieRunIds.mockReturnValue(['convo-with-checkpoint'])
    getTuple.mockResolvedValue({
      config: { configurable: { checkpoint_id: 'chk-1' } },
      checkpoint: {},
      metadata: {}
    })
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: 'convo-with-checkpoint' } })
    expect(sink.setState).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledWith('convo-with-checkpoint', 'cancelled')
  })

  it('dangling conversation with NO checkpoint: still rebroadcasts cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-no-checkpoint')])
    getZombieRunIds.mockReturnValue(['convo-no-checkpoint'])
    getTuple.mockResolvedValue(undefined)
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: 'convo-no-checkpoint' } })
    expect(sink.setState).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledWith('convo-no-checkpoint', 'cancelled')
  })

  it('non-dangling conversation: no cross-check, no rebroadcast', async () => {
    listConversations.mockReturnValue([meta('convo-clean')])
    getZombieRunIds.mockReturnValue([]) // boot scan found nothing to patch
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(getTuple).not.toHaveBeenCalled()
    expect(sink.setState).not.toHaveBeenCalled()
  })

  it('cross-checks and rebroadcasts independently per conversation', async () => {
    listConversations.mockReturnValue([meta('dangling'), meta('clean')])
    getZombieRunIds.mockReturnValue(['dangling'])
    getTuple.mockResolvedValue(undefined)
    const sink = makeSink()

    await resumeInterruptedRuns(sink)

    expect(getTuple).toHaveBeenCalledTimes(1)
    expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: 'dangling' } })
    expect(sink.setState).toHaveBeenCalledTimes(1)
    expect(sink.setState).toHaveBeenCalledWith('dangling', 'cancelled')
  })

  it('does not throw when the checkpointer lookup fails, and still rebroadcasts cancelled', async () => {
    listConversations.mockReturnValue([meta('convo-checkpoint-error')])
    getZombieRunIds.mockReturnValue(['convo-checkpoint-error'])
    getTuple.mockRejectedValue(new Error('disk read failed'))
    const sink = makeSink()

    await expect(resumeInterruptedRuns(sink)).resolves.toBeUndefined()

    expect(sink.setState).toHaveBeenCalledWith('convo-checkpoint-error', 'cancelled')
  })
})
