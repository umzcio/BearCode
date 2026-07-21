import { describe, it, expect } from 'vitest'
import { readUsage, makeTurnUsage } from './usage'

// Shape mirrors LangChain LLMResult: generations[][].message.usage_metadata
const result = (input: number, output: number): unknown => ({
  generations: [[{ message: { usage_metadata: { input_tokens: input, output_tokens: output } } }]]
})

describe('readUsage', () => {
  it('reads usage_metadata from a generation message', () => {
    expect(readUsage(result(120, 30) as never)).toEqual({ input: 120, output: 30 })
  })
  it('falls back to llmOutput.tokenUsage', () => {
    const r = {
      generations: [[{ message: {} }]],
      llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 7 } }
    }
    expect(readUsage(r as never)).toEqual({ input: 5, output: 7 })
  })
  it('returns null when no usage is present', () => {
    expect(readUsage({ generations: [[{ message: {} }]] } as never)).toBeNull()
  })
})

describe('provider-reported cost (OpenRouter usage accounting)', () => {
  const withCost = (input: number, output: number, cost?: number): unknown => ({
    generations: [
      [
        {
          message: {
            usage_metadata: { input_tokens: input, output_tokens: output },
            ...(cost === undefined ? {} : { response_metadata: { bearcodeCostUsd: cost } })
          }
        }
      ]
    ]
  })

  it('readUsage surfaces a reported cost when present', () => {
    expect(readUsage(withCost(10, 5, 0.007) as never)).toEqual({
      input: 10,
      output: 5,
      costUsd: 0.007
    })
  })

  it('readUsage omits costUsd entirely when the provider reported none', () => {
    expect(readUsage(withCost(10, 5) as never)).toEqual({ input: 10, output: 5 })
  })

  it('the accumulator sums cost across calls', () => {
    const acc = makeTurnUsage()
    acc.add('r1', undefined, { input: 10, output: 5, costUsd: 0.01 })
    acc.add('r2', undefined, { input: 20, output: 5, costUsd: 0.02 })
    expect(acc.snapshot()?.costUsd).toBeCloseTo(0.03, 10)
  })

  // A bare 0 would render as a real "$0.00" and hide the fact that nothing was
  // reported, so costUsd must stay absent for non-reporting providers.
  it('omits costUsd when NO call reported one (not a misleading zero)', () => {
    const acc = makeTurnUsage()
    acc.add('r1', undefined, { input: 10, output: 5 })
    const snap = acc.snapshot()
    expect(snap).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(snap && 'costUsd' in snap).toBe(false)
  })

  it('a reported zero IS kept (a free model really did cost nothing)', () => {
    const acc = makeTurnUsage()
    acc.add('r1', undefined, { input: 10, output: 5, costUsd: 0 })
    expect(acc.snapshot()?.costUsd).toBe(0)
  })

  it('does not double-count cost on the parent/child double-fire', () => {
    const acc = makeTurnUsage()
    acc.add('child', 'parent', { input: 10, output: 5, costUsd: 0.05 })
    acc.add('parent', undefined, { input: 10, output: 5, costUsd: 0.05 })
    expect(acc.snapshot()?.costUsd).toBeCloseTo(0.05, 10)
  })
})

describe('makeTurnUsage accumulator', () => {
  it('sums input/output across distinct model calls and tracks last input', () => {
    const acc = makeTurnUsage()
    // Two real model calls in the tool loop, each its own child/parent run pair.
    acc.add('child-1', 'parent-1', { input: 100, output: 20 })
    acc.add('child-2', 'parent-2', { input: 130, output: 40 })
    expect(acc.snapshot()).toEqual({ inputTokens: 230, outputTokens: 60, lastInputTokens: 130 })
  })
  it('dedups the parent/child double-fire: identical usage, DIFFERENT runIds linked by parentRunId', () => {
    const acc = makeTurnUsage()
    // handleLLMEnd fires twice for ONE call. The child model run carries the real
    // usage; its parentRunId points at the nested parent run, which then fires the
    // same usage under its OWN runId. Real runtime uses two distinct runIds here
    // (a single shared runId never happens), so only the parentRunId link can dedup.
    acc.add('child-1', 'parent-1', { input: 100, output: 20 }) // child fire
    acc.add('parent-1', 'graph-run', { input: 100, output: 20 }) // parent fire, same usage
    expect(acc.snapshot()).toEqual({ inputTokens: 100, outputTokens: 20, lastInputTokens: 100 })
  })
  it('dedups the double-fire regardless of parent/child arrival order', () => {
    const acc = makeTurnUsage()
    acc.add('parent-1', 'graph-run', { input: 100, output: 20 }) // parent fires first
    acc.add('child-1', 'parent-1', { input: 100, output: 20 }) // then the child fire
    expect(acc.snapshot()).toEqual({ inputTokens: 100, outputTokens: 20, lastInputTokens: 100 })
  })
  it('sums two real calls that share a grandparent run, collapsing each double-fire', () => {
    const acc = makeTurnUsage()
    // Both calls nest under the same graph/node run; the shared grandparent must
    // not swallow the second call. Parent-first order (the harder case).
    acc.add('parent-1', 'graph-run', { input: 100, output: 20 })
    acc.add('child-1', 'parent-1', { input: 100, output: 20 })
    acc.add('parent-2', 'graph-run', { input: 130, output: 40 })
    acc.add('child-2', 'parent-2', { input: 130, output: 40 })
    expect(acc.snapshot()).toEqual({ inputTokens: 230, outputTokens: 60, lastInputTokens: 130 })
  })
  it('snapshot is null-safe when nothing was added', () => {
    expect(makeTurnUsage().snapshot()).toBeNull()
  })
})
