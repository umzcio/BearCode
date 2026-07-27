// Live model-list discovery for the providers whose APIs actually expose one
// (verified against live docs, 2026-07-26). Pure fetch+parse -- no BearCode
// settings/ref-format knowledge lives here; registry.ts owns caching, ref
// prefixing, and the static-array fallback.
import type { ModelInfo } from '../../shared/types'
import type { ModelMetadata } from '../../shared/pricing'

export interface LiveDiscoveryResult {
  models: ModelInfo[]
  // Keyed by the provider's BARE model id (not a "provider/id" ref) --
  // registry.ts prefixes when populating its cache.
  capabilities: Record<string, Partial<ModelMetadata['capabilities']>>
}

const FETCH_TIMEOUT_MS = 5000
// Anthropic's default page size is 20 and BearCode only needs a small set of
// Claude chat models, but bound the pagination loop against a malformed or
// unexpectedly large response rather than looping unboundedly.
const MAX_PAGES = 5

interface AnthropicModelEntry {
  id: string
  display_name: string
  max_input_tokens?: number
  capabilities?: {
    image_input?: { supported?: boolean }
    structured_outputs?: { supported?: boolean }
    thinking?: { supported?: boolean }
    code_execution?: { supported?: boolean }
    pdf_input?: { supported?: boolean }
  }
}
interface AnthropicModelsResponse {
  data: AnthropicModelEntry[]
  has_more: boolean
  last_id: string
}

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_API_VERSION = '2023-06-01'

export async function fetchAnthropicModels(apiKey: string): Promise<LiveDiscoveryResult | null> {
  try {
    const models: ModelInfo[] = []
    const capabilities: Record<string, Partial<ModelMetadata['capabilities']>> = {}
    let afterId: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(ANTHROPIC_MODELS_URL)
      if (afterId) url.searchParams.set('after_id', afterId)
      const res = await fetch(url, {
        headers: { 'anthropic-version': ANTHROPIC_API_VERSION, 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const body = (await res.json()) as AnthropicModelsResponse
      for (const entry of body.data) {
        models.push({
          id: entry.id,
          label: entry.display_name,
          ...(entry.max_input_tokens ? { contextWindow: entry.max_input_tokens } : {})
        })
        if (entry.capabilities) {
          const c = entry.capabilities
          capabilities[entry.id] = {
            vision: c.image_input?.supported ?? false,
            responseSchema: c.structured_outputs?.supported ?? false,
            reasoning: c.thinking?.supported ?? false,
            codeExecution: c.code_execution?.supported ?? false,
            pdfInput: c.pdf_input?.supported ?? false
          }
        }
      }
      if (!body.has_more) break
      afterId = body.last_id
    }
    return { models, capabilities }
  } catch {
    return null
  }
}
