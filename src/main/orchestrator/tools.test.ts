import { describe, it, expect, vi, beforeEach } from 'vitest'

// tools.ts imports ../permissions, which reaches ../db (electron/sqlite at
// call time); mock the whole module so importing the module under test never
// opens a real database, and so the deny gate's rules-engine calls are
// observable.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run')
}))
vi.mock('../db', () => ({
  appendOrReplaceEvent: vi.fn()
}))
vi.mock('../artifacts/store', () => ({
  createPlanArtifact: vi.fn(),
  createWalkthroughArtifact: vi.fn()
}))

import { evaluateCommandForConversation } from '../permissions'
import type { Artifact, Event } from '../../shared/types'
import type { RunSink } from '../sink'
import { appendOrReplaceEvent } from '../db'
import { createPlanArtifact, createWalkthroughArtifact } from '../artifacts/store'
import {
  buildTools,
  clearDeniedReplayPins,
  pinDeniedReplays,
  takeDeniedEditReplayPin,
  takeDeniedReplayPin
} from './tools'

const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'art-1',
  conversationId: 'convo',
  type: 'plan',
  version: 1,
  title: 'Add dark mode',
  body: '# Plan body',
  status: 'approved',
  createdAt: 1,
  resolvedAt: 1,
  ...over
})

// Test-only widening: the three tools' zod-inferred types don't share an
// invoke signature, and the tests only care about name + string result.
interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const allTools = (sink: RunSink): InvokableTool[] =>
  buildTools('/tmp', 'convo', sink) as unknown as InvokableTool[]

beforeEach(() => {
  clearDeniedReplayPins('convo')
  clearDeniedReplayPins('other')
  vi.mocked(evaluateCommandForConversation).mockClear()
  vi.mocked(evaluateCommandForConversation).mockReturnValue('run')
  vi.mocked(createPlanArtifact).mockClear()
  vi.mocked(createWalkthroughArtifact).mockClear()
  vi.mocked(appendOrReplaceEvent).mockClear()
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
    const [runCommandTool] = allTools(makeSink())
    const out = await runCommandTool.invoke(
      { command: 'git push --force origin main' },
      { toolCallId: 'tc9' }
    )
    expect(out).toBe('User denied this command.')
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
  })

  it('falls through to normal evaluation when not pinned', async () => {
    vi.mocked(evaluateCommandForConversation).mockReturnValue('block')
    const [runCommandTool] = allTools(makeSink())
    const out = await runCommandTool.invoke({ command: 'rm -rf /' }, { toolCallId: 'tc1' })
    expect(out).toBe('This command was blocked by a permission rule.')
    expect(evaluateCommandForConversation).toHaveBeenCalledWith('rm -rf /', 'convo', '/tmp')
  })
})

describe('submit_plan / submit_walkthrough (Ba1 artifact substrate)', () => {
  const toolsFor = (
    sink: RunSink
  ): { submitPlan: InvokableTool; submitWalkthrough: InvokableTool } => {
    const tools = allTools(sink)
    return {
      submitPlan: tools.find((t) => t.name === 'submit_plan')!,
      submitWalkthrough: tools.find((t) => t.name === 'submit_walkthrough')!
    }
  }

  it('registers both tools alongside run_command', () => {
    const names = allTools(makeSink()).map((t) => t.name)
    expect(names).toEqual(['run_command', 'submit_plan', 'submit_walkthrough'])
  })

  it('always-proceed: returns the approval copy and emits+persists one approved artifact event', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ status: 'approved' }),
      policy: 'always-proceed'
    })
    const sink = makeSink()
    const { submitPlan } = toolsFor(sink)
    const out = await submitPlan.invoke({ title: 'Add dark mode', body: '# Plan body' })
    expect(out).toBe('Plan approved. Begin implementation.')
    // Id-less invoke (no config): the deterministic-id path falls back to a
    // random id, still passed through to the store as the 4th argument.
    expect(createPlanArtifact).toHaveBeenCalledWith(
      'convo',
      'Add dark mode',
      '# Plan body',
      expect.any(String)
    )
    expect(sink.emit).toHaveBeenCalledTimes(1)
    const [convoId, event] = vi.mocked(sink.emit).mock.calls[0] as [string, Event]
    expect(convoId).toBe('convo')
    expect(event).toMatchObject({
      type: 'artifact',
      artifactId: 'art-1',
      artifactType: 'plan',
      version: 1,
      title: 'Add dark mode',
      status: 'approved',
      body: '# Plan body'
    })
    // Persisted with the exact same event object the renderer saw --
    // appendOrReplaceEvent so a crash-rehydration replay replaces in place.
    expect(appendOrReplaceEvent).toHaveBeenCalledWith('convo', event)
  })

  it('request-review: returns immediately with awaiting-review copy; artifact event is pending-review', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ status: 'pending-review', version: 2, resolvedAt: null }),
      policy: 'request-review'
    })
    const sink = makeSink()
    const { submitPlan } = toolsFor(sink)
    const out = await submitPlan.invoke({ title: 'Add dark mode', body: '# Plan body' })
    expect(out).toBe(
      "Plan v2 recorded. It is awaiting the user's review in the artifacts pane. " +
        "Do not begin implementation; wait for the user's decision or feedback before making any changes."
    )
    const [, event] = vi.mocked(sink.emit).mock.calls[0] as [string, Event]
    expect(event).toMatchObject({ type: 'artifact', status: 'pending-review', version: 2 })
  })

  it('rejects an empty title or body with an error string and records nothing', async () => {
    const sink = makeSink()
    const { submitPlan, submitWalkthrough } = toolsFor(sink)
    const p = await submitPlan.invoke({ title: '  ', body: 'x' })
    expect(p).toBe(
      'submit_plan needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
    )
    const w = await submitWalkthrough.invoke({ title: 'T', body: '' })
    expect(w).toBe(
      'submit_walkthrough needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
    )
    expect(createPlanArtifact).not.toHaveBeenCalled()
    expect(createWalkthroughArtifact).not.toHaveBeenCalled()
    expect(sink.emit).not.toHaveBeenCalled()
    expect(appendOrReplaceEvent).not.toHaveBeenCalled()
  })

  it('submit_walkthrough acks and emits a final artifact event', async () => {
    vi.mocked(createWalkthroughArtifact).mockReturnValue(
      art({ id: 'art-2', type: 'walkthrough', status: 'final', title: 'What changed' })
    )
    const sink = makeSink()
    const { submitWalkthrough } = toolsFor(sink)
    const out = await submitWalkthrough.invoke({ title: 'What changed', body: '## Summary' })
    expect(out).toBe('Walkthrough v1 recorded.')
    const [, event] = vi.mocked(sink.emit).mock.calls[0] as [string, Event]
    expect(event).toMatchObject({
      type: 'artifact',
      artifactId: 'art-2',
      artifactType: 'walkthrough',
      status: 'final'
    })
  })

  it('replay-idempotent by key: the same toolCallId derives the same artifact id and event id on re-execution', async () => {
    // Crash-rehydration can RE-EXECUTE a completed submit tool (durability
    // 'async'; bearcode.db and checkpoints.db share no transaction). Two
    // invocations with the same provider tool-call id must converge on ONE
    // artifact row and ONE persisted event, with version/supersede state
    // untouched by the second call (the store's existence check, Task 2).
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ id: 'convo:tc1:artifact' }),
      policy: 'always-proceed'
    })
    const sink = makeSink()
    const { submitPlan } = toolsFor(sink)
    await submitPlan.invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    await submitPlan.invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    // Same deterministic artifact id both times -> the store returns the
    // existing row on the second call: exactly one artifact row.
    expect(createPlanArtifact).toHaveBeenNthCalledWith(1, 'convo', 'T', 'B', 'convo:tc1:artifact')
    expect(createPlanArtifact).toHaveBeenNthCalledWith(2, 'convo', 'T', 'B', 'convo:tc1:artifact')
    // Same deterministic event id both times -> appendOrReplaceEvent replaces
    // the row in place (exactly one persisted event) and the renderer upserts.
    const persisted = vi.mocked(appendOrReplaceEvent).mock.calls.map(([, e]) => e as Event)
    expect(persisted).toHaveLength(2)
    expect(persisted[0].id).toBe('convo:tc1:artifact-event')
    expect(persisted[1].id).toBe('convo:tc1:artifact-event')
  })

  it('SECURITY: submit tools never consult the permission engine (nothing to gate)', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({ artifact: art(), policy: 'always-proceed' })
    const { submitPlan } = toolsFor(makeSink())
    await submitPlan.invoke({ title: 'T', body: 'B' })
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
  })
})
