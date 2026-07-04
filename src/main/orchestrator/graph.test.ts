import { describe, it, expect, vi } from 'vitest'

// graph.ts imports ../db and ./checkpointer, which touch electron/sqlite at
// call time; mock them (same pattern as resume.test.ts) so importing the
// module under test never opens a real database.
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
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
  findDanglingRunCommandCall
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

describe('findDanglingRunCommandCall (crash-resume checkpoint scan)', () => {
  // Structural stand-ins for checkpointed BaseMessages: only tool_calls (AI)
  // and tool_call_id (ToolMessage) are read by the scanner.
  const ai = (...calls: Array<{ id: string; name: string; args: unknown }>): unknown => ({
    tool_calls: calls
  })
  const toolResult = (id: string): unknown => ({ tool_call_id: id })
  const human = (): unknown => ({ content: 'do the thing' })

  it('finds the paused run_command with no later ToolMessage', () => {
    const messages = [human(), ai({ id: 'tc1', name: 'run_command', args: { command: 'ls -l' } })]
    expect(findDanglingRunCommandCall(messages, 'ls -l')).toEqual({
      id: 'tc1',
      name: 'run_command',
      args: { command: 'ls -l' }
    })
  })

  it('returns null when a later ToolMessage already answered the call', () => {
    const messages = [
      human(),
      ai({ id: 'tc1', name: 'run_command', args: { command: 'ls -l' } }),
      toolResult('tc1')
    ]
    expect(findDanglingRunCommandCall(messages, 'ls -l')).toBeNull()
  })

  it('skips answered earlier calls and returns the last dangling one', () => {
    const messages = [
      human(),
      ai({ id: 'tc1', name: 'run_command', args: { command: 'ls -l' } }),
      toolResult('tc1'),
      ai({ id: 'tc2', name: 'run_command', args: { command: 'ls -l' } })
    ]
    expect(findDanglingRunCommandCall(messages, 'ls -l')?.id).toBe('tc2')
  })

  it('ignores dangling calls of other tools', () => {
    const messages = [human(), ai({ id: 'tc1', name: 'write_file', args: { path: 'a.txt' } })]
    expect(findDanglingRunCommandCall(messages, 'ls -l')).toBeNull()
  })

  it('rejects a dangling run_command whose command does not match the interrupt', () => {
    const messages = [
      human(),
      ai({ id: 'tc1', name: 'run_command', args: { command: 'rm -rf build' } })
    ]
    expect(findDanglingRunCommandCall(messages, 'ls -l')).toBeNull()
  })

  it('picks the matching call out of a mixed tool_calls array', () => {
    const messages = [
      human(),
      ai(
        { id: 'tc1', name: 'read_file', args: { path: 'a.txt' } },
        { id: 'tc2', name: 'run_command', args: { command: 'ls -l' } }
      ),
      toolResult('tc1')
    ]
    expect(findDanglingRunCommandCall(messages, 'ls -l')?.id).toBe('tc2')
  })

  it('handles empty histories and malformed entries without throwing', () => {
    expect(findDanglingRunCommandCall([], 'ls -l')).toBeNull()
    expect(
      findDanglingRunCommandCall(
        [null, undefined, 'text', { tool_calls: 'nope' }, { tool_calls: [null, { id: 42 }] }],
        'ls -l'
      )
    ).toBeNull()
  })
})
