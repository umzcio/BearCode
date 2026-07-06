// LangChain chat model factory, backed by the encrypted key vault.
// Never hardcode keys and never route through the Vercel AI Gateway;
// each provider is instantiated directly with the user's own key.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOllama } from '@langchain/ollama'
import { getKey } from '../keys'
import { getSettings } from '../settings'
import { parseModelRef } from '../providers/registry'
import type { EffortLevel, ProviderId } from '../../shared/types'

function requireKey(provider: ProviderId): string {
  const key = getKey(provider)
  if (!key) throw new Error(`No API key for ${provider}. Add it in Settings.`)
  return key
}

// Provider-specific constructor fragments for effort + thinking, kept PURE so
// the mapping is unit-tested without instantiating a LangChain class. Merged
// into the constructor args by makeModel. With opts omitted the result is
// byte-identical to the pre-E6 behavior (Anthropic/Google thinking on, effort
// unset). See planning/2026-07-05-e1e6-effort-composer-design.md §5.
//
// Haiku models don't support extended thinking; everything else gets adaptive
// thinking, mirroring the provider registry's providerOptions() for the legacy engine.
// display:'summarized' is required for reasoning to be visible: on Claude 4.6+
// models the raw chain of thought is never returned and the display defaults to
// 'omitted' (empty thinking text) -- without this the thinking blocks arrive with
// only a signature and no text, so the reasoning bridge (graph.ts) has nothing to
// show. 'summarized' returns a readable summary the bridge renders as "Thought for Ns".
//
// Gemini 2.5+ / 3.x models support thought summaries via thinkingConfig
// (`GoogleGenerativeAIThinkingConfig` in @langchain/google-genai's types.d.ts).
// Older 1.x models don't support thinking and error if this is set, so guard
// on model id, mirroring the Haiku exclusion above and the legacy engine's
// providerOptions() in src/main/providers/registry.ts.
export function buildModelExtras(
  provider: ProviderId,
  modelId: string,
  opts: { effort?: EffortLevel; thinking?: boolean }
): Record<string, unknown> {
  const effort = opts.effort ?? 'adaptive'
  const thinking = opts.thinking ?? true
  switch (provider) {
    case 'anthropic': {
      if (modelId.startsWith('claude-haiku')) return {} // never thinks; no effort
      const extras: Record<string, unknown> = {}
      if (thinking) extras.thinking = { type: 'adaptive', display: 'summarized' }
      if (effort !== 'adaptive') extras.outputConfig = { effort }
      return extras
    }
    case 'google':
      if (/^gemini-1[.-]/.test(modelId)) return {}
      return thinking ? { thinkingConfig: { includeThoughts: true } } : {}
    case 'ollama':
      return { think: thinking }
    default:
      // openai, openrouter: reasoning is folded into effort (greyed in UI); no
      // separate thinking knob.
      return {}
  }
}

export function makeModel(
  modelRef: string,
  opts: { effort?: EffortLevel; thinking?: boolean } = {}
): BaseChatModel {
  const { provider, modelId } = parseModelRef(modelRef)
  const extras = buildModelExtras(provider, modelId, opts)
  switch (provider) {
    case 'anthropic':
      return new ChatAnthropic({ apiKey: requireKey('anthropic'), model: modelId, ...extras })
    case 'openai':
      return new ChatOpenAI({ apiKey: requireKey('openai'), model: modelId, ...extras })
    case 'google':
      return new ChatGoogleGenerativeAI({ apiKey: requireKey('google'), model: modelId, ...extras })
    case 'openrouter':
      return new ChatOpenAI({
        apiKey: requireKey('openrouter'),
        model: modelId,
        configuration: { baseURL: 'https://openrouter.ai/api/v1' },
        ...extras
      })
    case 'ollama':
      return new ChatOllama({ baseUrl: getSettings().ollamaBaseUrl, model: modelId, ...extras })
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}
