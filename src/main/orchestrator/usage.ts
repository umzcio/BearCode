import type { LLMResult } from '@langchain/core/outputs'

// Pull normalized token usage from a completed LLM call. Prefers LangChain's
// message.usage_metadata (present across providers in v1); falls back to the
// older llmOutput.tokenUsage. Returns null when a provider reports nothing.
export function readUsage(output: LLMResult): { input: number; output: number } | null {
  for (const gens of output.generations ?? []) {
    for (const gen of gens) {
      const um = (
        gen as { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }
      ).message?.usage_metadata
      if (um && (um.input_tokens != null || um.output_tokens != null)) {
        return { input: um.input_tokens ?? 0, output: um.output_tokens ?? 0 }
      }
    }
  }
  const tu = (
    output.llmOutput as
      { tokenUsage?: { promptTokens?: number; completionTokens?: number } } | undefined
  )?.tokenUsage
  if (tu && (tu.promptTokens != null || tu.completionTokens != null)) {
    return { input: tu.promptTokens ?? 0, output: tu.completionTokens ?? 0 }
  }
  return null
}

export interface TurnUsageAccumulator {
  add(runId: string, usage: { input: number; output: number }): void
  snapshot(): { inputTokens: number; outputTokens: number; lastInputTokens: number } | null
}

// Accumulates usage across the (possibly many) model calls in one turn.
// Dedups the parent/child handleLLMEnd double-fire by runId. inputTokens/
// outputTokens are summed for cost; lastInputTokens is the final call's prompt
// size -- the accurate "how full is the window" signal.
export function makeTurnUsage(): TurnUsageAccumulator {
  const counted = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0
  let lastInputTokens = 0
  let any = false
  return {
    add(runId, usage) {
      if (counted.has(runId)) return
      counted.add(runId)
      any = true
      inputTokens += usage.input
      outputTokens += usage.output
      lastInputTokens = usage.input
    },
    snapshot() {
      return any ? { inputTokens, outputTokens, lastInputTokens } : null
    }
  }
}
