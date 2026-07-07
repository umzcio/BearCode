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
  it('sums input/output across distinct runs and tracks last input', () => {
    const acc = makeTurnUsage()
    acc.add('run-1', { input: 100, output: 20 })
    acc.add('run-2', { input: 130, output: 40 }) // second model call in the tool loop
    expect(acc.snapshot()).toEqual({ inputTokens: 230, outputTokens: 60, lastInputTokens: 130 })
  })
  it('dedups the parent/child double-fire by runId (same run counted once)', () => {
    const acc = makeTurnUsage()
    acc.add('run-1', { input: 100, output: 20 })
    acc.add('run-1', { input: 100, output: 20 }) // duplicate fire, same runId
    expect(acc.snapshot()).toEqual({ inputTokens: 100, outputTokens: 20, lastInputTokens: 100 })
  })
  it('snapshot is null-safe when nothing was added', () => {
    expect(makeTurnUsage().snapshot()).toBeNull()
  })
})
