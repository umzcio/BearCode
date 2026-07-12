// wrapToolsWithHooks (Task 8): the runner module is mocked so this test
// exercises only the wrapping/decision-routing logic, not real hook
// spawning (covered by runner.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from 'langchain'
import { z } from 'zod'

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
})
