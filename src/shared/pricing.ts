// Model pricing in USD per 1M tokens. Effective price = synced override (from
// AppSettings.modelPricing, refreshed by the Settings "Sync prices" button)
// falling back to the small bundled table below, which ships so cost works
// offline. No provider exposes an official pricing API for first-party models,
// so first-party rates are bundled (Anthropic, confidently) and everything else
// is populated by Sync. null = unknown price -> cost hidden for that model.
export interface ModelPrice {
  inputPer1M: number
  outputPer1M: number
}
export type PricingMap = Record<string, ModelPrice>

// A model's capability/shape metadata as reported by LiteLLM's catalog
// (model_prices_and_context_window.json). Populated by the SAME sync action
// that populates PricingMap -- one fetch, two derived maps (see
// src/main/pricing/sync.ts). Absent for a ref LiteLLM doesn't catalog
// (custom models, Ollama) -- callers must render that as "unknown," not as
// every capability being false.
export type ModelMode = 'chat' | 'embedding' | 'image_generation' | 'other'

export interface ModelMetadata {
  mode: ModelMode
  maxInputTokens?: number
  maxOutputTokens?: number
  capabilities: {
    functionCalling: boolean
    vision: boolean
    responseSchema: boolean
    reasoning: boolean
    webSearch: boolean
  }
}
export type ModelMetadataMap = Record<string, ModelMetadata>

// Seeded from published Anthropic rates (2026-07). OpenAI/Google/OpenRouter are
// intentionally left to Sync rather than shipping numbers that may be wrong.
export const BUNDLED_PRICES: PricingMap = {
  'anthropic/claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'anthropic/claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 },
  'anthropic/claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 }
}

export function resolvePrice(modelRef: string, synced?: PricingMap): ModelPrice | null {
  return synced?.[modelRef] ?? BUNDLED_PRICES[modelRef] ?? null
}
