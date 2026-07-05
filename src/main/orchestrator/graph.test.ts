import { describe, it, expect, vi } from 'vitest'

// graph.ts imports ../db and ./checkpointer, which touch electron/sqlite at
// call time; mock them (same pattern as resume.test.ts) so importing the
// module under test never opens a real database.
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
  dropDanglingApprovalRows: vi.fn(),
  dropDanglingCancel: vi.fn(),
  getConversationMeta: vi.fn(() => null)
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

import {
  textOfMessage,
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
  synthesizedApprovalCard,
  isRehydratableInterrupt,
  type ApprovalItem
} from './graph'

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
})

describe('isRehydratableInterrupt (crash-resume kind filter)', () => {
  it('accepts both approval-bearing kinds', () => {
    expect(isRehydratableInterrupt({ kind: 'run_command', command: 'ls' })).toBe(true)
    expect(isRehydratableInterrupt({ kind: 'edit_file', tool: 'write_file', path: 'a' })).toBe(true)
  })

  it('rejects unknown kinds and malformed values', () => {
    expect(isRehydratableInterrupt({ kind: 'future_kind' })).toBe(false)
    expect(isRehydratableInterrupt(undefined)).toBe(false)
    expect(isRehydratableInterrupt('edit_file')).toBe(false)
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
      // bare boolean, or LangGraph treats the resume as absent.
      for (const value of Object.values(resume)) {
        expect(Boolean(value)).toBe(true)
        expect(typeof value.approved).toBe('boolean')
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
