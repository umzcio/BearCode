import { describe, it, expect, vi, afterEach } from 'vitest'

// graph.ts imports ../db and ./checkpointer, which touch electron/sqlite at
// call time; mock them (same pattern as resume.test.ts) so importing the
// module under test never opens a real database.
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
  dropDanglingApprovalRows: vi.fn(),
  dropDanglingCancel: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  getLastResolvedModelRef: vi.fn(() => null),
  getLastUrsaRole: vi.fn(() => undefined),
  getRecentUrsaContext: vi.fn(() => ''),
  listArtifactComments: vi.fn(() => []),
  markArtifactCommentsSent: vi.fn(),
  setActiveRules: vi.fn(),
  setLastResolvedModelRef: vi.fn(),
  setPermissionMode: vi.fn(),
  setUrsaPipeline: vi.fn(),
  setUrsaPipelineStatus: vi.fn()
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

// Ursa (Phase 1) resolution is mocked so graph.ts's resolveTurnModelRef seam
// can be exercised without the real cheap-model classifier call.
vi.mock('./ursa', () => ({
  URSA_MODEL_REF: 'ursa/auto',
  isUrsaModelRef: (ref: string) => ref === 'ursa/auto',
  resolveUrsaModelRef: vi.fn(),
  // Ursa Arc 2 (Task 2): buildSubagents consults this to route the researcher/
  // browser subagents while Ursa drives a turn. Default empty (no overrides);
  // per-test overridden below.
  resolveSubagentModelRefs: vi.fn(() => ({})),
  // Ursa Phase 2 (Task 3): the declined-pipeline path recovers a role name from
  // the resolved modelRef. Real reverse-lookup here (it is pure) so the mock
  // stays honest for any test that exercises the ursaResolved branch.
  roleNameForModelRef: (ref: string) =>
    ({
      'openai/gpt-5.6-sol': 'coder',
      'anthropic/claude-sonnet-5': 'reviewer'
    })[ref],
  // Ursa Modes (Task 3): resolveTurnModelRef's 'code' mode branch consults
  // this instead of the classifier. Default undefined (unkeyed) so tests
  // that don't override it exercise the fall-through-to-auto path; per-test
  // overridden for the locked-coder path.
  coderRoleIfEligible: vi.fn(() => undefined),
  // Ursa Modes (Task 6): runGraph's deep-research branch consults this to
  // eligibility-map the preset. Default returns a 3-step pipeline; per-test
  // overridden for the verifier-gate error path.
  resolveDeepResearchPipeline: vi.fn(() => ({
    steps: [
      {
        role: 'verifier',
        modelRef: 'perplexity/sonar-pro',
        subtask: 'search the web'
      },
      {
        role: 'reviewer',
        modelRef: 'anthropic/claude-sonnet-5',
        subtask: 'write the report'
      }
    ]
  }))
}))

// makeModel is mocked so buildSubagents can build distinguishable per-role
// subagent models without constructing a real provider client. Returns a
// tagged sentinel so a test can assert exactly which ref produced which
// subagent's model.
vi.mock('./models', () => ({
  makeModel: vi.fn((ref: string) => ({ __fakeModel: ref }))
}))

// Ursa Modes (Task 4): the council runner is a self-contained module tested in
// council.test.ts; mock it here so runGraph's council-dispatch seam can be
// asserted without driving three model calls + a chair stream.
vi.mock('./council', () => ({
  runCouncil: vi.fn(async () => ({ paused: false }))
}))

import {
  textOfMessage,
  buildUserMessageContent,
  citationsFromMetadata,
  shouldEmitBridgedText,
  shouldRetryEmptyFinal,
  interruptBelongsToToolCall,
  findDanglingRunCommandCalls,
  orderCompletedCallsFirst,
  pairInterruptsToCalls,
  allDecided,
  buildResumeMap,
  deniedToolCallEvents,
  resolvedToolCallEvents,
  deniedReplayPinsOf,
  toolResultOutput,
  synthesizedApprovalCard,
  pairedApprovalInput,
  isRehydratableInterrupt,
  isSkillProposalInterrupt,
  planReviewArtifactIdOf,
  planProceedModeFlip,
  resolvePlanInterrupt,
  resolveSkillProposalInterrupt,
  resolveInterrupt,
  forgetPendingApproval,
  persistRuleMentions,
  resolveTurnModelRef,
  rehydrateModelRef,
  runGraph,
  buildSubagents,
  setStartUrsaPipeline,
  __parkForTest,
  type ApprovalItem
} from './graph'
import {
  resolveUrsaModelRef,
  resolveSubagentModelRefs,
  coderRoleIfEligible,
  resolveDeepResearchPipeline
} from './ursa'
import { makeModel } from './models'
import { runCouncil } from './council'
import {
  getLastResolvedModelRef,
  getLastUrsaRole,
  getRecentUrsaContext,
  setLastResolvedModelRef,
  setUrsaPipeline,
  setUrsaPipelineStatus
} from '../db'
import type { PlanReviewResolution, SkillProposalResolution } from './tools'
import { browserManager } from '../browser/manager'
import type { RunSink } from '../sink'
import type { AttachmentRef } from '../../shared/types'

describe('citationsFromMetadata (Perplexity web sources)', () => {
  it('prefers rich search_results over bare citations urls', () => {
    expect(
      citationsFromMetadata({
        citations: ['https://a.com', 'https://b.com'],
        search_results: [
          { title: 'A', url: 'https://a.com', date: '2026-01-01' },
          { title: 'B', url: 'https://b.com' }
        ]
      })
    ).toEqual([
      { url: 'https://a.com', title: 'A', date: '2026-01-01' },
      { url: 'https://b.com', title: 'B' }
    ])
  })

  it('falls back to bare citation urls', () => {
    expect(citationsFromMetadata({ citations: ['https://a.com'] })).toEqual([
      { url: 'https://a.com' }
    ])
  })

  it('returns [] for absent metadata, foreign providers, and malformed shapes', () => {
    expect(citationsFromMetadata(undefined)).toEqual([])
    expect(citationsFromMetadata({ usage: { total_tokens: 5 } })).toEqual([])
    expect(citationsFromMetadata({ citations: [42, null], search_results: 'nope' })).toEqual([])
  })
})

describe('textOfMessage', () => {
  it('returns a plain-string content as-is', () => {
    expect(textOfMessage('Here are the files.')).toBe('Here are the files.')
  })

  it('concatenates text blocks from a content array', () => {
    expect(
      textOfMessage([
        { type: 'text', text: 'Here are the files: ' },
        { type: 'text', text: 'index.html, style.css' }
      ])
    ).toBe('Here are the files: index.html, style.css')
  })

  it('skips thinking/reasoning and other non-text blocks', () => {
    expect(
      textOfMessage([
        { type: 'thinking', thinking: '**Defining the Core Intent**' },
        { type: 'text', text: 'The folder contains two files.' },
        { type: 'reasoning', reasoning: 'more thoughts' }
      ])
    ).toBe('The folder contains two files.')
  })

  it('returns empty for non-string, non-array content', () => {
    expect(textOfMessage(undefined)).toBe('')
    expect(textOfMessage(null)).toBe('')
    expect(textOfMessage({ type: 'text', text: 'not in an array' })).toBe('')
  })

  it('ignores text blocks whose text field is not a string', () => {
    expect(textOfMessage([{ type: 'text' }, { type: 'text', text: 42 }])).toBe('')
  })
})

describe('buildUserMessageContent', () => {
  const ref = (
    id: string,
    kind: 'image' | 'text' | 'pdf' | 'office' = 'image',
    mime = 'image/png'
  ): { id: string; name: string; mime: string; kind: typeof kind } => ({
    id,
    name: kind === 'pdf' ? `${id}.pdf` : `${id}.png`,
    mime: kind === 'pdf' ? 'application/pdf' : mime,
    kind
  })
  const noBytes = (): string | null => null
  const noSide = (): string | null => null

  it('returns the plain string when there are no attachments', () => {
    expect(buildUserMessageContent('hello', [], noBytes, noSide, { pdfNative: false })).toBe(
      'hello'
    )
  })

  it('image only -> text block then one image block per resolvable image', () => {
    const out = buildUserMessageContent(
      'describe these',
      [ref('a'), ref('b', 'image', 'image/jpeg')],
      (a) => (a.id === 'a' ? 'AAAA' : 'BBBB'),
      noSide,
      { pdfNative: false }
    )
    expect(out).toEqual([
      { type: 'text', text: 'describe these' },
      { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'AAAA' },
      { type: 'image', source_type: 'base64', mime_type: 'image/jpeg', data: 'BBBB' }
    ])
  })

  it('text attachment -> a plain string with a titled section (no blocks)', () => {
    const out = buildUserMessageContent(
      'summarise',
      [{ id: 't1', name: 'a.ts', mime: 'text/plain', kind: 'text' }],
      noBytes,
      () => 'const x = 1',
      { pdfNative: false }
    )
    expect(typeof out).toBe('string')
    expect(out).toContain('summarise')
    expect(out).toContain('## Attached file: a.ts')
    expect(out).toContain('const x = 1')
  })

  it('pdf on a non-capable provider -> inlined sidecar text (string)', () => {
    const out = buildUserMessageContent(
      'q',
      [ref('p', 'pdf')],
      noBytes,
      () => 'extracted pdf text',
      { pdfNative: false }
    )
    expect(typeof out).toBe('string')
    expect(out).toContain('extracted pdf text')
  })

  it('pdf on a capable provider -> native file block with metadata.filename', () => {
    const out = buildUserMessageContent(
      'q',
      [ref('p', 'pdf')],
      () => 'PDFB64',
      () => 'ignored sidecar',
      { pdfNative: true }
    )
    expect(out).toEqual([
      { type: 'text', text: 'q' },
      {
        type: 'file',
        source_type: 'base64',
        mime_type: 'application/pdf',
        data: 'PDFB64',
        metadata: { filename: 'p.pdf' }
      }
    ])
  })

  it('enforces the aggregate inline budget across attachments', () => {
    // Three fixtures so the budget is actually exceeded (512 KB total) AND both
    // notices are reachable: f1 fits whole, f2 crosses the remaining budget
    // (byte-clipped + "truncated" notice), f3 arrives after the budget is spent
    // (fully "omitted"). A 2-file fixture can only ever produce the truncated
    // notice on the crossing file -- never the omitted one.
    const texts: Record<string, string> = {
      f1: 'a'.repeat(300 * 1024),
      f2: 'b'.repeat(300 * 1024),
      f3: 'c'.repeat(50 * 1024)
    }
    const out = buildUserMessageContent(
      'go',
      [
        { id: 'f1', name: 'one.txt', mime: 'text/plain', kind: 'text' },
        { id: 'f2', name: 'two.txt', mime: 'text/plain', kind: 'text' },
        { id: 'f3', name: 'three.txt', mime: 'text/plain', kind: 'text' }
      ],
      noBytes,
      (a) => texts[a.id],
      { pdfNative: false }
    ) as string
    expect(out).toContain('one.txt')
    expect(out).toMatch(/truncated: inlined-content budget reached/)
    expect(out).toMatch(/omitted: inlined-content budget reached/)
  })

  it('notes an attachment whose sidecar is gone rather than dropping it silently', () => {
    const out = buildUserMessageContent(
      'go',
      [{ id: 'g', name: 'gone.txt', mime: 'text/plain', kind: 'text' }],
      noBytes,
      () => null,
      { pdfNative: false }
    ) as string
    expect(out).toContain('(could not read gone.txt)')
  })

  it('back-compat: an attachment with no kind is read as image, never silently dropped', () => {
    const legacy = { id: 'legacy', name: 'legacy.png', mime: 'image/png' } as AttachmentRef
    const out = buildUserMessageContent('describe', [legacy], () => 'LEGACYB64', noSide, {
      pdfNative: false
    })
    expect(out).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'LEGACYB64' }
    ])
  })
})

describe('shouldEmitBridgedText (containment guard)', () => {
  it('emits when the stream delivered no text (Gemini strip case)', () => {
    expect(shouldEmitBridgedText('The folder has two files.', '')).toBe(true)
  })

  it('does NOT emit when the streamed answer already contains the bridged text (kimi/openai/anthropic)', () => {
    // Providers whose stream carries the text accumulate the exact same tokens
    // handleLLMEnd sees, so containment is exact.
    const answer = 'Here are the files in the current folder: index.html, style.css'
    expect(shouldEmitBridgedText(answer, answer)).toBe(false)
  })

  it('does NOT emit when the bridged text is a substring of a longer streamed answer', () => {
    expect(shouldEmitBridgedText('index.html', 'The files are index.html and style.css')).toBe(
      false
    )
  })

  it('never emits empty bridged text', () => {
    expect(shouldEmitBridgedText('', '')).toBe(false)
  })

  it('emits when the streamed answer differs from the bridged text', () => {
    expect(shouldEmitBridgedText('Full final answer.', 'partial intro only')).toBe(true)
  })
})

describe('shouldRetryEmptyFinal (empty-final decision)', () => {
  it('retries when tools ran, no answer accumulated, and no retry yet', () => {
    expect(shouldRetryEmptyFinal(1, '', false)).toBe(true)
  })

  it('does not retry when the turn ran no tools', () => {
    expect(shouldRetryEmptyFinal(0, '', false)).toBe(false)
  })

  it('does not retry when an answer was accumulated', () => {
    expect(shouldRetryEmptyFinal(2, 'Here is the answer.', false)).toBe(false)
  })

  it('retries at most once', () => {
    expect(shouldRetryEmptyFinal(1, '', true)).toBe(false)
  })
})

describe('interruptBelongsToToolCall (pending-interrupt attribution)', () => {
  const interrupt = { kind: 'run_command', command: 'rm -rf build' }

  it('matches the run_command call carrying the same command', () => {
    expect(
      interruptBelongsToToolCall(interrupt, {
        name: 'run_command',
        args: { command: 'rm -rf build' }
      })
    ).toBe(true)
  })

  it('rejects a stale run_command call with a different command', () => {
    // The nudge-segment repro: already-executed bridged call `ls` iterated
    // again with no result while the NEW interrupt belongs to `rm -rf build`.
    expect(
      interruptBelongsToToolCall(interrupt, { name: 'run_command', args: { command: 'ls' } })
    ).toBe(false)
  })

  it('rejects a non-run_command call claiming a run_command interrupt', () => {
    expect(
      interruptBelongsToToolCall(interrupt, { name: 'write_file', args: { path: 'a.txt' } })
    ).toBe(false)
  })

  it('rejects when the candidate has no args at all', () => {
    expect(interruptBelongsToToolCall(interrupt, { name: 'run_command' })).toBe(false)
  })

  it('passes unknown interrupt kinds through (nothing to verify against)', () => {
    expect(
      interruptBelongsToToolCall({ kind: 'future_kind' }, { name: 'run_command', args: {} })
    ).toBe(true)
    expect(interruptBelongsToToolCall(undefined, { name: 'run_command', args: {} })).toBe(true)
  })

  it('pairs a run_command_unsandboxed interrupt to its run_command call', () => {
    expect(
      interruptBelongsToToolCall(
        { kind: 'run_command_unsandboxed', command: 'npm i', toolCallId: 'tc1' },
        { id: 'tc1', name: 'run_command', args: { command: 'npm i' } }
      )
    ).toBe(true)
  })

  it('a browser payload never claims a run_command candidate (F4 finding 1)', () => {
    // The crash-resume dangling scan is run_command-only. Without the browser
    // branch an id-less browser payload hit the terminal `return true` and
    // claimed an unrelated run_command call, mislabeling the re-surfaced card.
    const browserValue = { kind: 'browser', tool: 'browser_evaluate', input: { script: 'x' } }
    expect(
      interruptBelongsToToolCall(browserValue, {
        id: 'tc1',
        name: 'run_command',
        args: { command: 'ls' }
      })
    ).toBe(false)
  })

  it('a browser payload pairs to its browser_* call by toolCallId, never a fallback', () => {
    const v = { kind: 'browser', tool: 'browser_click', input: { ref: 'e1' }, toolCallId: 'tcB' }
    expect(interruptBelongsToToolCall(v, { id: 'tcB', name: 'browser_click' })).toBe(true)
    // id-less browser candidate: no fallback pairing (must match by toolCallId).
    const idless = { kind: 'browser', tool: 'browser_click', input: { ref: 'e1' } }
    expect(interruptBelongsToToolCall(idless, { id: 'x', name: 'browser_click' })).toBe(false)
  })

  it('a hook_ask payload never claims an unrelated run_command candidate (Task 8 review fix)', () => {
    // Mirrors the browser test above: a hook-ask approval can wrap ANY tool
    // (wrap.ts wraps every custom tool; fsBackend.ts's hookPreGate wraps
    // every built-in fs tool), so it must never fall through to the
    // terminal `return true` and CLAIM an unrelated dangling run_command
    // candidate.
    const hookValue = { kind: 'hook_ask', tool: 'activate_skill', input: {} }
    expect(
      interruptBelongsToToolCall(hookValue, {
        id: 'tc1',
        name: 'run_command',
        args: { command: 'ls' }
      })
    ).toBe(false)
  })

  it('a hook_ask payload pairs to its wrapped tool call by toolCallId, never a fallback', () => {
    const v = {
      kind: 'hook_ask',
      tool: 'write_file',
      input: { file_path: 'a.txt' },
      toolCallId: 'tcH'
    }
    expect(interruptBelongsToToolCall(v, { id: 'tcH', name: 'write_file' })).toBe(true)
    const idless = { kind: 'hook_ask', tool: 'write_file', input: { file_path: 'a.txt' } }
    expect(interruptBelongsToToolCall(idless, { id: 'x', name: 'write_file' })).toBe(false)
  })
})

describe('edit interrupt pairing', () => {
  const editInt = {
    interruptId: 'i1',
    value: { kind: 'edit_file', tool: 'write_file', path: 'src/a.ts', toolCallId: 'tc1' }
  }

  it('pairs an edit interrupt to its tool call by toolCallId', () => {
    const tc = { id: 'tc1', name: 'write_file', args: { file_path: 'src/a.ts', content: 'x' } }
    expect(interruptBelongsToToolCall(editInt.value, tc)).toBe(true)
  })

  it('falls back to path matching when toolCallId is absent', () => {
    const v = { kind: 'edit_file', tool: 'write_file', path: 'src/a.ts' }
    expect(
      interruptBelongsToToolCall(v, {
        id: 'x',
        name: 'write_file',
        args: { file_path: 'src/a.ts' }
      })
    ).toBe(true)
    expect(
      interruptBelongsToToolCall(v, {
        id: 'x',
        name: 'write_file',
        args: { file_path: 'src/b.ts' }
      })
    ).toBe(false)
  })

  it('does not pair an edit interrupt to a run_command call', () => {
    expect(
      interruptBelongsToToolCall(editInt.value, {
        id: 'tc1',
        name: 'run_command',
        args: { command: 'ls' }
      })
    ).toBe(false)
  })

  it('matches the RAW agent path, never the resolved display path', () => {
    // Task 3 review carry-forward: value.path is what the model sent (so it
    // is what the streamed tool_call args contain); value.resolvedPath is for
    // DISPLAY only and must never participate in pairing.
    const v = { kind: 'edit_file', tool: 'write_file', path: 'safe/../.env', resolvedPath: '.env' }
    expect(
      interruptBelongsToToolCall(v, {
        id: 'x',
        name: 'write_file',
        args: { file_path: 'safe/../.env' }
      })
    ).toBe(true)
    expect(
      interruptBelongsToToolCall(v, { id: 'x', name: 'write_file', args: { file_path: '.env' } })
    ).toBe(false)
  })

  it('requires the exact write tool (an edit_file interrupt never claims a write_file call)', () => {
    const v = { kind: 'edit_file', tool: 'edit_file', path: 'src/a.ts' }
    expect(
      interruptBelongsToToolCall(v, {
        id: 'x',
        name: 'write_file',
        args: { file_path: 'src/a.ts' }
      })
    ).toBe(false)
  })

  it('accepts args.path as the fallback key when args.file_path is absent', () => {
    const v = { kind: 'edit_file', tool: 'write_file', path: 'src/a.ts' }
    expect(
      interruptBelongsToToolCall(v, { id: 'x', name: 'write_file', args: { path: 'src/a.ts' } })
    ).toBe(true)
  })

  it('a present-but-mismatched toolCallId never falls back to the path match', () => {
    // Same posture as pairInterruptsToCalls: a card must never show one edit
    // while its decision resumes another.
    expect(
      interruptBelongsToToolCall(editInt.value, {
        id: 'tc2',
        name: 'write_file',
        args: { file_path: 'src/a.ts' }
      })
    ).toBe(false)
  })

  it('mixed superstep: an id-less edit interrupt never claims a run_command sibling', () => {
    const cmd = { id: 'tc1', name: 'run_command', args: { command: 'ls' } }
    const write = { id: 'tc2', name: 'write_file', args: { file_path: 'src/a.ts', content: 'x' } }
    const out = pairInterruptsToCalls(
      [{ interruptId: 'i1', value: { kind: 'edit_file', tool: 'write_file', path: 'src/a.ts' } }],
      [cmd, write]
    )
    expect(out[0].call?.id).toBe('tc2')
  })
})

describe('read_file interrupt pairing (F8 outside-folder read approval)', () => {
  it('pairs a read interrupt to its tool call by toolCallId', () => {
    const v = { kind: 'read_file', tool: 'read_file', path: '../secret.txt', toolCallId: 'tc9' }
    expect(
      interruptBelongsToToolCall(v, {
        id: 'tc9',
        name: 'read_file',
        args: { file_path: '../secret.txt' }
      })
    ).toBe(true)
  })

  it('falls back to path match when toolCallId is absent, and requires the exact tool', () => {
    const v = { kind: 'read_file', tool: 'ls', path: '../out' }
    expect(interruptBelongsToToolCall(v, { id: 'x', name: 'ls', args: { path: '../out' } })).toBe(
      true
    )
    expect(interruptBelongsToToolCall(v, { id: 'x', name: 'grep', args: { path: '../out' } })).toBe(
      false
    )
  })

  it('a present-but-mismatched toolCallId never falls back to the path match', () => {
    const v = { kind: 'read_file', tool: 'read_file', path: '../secret.txt', toolCallId: 'tc9' }
    expect(
      interruptBelongsToToolCall(v, {
        id: 'other',
        name: 'read_file',
        args: { file_path: '../secret.txt' }
      })
    ).toBe(false)
  })
})

describe('synthesizedApprovalCard (call:null synthesis and edit rehydration)', () => {
  it('synthesizes a run_command card from the payload command', () => {
    expect(
      synthesizedApprovalCard({ kind: 'run_command', command: 'ls -l', toolCallId: 'tc1' })
    ).toEqual({ tool: 'run_command', input: { command: 'ls -l' }, toolCallId: 'tc1' })
  })

  it('falls back to an empty command and drops a non-string toolCallId', () => {
    expect(synthesizedApprovalCard({ kind: 'run_command', toolCallId: 42 })).toEqual({
      tool: 'run_command',
      input: { command: '' },
      toolCallId: undefined
    })
  })

  it('synthesizes a read_file card (never a mislabeled empty run_command)', () => {
    // F8 security fix: an unpaired read_file interrupt must render as its read
    // tool with the resolved target, not fall through to an empty command card.
    expect(
      synthesizedApprovalCard({
        kind: 'read_file',
        tool: 'read_file',
        path: 'assets/link/id_rsa',
        resolvedPath: '/Users/zach/.ssh/id_rsa',
        toolCallId: 'tc9'
      })
    ).toEqual({
      tool: 'read_file',
      input: { file_path: '/Users/zach/.ssh/id_rsa', requested_path: 'assets/link/id_rsa' },
      toolCallId: 'tc9'
    })
  })

  it('a read_file card keeps the read tool name (ls/grep/glob) from the payload', () => {
    expect(synthesizedApprovalCard({ kind: 'read_file', tool: 'ls', path: '../out' }).tool).toBe(
      'ls'
    )
  })

  it('shows the RESOLVED path on an edit card and carries the raw string as requested_path', () => {
    // Carry-forward: the UI must render the TRUE target ('safe/../.env'
    // resolving to '.env' must show '.env'); the raw agent string rides along
    // because it is what the replayed gate call receives, so it is what the
    // denied-replay pin has to match.
    expect(
      synthesizedApprovalCard({
        kind: 'edit_file',
        tool: 'write_file',
        path: 'safe/../.env',
        resolvedPath: '.env',
        toolCallId: 'tc1'
      })
    ).toEqual({
      tool: 'write_file',
      input: { file_path: '.env', requested_path: 'safe/../.env' },
      toolCallId: 'tc1'
    })
  })

  it('omits requested_path when the raw and resolved paths agree', () => {
    expect(
      synthesizedApprovalCard({
        kind: 'edit_file',
        tool: 'edit_file',
        path: 'src/a.ts',
        resolvedPath: 'src/a.ts',
        toolCallId: 'tc1'
      })
    ).toEqual({ tool: 'edit_file', input: { file_path: 'src/a.ts' }, toolCallId: 'tc1' })
  })

  it('degrades to the raw path when the payload carries no resolvedPath', () => {
    expect(
      synthesizedApprovalCard({ kind: 'edit_file', tool: 'write_file', path: 'a.txt' })
    ).toEqual({ tool: 'write_file', input: { file_path: 'a.txt' }, toolCallId: undefined })
  })

  it('never lets a malformed edit payload synthesize a non-edit tool', () => {
    expect(
      synthesizedApprovalCard({ kind: 'edit_file', tool: 'run_command', path: 'a' }).tool
    ).toBe('write_file')
  })

  it('synthesizes a browser card from the payload tool + input (never an empty run_command)', () => {
    // F4 finding 1: a crash-resumed browser approval must re-surface as its REAL
    // browser card. Before the fix it fell through to the run_command default,
    // and approving that empty-command card resumed and EXECUTED the parked
    // action (here arbitrary in-page JS via evaluate).
    expect(
      synthesizedApprovalCard({
        kind: 'browser',
        action: 'evaluate JavaScript in the page',
        tool: 'browser_evaluate',
        input: { script: 'location.href="https://evil.example"' },
        toolCallId: 'tcEval'
      })
    ).toEqual({
      tool: 'browser_evaluate',
      input: { script: 'location.href="https://evil.example"' },
      toolCallId: 'tcEval'
    })
  })

  it('degrades a malformed browser payload to browser_navigate, never escaping to another tool', () => {
    const card = synthesizedApprovalCard({ kind: 'browser', tool: 'run_command', input: {} })
    expect(card.tool).toBe('browser_navigate')
    expect(card.input).toEqual({})
  })

  it('rebuilds a hook_ask card as the REAL wrapped tool, never the empty run_command fallback (Task 8 review fix)', () => {
    // A hook's PreToolUse matcher can target ANY tool -- not just
    // run_command -- so the reviewer's own example (activate_skill) must
    // surface as its true card, carrying the real input the tool will
    // receive on approval.
    expect(
      synthesizedApprovalCard({
        kind: 'hook_ask',
        tool: 'activate_skill',
        input: { name: 'some-skill' },
        reason: 'guard hook',
        toolCallId: 'tcHook'
      })
    ).toEqual({
      tool: 'activate_skill',
      input: { name: 'some-skill' },
      toolCallId: 'tcHook'
    })
  })

  it('a hook_ask card wrapping a built-in fs tool also surfaces as its real tool/input', () => {
    expect(
      synthesizedApprovalCard({
        kind: 'hook_ask',
        tool: 'write_file',
        input: { file_path: 'a.txt', content: 'x' },
        toolCallId: 'tcHookWrite'
      })
    ).toEqual({
      tool: 'write_file',
      input: { file_path: 'a.txt', content: 'x' },
      toolCallId: 'tcHookWrite'
    })
  })

  it('a hook_ask payload with a missing/non-string tool degrades to run_command rather than crashing', () => {
    const card = synthesizedApprovalCard({ kind: 'hook_ask', input: { x: 1 }, toolCallId: 'tc9' })
    expect(card.tool).toBe('run_command')
    expect(card.input).toEqual({ x: 1 })
  })
})

describe('pairedApprovalInput (live paired-card input enrichment)', () => {
  it('shows the RESOLVED path on a paired edit card, carrying the raw string as requested_path', () => {
    // Reviewer finding 2: the common live case is a PAIRED interrupt, and its
    // card must display the TRUE target too, not just synthesized/rehydrated
    // cards. The streamed args' extra fields survive for the card's preview.
    const value = {
      kind: 'edit_file',
      tool: 'write_file',
      path: 'safe/../.env',
      resolvedPath: '.env'
    }
    expect(pairedApprovalInput(value, { file_path: 'safe/../.env', content: 'SECRET=1' })).toEqual({
      file_path: '.env',
      requested_path: 'safe/../.env',
      content: 'SECRET=1'
    })
  })

  it('omits requested_path when the raw and resolved paths agree', () => {
    const value = {
      kind: 'edit_file',
      tool: 'edit_file',
      path: 'src/a.ts',
      resolvedPath: 'src/a.ts'
    }
    expect(
      pairedApprovalInput(value, { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
    ).toEqual({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  })

  it('passes run_command args through untouched (byte-identical events)', () => {
    const args = { command: 'ls -l' }
    expect(pairedApprovalInput({ kind: 'run_command', command: 'ls -l' }, args)).toBe(args)
  })

  it('leaves the args untouched when the edit payload carries no resolvedPath', () => {
    const args = { file_path: 'a.txt', content: 'x' }
    expect(
      pairedApprovalInput({ kind: 'edit_file', tool: 'write_file', path: 'a.txt' }, args)
    ).toBe(args)
  })
})

describe('isRehydratableInterrupt (crash-resume kind filter)', () => {
  it('accepts both approval-bearing kinds', () => {
    expect(isRehydratableInterrupt({ kind: 'run_command', command: 'ls' })).toBe(true)
    expect(isRehydratableInterrupt({ kind: 'edit_file', tool: 'write_file', path: 'a' })).toBe(true)
  })

  it('accepts plan_review and browser (they survive a crash/restart)', () => {
    expect(isRehydratableInterrupt({ kind: 'plan_review', artifactId: 'a' })).toBe(true)
    expect(
      isRehydratableInterrupt({ kind: 'browser', tool: 'browser_evaluate', input: { script: 'x' } })
    ).toBe(true)
  })

  it('rejects unknown kinds and malformed values', () => {
    expect(isRehydratableInterrupt({ kind: 'future_kind' })).toBe(false)
    expect(isRehydratableInterrupt(undefined)).toBe(false)
    expect(isRehydratableInterrupt('edit_file')).toBe(false)
  })

  it('accepts run_command_unsandboxed', () => {
    expect(isRehydratableInterrupt({ kind: 'run_command_unsandboxed' })).toBe(true)
  })

  it('accepts hook_ask (a hook-ask card pending at crash/restart survives, like run_command)', () => {
    expect(isRehydratableInterrupt({ kind: 'hook_ask', tool: 'activate_skill', input: {} })).toBe(
      true
    )
  })
})

describe('findDanglingRunCommandCalls (crash-resume checkpoint scan)', () => {
  // Structural stand-ins for checkpointed BaseMessages: only tool_calls (AI)
  // and tool_call_id (ToolMessage) are read by the scanner.
  const ai = (...calls: Array<{ id: string; name: string; args: unknown }>): unknown => ({
    tool_calls: calls
  })
  const toolResult = (id: string): unknown => ({ tool_call_id: id })
  const human = (): unknown => ({ content: 'do the thing' })

  it('finds the paused run_command with no ToolMessage', () => {
    const messages = [human(), ai({ id: 'tc1', name: 'run_command', args: { command: 'ls -l' } })]
    expect(findDanglingRunCommandCalls(messages)).toEqual([
      { id: 'tc1', name: 'run_command', args: { command: 'ls -l' } }
    ])
  })

  it('returns all parallel dangling calls in message order', () => {
    const messages = [
      human(),
      ai(
        { id: 'tc1', name: 'run_command', args: { command: 'rm index.html' } },
        { id: 'tc2', name: 'run_command', args: { command: 'rm style.css' } }
      )
    ]
    expect(findDanglingRunCommandCalls(messages).map((c) => c.id)).toEqual(['tc1', 'tc2'])
  })

  it('excludes calls a ToolMessage already answered', () => {
    const messages = [
      human(),
      ai({ id: 'tc1', name: 'run_command', args: { command: 'ls -l' } }),
      toolResult('tc1'),
      ai({ id: 'tc2', name: 'run_command', args: { command: 'ls -l' } })
    ]
    expect(findDanglingRunCommandCalls(messages).map((c) => c.id)).toEqual(['tc2'])
  })

  it('ignores dangling calls of other tools', () => {
    const messages = [
      human(),
      ai(
        { id: 'tc1', name: 'write_file', args: { path: 'a.txt' } },
        { id: 'tc2', name: 'run_command', args: { command: 'ls -l' } }
      )
    ]
    expect(findDanglingRunCommandCalls(messages).map((c) => c.id)).toEqual(['tc2'])
  })

  it('handles empty histories and malformed entries without throwing', () => {
    expect(findDanglingRunCommandCalls([])).toEqual([])
    expect(
      findDanglingRunCommandCalls([
        null,
        undefined,
        'text',
        { tool_calls: 'nope' },
        { tool_calls: [null, { id: 42 }] }
      ])
    ).toEqual([])
  })
})

describe('pairInterruptsToCalls (interrupt-to-tool_call pairing)', () => {
  const rm = { id: 'tc1', name: 'run_command', args: { command: 'rm index.html' } }
  const ls = { id: 'tc2', name: 'run_command', args: { command: 'ls -l' } }

  it('pairs exactly by toolCallId when the payload carries one', () => {
    const out = pairInterruptsToCalls(
      [{ interruptId: 'i2', value: { kind: 'run_command', command: 'ls -l', toolCallId: 'tc2' } }],
      [rm, ls]
    )
    expect(out).toEqual([
      {
        interruptId: 'i2',
        value: { kind: 'run_command', command: 'ls -l', toolCallId: 'tc2' },
        call: ls
      }
    ])
  })

  it('disambiguates two identical parallel commands via toolCallId', () => {
    const twin1 = { id: 'tc1', name: 'run_command', args: { command: 'make' } }
    const twin2 = { id: 'tc2', name: 'run_command', args: { command: 'make' } }
    const out = pairInterruptsToCalls(
      [
        { interruptId: 'i2', value: { kind: 'run_command', command: 'make', toolCallId: 'tc2' } },
        { interruptId: 'i1', value: { kind: 'run_command', command: 'make', toolCallId: 'tc1' } }
      ],
      [twin1, twin2]
    )
    expect(out[0].call?.id).toBe('tc2')
    expect(out[1].call?.id).toBe('tc1')
  })

  it('does NOT fall back to a command match when toolCallId names an absent call', () => {
    // Security posture: a card must never show one command while its decision
    // resumes another. The unmatched interrupt pairs to nothing and the caller
    // synthesizes its card from the payload instead.
    const out = pairInterruptsToCalls(
      [
        {
          interruptId: 'i1',
          value: { kind: 'run_command', command: 'ls -l', toolCallId: 'tc-gone' }
        }
      ],
      [ls]
    )
    expect(out[0].call).toBeNull()
  })

  it('falls back to command matching when the payload has no toolCallId', () => {
    const out = pairInterruptsToCalls(
      [{ interruptId: 'i1', value: { kind: 'run_command', command: 'ls -l' } }],
      [rm, ls]
    )
    expect(out[0].call?.id).toBe('tc2')
  })

  it('consumes command-matched candidates in order without double-claiming', () => {
    const twin1 = { id: 'tc1', name: 'run_command', args: { command: 'make' } }
    const twin2 = { id: 'tc2', name: 'run_command', args: { command: 'make' } }
    const out = pairInterruptsToCalls(
      [
        { interruptId: 'i1', value: { kind: 'run_command', command: 'make' } },
        { interruptId: 'i2', value: { kind: 'run_command', command: 'make' } }
      ],
      [twin1, twin2]
    )
    expect(out[0].call?.id).toBe('tc1')
    expect(out[1].call?.id).toBe('tc2')
  })

  it('skips a stale candidate whose command does not match (nudge-segment repro)', () => {
    const out = pairInterruptsToCalls(
      [{ interruptId: 'i1', value: { kind: 'run_command', command: 'rm index.html' } }],
      [ls, rm]
    )
    expect(out[0].call?.id).toBe('tc1')
  })

  it('pairs to nothing when no candidate matches at all', () => {
    const out = pairInterruptsToCalls(
      [{ interruptId: 'i1', value: { kind: 'run_command', command: 'rm index.html' } }],
      [ls]
    )
    expect(out[0].call).toBeNull()
  })

  it('crash-resume: a browser interrupt pairs to NO run_command candidate, then synthesizes its real card (F4 finding 1)', () => {
    // This is exactly the composition rehydratePausedRun runs: the dangling
    // scan is run_command-only, so a parked browser approval must pair to null
    // and re-park from synthesizedApprovalCard — the REAL browser card, not the
    // empty run_command fallback whose approval would EXECUTE the parked action.
    const evalInterrupt = {
      interruptId: 'ib',
      value: {
        kind: 'browser',
        action: 'evaluate JavaScript in the page',
        tool: 'browser_evaluate',
        input: { script: 'fetch("/steal")' },
        toolCallId: 'tcEval'
      }
    }
    const dangling = findDanglingRunCommandCalls([
      {
        tool_calls: [
          { id: 'tcEval', name: 'browser_evaluate', args: { script: 'fetch("/steal")' } }
        ]
      }
    ])
    // The browser call is NOT a run_command, so the scan yields nothing.
    expect(dangling).toEqual([])
    const out = pairInterruptsToCalls([evalInterrupt], dangling)
    expect(out[0].call).toBeNull()
    const card = synthesizedApprovalCard(out[0].value)
    expect(card).toEqual({
      tool: 'browser_evaluate',
      input: { script: 'fetch("/steal")' },
      toolCallId: 'tcEval'
    })
  })

  it('crash-resume: a hook_ask interrupt pairs to NO run_command candidate, then synthesizes its real card (Task 8 review fix)', () => {
    // Same composition rehydratePausedRun runs for hook_ask: the dangling
    // scan is run_command-only, so a parked hook-ask approval (here wrapping
    // activate_skill, the reviewer's own example) must pair to null and
    // re-park from synthesizedApprovalCard -- the REAL card, not the empty
    // run_command fallback whose approval would EXECUTE the parked action.
    const hookInterrupt = {
      interruptId: 'ih',
      value: {
        kind: 'hook_ask',
        tool: 'activate_skill',
        input: { name: 'some-skill' },
        toolCallId: 'tcSkill'
      }
    }
    const dangling = findDanglingRunCommandCalls([
      { tool_calls: [{ id: 'tcSkill', name: 'activate_skill', args: { name: 'some-skill' } }] }
    ])
    // The gated call is NOT a run_command, so the scan yields nothing.
    expect(dangling).toEqual([])
    const out = pairInterruptsToCalls([hookInterrupt], dangling)
    expect(out[0].call).toBeNull()
    const card = synthesizedApprovalCard(out[0].value)
    expect(card).toEqual({
      tool: 'activate_skill',
      input: { name: 'some-skill' },
      toolCallId: 'tcSkill'
    })
  })
})

describe('approval decision collection (collect-then-resume)', () => {
  const items = (...entries: Array<[string, ApprovalItem]>): Map<string, ApprovalItem> =>
    new Map(entries)
  const item = (interruptId: string, decision?: boolean): ApprovalItem => ({
    interruptId,
    tool: 'run_command',
    input: { command: 'ls -l' },
    decision
  })

  describe('allDecided (all-answered detection)', () => {
    it('is false while any card is unanswered', () => {
      expect(allDecided(items(['c1', item('i1', true)], ['c2', item('i2')]))).toBe(false)
    })

    it('is true once every card has a decision, approvals and denials alike', () => {
      expect(allDecided(items(['c1', item('i1', true)], ['c2', item('i2', false)]))).toBe(true)
    })

    it('is vacuously true for an empty set', () => {
      expect(allDecided(items())).toBe(true)
    })
  })

  describe('buildResumeMap (keyed resume construction)', () => {
    it('maps every interrupt id to a truthy { approved } object', () => {
      const resume = buildResumeMap(items(['c1', item('i1', true)], ['c2', item('i2', false)]))
      expect(resume).toEqual({ i1: { approved: true }, i2: { approved: false } })
      // The resume-payload invariant: values must be truthy objects, never a
      // bare boolean, or LangGraph treats the resume as absent. (Cast: the
      // return type widened to ResumeValue when plan_review resolutions
      // joined the map; these command items always carry { approved }.)
      for (const value of Object.values(resume)) {
        expect(Boolean(value)).toBe(true)
        expect(typeof (value as { approved: boolean }).approved).toBe('boolean')
      }
    })

    it('fails safe to denied for an undecided item', () => {
      expect(buildResumeMap(items(['c1', item('i1')]))).toEqual({ i1: { approved: false } })
    })
  })

  describe('deniedToolCallEvents (deny-all on cancel)', () => {
    it('emits a terminal denied row for every card, including answered-but-undispatched approvals', () => {
      const events = deniedToolCallEvents(
        items(['c1', item('i1', true)], ['c2', item('i2')], ['c3', item('i3', false)])
      )
      expect(events.map((e) => e.id)).toEqual(['c1', 'c2', 'c3'])
      for (const e of events) {
        expect(e.type).toBe('tool_call')
        expect(e.approvalState).toBe('denied')
        expect(e.tool).toBe('run_command')
        expect(e.input).toEqual({ command: 'ls -l' })
      }
    })

    it('returns nothing for an empty set', () => {
      expect(deniedToolCallEvents(items())).toEqual([])
    })

    it('produces a correct denied row for edit items (cancel-deny-all)', () => {
      const events = deniedToolCallEvents(
        items([
          'c1',
          {
            interruptId: 'i1',
            tool: 'edit_file',
            input: { file_path: 'src/a.ts' },
            decision: true
          }
        ])
      )
      expect(events).toEqual([
        {
          type: 'tool_call',
          id: 'c1',
          tool: 'edit_file',
          input: { file_path: 'src/a.ts' },
          approvalState: 'denied'
        }
      ])
    })
  })

  describe('resolvedToolCallEvents (dispatch-time persistence batch)', () => {
    it('maps every card to its terminal row under the pending card event id', () => {
      const events = resolvedToolCallEvents(
        items(['c1', item('i1', true)], ['c2', item('i2', false)])
      )
      expect(events.map((e) => [e.id, e.approvalState])).toEqual([
        ['c1', 'approved'],
        ['c2', 'denied']
      ])
      for (const e of events) {
        expect(e.type).toBe('tool_call')
        expect(e.tool).toBe('run_command')
        expect(e.input).toEqual({ command: 'ls -l' })
      }
    })

    it('fails safe to denied for an undecided item, matching buildResumeMap', () => {
      expect(resolvedToolCallEvents(items(['c1', item('i1')]))[0].approvalState).toBe('denied')
    })
  })

  describe('deniedReplayPinsOf (execution-layer deny pins for one dispatch)', () => {
    const denied = (toolCallId?: string, command: unknown = 'git push --force'): ApprovalItem => ({
      interruptId: 'i1',
      tool: 'run_command',
      input: { command },
      toolCallId,
      decision: false
    })

    it('pins denied cards by toolCallId with the command as metadata', () => {
      const pins = deniedReplayPinsOf(
        items(['c1', item('i1', true)], ['c2', denied('tc2')], ['c3', item('i3', true)])
      )
      expect(pins).toEqual([{ toolCallId: 'tc2', command: 'git push --force' }])
    })

    it('pins undecided cards too, matching the fail-safe-to-denied resume', () => {
      expect(deniedReplayPinsOf(items(['c1', item('i1')]))).toHaveLength(1)
    })

    it('never pins an approved card', () => {
      expect(deniedReplayPinsOf(items(['c1', item('i1', true)]))).toEqual([])
    })

    it('omits a non-string command instead of pinning a bogus value', () => {
      const pins = deniedReplayPinsOf(items(['c1', denied(undefined, 42)]))
      expect(pins).toEqual([{ toolCallId: undefined, command: undefined }])
    })

    const deniedEdit = (input: unknown, toolCallId?: string): ApprovalItem => ({
      interruptId: 'i9',
      tool: 'write_file',
      input,
      toolCallId,
      decision: false
    })

    it('pins a denied edit by toolCallId with the raw path as the fallback key', () => {
      const pins = deniedReplayPinsOf(
        items(['c1', deniedEdit({ file_path: 'src/a.ts', content: 'x' }, 'tc2')])
      )
      expect(pins).toEqual([{ toolCallId: 'tc2', editPath: 'src/a.ts' }])
    })

    it('prefers requested_path (the raw agent string) over the resolved display path', () => {
      // A synthesized edit card displays the resolved path but the replayed
      // gate call receives the raw string, so the pin must carry the raw one.
      const pins = deniedReplayPinsOf(
        items(['c1', deniedEdit({ file_path: '.env', requested_path: 'safe/../.env' })])
      )
      expect(pins).toEqual([{ toolCallId: undefined, editPath: 'safe/../.env' }])
    })

    it('never pins an approved edit', () => {
      expect(
        deniedReplayPinsOf(
          items([
            'c1',
            {
              interruptId: 'i1',
              tool: 'edit_file',
              input: { file_path: 'src/a.ts' },
              decision: true
            }
          ])
        )
      ).toEqual([])
    })

    const deniedBrowser = (input: unknown, toolCallId?: string): ApprovalItem => ({
      interruptId: 'ib',
      tool: 'browser_click',
      input,
      toolCallId,
      decision: false
    })

    it('pins a denied browser card under its canonical action label', () => {
      // The pin key must equal browserActionLabel(tool, input) so the replayed
      // tool's takeDeniedBrowserReplayPin (id-less fallback) matches it.
      const pins = deniedReplayPinsOf(items(['c1', deniedBrowser({ ref: 'e12' }, 'tc2')]))
      expect(pins).toEqual([{ toolCallId: 'tc2', browserAction: 'click e12' }])
    })

    it('pins an id-less denied browser card under browserAction only', () => {
      const pins = deniedReplayPinsOf(
        items([
          'c1',
          {
            interruptId: 'ib',
            tool: 'browser_navigate',
            input: { url: 'https://x.com/a' },
            decision: false
          }
        ])
      )
      expect(pins).toEqual([{ toolCallId: undefined, browserAction: 'navigate https://x.com/a' }])
    })

    it('never pins an approved browser card', () => {
      expect(
        deniedReplayPinsOf(
          items(['c1', { ...deniedBrowser({ ref: 'e1' }, 'tc9'), decision: true }])
        )
      ).toEqual([])
    })

    it('emits an unsandboxedCommand pin for an un-approved unsandboxed card', () => {
      const items = new Map([
        [
          'c1',
          {
            interruptId: 'i1',
            tool: 'run_command',
            input: { command: 'npm i', unsandboxed: true },
            toolCallId: 'tc1',
            decision: false
          }
        ]
      ])
      const pins = deniedReplayPinsOf(items as never)
      expect(pins[0]).toEqual({ toolCallId: 'tc1', unsandboxedCommand: 'npm i' })
    })
  })

  describe('toolResultOutput (card output vs. model text)', () => {
    it('applies the 50000-char budget to a normal tool result', () => {
      const big = 'x'.repeat(60000)
      const { output, truncated } = toolResultOutput('run_command', 'tc1', big, true)
      expect(truncated).toBe(true)
      expect(output.endsWith('… output truncated')).toBe(true)
      expect(output.length).toBeLessThan(60000)
    })

    it('passes a short result through untouched', () => {
      expect(toolResultOutput('run_command', 'tc1', 'ok', true)).toEqual({
        output: 'ok',
        truncated: false
      })
    })

    it('splices a stashed screenshot into the persisted output, bypassing truncation', () => {
      const dataUrl = 'data:image/png;base64,' + 'A'.repeat(200000)
      browserManager.stashScreenshot('tcShot', dataUrl)
      // take=true (authoritative persist) consumes the stash and returns the
      // FULL data URL — never truncated — while the model only ever saw the
      // placeholder passed as modelText.
      const { output, truncated } = toolResultOutput(
        'browser_screenshot',
        'tcShot',
        'Screenshot captured (~150 KB); rendered in the browser step for the user.',
        true
      )
      expect(output).toBe(dataUrl)
      expect(truncated).toBe(false)
      // Take-once: a second read finds nothing stashed and falls back to the
      // model text (budgeted).
      expect(toolResultOutput('browser_screenshot', 'tcShot', 'placeholder', true).output).toBe(
        'placeholder'
      )
    })

    it('peek (live stream) leaves the stash for the authoritative persist to consume', () => {
      const dataUrl = 'data:image/png;base64,ZZZ'
      browserManager.stashScreenshot('tcPeek', dataUrl)
      expect(toolResultOutput('browser_screenshot', 'tcPeek', 'x', false).output).toBe(dataUrl)
      // Still present for the take.
      expect(toolResultOutput('browser_screenshot', 'tcPeek', 'x', true).output).toBe(dataUrl)
      // Now consumed.
      expect(toolResultOutput('browser_screenshot', 'tcPeek', 'x', true).output).toBe('x')
    })
  })
})

describe('orderCompletedCallsFirst (segment post-loop ordering)', () => {
  const cand = (id?: string): { tc: { id?: string } } => ({ tc: { id } })
  const ids = (list: Array<{ tc: { id?: string } }>): Array<string | undefined> =>
    list.map((c) => c.tc.id)

  it('moves a bridged completed call ahead of a streamed pause candidate', () => {
    // The two-guarded-commands turn: cmd2 (streamed, pending) is listed before
    // cmd1 (bridged fallback, result already in toolMsgById). cmd1 must be
    // processed first or its tool_result is lost when cmd2 returns paused.
    const results = new Set(['tc1'])
    const out = orderCompletedCallsFirst([cand('tc2'), cand('tc1')], (id) => results.has(id))
    expect(ids(out)).toEqual(['tc1', 'tc2'])
  })

  it('preserves relative order within each group', () => {
    const results = new Set(['a', 'c'])
    const out = orderCompletedCallsFirst([cand('a'), cand('b'), cand('c'), cand('d')], (id) =>
      results.has(id)
    )
    expect(ids(out)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('leaves an all-completed or all-pending list unchanged', () => {
    const all = [cand('a'), cand('b')]
    expect(ids(orderCompletedCallsFirst(all, () => true))).toEqual(['a', 'b'])
    expect(ids(orderCompletedCallsFirst(all, () => false))).toEqual(['a', 'b'])
  })

  it('treats id-less calls as non-completed without calling hasResult', () => {
    const hasResult = (id: string): boolean => {
      expect(id).toBeDefined()
      return true
    }
    const out = orderCompletedCallsFirst([cand(undefined), cand('a')], hasResult)
    expect(ids(out)).toEqual(['a', undefined])
  })
})

describe('plan_review interrupt pairing', () => {
  const planValue = {
    kind: 'plan_review',
    artifactId: 'convo:tc1:abcd1234deadbeef:artifact',
    title: 'Add dark mode',
    toolCallId: 'tc1'
  }

  it('interruptBelongsToToolCall: exact toolCallId match, and only for submit_plan candidates', () => {
    expect(
      interruptBelongsToToolCall(planValue, {
        id: 'tc1',
        name: 'submit_plan',
        args: { title: 'Add dark mode' }
      })
    ).toBe(true)
    expect(
      interruptBelongsToToolCall(planValue, {
        id: 'tc2',
        name: 'submit_plan',
        args: { title: 'Add dark mode' }
      })
    ).toBe(false)
    expect(
      interruptBelongsToToolCall(planValue, {
        id: 'tc1',
        name: 'run_command',
        args: { command: 'x' }
      })
    ).toBe(false)
  })

  it('id-less payload falls back to the title match (the command-match analog)', () => {
    const idless = { kind: 'plan_review', artifactId: 'a1', title: 'Add dark mode' }
    expect(
      interruptBelongsToToolCall(idless, {
        id: 'tcX',
        name: 'submit_plan',
        args: { title: 'Add dark mode' }
      })
    ).toBe(true)
    expect(
      interruptBelongsToToolCall(idless, {
        id: 'tcX',
        name: 'submit_plan',
        args: { title: 'Other plan' }
      })
    ).toBe(false)
  })

  it('pairedApprovalInput merges the artifactId into the streamed args (card <-> pane pairing)', () => {
    expect(pairedApprovalInput(planValue, { title: 'Add dark mode', body: '# Plan' })).toEqual({
      title: 'Add dark mode',
      body: '# Plan',
      artifactId: 'convo:tc1:abcd1234deadbeef:artifact'
    })
    // Non-plan payloads pass through untouched (run_command regression).
    expect(pairedApprovalInput({ kind: 'run_command', command: 'ls' }, { command: 'ls' })).toEqual({
      command: 'ls'
    })
  })

  it('synthesizedApprovalCard builds the plan card from the payload alone (rehydration path)', () => {
    expect(synthesizedApprovalCard(planValue)).toEqual({
      tool: 'submit_plan',
      input: { title: 'Add dark mode', artifactId: 'convo:tc1:abcd1234deadbeef:artifact' },
      toolCallId: 'tc1'
    })
  })

  it('planReviewArtifactIdOf discriminates by kind', () => {
    expect(planReviewArtifactIdOf(planValue)).toBe('convo:tc1:abcd1234deadbeef:artifact')
    expect(planReviewArtifactIdOf({ kind: 'run_command', command: 'x' })).toBeUndefined()
    expect(planReviewArtifactIdOf(null)).toBeUndefined()
  })

  it('isRehydratableInterrupt accepts plan_review (the pause survives a crash)', () => {
    expect(isRehydratableInterrupt(planValue)).toBe(true)
  })
})

describe('plan_review resume shape (SECURITY: the kind branch)', () => {
  const planItem = (resolution?: PlanReviewResolution): ApprovalItem => ({
    interruptId: 'i-plan',
    tool: 'submit_plan',
    input: { title: 'T', artifactId: 'a1' },
    toolCallId: 'tc1',
    planReview: { artifactId: 'a1', ...(resolution ? { resolution } : {}) }
  })
  const cmdItem = (decision?: boolean): ApprovalItem => ({
    interruptId: 'i-cmd',
    tool: 'run_command',
    input: { command: 'ls' },
    toolCallId: 'tc2',
    ...(decision === undefined ? {} : { decision })
  })

  it('allDecided: a plan item is decided only by a resolution, never by `decision`', () => {
    expect(allDecided(new Map([['c1', planItem()]]))).toBe(false)
    expect(allDecided(new Map([['c1', planItem({ proceed: true })]]))).toBe(true)
  })

  it('buildResumeMap branches by kind: plan items resume with their resolution object, commands with { approved }', () => {
    const items = new Map([
      ['c1', planItem({ proceed: false, feedback: 'change it' })],
      ['c2', cmdItem(true)]
    ])
    expect(buildResumeMap(items)).toEqual({
      'i-plan': { proceed: false, feedback: 'change it' },
      'i-cmd': { approved: true }
    })
  })

  it('a plan item NEVER resumes as { approved } and every value is a truthy object', () => {
    const resume = buildResumeMap(new Map([['c1', planItem({ proceed: true })]]))
    expect(resume['i-plan']).toEqual({ proceed: true })
    expect('approved' in (resume['i-plan'] as object)).toBe(false)
    for (const v of Object.values(resume)) expect(Boolean(v)).toBe(true)
  })

  it("the undecided-plan fail-safe is design 3.5's deny-all value", () => {
    expect(buildResumeMap(new Map([['c1', planItem()]]))['i-plan']).toEqual({
      proceed: false,
      feedback: 'The user stopped the run.'
    })
  })

  it('resolvedToolCallEvents: proceed persists approved, feedback persists denied', () => {
    const events = resolvedToolCallEvents(
      new Map([
        ['c1', planItem({ proceed: true })],
        ['c2', planItem({ proceed: false, feedback: 'x' })]
      ])
    )
    expect(events[0].approvalState).toBe('approved')
    expect(events[1].approvalState).toBe('denied')
  })

  it('deniedReplayPinsOf SKIPS plan items entirely (no pin analog, by design)', () => {
    const pins = deniedReplayPinsOf(
      new Map([
        ['c1', planItem({ proceed: false, feedback: 'x' })],
        ['c2', planItem()],
        ['c3', cmdItem(false)]
      ])
    )
    expect(pins).toEqual([{ toolCallId: 'tc2', command: 'ls' }])
  })

  it("resolvePlanInterrupt returns 'stale' when nothing is parked (stale IPC)", () => {
    expect(resolvePlanInterrupt('nowhere', 'c1', { proceed: true })).toBe('stale')
  })
})

describe('propose_skill resume shape (SECURITY: the kind branch, G-skills Task 8)', () => {
  const skillItem = (resolution?: SkillProposalResolution): ApprovalItem => ({
    interruptId: 'i-skill',
    tool: 'propose_skill',
    input: { name: 'n', description: 'd', body: 'b' },
    toolCallId: 'tc3',
    skillProposal: { ...(resolution ? { resolution } : {}) }
  })
  const cmdItem = (decision?: boolean): ApprovalItem => ({
    interruptId: 'i-cmd',
    tool: 'run_command',
    input: { command: 'ls' },
    toolCallId: 'tc2',
    ...(decision === undefined ? {} : { decision })
  })

  it('allDecided: a skill-proposal item is decided only by a resolution, never by `decision`', () => {
    expect(allDecided(new Map([['c1', skillItem()]]))).toBe(false)
    expect(allDecided(new Map([['c1', skillItem({ save: false })]]))).toBe(true)
  })

  it('buildResumeMap branches by kind: skill items resume with their resolution object, commands with { approved }', () => {
    const items = new Map([
      ['c1', skillItem({ save: false })],
      ['c2', cmdItem(true)]
    ])
    expect(buildResumeMap(items)).toEqual({
      'i-skill': { save: false },
      'i-cmd': { approved: true }
    })
  })

  it('a skill item NEVER resumes as { approved } and every value is a truthy object', () => {
    const resume = buildResumeMap(
      new Map([
        ['c1', skillItem({ save: true, name: 'n', description: 'd', body: 'b', scope: 'global' })]
      ])
    )
    expect(resume['i-skill']).toEqual({
      save: true,
      name: 'n',
      description: 'd',
      body: 'b',
      scope: 'global'
    })
    expect('approved' in (resume['i-skill'] as object)).toBe(false)
    for (const v of Object.values(resume)) expect(Boolean(v)).toBe(true)
  })

  it('the undecided-skill-proposal fail-safe is the discard variant { save: false }', () => {
    expect(buildResumeMap(new Map([['c1', skillItem()]]))['i-skill']).toEqual({ save: false })
  })

  it('resolvedToolCallEvents: save:true persists approved, save:false persists denied', () => {
    const events = resolvedToolCallEvents(
      new Map([
        ['c1', skillItem({ save: true, name: 'n', description: 'd', body: 'b', scope: 'global' })],
        ['c2', skillItem({ save: false })]
      ])
    )
    expect(events[0].approvalState).toBe('approved')
    expect(events[1].approvalState).toBe('denied')
  })

  it('isRehydratableInterrupt accepts propose_skill (the pause survives a crash)', () => {
    expect(isRehydratableInterrupt({ kind: 'propose_skill', name: 'n' })).toBe(true)
  })

  it('isSkillProposalInterrupt marks a propose_skill payload and only that kind (review findings 1/2/3/4)', () => {
    expect(isSkillProposalInterrupt({ kind: 'propose_skill', name: 'n' })).toBe(true)
    expect(isSkillProposalInterrupt({ kind: 'plan_review', artifactId: 'a' })).toBe(false)
    expect(isSkillProposalInterrupt({ kind: 'run_command', command: 'ls' })).toBe(false)
    expect(isSkillProposalInterrupt(undefined)).toBe(false)
    expect(isSkillProposalInterrupt(null)).toBe(false)
  })

  it("crash-resume: a propose_skill interrupt pairs to NO run_command candidate, then synthesizes its real card and is markable via isSkillProposalInterrupt (finding 4, rehydratePausedRun's composition)", () => {
    const skillInterrupt = {
      interruptId: 'is1',
      value: {
        kind: 'propose_skill',
        name: 'my-skill',
        description: 'A specific description',
        body: '# Body',
        toolCallId: 'tcSkill'
      }
    }
    const dangling = findDanglingRunCommandCalls([
      { tool_calls: [{ id: 'tcSkill', name: 'propose_skill', args: { name: 'my-skill' } }] }
    ])
    // propose_skill is not run_command, so the dangling scan yields nothing --
    // exactly like plan_review/edit/browser, this pause re-parks from the
    // payload alone (rehydratePausedRun's isSkillProposalInterrupt branch).
    expect(dangling).toEqual([])
    const out = pairInterruptsToCalls([skillInterrupt], dangling)
    expect(out[0].call).toBeNull()
    expect(isSkillProposalInterrupt(out[0].value)).toBe(true)
    const card = synthesizedApprovalCard(out[0].value)
    expect(card).toEqual({
      tool: 'propose_skill',
      input: { name: 'my-skill', description: 'A specific description', body: '# Body' },
      toolCallId: 'tcSkill'
    })
    // The full parked ApprovalItem rehydratePausedRun now constructs (finding
    // 4's fix): skillProposal must be present so resolveSkillProposalInterrupt
    // can ever find this item again instead of reporting 'stale'.
    const item: ApprovalItem = {
      interruptId: out[0].interruptId,
      tool: card.tool,
      input: card.input,
      toolCallId: card.toolCallId,
      ...(isSkillProposalInterrupt(out[0].value) ? { skillProposal: {} } : {})
    }
    expect(item.skillProposal).toEqual({})
  })

  it("resolveSkillProposalInterrupt returns 'stale' when nothing is parked (stale IPC)", () => {
    expect(resolveSkillProposalInterrupt('nowhere', 'c1', { save: false })).toBe('stale')
  })

  it('resolveSkillProposalInterrupt records the resolution and resolves', () => {
    const sink: RunSink = { emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() }
    const items = new Map([['c1', skillItem()]])
    __parkForTest('convo-skill', items, sink, new AbortController().signal)
    expect(
      resolveSkillProposalInterrupt('convo-skill', 'c1', {
        save: true,
        name: 'edited',
        description: 'd',
        body: 'b',
        scope: 'global'
      })
    ).toBe('resolved')
    expect(items.get('c1')?.skillProposal?.resolution).toEqual({
      save: true,
      name: 'edited',
      description: 'd',
      body: 'b',
      scope: 'global'
    })
    forgetPendingApproval('convo-skill')
  })

  it('resolveSkillProposalInterrupt is a no-op cross-guard against a parked plan/command item', () => {
    const sink: RunSink = { emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() }
    __parkForTest('convo-skill-2', new Map([['c1', cmdItem()]]), sink, new AbortController().signal)
    expect(resolveSkillProposalInterrupt('convo-skill-2', 'c1', { save: false })).toBe('stale')
    forgetPendingApproval('convo-skill-2')
  })
})

// The `planItem`/`cmdItem` helpers of the resume-shape suite, re-declared at
// file scope for the seam-parked cross-guard tests below.
const planItemX = (resolution?: PlanReviewResolution): ApprovalItem => ({
  interruptId: 'i-plan',
  tool: 'submit_plan',
  input: { title: 'T', artifactId: 'a1' },
  toolCallId: 'tc1',
  planReview: { artifactId: 'a1', ...(resolution ? { resolution } : {}) }
})
const cmdItemX = (decision?: boolean): ApprovalItem => ({
  interruptId: 'i-cmd',
  tool: 'run_command',
  input: { command: 'ls' },
  toolCallId: 'tc2',
  ...(decision === undefined ? {} : { decision })
})

describe('planProceedModeFlip (Proceed conditionally flips plan -> accept-edits)', () => {
  it('(a) still in plan at Proceed time: flips to accept-edits', () => {
    expect(planProceedModeFlip('plan')).toBe('accept-edits')
  })
  it('(b) user switched to auto during the pause: no flip (stays auto)', () => {
    expect(planProceedModeFlip('auto')).toBeNull()
  })
  it('never overwrites or downgrades another explicit mode', () => {
    expect(planProceedModeFlip('accept-edits')).toBeNull()
    expect(planProceedModeFlip('ask')).toBeNull()
    expect(planProceedModeFlip('bypass')).toBeNull()
    expect(planProceedModeFlip(undefined)).toBeNull()
  })
})

describe('resolution-channel cross-guards (SECURITY, via the __parkForTest seam)', () => {
  const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
  afterEach(() => forgetPendingApproval('convo-x'))

  it('resolveInterrupt (the boolean tools.approve wire) can NEVER resolve a parked plan item', () => {
    const sink = makeSink()
    __parkForTest('convo-x', new Map([['c1', planItemX()]]), sink, new AbortController().signal)
    expect(resolveInterrupt('convo-x', 'c1', true)).toBe(false)
    expect(resolveInterrupt('convo-x', 'c1', false)).toBe(false)
    // No terminal card emitted, no dispatch: the card is untouched.
    expect(sink.emit).not.toHaveBeenCalled()
  })

  it("resolvePlanInterrupt (the artifacts wire) returns 'stale' for a parked command item", () => {
    const sink = makeSink()
    __parkForTest('convo-x', new Map([['c1', cmdItemX()]]), sink, new AbortController().signal)
    expect(resolvePlanInterrupt('convo-x', 'c1', { proceed: true })).toBe('stale')
    expect(sink.emit).not.toHaveBeenCalled()
  })

  it("Review-requires-substance: proceed:false with no comments and no message is 'needs-substance' and records nothing", () => {
    // The file-level '../db' mock's listArtifactComments returns [] (no drafts).
    const sink = makeSink()
    const items = new Map([['c1', planItemX()]])
    __parkForTest('convo-x', items, sink, new AbortController().signal)
    expect(resolvePlanInterrupt('convo-x', 'c1', { proceed: false })).toBe('needs-substance')
    expect(resolvePlanInterrupt('convo-x', 'c1', { proceed: false, message: '   ' })).toBe(
      'needs-substance'
    )
    expect(items.get('c1')?.planReview?.resolution).toBeUndefined()
    expect(sink.emit).not.toHaveBeenCalled()
  })
})

import { getConversationMeta, setActiveRules } from '../db'

describe('persistRuleMentions', () => {
  afterEach(() => vi.clearAllMocks())

  it('does nothing when there are no rule mentions', () => {
    persistRuleMentions('c1', [{ kind: 'file', name: 'a.ts', path: 'a.ts' }])
    expect(setActiveRules).not.toHaveBeenCalled()
  })

  it('unions mentioned rule names with existing activeRules and persists', () => {
    vi.mocked(getConversationMeta).mockReturnValue({
      id: 'c1',
      projectPath: '/p',
      title: null,
      modelRef: null,
      createdAt: 0,
      updatedAt: 0,
      permissionMode: 'accept-edits',
      activeRules: ['style']
    })
    persistRuleMentions('c1', [
      { kind: 'rule', name: 'style' },
      { kind: 'rule', name: 'security' }
    ])
    expect(setActiveRules).toHaveBeenCalledWith('c1', ['style', 'security'])
  })
})

describe('runGraph — Ursa resolution', () => {
  afterEach(() => vi.clearAllMocks())

  it('resolves URSA_MODEL_REF to a concrete modelRef, records the role, and persists it for rehydration', async () => {
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-haiku-4-5',
      roleName: 'grunt'
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'refactor this module')
    expect(result).toEqual({ modelRef: 'anthropic/claude-haiku-4-5', ursaRole: 'grunt' })
    expect(resolveUrsaModelRef).toHaveBeenCalledWith({ userText: 'refactor this module' })
    expect(setLastResolvedModelRef).toHaveBeenCalledWith('c1', 'anthropic/claude-haiku-4-5')
  })

  it("passes the classifier's own token usage through when resolveUrsaModelRef reports it", async () => {
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'openai/gpt-5.6-sol',
      roleName: 'coder',
      classifierUsage: {
        modelRef: 'anthropic/claude-haiku-4-5',
        inputTokens: 120,
        outputTokens: 6
      }
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'build a thing')
    expect(result).toEqual({
      modelRef: 'openai/gpt-5.6-sol',
      ursaRole: 'coder',
      classifierUsage: {
        modelRef: 'anthropic/claude-haiku-4-5',
        inputTokens: 120,
        outputTokens: 6
      }
    })
  })

  it('omits classifierUsage from the result when resolveUrsaModelRef does not report it', async () => {
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-haiku-4-5',
      roleName: 'grunt'
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'hi')
    expect(result).not.toHaveProperty('classifierUsage')
  })

  it('threads recentContext and previousRole from the db accessors into resolveUrsaModelRef', async () => {
    vi.mocked(getRecentUrsaContext).mockReturnValue('User: build a site\nAssistant: done')
    vi.mocked(getLastUrsaRole).mockReturnValue('coder')
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'openai/gpt-5.6-sol',
      roleName: 'coder'
    })
    await resolveTurnModelRef('c1', 'ursa/auto', 'now fix that bug')
    expect(resolveUrsaModelRef).toHaveBeenCalledWith({
      userText: 'now fix that bug',
      recentContext: 'User: build a site\nAssistant: done',
      previousRole: 'coder'
    })
  })

  it('omits recentContext/previousRole when the accessors are empty (turn 1)', async () => {
    vi.mocked(getRecentUrsaContext).mockReturnValue('')
    vi.mocked(getLastUrsaRole).mockReturnValue(undefined)
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-haiku-4-5',
      roleName: 'grunt'
    })
    await resolveTurnModelRef('c1', 'ursa/auto', 'hi')
    expect(resolveUrsaModelRef).toHaveBeenCalledWith({ userText: 'hi' })
  })

  it('passes a concrete modelRef through untouched (no classifier call)', async () => {
    const result = await resolveTurnModelRef('c1', 'anthropic/claude-sonnet-5', 'hi')
    expect(result).toEqual({ modelRef: 'anthropic/claude-sonnet-5' })
    expect(resolveUrsaModelRef).not.toHaveBeenCalled()
    expect(setLastResolvedModelRef).not.toHaveBeenCalled()
  })

  it('propagates a thrown error (e.g. Ursa disabled, or no eligible role) without persisting a resolution', async () => {
    vi.mocked(resolveUrsaModelRef).mockRejectedValue(new Error('Ursa is disabled.'))
    await expect(resolveTurnModelRef('c1', 'ursa/auto', 'refactor this')).rejects.toThrow(
      /disabled/i
    )
    expect(setLastResolvedModelRef).not.toHaveBeenCalled()
  })

  it('rehydrateModelRef reuses the persisted resolution for the sentinel instead of re-classifying', () => {
    vi.mocked(getLastResolvedModelRef).mockReturnValue('anthropic/claude-haiku-4-5')
    expect(rehydrateModelRef('c1', 'ursa/auto')).toBe('anthropic/claude-haiku-4-5')
    expect(getLastResolvedModelRef).toHaveBeenCalledWith('c1')
  })

  it('rehydrateModelRef leaves the sentinel unresolved when nothing was persisted (honest failure downstream)', () => {
    vi.mocked(getLastResolvedModelRef).mockReturnValue(null)
    expect(rehydrateModelRef('c1', 'ursa/auto')).toBe('ursa/auto')
  })

  it('rehydrateModelRef returns a concrete ref unchanged', () => {
    expect(rehydrateModelRef('c1', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
    expect(getLastResolvedModelRef).not.toHaveBeenCalled()
  })
})

describe('runGraph — Ursa Modes: code mode lock (Task 3)', () => {
  afterEach(() => vi.clearAllMocks())

  it("locks to the coder role with no classifier call when mode is 'code'", async () => {
    vi.mocked(getConversationMeta).mockReturnValue({
      id: 'c1',
      projectPath: null,
      title: null,
      modelRef: 'ursa/auto',
      createdAt: 0,
      updatedAt: 0,
      permissionMode: 'accept-edits',
      activeRules: [],
      effort: 'medium',
      webSearch: false,
      thinking: false,
      ursaMode: 'code',
      projectId: null,
      pinned: false,
      archived: false,
      environment: 'local',
      worktrees: []
    })
    vi.mocked(coderRoleIfEligible).mockReturnValue({
      name: 'coder',
      modelRef: 'openai/gpt-5.6-sol',
      description: 'builds things'
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'build a widget')
    expect(result).toEqual({ modelRef: 'openai/gpt-5.6-sol', ursaRole: 'coder' })
    expect(resolveUrsaModelRef).not.toHaveBeenCalled()
    expect(setLastResolvedModelRef).toHaveBeenCalledWith('c1', 'openai/gpt-5.6-sol')
  })

  it("falls through to the normal auto (classifier) path when the coder role is unkeyed in 'code' mode", async () => {
    vi.mocked(getConversationMeta).mockReturnValue({
      id: 'c1',
      projectPath: null,
      title: null,
      modelRef: 'ursa/auto',
      createdAt: 0,
      updatedAt: 0,
      permissionMode: 'accept-edits',
      activeRules: [],
      effort: 'medium',
      webSearch: false,
      thinking: false,
      ursaMode: 'code',
      projectId: null,
      pinned: false,
      archived: false,
      environment: 'local',
      worktrees: []
    })
    vi.mocked(coderRoleIfEligible).mockReturnValue(undefined)
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-haiku-4-5',
      roleName: 'grunt'
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'build a widget')
    expect(resolveUrsaModelRef).toHaveBeenCalledWith({ userText: 'build a widget' })
    expect(result).toEqual({ modelRef: 'anthropic/claude-haiku-4-5', ursaRole: 'grunt' })
  })

  it("mode 'auto' (or unset) never consults coderRoleIfEligible and runs the classifier as before", async () => {
    vi.mocked(getConversationMeta).mockReturnValue({
      id: 'c1',
      projectPath: null,
      title: null,
      modelRef: 'ursa/auto',
      createdAt: 0,
      updatedAt: 0,
      permissionMode: 'accept-edits',
      activeRules: [],
      effort: 'medium',
      webSearch: false,
      thinking: false,
      ursaMode: 'auto',
      projectId: null,
      pinned: false,
      archived: false,
      environment: 'local',
      worktrees: []
    })
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-haiku-4-5',
      roleName: 'grunt'
    })
    const result = await resolveTurnModelRef('c1', 'ursa/auto', 'hi')
    expect(coderRoleIfEligible).not.toHaveBeenCalled()
    expect(result).toEqual({ modelRef: 'anthropic/claude-haiku-4-5', ursaRole: 'grunt' })
  })
})

describe('runGraph — Ursa Modes: council dispatch (Task 4)', () => {
  // getConversationMeta is set per-test via mockReturnValue, which vi.clearAllMocks
  // does NOT reset -- so restore the module-mock default (null) after each test,
  // or a leaked ursaMode:'council' would make runGraph's new council branch fire
  // in unrelated later suites (e.g. the pipeline proposal test).
  afterEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConversationMeta).mockReturnValue(null)
  })

  const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
  const metaWith = (ursaMode: 'auto' | 'code' | 'council' | 'deep-research') => ({
    id: 'c1',
    projectPath: null,
    title: null,
    modelRef: 'ursa/auto',
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'accept-edits' as const,
    activeRules: [],
    effort: 'medium' as const,
    thinking: false,
    webSearch: false,
    ursaMode,
    projectId: null,
    pinned: false,
    archived: false,
    environment: 'local' as const,
    worktrees: []
  })

  it("routes an Ursa turn to runCouncil (no classifier, no agent) when mode is 'council'", async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('council'))
    vi.mocked(runCouncil).mockResolvedValue({ paused: false })
    const sink = makeSink()
    const result = await runGraph({
      conversationId: 'c1',
      userText: 'weigh X vs Y',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    })
    expect(result).toEqual({ paused: false })
    expect(runCouncil).toHaveBeenCalledWith('c1', 'weigh X vs Y', sink, expect.anything())
    // Council never classifies and never builds an agent.
    expect(resolveUrsaModelRef).not.toHaveBeenCalled()
    expect(makeModel).not.toHaveBeenCalled()
    // The user_message is still emitted before dispatch (transcript honesty).
    expect(
      vi
        .mocked(sink.emit)
        .mock.calls.map((c) => c[1])
        .some((e) => e.type === 'user_message')
    ).toBe(true)
  })

  it("does NOT route to runCouncil for mode 'auto' (classifier path unchanged)", async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('auto'))
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-sonnet-5',
      roleName: 'reviewer'
    })
    const sink = makeSink()
    // buildAgentAndContext/drive may throw with the fake model — irrelevant; we
    // only assert the council seam was not taken and the classifier still ran.
    await runGraph({
      conversationId: 'c1',
      userText: 'explain this',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    }).catch(() => {})
    expect(runCouncil).not.toHaveBeenCalled()
    expect(resolveUrsaModelRef).toHaveBeenCalled()
  })

  it('does NOT route a concrete (non-Ursa) model to runCouncil even if meta says council', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('council'))
    const sink = makeSink()
    await runGraph({
      conversationId: 'c1',
      userText: 'hi',
      modelRef: 'anthropic/claude-sonnet-5',
      sink,
      signal: new AbortController().signal
    }).catch(() => {})
    expect(runCouncil).not.toHaveBeenCalled()
  })
})

describe('runGraph — Ursa Modes: deep research (Task 6)', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.mocked(getConversationMeta).mockReturnValue(null)
    setStartUrsaPipeline(() => {})
  })

  const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
  const metaWith = (ursaMode: 'auto' | 'code' | 'council' | 'deep-research') => ({
    id: 'c1',
    projectPath: null,
    title: null,
    modelRef: 'ursa/auto',
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'accept-edits' as const,
    activeRules: [],
    effort: 'medium' as const,
    thinking: false,
    webSearch: false,
    ursaMode,
    projectId: null,
    pinned: false,
    archived: false,
    environment: 'local' as const,
    worktrees: []
  })

  it('auto-starts the preset pipeline (running, no consent card) and parks paused:true', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('deep-research'))
    const started = vi.fn()
    setStartUrsaPipeline(started)
    const sink = makeSink()
    const result = await runGraph({
      conversationId: 'c1',
      userText: 'research quantum error correction',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    })
    // Parked so startRunOrchestrator keeps the AbortController alive; the engine
    // owns the run from here.
    expect(result).toEqual({ paused: true })
    // Persisted as a RUNNING pipeline straight away with a sentinel call_id --
    // never 'proposed', so resolveUrsaPipelineOrchestrator rejects it.
    expect(setUrsaPipeline).toHaveBeenCalledTimes(1)
    const [convId, steps, callId] = vi.mocked(setUrsaPipeline).mock.calls[0]
    expect(convId).toBe('c1')
    expect((steps as Array<{ role: string }>).map((s) => s.role)).toEqual(['verifier', 'reviewer'])
    expect(typeof callId).toBe('string')
    expect(setUrsaPipelineStatus).toHaveBeenCalledWith('c1', 'running')
    // The engine was started on the turn's live signal.
    expect(started).toHaveBeenCalledWith('c1', sink, expect.anything())
    // NO classifier, NO agent, and crucially NO pending consent card.
    expect(resolveUrsaModelRef).not.toHaveBeenCalled()
    expect(makeModel).not.toHaveBeenCalled()
    const emitted = vi.mocked(sink.emit).mock.calls.map((c) => c[1])
    expect(emitted.some((e) => e.type === 'tool_call')).toBe(false)
    // The user_message is still emitted before dispatch (transcript honesty).
    expect(emitted.some((e) => e.type === 'user_message')).toBe(true)
  })

  it('fails honestly (recoverable error, no pipeline) when the verifier is unkeyed', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('deep-research'))
    vi.mocked(resolveDeepResearchPipeline).mockReturnValue({
      error: 'Deep Research needs a Perplexity API key. Add one in Settings > Providers.'
    })
    const started = vi.fn()
    setStartUrsaPipeline(started)
    const sink = makeSink()
    const result = await runGraph({
      conversationId: 'c1',
      userText: 'research something',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    })
    expect(result).toEqual({ paused: false, failed: true })
    expect(setUrsaPipeline).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    expect(sink.setState).toHaveBeenCalledWith('c1', 'error')
    const emitted = vi.mocked(sink.emit).mock.calls.map((c) => c[1])
    const err = emitted.find((e) => e.type === 'error')
    expect(err).toMatchObject({ recoverable: true })
    expect((err as { message: string }).message).toMatch(/Perplexity/)
  })

  it('does NOT deep-research a concrete (non-Ursa) model even if meta says deep-research', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('deep-research'))
    const started = vi.fn()
    setStartUrsaPipeline(started)
    const sink = makeSink()
    await runGraph({
      conversationId: 'c1',
      userText: 'hi',
      modelRef: 'anthropic/claude-sonnet-5',
      sink,
      signal: new AbortController().signal
    }).catch(() => {})
    expect(started).not.toHaveBeenCalled()
    expect(setUrsaPipeline).not.toHaveBeenCalled()
  })

  it('REGRESSION: Auto-mode classifier pipeline proposal still shows its consent card', async () => {
    vi.mocked(getConversationMeta).mockReturnValue(metaWith('auto'))
    const steps = [
      { role: 'coder', modelRef: 'openai/gpt-5.6-sol', subtask: 'build' },
      { role: 'reviewer', modelRef: 'anthropic/claude-sonnet-5', subtask: 'review' }
    ]
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'openai/gpt-5.6-sol',
      roleName: 'coder',
      pipeline: steps
    })
    const sink = makeSink()
    const result = await runGraph({
      conversationId: 'c1',
      userText: 'build then review',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    })
    // Auto mode still parks on the consent card, NOT the deep-research auto-start.
    expect(result).toEqual({ paused: true })
    expect(resolveDeepResearchPipeline).not.toHaveBeenCalled()
    const emitted = vi.mocked(sink.emit).mock.calls.map((c) => c[1])
    const card = emitted.find((e) => e.type === 'tool_call')
    expect(card).toMatchObject({ tool: 'ursa_pipeline', approvalState: 'pending' })
    expect(sink.setState).toHaveBeenCalledWith('c1', 'awaiting-approval')
  })
})

describe('runGraph — Ursa Phase 2 pipeline proposal (consent gate)', () => {
  afterEach(() => vi.clearAllMocks())

  const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })

  it('parks a proposed pipeline with a pending synthetic card + persisted row, and builds NO agent', async () => {
    const steps = [
      { role: 'coder', modelRef: 'openai/gpt-5.6-sol', subtask: 'build the parser' },
      { role: 'reviewer', modelRef: 'anthropic/claude-sonnet-5', subtask: 'review it' }
    ]
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'openai/gpt-5.6-sol',
      roleName: 'coder',
      pipeline: steps
    })
    const sink = makeSink()
    const controller = new AbortController()
    const result = await runGraph({
      conversationId: 'c1',
      userText: 'build a parser, then review it',
      modelRef: 'ursa/auto',
      sink,
      signal: controller.signal
    })

    expect(result).toEqual({ paused: true })
    // Proposal persisted (a fresh uuid callId threaded into both the row and card).
    expect(setUrsaPipeline).toHaveBeenCalledTimes(1)
    const [convId, persistedSteps, callId] = vi.mocked(setUrsaPipeline).mock.calls[0]
    expect(convId).toBe('c1')
    expect(persistedSteps).toEqual(steps)
    expect(typeof callId).toBe('string')

    // A pending synthetic ursa_pipeline tool_call was emitted with the same id.
    const toolCall = vi
      .mocked(sink.emit)
      .mock.calls.map((c) => c[1])
      .find((e) => e.type === 'tool_call')
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      id: callId,
      tool: 'ursa_pipeline',
      input: { steps },
      approvalState: 'pending'
    })
    // Run parked awaiting consent; NO agent (makeModel) was ever constructed.
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'awaiting-approval')
    expect(makeModel).not.toHaveBeenCalled()
    // The user_message emitted before resolution is kept (transcript honesty).
    expect(
      vi
        .mocked(sink.emit)
        .mock.calls.map((c) => c[1])
        .some((e) => e.type === 'user_message')
    ).toBe(true)
  })

  it('does NOT propose (single-role path) when the classifier returns no pipeline', async () => {
    vi.mocked(resolveUrsaModelRef).mockResolvedValue({
      modelRef: 'anthropic/claude-sonnet-5',
      roleName: 'reviewer'
    })
    const sink = makeSink()
    // No pipeline -> falls through to buildAgentAndContext. We don't drive a real
    // model here; assert only that the pipeline seam was NOT taken.
    await runGraph({
      conversationId: 'c1',
      userText: 'explain this code',
      modelRef: 'ursa/auto',
      sink,
      signal: new AbortController().signal
    }).catch(() => {
      /* buildAgentAndContext/drive may throw with mocked models — irrelevant here */
    })
    expect(setUrsaPipeline).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(sink.emit)
        .mock.calls.map((c) => c[1])
        .some((e) => e.type === 'tool_call' && e.tool === 'ursa_pipeline')
    ).toBe(false)
  })
})

describe('runGraph — Ursa Phase 2 pipeline step (ursaStep)', () => {
  afterEach(() => vi.clearAllMocks())

  const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })

  // A pipeline step's pre-build bookkeeping runs before buildAgentAndContext
  // (which needs deeper mocks than this suite provides and so throws here). The
  // assertions target exactly that bookkeeping, which is complete by then:
  // classification is skipped, the step model is persisted for rehydration, an
  // ursa_step divider is emitted, and NO user_message is echoed.
  it('skips classification, persists the step model, emits an ursa_step divider, and echoes no user_message', async () => {
    const sink = makeSink()
    await runGraph({
      conversationId: 'c1',
      userText: '',
      modelRef: 'openai/gpt-5.6-sol',
      sink,
      signal: new AbortController().signal,
      ursaStep: {
        index: 2,
        total: 3,
        role: 'reviewer',
        modelRef: 'openai/gpt-5.6-sol',
        subtask: 'review the parser',
        originalUserText: 'build a parser, then review it'
      }
      // buildAgentAndContext throws with this suite's minimal mocks; the divider
      // + model persistence already happened before it.
    }).catch(() => {})

    // The classifier is never consulted for a step.
    expect(resolveUrsaModelRef).not.toHaveBeenCalled()
    // The step's model is persisted so a tool-approval pause inside it rehydrates
    // on the right model (design §3.1).
    expect(setLastResolvedModelRef).toHaveBeenCalledWith('c1', 'openai/gpt-5.6-sol')

    const emitted = vi.mocked(sink.emit).mock.calls.map((c) => c[1])
    const stepDivider = emitted.find((e) => e.type === 'ursa_step')
    expect(stepDivider).toMatchObject({
      type: 'ursa_step',
      index: 2,
      total: 3,
      role: 'reviewer',
      modelRef: 'openai/gpt-5.6-sol',
      subtask: 'review the parser'
    })
    // Steps are internal turns -- the real user_message was persisted when the
    // proposal was created, never re-echoed here.
    expect(emitted.some((e) => e.type === 'user_message')).toBe(false)
  })
})

describe('buildSubagents (Ursa Arc 2 subagent-level routing)', () => {
  afterEach(() => vi.clearAllMocks())

  // A distinct sentinel so the browser subagent's injected tools can be asserted
  // to ride through untouched regardless of the model override.
  const browserTools = [{ name: 'browser_navigate' }] as never

  it('routes researcher and browser to their mapped roles when ursaRole is set', () => {
    vi.mocked(resolveSubagentModelRefs).mockReturnValue({
      researcher: 'anthropic/claude-sonnet-5',
      browser: 'openai/gpt-5.6-luna'
    })
    const [researcher, browser] = buildSubagents('coder', browserTools)

    expect(researcher.name).toBe('researcher')
    expect(researcher.model).toEqual({ __fakeModel: 'anthropic/claude-sonnet-5' })
    expect(browser.name).toBe('browser')
    expect(browser.model).toEqual({ __fakeModel: 'openai/gpt-5.6-luna' })
    // The browser subagent's injected tools survive the model override.
    expect(browser.tools).toBe(browserTools)
    expect(makeModel).toHaveBeenCalledWith('anthropic/claude-sonnet-5')
    expect(makeModel).toHaveBeenCalledWith('openai/gpt-5.6-luna')
  })

  it('adds no model field and never consults the resolver when ursaRole is undefined', () => {
    // Even if the resolver WOULD return refs, the undefined path must never call
    // it (byte-identical to the pre-Arc-2 manual-model / crash-resume behavior).
    vi.mocked(resolveSubagentModelRefs).mockReturnValue({
      researcher: 'anthropic/claude-sonnet-5',
      browser: 'openai/gpt-5.6-luna'
    })
    const [researcher, browser] = buildSubagents(undefined, browserTools)

    expect(researcher).not.toHaveProperty('model')
    expect(browser).not.toHaveProperty('model')
    expect(browser.tools).toBe(browserTools)
    expect(resolveSubagentModelRefs).not.toHaveBeenCalled()
    expect(makeModel).not.toHaveBeenCalled()
  })

  it('adds no model field when the resolver returns an empty map (no keyed roles)', () => {
    vi.mocked(resolveSubagentModelRefs).mockReturnValue({})
    const [researcher, browser] = buildSubagents('reviewer', browserTools)

    expect(researcher).not.toHaveProperty('model')
    expect(browser).not.toHaveProperty('model')
    expect(makeModel).not.toHaveBeenCalled()
  })

  it('routes only the subagents present in a partial resolver result', () => {
    // grunt's provider unkeyed -> browser absent; researcher still routed.
    vi.mocked(resolveSubagentModelRefs).mockReturnValue({
      researcher: 'anthropic/claude-sonnet-5'
    })
    const [researcher, browser] = buildSubagents('architect', browserTools)

    expect(researcher.model).toEqual({ __fakeModel: 'anthropic/claude-sonnet-5' })
    expect(browser).not.toHaveProperty('model')
    expect(browser.tools).toBe(browserTools)
  })
})
