// wrapToolsWithHooks (Task 8): the runner module is mocked so this test
// exercises only the wrapping/decision-routing logic, not real hook
// spawning (covered by runner.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from 'langchain'
import { z } from 'zod'
import { clearDeniedReplayPins, pinDeniedReplays } from '../orchestrator/tools'

const mockRunPreToolUse = vi.fn()
const mockRunPostToolUse = vi.fn()
vi.mock('./runner', () => ({
  runPreToolUse: (...args: unknown[]) => mockRunPreToolUse(...args),
  runPostToolUse: (...args: unknown[]) => mockRunPostToolUse(...args)
}))

// interrupt() is not exercised by these cases (deny/allow/throwing-hook never
// reach it) but must still be a callable stub for the module to import.
vi.mock('@langchain/langgraph', () => ({ interrupt: vi.fn() }))

import { wrapToolsWithHooks } from './wrap'

function fakeCtx(): { projectPath: string; conversationId: string; trusted: boolean } {
  return { projectPath: '/proj', conversationId: 'c1', trusted: true }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeFakeTool(fn: (input: { x?: string }) => Promise<string>) {
  return tool(fn, {
    name: 'toolA',
    description: 'a fake tool',
    schema: z.object({ x: z.string().optional() })
  })
}

interface Invokable {
  invoke: (input: unknown) => Promise<unknown>
}

describe('wrapToolsWithHooks', () => {
  beforeEach(() => {
    mockRunPreToolUse.mockReset()
    mockRunPostToolUse.mockReset().mockResolvedValue(undefined)
    clearDeniedReplayPins('c1')
  })

  it('deny short-circuits: the reason is returned, the original is never called', async () => {
    const original = vi.fn(async (input: { x?: string }) => `ran:${input.x}`)
    const toolA = makeFakeTool(original)
    mockRunPreToolUse.mockResolvedValue({ decision: 'deny', reason: 'blocked by guard' })

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [Invokable]
    const out = await wrapped.invoke({ x: 'hi' })

    expect(out).toBe('blocked by guard')
    expect(original).not.toHaveBeenCalled()
  })

  it('allow calls the original tool and returns its result', async () => {
    const original = vi.fn(async (input: { x?: string }) => `ran:${input.x}`)
    const toolA = makeFakeTool(original)
    mockRunPreToolUse.mockResolvedValue({ decision: 'allow' })

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [Invokable]
    const out = await wrapped.invoke({ x: 'hi' })

    expect(out).toBe('ran:hi')
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('fires PostToolUse after a successful allowed call', async () => {
    const original = vi.fn(async () => 'result')
    const toolA = makeFakeTool(original)
    mockRunPreToolUse.mockResolvedValue({ decision: 'allow' })

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [Invokable]
    await wrapped.invoke({})

    expect(mockRunPostToolUse).toHaveBeenCalledWith('toolA', {}, true, 'result', fakeCtx())
  })

  it('a throwing hook layer does NOT block -- the original still runs', async () => {
    const original = vi.fn(async () => 'ok')
    const toolA = makeFakeTool(original)
    mockRunPreToolUse.mockRejectedValue(new Error('hooks layer exploded'))

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [Invokable]
    const out = await wrapped.invoke({})

    expect(out).toBe('ok')
    expect(original).toHaveBeenCalledTimes(1)
  })

  // Critical finding: a keyed-resume replay re-runs this ENTIRE wrapped
  // function from the top, including a fresh runPreToolUse call -- so a
  // recorded Denied decision must win even when the hooks layer would now
  // return a different decision (a non-deterministic hook, or the hook being
  // edited/disabled while the card was pending).
  it('a pinned denied-replay short-circuits BEFORE runPreToolUse is even consulted, take-once', async () => {
    const original = vi.fn(async () => 'ran')
    const toolA = makeFakeTool(original)
    // Simulate the hooks layer flipping its mind on replay: this would allow
    // the call if the pin guard were absent.
    mockRunPreToolUse.mockResolvedValue({ decision: 'allow' })
    pinDeniedReplays('c1', [{ toolCallId: 'tc-1' }])

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [
      { invoke: (input: unknown, config?: unknown) => Promise<unknown> }
    ]
    const out = await wrapped.invoke({}, { toolCallId: 'tc-1' })

    expect(out).toBe('User denied this action.')
    expect(original).not.toHaveBeenCalled()
    expect(mockRunPreToolUse).not.toHaveBeenCalled()

    // Take-once: a genuinely new call reusing the same toolCallId (a fresh,
    // unrelated tool invocation) must not be silently denied.
    const out2 = await wrapped.invoke({}, { toolCallId: 'tc-1' })
    expect(out2).toBe('ran')
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('a denied-replay pin with no toolCallId on this call does not block it', async () => {
    const original = vi.fn(async () => 'ran')
    const toolA = makeFakeTool(original)
    mockRunPreToolUse.mockResolvedValue({ decision: 'allow' })
    pinDeniedReplays('c1', [{ toolCallId: 'tc-1' }])

    const [wrapped] = wrapToolsWithHooks([toolA], fakeCtx()) as [Invokable]
    const out = await wrapped.invoke({})

    expect(out).toBe('ran')
    expect(original).toHaveBeenCalledTimes(1)
  })
})
