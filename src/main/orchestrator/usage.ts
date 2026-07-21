import type { LLMResult } from '@langchain/core/outputs'

// Pull normalized token usage from a completed LLM call. Prefers LangChain's
// message.usage_metadata (present across providers in v1); falls back to the
// older llmOutput.tokenUsage. Returns null when a provider reports nothing.
export function readUsage(
  output: LLMResult
): { input: number; output: number; costUsd?: number } | null {
  for (const gens of output.generations ?? []) {
    for (const gen of gens) {
      const message = (
        gen as {
          message?: {
            usage_metadata?: { input_tokens?: number; output_tokens?: number }
            response_metadata?: Record<string, unknown>
          }
        }
      ).message
      const um = message?.usage_metadata
      if (um && (um.input_tokens != null || um.output_tokens != null)) {
        // A provider-reported cost, when the provider gives one (OpenRouter's
        // usage accounting; see models.ts attachOpenRouterCost). Optional --
        // every other provider still relies on the derived price table.
        const reported = message?.response_metadata?.['bearcodeCostUsd']
        return {
          input: um.input_tokens ?? 0,
          output: um.output_tokens ?? 0,
          ...(typeof reported === 'number' && Number.isFinite(reported)
            ? { costUsd: reported }
            : {})
        }
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
    usage: { input: number; output: number; costUsd?: number }
  ): void
  snapshot(): {
    inputTokens: number
    outputTokens: number
    lastInputTokens: number
    costUsd?: number
  } | null
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
  let costUsd = 0
  // Tracked separately from `any`: a turn can report tokens with no cost (every
  // provider except OpenRouter), and summing to a bare 0 there would look like
  // a real "$0.00" instead of "not reported". Only emit costUsd if some call
  // actually reported one.
  let anyCost = false
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
      if (usage.costUsd != null) {
        costUsd += usage.costUsd
        anyCost = true
      }
    },
    snapshot() {
      if (!any) return null
      return { inputTokens, outputTokens, lastInputTokens, ...(anyCost ? { costUsd } : {}) }
    }
  }
}
