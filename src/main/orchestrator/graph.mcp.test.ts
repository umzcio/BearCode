import { describe, it, expect, vi } from 'vitest'

// graph.ts imports ../db and ./checkpointer, which touch electron/sqlite at
// call time; mock them (same pattern as graph.test.ts) so importing the module
// under test never opens a real database.
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
  dropDanglingApprovalRows: vi.fn(),
  dropDanglingCancel: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  listArtifactComments: vi.fn(() => []),
  markArtifactCommentsSent: vi.fn(),
  setActiveRules: vi.fn(),
  setPermissionMode: vi.fn()
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

import {
  interruptBelongsToToolCall,
  synthesizedApprovalCard,
  pairedApprovalInput,
  deniedReplayPinsOf,
  toolResultOutput,
  isRehydratableInterrupt,
  type ApprovalItem
} from './graph'

describe('isRehydratableInterrupt — mcp kind', () => {
  it('re-surfaces a parked mcp approval on crash-resume', () => {
    expect(isRehydratableInterrupt({ kind: 'mcp', tool: 'mcp__gh__get_issue' })).toBe(true)
  })
})

describe('interruptBelongsToToolCall — mcp branch', () => {
  const value = { kind: 'mcp', tool: 'mcp__gh__get_issue', toolCallId: 'tcM' }
  it('pairs an mcp payload only to an mcp__ call by toolCallId', () => {
    expect(interruptBelongsToToolCall(value, { id: 'tcM', name: 'mcp__gh__get_issue' })).toBe(true)
  })
  it('rejects a non-mcp candidate (never claims a run_command sibling)', () => {
    expect(interruptBelongsToToolCall(value, { id: 'tcM', name: 'run_command' })).toBe(false)
  })
  it('rejects a different toolCallId', () => {
    expect(interruptBelongsToToolCall(value, { id: 'other', name: 'mcp__gh__get_issue' })).toBe(
      false
    )
  })
  it('never pairs id-less (no fallback for mcp)', () => {
    expect(
      interruptBelongsToToolCall(
        { kind: 'mcp', tool: 'mcp__gh__get_issue' },
        { id: 'tcM', name: 'mcp__gh__get_issue' }
      )
    ).toBe(false)
  })
})

describe('synthesizedApprovalCard — mcp branch', () => {
  it('rebuilds the faithful mcp card from the payload', () => {
    expect(
      synthesizedApprovalCard({
        kind: 'mcp',
        tool: 'mcp__gh__get_issue',
        input: { number: 5 },
        toolCallId: 'tcM'
      })
    ).toEqual({ tool: 'mcp__gh__get_issue', input: { number: 5 }, toolCallId: 'tcM' })
  })
  it('degrades a malformed (non-mcp__) tool name without escaping into another card', () => {
    const card = synthesizedApprovalCard({ kind: 'mcp', tool: 'run_command', input: {} })
    expect(String(card.tool).startsWith('mcp__')).toBe(true)
  })
})

describe('pairedApprovalInput — mcp', () => {
  it('passes the streamed args through untouched (no path enrichment)', () => {
    const args = { number: 5 }
    expect(pairedApprovalInput({ kind: 'mcp', tool: 'mcp__gh__get_issue' }, args)).toBe(args)
  })
})

describe('deniedReplayPinsOf — mcp branch', () => {
  it('pins a denied mcp card under mcpAction (server.tool) + toolCallId', () => {
    const items = new Map<string, ApprovalItem>([
      [
        'tcM',
        {
          interruptId: 'i1',
          tool: 'mcp__gh__get_issue' as ApprovalItem['tool'],
          input: { number: 5 },
          decision: false,
          toolCallId: 'tcM'
        }
      ]
    ])
    expect(deniedReplayPinsOf(items)).toEqual([{ toolCallId: 'tcM', mcpAction: 'gh.get_issue' }])
  })
})

describe('toolResultOutput — mcp hard cap (no stash bypass)', () => {
  it('truncates a large mcp payload at 50000 chars (audit L-15)', () => {
    const big = 'x'.repeat(60000)
    const { output, truncated } = toolResultOutput('mcp__gh__get_issue', 'tcBig', big, true)
    expect(output.length).toBe(50000 + '\n… output truncated'.length)
    expect(truncated).toBe(true)
  })
  it('passes small mcp payloads through untouched', () => {
    expect(toolResultOutput('mcp__gh__get_issue', 'tcSmall', 'ok', true)).toEqual({
      output: 'ok',
      truncated: false
    })
  })
})
