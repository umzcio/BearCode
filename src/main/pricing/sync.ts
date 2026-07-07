import type { PricingMap } from '../../shared/pricing'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// The modelId within a "provider/modelId" ref (split on FIRST slash; OpenRouter
// ids contain slashes).
function modelIdOf(ref: string): string {
  const i = ref.indexOf('/')
  return i === -1 ? ref : ref.slice(i + 1)
}

interface LiteLLMEntry {
  input_cost_per_token?: number
  output_cost_per_token?: number
}

// Match each of our refs to a LiteLLM key: exact modelId, then the full ref
// (covers "openrouter/vendor/model"). per-token USD -> per-1M.
export function parseLiteLLM(
  raw: Record<string, LiteLLMEntry>,
  refs: string[]
): { prices: PricingMap; unmatched: string[] } {
  const prices: PricingMap = {}
  const unmatched: string[] = []
  for (const ref of refs) {
    const entry = raw[modelIdOf(ref)] ?? raw[ref]
    if (entry && (entry.input_cost_per_token != null || entry.output_cost_per_token != null)) {
      prices[ref] = {
        inputPer1M: (entry.input_cost_per_token ?? 0) * 1_000_000,
        outputPer1M: (entry.output_cost_per_token ?? 0) * 1_000_000
      }
    } else {
      unmatched.push(ref)
    }
  }
  return { prices, unmatched }
}

// Fetch + parse. Caller persists the returned prices via settings and stamps
// syncedAt. Throws on network/parse failure (surfaced to the UI).
export async function syncPricing(
  refs: string[]
): Promise<{ prices: PricingMap; unmatched: string[] }> {
  const res = await fetch(LITELLM_URL)
  if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, LiteLLMEntry>
  return parseLiteLLM(raw, refs)
}
