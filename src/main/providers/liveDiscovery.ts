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
          // Only set a field when its sub-object was actually present in the
          // response -- "Anthropic didn't mention this field" must stay
          // absent (undefined), never harden into a manufactured `false`.
          // A present `false` here would win the per-field merge in
          // modelRows.ts's mergeMetadata (`live?.vision ?? base?...`) and
          // shadow a real `true` from LiteLLM's synced metadata.
          const patch: Partial<ModelMetadata['capabilities']> = {}
          if (c.image_input?.supported !== undefined) patch.vision = c.image_input.supported
          if (c.structured_outputs?.supported !== undefined)
            patch.responseSchema = c.structured_outputs.supported
          if (c.thinking?.supported !== undefined) patch.reasoning = c.thinking.supported
          if (c.code_execution?.supported !== undefined)
            patch.codeExecution = c.code_execution.supported
          if (c.pdf_input?.supported !== undefined) patch.pdfInput = c.pdf_input.supported
          capabilities[entry.id] = patch
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

interface GoogleModelEntry {
  name: string
  displayName?: string
  inputTokenLimit?: number
  thinking?: boolean
  // The standard signal for "this model can do chat/text generation" on
  // Gemini's API. models.list also returns embedding models, Imagen, Veo,
  // TTS/image variants, Gemma, etc. -- entries missing this field entirely
  // are excluded too (fail toward excluding an unknown-shaped entry, not
  // including it).
  supportedGenerationMethods?: string[]
}
interface GoogleModelsResponse {
  models?: GoogleModelEntry[]
  nextPageToken?: string
}

const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export async function fetchGoogleModels(apiKey: string): Promise<LiveDiscoveryResult | null> {
  try {
    const models: ModelInfo[] = []
    const capabilities: Record<string, Partial<ModelMetadata['capabilities']>> = {}
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(GOOGLE_MODELS_URL)
      url.searchParams.set('pageSize', '50')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await fetch(url, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const body = (await res.json()) as GoogleModelsResponse
      for (const entry of body.models ?? []) {
        if (!entry.supportedGenerationMethods?.includes('generateContent')) continue
        const id = entry.name.replace(/^models\//, '')
        models.push({
          id,
          label: entry.displayName ?? id,
          ...(entry.inputTokenLimit ? { contextWindow: entry.inputTokenLimit } : {})
        })
        if (entry.thinking != null) {
          capabilities[id] = { reasoning: entry.thinking }
        }
      }
      if (!body.nextPageToken) break
      pageToken = body.nextPageToken
    }
    return { models, capabilities }
  } catch {
    return null
  }
}

interface OpenAIModelEntry {
  id: string
}
interface OpenAIModelsResponse {
  data: OpenAIModelEntry[]
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'

// OpenAI's list response has no display name and no capability/type field at
// all -- it mixes chat models with embeddings/whisper/tts/dall-e/moderation/
// fine-tunes. The caller (registry.ts) supplies the filter, since deciding
// "is this a chat model" is BearCode-settings-shaped logic (a LiteLLM
// cross-reference, with a hardcoded bootstrap fallback), not something this
// pure fetch/parse layer should know about.
export async function fetchOpenAIModels(
  apiKey: string,
  isKnownChatModel: (id: string) => boolean
): Promise<LiveDiscoveryResult | null> {
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as OpenAIModelsResponse
    const models: ModelInfo[] = body.data
      .filter((entry) => isKnownChatModel(entry.id))
      .map((entry) => ({ id: entry.id, label: entry.id }))
    return { models, capabilities: {} }
  } catch {
    return null
  }
}
