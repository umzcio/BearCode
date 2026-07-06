import type { Event, ProviderModels } from '@shared/types'

// Rough token estimate (the standard ~4-chars-per-token heuristic). Labeled "~"
// in the UI so it never reads as exact. Not a substitute for real usage_metadata
// (deferred — would require touching the graph's streaming path).
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Sum the estimate over the text-bearing events that make up the bulk of what
// gets resent to the model: user messages, assistant prose, and tool results.
export function conversationTokens(events: Event[]): number {
  let total = 0
  for (const e of events) {
    if (e.type === 'user_message') total += estimateTokens(e.text)
    else if (e.type === 'assistant_text') total += estimateTokens(e.text)
    else if (e.type === 'tool_result') total += estimateTokens(e.output)
  }
  return total
}

export function contextUsage(tokens: number, window: number): { pct: number; near: boolean } {
  const pct = Math.round((tokens / window) * 100)
  return { pct, near: pct >= 80 }
}

// Look up the selected model's context window (undefined = unknown → hide meter).
export function contextWindowFor(
  providers: ProviderModels[],
  modelRef: string | null
): number | undefined {
  if (!modelRef) return undefined
  const slash = modelRef.indexOf('/')
  if (slash === -1) return undefined
  const providerId = modelRef.slice(0, slash)
  const modelId = modelRef.slice(slash + 1)
  const provider = providers.find((p) => p.id === providerId)
  return provider?.models.find((m) => m.id === modelId)?.contextWindow
}
