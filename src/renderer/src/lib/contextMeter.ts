import type { Event, ProviderModels } from '@shared/types'
import { resolvePrice, type PricingMap } from '@shared/pricing'

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

// The newest turn's measured usage from the provider (null until any turn
// reports usage_metadata). `lastInputTokens` is the real prompt size sent on
// the last turn — the accurate substitute for the char/4 estimate.
export function latestUsage(
  events: Event[]
): { inputTokens: number; outputTokens: number; lastInputTokens: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn_meta' && e.usage) return e.usage
  }
  return null
}

// Roll up measured token usage per provider/model so a conversation that
// switched models attributes tokens (and therefore cost) to the right one.
export function usageByModel(events: Event[]): {
  modelRef: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}[] {
  const map = new Map<
    string,
    { modelRef: string; provider: string; model: string; inputTokens: number; outputTokens: number }
  >()
  const add = (modelRef: string, inputTokens: number, outputTokens: number): void => {
    const slash = modelRef.indexOf('/')
    const provider = slash === -1 ? modelRef : modelRef.slice(0, slash)
    const model = slash === -1 ? modelRef : modelRef.slice(slash + 1)
    const cur = map.get(modelRef) ?? {
      modelRef,
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0
    }
    cur.inputTokens += inputTokens
    cur.outputTokens += outputTokens
    map.set(modelRef, cur)
  }
  for (const e of events) {
    if (e.type !== 'turn_meta') continue
    if (e.usage) add(`${e.provider}/${e.model}`, e.usage.inputTokens, e.usage.outputTokens)
    // Ursa Phase 1 (Task 5, #3): the routing classifier ran on its own cheap
    // model (its own modelRef, often different from the resolved role's), and
    // those tokens cost real money -- fold them into the same per-model rollup
    // so the breakdown/cost accounts for them under the classifier's model.
    if (e.ursaClassifierUsage) {
      const cu = e.ursaClassifierUsage
      add(cu.modelRef, cu.inputTokens, cu.outputTokens)
    }
  }
  return [...map.values()]
}

// Ursa Phase 1 (Task 6, #4): per-role spend. Aggregate the cost of every turn
// Ursa routed, grouped by the role that handled it (turn_meta.ursaRole). A
// role's cost folds in both the turn's main-model usage AND the routing
// classifier's own usage for that turn (both cost real money to serve that
// turn), using the same price resolution as the per-model breakdown. Turns
// without an ursaRole (non-Ursa conversations) contribute nothing, so the
// returned list is empty and the UI hides the section entirely. Insertion
// order follows first-seen role.
export function costByRole(
  events: Event[],
  synced?: PricingMap
): { role: string; cost: number; hasUnknown: boolean }[] {
  const map = new Map<string, { role: string; cost: number; hasUnknown: boolean }>()
  for (const e of events) {
    if (e.type !== 'turn_meta' || !e.ursaRole) continue
    const cur = map.get(e.ursaRole) ?? { role: e.ursaRole, cost: 0, hasUnknown: false }
    const addCost = (modelRef: string, inputTokens: number, outputTokens: number): void => {
      const price = resolvePrice(modelRef, synced)
      if (!price) {
        cur.hasUnknown = true
        return
      }
      cur.cost += (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000
    }
    if (e.usage) addCost(`${e.provider}/${e.model}`, e.usage.inputTokens, e.usage.outputTokens)
    if (e.ursaClassifierUsage) {
      const cu = e.ursaClassifierUsage
      addCost(cu.modelRef, cu.inputTokens, cu.outputTokens)
    }
    map.set(e.ursaRole, cur)
  }
  return [...map.values()]
}

// Estimated USD cost from per-model usage. Models with no resolvable price
// (e.g. local Ollama) are excluded from the total and flip `hasUnknown` so the
// UI can mark the figure as partial.
export function conversationCost(
  byModel: ReturnType<typeof usageByModel>,
  synced?: PricingMap
): { total: number; perModel: Record<string, number>; hasUnknown: boolean } {
  const perModel: Record<string, number> = {}
  let total = 0
  let hasUnknown = false
  for (const m of byModel) {
    const price = resolvePrice(m.modelRef, synced)
    if (!price) {
      hasUnknown = true
      continue
    }
    const cost = (m.inputTokens * price.inputPer1M + m.outputTokens * price.outputPer1M) / 1_000_000
    perModel[m.modelRef] = cost
    total += cost
  }
  return { total, perModel, hasUnknown }
}
