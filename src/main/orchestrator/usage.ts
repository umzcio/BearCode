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
  add(
    runId: string,
    parentRunId: string | undefined,
    usage: { input: number; output: number }
  ): void
  snapshot(): { inputTokens: number; outputTokens: number; lastInputTokens: number } | null
}

// Accumulates usage across the (possibly many) model calls in one turn.
//
// handleLLMEnd double-fires for a SINGLE model call: once for the nested parent
// run and once for the child model run. Both carry IDENTICAL usage_metadata but
// under DIFFERENT runIds -- the child's parentRunId is the parent's runId (this
// is why the reasoning/tool-call dedup elsewhere in graph.ts keys on content/id,
// never on runId). Deduping by runId alone therefore counts every call TWICE.
//
// So we dedup by the parent/child link instead. A fire is skipped when:
//   - its runId was already counted (defensive: the exact run recounted), or
//   - its parentRunId was already counted (it is the CHILD of a counted parent), or
//   - its runId was recorded as some counted fire's parentRunId (it is the PARENT
//     of a counted child -- catches the parent fire arriving after the child).
// Each genuine model call in the tool loop has its own distinct parent run, so
// real calls are still summed; only the paired double-fire collapses. The shared
// grandparent (graph/node) run only ever lands in `parentLinks` and is never used
// to skip a parentRunId, so it cannot swallow a later distinct call.
//
// inputTokens/outputTokens are summed for cost; lastInputTokens is the final
// call's prompt size -- the accurate "how full is the window" signal.
export function makeTurnUsage(): TurnUsageAccumulator {
  const counted = new Set<string>()
  const parentLinks = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0
  let lastInputTokens = 0
  let any = false
  return {
    add(runId, parentRunId, usage) {
      if (counted.has(runId)) return
      if (parentRunId != null && counted.has(parentRunId)) return
      if (parentLinks.has(runId)) return
      counted.add(runId)
      if (parentRunId != null) parentLinks.add(parentRunId)
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
