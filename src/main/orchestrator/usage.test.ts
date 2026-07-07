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
