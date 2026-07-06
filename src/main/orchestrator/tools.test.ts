import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// tools.ts imports ../permissions, which reaches ../db (electron/sqlite at
// call time); mock the whole module so importing the module under test never
// opens a real database, and so the deny gate's rules-engine calls are
// observable.
vi.mock('../permissions', () => ({
  evaluateCommandForConversation: vi.fn(() => 'run'),
  resolveConversationMode: vi.fn(() => 'accept-edits')
}))
vi.mock('../db', () => ({
  appendOrReplaceEvent: vi.fn()
}))
vi.mock('../artifacts/store', () => ({
  createPlanArtifact: vi.fn(),
  createWalkthroughArtifact: vi.fn(),
  approvePlanArtifact: vi.fn()
}))
vi.mock('../agentsDir', () => ({
  loadAgentsContent: vi.fn(() => ({ rules: [], workflows: [] }))
}))
// Spread-importOriginal: only `interrupt` is stubbed, everything else
// @langchain/langgraph exports (Command, etc.) stays live for this file.
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn()
}))

import { evaluateCommandForConversation, resolveConversationMode } from '../permissions'
import type { Artifact, Event } from '../../shared/types'
import type { RunSink } from '../sink'
import { appendOrReplaceEvent } from '../db'
import {
  createPlanArtifact,
  createWalkthroughArtifact,
  approvePlanArtifact
} from '../artifacts/store'
import { loadAgentsContent } from '../agentsDir'
import type { Rule } from '../agentsDir/types'
import { interrupt } from '@langchain/langgraph'
import {
  buildTools,
  clearAllPlanReviewPending,
  clearDeniedReplayPins,
  pinDeniedReplays,
  takeDeniedEditReplayPin,
  takeDeniedReplayPin,
  tryEnterPlanReview
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
  buildTools('/tmp', 'convo', sink, 'group-1') as unknown as InvokableTool[]

beforeEach(() => {
  clearDeniedReplayPins('convo')
  clearDeniedReplayPins('other')
  clearAllPlanReviewPending()
  vi.mocked(evaluateCommandForConversation).mockClear()
  vi.mocked(evaluateCommandForConversation).mockReturnValue('run')
  vi.mocked(resolveConversationMode).mockReturnValue('accept-edits')
  vi.mocked(createPlanArtifact).mockClear()
  vi.mocked(createWalkthroughArtifact).mockClear()
  vi.mocked(approvePlanArtifact).mockReset()
  vi.mocked(appendOrReplaceEvent).mockClear()
  vi.mocked(interrupt).mockReset()
  vi.mocked(loadAgentsContent).mockReturnValue({ rules: [], workflows: [] })
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

  it('block in plan mode returns the read-only message, not the generic rule message', async () => {
    vi.mocked(evaluateCommandForConversation).mockReturnValue('block')
    vi.mocked(resolveConversationMode).mockReturnValue('plan')
    const [runCommandTool] = allTools(makeSink())
    const out = await runCommandTool.invoke({ command: 'npm test' }, { toolCallId: 'tcP' })
    expect(out).toBe(
      'Plan mode is read-only; submit a plan and wait for approval before editing or running commands.'
    )
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
    expect(names).toEqual([
      'run_command',
      'submit_plan',
      'submit_walkthrough',
      'activate_rule',
      'generate_document'
    ])
  })

  it('always-proceed: returns the approval copy and emits+persists one approved artifact event', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ status: 'approved' }),
      policy: 'always-proceed',
      superseded: []
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

  // The Ba1-era "request-review returns immediately" behavior is superseded
  // by Ba2's plan_review interrupt (see the 'plan_review interrupt (Ba2
  // proceed loop)' suite below): request-review now PAUSES via interrupt()
  // instead of returning a hold-copy string, so that scenario is covered
  // there instead of here.

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

  it('replay-idempotent by key: the same toolCallId AND content derive the same artifact id and event id on re-execution', async () => {
    // Crash-rehydration can RE-EXECUTE a completed submit tool (durability
    // 'async'; bearcode.db and checkpoints.db share no transaction). A true
    // replay carries the identical title+body, so two invocations with the
    // same provider tool-call id and the same content must converge on ONE
    // artifact row and ONE persisted event, with version/supersede state
    // untouched by the second call (the store's existence check, Task 2).
    // f1578752dda3ef03 = sha256(JSON.stringify(['T', 'B'])).slice(0, 16), the
    // content-hash segment of the deterministic key (injective JSON input,
    // I3: plain concatenation is not injective across title/body).
    const expectedId = 'convo:tc1:f1578752dda3ef03:artifact'
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ id: expectedId }),
      policy: 'always-proceed',
      superseded: []
    })
    const sink = makeSink()
    const { submitPlan } = toolsFor(sink)
    await submitPlan.invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    await submitPlan.invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    // Same deterministic artifact id both times -> the store returns the
    // existing row on the second call: exactly one artifact row.
    expect(createPlanArtifact).toHaveBeenNthCalledWith(1, 'convo', 'T', 'B', expectedId)
    expect(createPlanArtifact).toHaveBeenNthCalledWith(2, 'convo', 'T', 'B', expectedId)
    // Same deterministic event id both times -> appendOrReplaceEvent replaces
    // the row in place (exactly one persisted event) and the renderer upserts.
    const persisted = vi.mocked(appendOrReplaceEvent).mock.calls.map(([, e]) => e as Event)
    expect(persisted).toHaveLength(2)
    expect(persisted[0].id).toBe('convo:tc1:f1578752dda3ef03:artifact-event')
    expect(persisted[1].id).toBe('convo:tc1:f1578752dda3ef03:artifact-event')
  })

  it('collision-safe by content: the same toolCallId with DIFFERENT content derives different ids', async () => {
    // Provider tool-call ids can REPEAT across iterations for non-Anthropic
    // providers (graph.ts callIdMap). A NEW plan under a reused tc.id must not
    // hit the store's existence check and silently resurrect the OLD row (and
    // its recorded policy -- possibly an approval the user never granted for
    // this plan): different content must fold to a different deterministic id
    // so the store records a fresh row and a fresh event.
    // Mirror the store's real contract (the returned artifact carries the id
    // it was called with) since event ids now derive from artifact.id, not a
    // second independently-hashed value.
    vi.mocked(createPlanArtifact).mockImplementation((_convo, _title, _body, id) => ({
      artifact: art({ id }),
      policy: 'always-proceed',
      superseded: []
    }))
    const sink = makeSink()
    const { submitPlan } = toolsFor(sink)
    await submitPlan.invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    await submitPlan.invoke({ title: 'T2', body: 'B' }, { toolCallId: 'tc1' })
    await submitPlan.invoke({ title: 'T', body: 'B2' }, { toolCallId: 'tc1' })
    const artifactIds = vi.mocked(createPlanArtifact).mock.calls.map((c) => c[3])
    expect(artifactIds).toHaveLength(3)
    expect(new Set(artifactIds).size).toBe(3)
    const eventIds = vi.mocked(appendOrReplaceEvent).mock.calls.map(([, e]) => (e as Event).id)
    expect(new Set(eventIds).size).toBe(3)
  })

  it('SECURITY: submit tools never consult the permission engine (nothing to gate)', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art(),
      policy: 'always-proceed',
      superseded: []
    })
    const { submitPlan } = toolsFor(makeSink())
    await submitPlan.invoke({ title: 'T', body: 'B' })
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
  })
})

describe('plan_review interrupt (Ba2 proceed loop)', () => {
  const pendingArt = (over: Partial<Artifact> = {}): Artifact =>
    art({ status: 'pending-review', resolvedAt: null, ...over })
  const submitPlanOf = (sink: RunSink): InvokableTool =>
    allTools(sink).find((t) => t.name === 'submit_plan')!
  // The deterministic key the tool derives (content-hashed since 8d5a51f;
  // injective JSON input per this plan's Global Constraints / I3). Computed,
  // not hardcoded, so these tests state the derivation rule itself.
  const artifactIdOf = (tc: string, title: string, body: string): string =>
    `convo:${tc}:${createHash('sha256')
      .update(JSON.stringify([title, body]))
      .digest('hex')
      .slice(0, 16)}:artifact`

  it('request-review: creates the pending row and emits its event BEFORE interrupting, with the full payload', async () => {
    const planId = artifactIdOf('tc1', 'Add dark mode', '# Plan')
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: planId }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: true })
    vi.mocked(approvePlanArtifact).mockReturnValue(pendingArt({ id: planId, status: 'approved' }))
    const sink = makeSink()
    await submitPlanOf(sink).invoke(
      { title: 'Add dark mode', body: '# Plan' },
      { toolCallId: 'tc1' }
    )
    expect(createPlanArtifact).toHaveBeenCalledWith('convo', 'Add dark mode', '# Plan', planId)
    expect(interrupt).toHaveBeenCalledWith({
      kind: 'plan_review',
      artifactId: planId,
      title: 'Add dark mode',
      toolCallId: 'tc1'
    })
    // Ordering: row, event, THEN interrupt (the pause must have something to show).
    expect(vi.mocked(createPlanArtifact).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(interrupt).mock.invocationCallOrder[0]
    )
    const firstEmitOrder = (vi.mocked(sink.emit).mock.invocationCallOrder as number[])[0]
    expect(firstEmitOrder).toBeLessThan(vi.mocked(interrupt).mock.invocationCallOrder[0])
  })

  it('proceed resume: approves the artifact, re-emits its event under the SAME id, returns the approval copy', async () => {
    const planId = artifactIdOf('tc1', 'T', 'B')
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: planId }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: true })
    vi.mocked(approvePlanArtifact).mockReturnValue(art({ id: planId, status: 'approved' }))
    const sink = makeSink()
    const out = await submitPlanOf(sink).invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc1' })
    expect(out).toBe('Plan approved. Begin implementation.')
    // The approve flip writes 'approved' -- the ONLY status the store's
    // fail-safe replay reconstruction maps to always-proceed (8d5a51f), so a
    // post-proceed crash replay returns approval copy without re-interrupting.
    expect(approvePlanArtifact).toHaveBeenCalledWith(planId)
    const events = vi.mocked(appendOrReplaceEvent).mock.calls.map(([, e]) => e as Event)
    const artifactEvents = events.filter((e) => e.type === 'artifact')
    expect(artifactEvents).toHaveLength(2) // pending, then approved
    expect(artifactEvents[0].id).toBe(`${planId}-event`)
    expect(artifactEvents[1].id).toBe(`${planId}-event`) // SAME id: replaces in place
    expect((artifactEvents[1] as Extract<Event, { type: 'artifact' }>).status).toBe('approved')
  })

  it('proceed with comments: appends the steering block to the approval copy', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: 'a' }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: true, comments: '> quote\n\nnote' })
    vi.mocked(approvePlanArtifact).mockReturnValue(art({ id: 'a', status: 'approved' }))
    const out = await submitPlanOf(makeSink()).invoke({ title: 'T', body: 'B' })
    expect(out).toBe(
      'Plan approved. Begin implementation.\n\nThe user attached comments to guide the implementation:\n\n> quote\n\nnote'
    )
  })

  it('feedback resume: returns the prefixed feedback and leaves the artifact pending (no approve, no status re-emit)', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: 'a' }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: false, feedback: '> quote\n\nchange this' })
    const sink = makeSink()
    const out = await submitPlanOf(sink).invoke({ title: 'T', body: 'B' })
    expect(out).toBe(
      'The user reviewed the plan and left feedback instead of proceeding:\n\n> quote\n\nchange this'
    )
    expect(approvePlanArtifact).not.toHaveBeenCalled()
    const artifactEvents = vi
      .mocked(appendOrReplaceEvent)
      .mock.calls.map(([, e]) => e as Event)
      .filter((e) => e.type === 'artifact')
    expect(artifactEvents).toHaveLength(1) // only the pending emit; artifact STAYS pending
  })

  it('a v2 submission re-emits every superseded prior under ITS deterministic event id (chip un-stale)', async () => {
    // v1's key came from ITS OWN submission (different toolCallId + content);
    // its event id must be derivable from its row id alone: `${id}-event`.
    const v1Id = artifactIdOf('tc1', 'T', 'old body')
    const v2Id = artifactIdOf('tc2', 'T', 'B')
    const v1 = art({ id: v1Id, status: 'superseded', version: 1, resolvedAt: 9 })
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: v2Id, version: 2 }),
      policy: 'request-review',
      superseded: [v1]
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: false, feedback: 'x' })
    const sink = makeSink()
    await submitPlanOf(sink).invoke({ title: 'T', body: 'B' }, { toolCallId: 'tc2' })
    const artifactEvents = vi
      .mocked(appendOrReplaceEvent)
      .mock.calls.map(([, e]) => e as Extract<Event, { type: 'artifact' }>)
      .filter((e) => e.type === 'artifact')
    expect(artifactEvents[0]).toMatchObject({
      id: `${v1Id}-event`,
      artifactId: v1Id,
      status: 'superseded'
    })
    expect(artifactEvents[1]).toMatchObject({
      id: `${v2Id}-event`,
      status: 'pending-review',
      version: 2
    })
  })

  it('design 5: a second submit while a review is pending errors WITHOUT recording anything', async () => {
    tryEnterPlanReview('convo', 'someone-elses-artifact')
    const out = await submitPlanOf(makeSink()).invoke(
      { title: 'T', body: 'B' },
      { toolCallId: 'tc9' }
    )
    expect(out).toBe(
      "A plan is already awaiting the user's review in this conversation. Wait for that review to be resolved before submitting another plan."
    )
    expect(createPlanArtifact).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('the gate re-admits the SAME artifactId (replay of the paused submission derives the same content-hashed key)', async () => {
    const planId = artifactIdOf('tc1', 'T', 'B')
    tryEnterPlanReview('convo', planId)
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: planId }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: true })
    vi.mocked(approvePlanArtifact).mockReturnValue(art({ id: planId, status: 'approved' }))
    const out = await submitPlanOf(makeSink()).invoke(
      { title: 'T', body: 'B' },
      { toolCallId: 'tc1' }
    )
    expect(out).toBe('Plan approved. Begin implementation.')
  })

  it('a replayed submission whose plan was superseded returns the notice without pausing (fail-safe policy path)', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ id: 'old', status: 'superseded' }),
      // 8d5a51f fail-safe: only 'approved' reconstructs always-proceed, so a
      // superseded row replays into the request-review path -- the tool's own
      // superseded guard must screen it BEFORE the interrupt.
      policy: 'request-review',
      superseded: []
    })
    const out = await submitPlanOf(makeSink()).invoke(
      { title: 'T', body: 'B' },
      { toolCallId: 'tc1' }
    )
    expect(out).toBe(
      'This plan was superseded by a newer plan submission. Continue from the newest plan.'
    )
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('always-proceed regression: no interrupt, immediate approval (Ba1 path unchanged)', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: art({ status: 'approved' }),
      policy: 'always-proceed',
      superseded: []
    })
    const out = await submitPlanOf(makeSink()).invoke({ title: 'T', body: 'B' })
    expect(out).toBe('Plan approved. Begin implementation.')
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('SECURITY: the paused-and-resumed submit still never consults the permission engine', async () => {
    vi.mocked(createPlanArtifact).mockReturnValue({
      artifact: pendingArt({ id: 'a' }),
      policy: 'request-review',
      superseded: []
    })
    vi.mocked(interrupt).mockReturnValue({ proceed: true })
    vi.mocked(approvePlanArtifact).mockReturnValue(art({ id: 'a', status: 'approved' }))
    await submitPlanOf(makeSink()).invoke({ title: 'T', body: 'B' })
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
  })

  // Fail-safe resume handling (binding invariant): ONLY a well-formed
  // { proceed: true } resolution may reach approval. Every falsy or malformed
  // resume value -- including the run_command approval shape arriving on the
  // wrong interrupt -- must fall to the feedback branch with the generic
  // message: no approvePlanArtifact call, no approved re-emit, artifact stays
  // pending. Never to approval.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['an empty object (no proceed key)', {}],
    ['the run_command shape { approved: true } (wrong kind)', { approved: true }]
  ])(
    'fail-safe: a resume of %s takes the feedback branch, never approval',
    async (_label, resume) => {
      vi.mocked(createPlanArtifact).mockReturnValue({
        artifact: pendingArt({ id: 'a' }),
        policy: 'request-review',
        superseded: []
      })
      vi.mocked(interrupt).mockReturnValue(resume)
      const sink = makeSink()
      const out = await submitPlanOf(sink).invoke({ title: 'T', body: 'B' })
      expect(out).toBe(
        'The user reviewed the plan and left feedback instead of proceeding:\n\nNo feedback was provided.'
      )
      expect(approvePlanArtifact).not.toHaveBeenCalled()
      // Only the pending emit: no status re-emit to approved, artifact STAYS pending.
      const artifactEvents = vi
        .mocked(appendOrReplaceEvent)
        .mock.calls.map(([, e]) => e as Extract<Event, { type: 'artifact' }>)
        .filter((e) => e.type === 'artifact')
      expect(artifactEvents).toHaveLength(1)
      expect(artifactEvents[0].status).toBe('pending-review')
    }
  )
})

describe('activate_rule (D1 model-decision rules, read-only by construction)', () => {
  const rule = (over: Partial<Rule> = {}): Rule => ({
    name: 'deploy',
    body: 'Deploy via carrier pigeon.',
    activation: 'model',
    globs: [],
    description: 'Deployment steps',
    source: 'project',
    ...over
  })
  const activateRuleOf = (sink: RunSink): InvokableTool =>
    allTools(sink).find((t) => t.name === 'activate_rule')!

  it('returns the body for a model rule, prefixed with the rule name', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({ rules: [rule()], workflows: [] })
    const out = await activateRuleOf(makeSink()).invoke({ name: 'deploy' })
    expect(out).toBe('Rule deploy:\nDeploy via carrier pigeon.')
  })

  it('an unknown name lists the available model-rule candidates', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({
      rules: [rule({ name: 'deploy' }), rule({ name: 'style' })],
      workflows: []
    })
    const out = await activateRuleOf(makeSink()).invoke({ name: 'nope' })
    expect(out).toBe('Unknown rule: nope. Available rules: deploy, style')
  })

  it('manual and always rules are not activatable', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({
      rules: [
        rule({ name: 'manual-one', activation: 'manual' }),
        rule({ name: 'always-one', activation: 'always' })
      ],
      workflows: []
    })
    const out = await activateRuleOf(makeSink()).invoke({ name: 'manual-one' })
    expect(out).toBe('Unknown rule: manual-one. Available rules: ')
  })

  it('an errored rule is not activatable', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({
      rules: [rule({ error: 'missing description' })],
      workflows: []
    })
    const out = await activateRuleOf(makeSink()).invoke({ name: 'deploy' })
    expect(out).toBe('Unknown rule: deploy. Available rules: ')
  })

  it('matches case-foldedly when no exact match exists', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({
      rules: [rule({ name: 'Deploy' })],
      workflows: []
    })
    const out = await activateRuleOf(makeSink()).invoke({ name: 'deploy' })
    expect(out).toBe('Rule Deploy:\nDeploy via carrier pigeon.')
  })

  it('SECURITY: never consults the permission engine and never interrupts', async () => {
    vi.mocked(loadAgentsContent).mockReturnValue({ rules: [rule()], workflows: [] })
    await activateRuleOf(makeSink()).invoke({ name: 'deploy' })
    expect(evaluateCommandForConversation).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })
})
