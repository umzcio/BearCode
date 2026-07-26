import type { ModelMetadata, ModelMetadataMap, ModelMode, PricingMap } from '../../shared/pricing'

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
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_response_schema?: boolean
  supports_reasoning?: boolean
  supports_web_search?: boolean
  [key: string]: unknown
}

// LiteLLM's `mode` carries many values we don't distinguish in the UI
// (completion, rerank, audio_*, moderation, ...) -- collapse anything outside
// our three UI-relevant modes to 'other' rather than growing the union to
// match LiteLLM's full vocabulary.
const KNOWN_MODES: ReadonlySet<string> = new Set(['chat', 'embedding', 'image_generation'])

function metadataFromEntry(entry: LiteLLMEntry): ModelMetadata {
  const mode: ModelMode = KNOWN_MODES.has(entry.mode ?? '') ? (entry.mode as ModelMode) : 'other'
  return {
    mode,
    maxInputTokens: entry.max_input_tokens,
    maxOutputTokens: entry.max_output_tokens,
    capabilities: {
      functionCalling: entry.supports_function_calling ?? false,
      vision: entry.supports_vision ?? false,
      responseSchema: entry.supports_response_schema ?? false,
      reasoning: entry.supports_reasoning ?? false,
      webSearch: entry.supports_web_search ?? false
    }
  }
}

// A LiteLLM entry carries shape metadata if it has a mode or a context-window
// limit -- both fields are present on essentially every real catalog entry,
// so this is a reliable "this ref has real data" test distinct from the
// price-specific check below.
function hasShapeFields(entry: LiteLLMEntry): boolean {
  return entry.mode != null || entry.max_input_tokens != null || entry.max_output_tokens != null
}

// Match each of our refs to a LiteLLM key: exact modelId, then the full ref
// (covers "openrouter/vendor/model"). per-token USD -> per-1M for price;
// mode/context/supports_* pass through as-is for metadata. A ref counts as
// "unmatched" only if NEITHER price nor shape data was found for it.
export function parseLiteLLM(
  raw: Record<string, LiteLLMEntry>,
  refs: string[]
): { prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] } {
  const prices: PricingMap = {}
  const metadata: ModelMetadataMap = {}
  const unmatched: string[] = []
  for (const ref of refs) {
    const entry = raw[modelIdOf(ref)] ?? raw[ref]
    if (!entry) {
      unmatched.push(ref)
      continue
    }
    let matched = false
    if (entry.input_cost_per_token != null || entry.output_cost_per_token != null) {
      prices[ref] = {
        inputPer1M: (entry.input_cost_per_token ?? 0) * 1_000_000,
        outputPer1M: (entry.output_cost_per_token ?? 0) * 1_000_000
      }
      matched = true
    }
    if (hasShapeFields(entry)) {
      metadata[ref] = metadataFromEntry(entry)
      matched = true
    }
    if (!matched) unmatched.push(ref)
  }
  return { prices, metadata, unmatched }
}

// Fetch + parse. Caller persists the returned prices/metadata via settings and
// stamps syncedAt. Throws on network/parse failure (surfaced to the UI).
export async function syncPricing(
  refs: string[]
): Promise<{ prices: PricingMap; metadata: ModelMetadataMap; unmatched: string[] }> {
  const res = await fetch(LITELLM_URL)
  if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, LiteLLMEntry>
  return parseLiteLLM(raw, refs)
}
